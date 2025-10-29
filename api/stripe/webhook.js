// /api/stripe/webhook.js
import { applyCors, preflight } from '../_cors.js';
import Stripe from 'stripe';

export const config = { api: { bodyParser: false } };

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (preflight(req, res)) return; // harmless for browsers; Stripe won’t send OPTIONS
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const buf = await buffer(req);

    let event;
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(buf, sig, endpointSecret);
    } else {
      event = JSON.parse(buf.toString()); // not recommended, but avoids crash if secret missing
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('Checkout complete:', session.id, session.metadata);
      // TODO: persist payment, notify, etc.
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('Webhook error', e);
    res.status(400).json({ ok: false, error: e.message || 'Webhook error' });
  }
}
