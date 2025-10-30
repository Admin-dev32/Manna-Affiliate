// /api/stripe/webhook.js
export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false }, // IMPORTANT: raw body for Stripe signature
};

import { createCalendarEvent } from '../create-event.js';

// Lazy Stripe init
const stripe = (() => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
  // eslint-disable-next-line global-require
  return require('stripe')(key, { apiVersion: '2023-10-16' });
})();

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Read raw body without extra deps
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  if (!endpointSecret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).send('Server misconfigured');
  }

  let event;
  try {
    const buf = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, endpointSecret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Metadata set by /api/create-checkout
      const m = session.metadata || {};
      const payload = {
        fullName: m.fullName || '',
        email: m.email || '',
        phone: m.phone || '',
        venue: m.venue || '',
        startISO: m.startISO || '',
        pkg: m.pkg || '',
        mainBar: m.mainBar || '',
        secondEnabled: m.secondEnabled === 'true',
        secondBar: m.secondBar || '',
        secondSize: m.secondSize || '',
        fountainEnabled: m.fountainEnabled === 'true',
        fountainSize: m.fountainSize || '',
        fountainType: m.fountainType || '',
        notes: m.notes || '',
        total: Number(m.total || 0),
        deposit: Number(m.deposit || 0),
        balance: Number(m.balance || 0),
        payMode: m.payMode || 'deposit',
        affiliateName: m.affName || '',
        affiliateEmail: m.affEmail || '',
        noDeposit: false, // paid via Stripe
      };

      try {
        const ev = await createCalendarEvent(payload);
        console.log('✅ Calendar event created from webhook:', ev?.id);
      } catch (e) {
        console.error('❌ Failed to create calendar event from webhook:', e);
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error', e);
    return res.status(500).json({ ok: false });
  }
}
