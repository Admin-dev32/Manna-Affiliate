// api/webhook.js
import { buffer } from 'micro';
import Stripe from 'stripe';
import { corsHeaders, handleOptions } from './_utils/cors';

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

export default async function handler(req, res) {
  if (handleOptions(req, res)) return; // harmless

  if (req.method !== 'POST') {
    const h = corsHeaders('*'); Object.entries(h).forEach(([k,v])=>res.setHeader(k,v));
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET_MGMT || process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const h = corsHeaders('*'); Object.entries(h).forEach(([k,v])=>res.setHeader(k,v));
    return res.status(400).json({ ok:false, error:`Webhook Error: ${err.message}` });
  }

  // Handle events (example: checkout.session.completed)
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Read metadata you set in create-checkout
      const md = session.metadata || {};
      // Create Google Calendar event after successful payment
      // await createEventFromMetadata(md); // call your existing logic

      const h = corsHeaders('*'); Object.entries(h).forEach(([k,v])=>res.setHeader(k,v));
      return res.status(200).json({ ok:true, received:true });
    }

    const h = corsHeaders('*'); Object.entries(h).forEach(([k,v])=>res.setHeader(k,v));
    return res.status(200).json({ ok:true, ignored:true, type:event.type });
  } catch (e) {
    const h = corsHeaders('*'); Object.entries(h).forEach(([k,v])=>res.setHeader(k,v));
    return res.status(500).json({ ok:false, error:e.message });
  }
}
