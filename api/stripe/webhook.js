// /api/stripe/webhook.js
export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false }, // needed to verify Stripe signature
};

import Stripe from 'stripe';
import getRawBody from 'raw-body';

function json(res, code, obj) {
  res.status(code).json(obj);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    return json(res, 500, { ok: false, error: 'missing_stripe_env' });
  }

  const stripe = new Stripe(stripeSecret, { apiVersion: '2022-11-15' });

  let event;
  try {
    const raw = await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error('stripe webhook verify failed:', err?.message || err);
    return json(res, 400, { ok: false, error: 'invalid_signature' });
  }

  // We only handle completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return json(res, 200, { ok: true, ignored: event.type });
  }

  try {
    const session = event.data?.object || {};
    const md = session.metadata || {};

    // Required for /api/create-event.js
    const payload = {
      // required
      startISO: String(md.startISO || ''),
      pkg: String(md.pkg || ''),
      mainBar: String(md.mainBar || ''),
      fullName: String(md.fullName || ''),
      // optional
      email: String(md.email || ''),
      phone: String(md.phone || ''),
      venue: String(md.venue || ''),
      dateISO: String(md.dateISO || ''),
      affiliateName: String(md.affiliateName || ''),
      affiliateEmail: String(md.affiliateEmail || ''),
      pin: String(md.pin || ''),
      // flags (optional)
      secondEnabled: md.secondEnabled === 'true',
      secondBar: String(md.secondBar || ''),
      secondSize: String(md.secondSize || ''),
      fountainEnabled: md.fountainEnabled === 'true',
      fountainSize: String(md.fountainSize || ''),
      fountainType: String(md.fountainType || ''),
      notes: String(md.notes || ''),
    };

    // Validate required fields (this is what caused the 400 before)
    const missing = [];
    if (!payload.startISO) missing.push('startISO');
    if (!payload.pkg) missing.push('pkg');
    if (!payload.mainBar) missing.push('mainBar');
    if (!payload.fullName) missing.push('fullName');

    if (missing.length) {
      console.error('create-event missing fields:', missing);
      return json(res, 400, {
        ok: false,
        error: 'missing_fields',
        missing,
      });
    }

    const BASE =
      process.env.PUBLIC_URL ||
      'https://manna-affiliate.vercel.app';

    // Call your own API to reuse the calendar-creation logic
    const rsp = await fetch(`${BASE}/api/create-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const j = await rsp.json().catch(() => ({}));
    if (!rsp.ok || !j.ok) {
      console.error('create-event failed from webhook:', rsp.status, j);
      return json(res, 500, {
        ok: false,
        error: 'create_event_failed',
        detail: `HTTP ${rsp.status}`,
        body: j?.error || j,
      });
    }

    return json(res, 200, { ok: true, createdEventId: j.eventId || null });
  } catch (e) {
    console.error('webhook handler error:', e);
    return json(res, 500, { ok: false, error: 'server_error' });
  }
}
