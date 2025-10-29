// /api/create-checkout.js
import { applyCors, preflight } from './_cors.js';
import { resolveAffiliate } from './_affiliates.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};
    const { pin, total, deposit, payMode, affiliateName } = payload;

    const aff = resolveAffiliate(pin);
    if (!aff) return res.status(401).json({ ok: false, error: 'Invalid PIN' });

    const amountNow = Math.round(Number(deposit || 0) * 100);
    if (!amountNow || amountNow < 50) {
      return res.status(400).json({ ok: false, error: 'Deposit/amount due is too low or missing.' });
    }

    const successBase = process.env.SUCCESS_URL || 'https://manna-affiliate.vercel.app';
    const cancelBase = process.env.CANCEL_URL || 'https://manna-affiliate.vercel.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: payMode === 'full' ? 'Manna — Pay in full' : 'Manna — Deposit',
            description: `Affiliate: ${affiliateName || aff.name} (${aff.id})`
          },
          unit_amount: amountNow
        },
        quantity: 1
      }],
      success_url: `${successBase}/success`,
      cancel_url: `${cancelBase}/cancel`,
      metadata: {
        pin: String(pin),
        affiliateId: aff.id,
        affiliateName: affiliateName || aff.name,
        total: String(total || ''),
        payMode: String(payMode || 'deposit')
      }
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Checkout error' });
  }
}
