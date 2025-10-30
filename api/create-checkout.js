// /api/create-checkout.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import Stripe from 'stripe';
import { resolveAffiliate } from './_affiliates.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20',
});

function moneyToCents(v) {
  return Math.max(0, Math.round(Number(v || 0) * 100));
}

function safeStr(v, fallback = '') {
  return (typeof v === 'string' ? v : fallback).trim();
}

export default async function handler(req, res) {
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const body = req.body || {};
    const pin = safeStr(body.pin);
    const aff = resolveAffiliate(pin);
    if (!aff) {
      return res.status(400).json({ ok: false, error: 'invalid_pin' });
    }

    // En frontend ya calculas totals; aquí reforzamos reglas:
    const payMode = safeStr(body.payMode, 'deposit'); // deposit | full
    const total = Number(body.total || 0);
    const deposit = Number(body.deposit || 0);

    // ✅ Regla: depósito obligatorio (> 0) cuando payMode = 'deposit'
    if (payMode !== 'full') {
      if (!(deposit > 0)) {
        return res.status(400).json({ ok: false, error: 'deposit_required', message: 'Deposit must be greater than $0.' });
      }
    }

    // Monto que cobraremos:
    const amountToCharge = (payMode === 'full') ? total : deposit;
    if (!(amountToCharge > 0)) {
      return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }

    // Información visible en el concepto
    const mainBar = safeStr(body.mainBar, 'Bar');
    const pkg = safeStr(body.pkg, '');
    const fullName = safeStr(body.fullName, 'Client');
    const when = safeStr(body.startISO, '');
    const lineName = (payMode === 'full')
      ? `Full payment — ${mainBar} (${pkg}) — ${fullName}`
      : `Deposit — ${mainBar} (${pkg}) — ${fullName}`;

    // Success / cancel URLs
    const successUrl = process.env.CHECKOUT_SUCCESS_URL || 'https://mannasnackbars.com/thankyou';
    const cancelUrl = process.env.CHECKOUT_CANCEL_URL || 'https://mannasnackbars.com/';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      // cobro exacto del depósito o total
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: lineName,
            metadata: {
              pkg,
              mainBar,
              fullName,
              startISO: when,
              affiliateId: aff.id,
              affiliateName: aff.name,
            }
          },
          unit_amount: moneyToCents(amountToCharge),
        },
        quantity: 1,
      }],
      // Datos para el webhook
      metadata: {
        // Lo que necesitará tu /api/stripe/webhook para crear booking post-pago si así lo decides
        isDeposit: payMode !== 'full' ? '1' : '0',
        pkg,
        mainBar,
        fullName,
        startISO: when,
        affiliateId: aff.id,
        affiliateName: aff.name,
        affiliateEmail: safeStr(body.affiliateEmail),
        email: safeStr(body.email),
        phone: safeStr(body.phone),
        venue: safeStr(body.venue),
        total: String(total),
        deposit: String(deposit),
        balance: String(Number(total - deposit)),
        pin,
      },
      customer_email: safeStr(body.email) || undefined,
      allow_promotion_codes: true,
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    console.error('create-checkout error', e);
    return res.status(500).json({ ok: false, error: 'create_checkout_failed', detail: e.message });
  }
}
