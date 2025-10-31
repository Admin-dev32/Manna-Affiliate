// /api/create-checkout.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';

function cors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const willAllow = allow.length ? allow.includes(origin) : true;

  res.setHeader('Access-Control-Allow-Origin', willAllow ? origin || '*' : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });
    const stripe = new Stripe(stripeSecret, { apiVersion: '2022-11-15' });

    const successUrl = process.env.STRIPE_SUCCESS_URL || 'https://mannasnackbars.com/thankyou';
    const cancelUrl  = process.env.STRIPE_CANCEL_URL  || 'https://mannasnackbars.com/';

    const body = req.body || {};
    const deposit = Number(body.deposit || 0);
    if (!(deposit > 0)) {
      return res.status(400).json({ ok: false, error: 'Deposit required. Enter a deposit > $0.' });
    }

    const pkg = String(body.pkg || '');
    const mainBar = String(body.mainBar || '');
    const clientName = String(body.fullName || 'Client');

    const titleMap = {
      pancake: 'Mini Pancake',
      maruchan: 'Maruchan',
      esquites: 'Esquites (Corn Cups)',
      snack: 'Manna Snack — Classic',
      tostiloco: 'Tostiloco (Premium)'
    };
    const sizeMap = {
      '50-150-5h': '50–150',
      '150-250-5h': '150–250',
      '250-350-6h': '250–350'
    };
    const title = `${titleMap[mainBar] || 'Service'} — ${sizeMap[pkg] || pkg} (Deposit)`;

    // ✅ Include totals so webhook can display them nicely
    const totalNum   = Number(body.total || 0);
    const balanceNum = Math.max(0, totalNum - deposit);

    const metadata = {
      pkg, mainBar,
      fullName: clientName,
      phone: String(body.phone || ''),
      venue: String(body.venue || ''),
      dateISO: String(body.dateISO || ''),
      startISO: String(body.startISO || ''),
      email: String(body.email || ''), // optional; webhook will prefer checkout email
      affiliateName: String(body.affiliateName || ''),
      affiliateEmail: String(body.affiliateEmail || ''),
      pin: String(body.pin || ''),
      payMode: 'deposit',
      // totals
      deposit: String(Math.round(deposit)),
      total: String(Math.round(totalNum)),
      balance: String(Math.round(balanceNum)),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(deposit * 100),
          product_data: { name: title },
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}