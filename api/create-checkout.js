// api/create-checkout.js
import Stripe from 'stripe';
import { sendJSON, handleOptions } from './_utils/cors';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') return sendJSON(res, 405, { ok:false, error:'Method not allowed' });

  try {
    const data = req.body || {};
    const {
      fullName, email, phone, venue,
      pkg, mainBar, secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      discountMode, discountValue, payMode,
      total, deposit, balance,
      startISO, pin, notes,
    } = data;

    const amount = Math.round(((payMode === 'full' ? total : (deposit || 0)) || 0) * 100);
    if (!amount || amount < 50) return sendJSON(res, 400, { ok:false, error:'Amount must be ≥ $0.50' });

    const successURL = process.env.PUBLIC_SUCCESS_URL || 'https://manna-affiliate.vercel.app/success';
    const cancelURL  = process.env.PUBLIC_CANCEL_URL  || 'https://manna-affiliate.vercel.app/cancel';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successURL,
      cancel_url: cancelURL,
      customer_email: email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: `Manna booking — ${pkg} — ${mainBar}`,
            description: `Affiliate PIN ${pin || '-'} | ${new Date(startISO).toLocaleString()}`,
          },
        },
      }],
      metadata: {
        fullName, email, phone, venue,
        pkg, mainBar, secondEnabled, secondBar, secondSize,
        fountainEnabled, fountainSize, fountainType,
        discountMode, discountValue, payMode,
        total, deposit, balance,
        startISO, pin, notes,
        source: 'affiliate',
      },
    });

    return sendJSON(res, 200, { ok:true, url:session.url });
  } catch (e) {
    return sendJSON(res, 500, { ok:false, error:e.message });
  }
}
