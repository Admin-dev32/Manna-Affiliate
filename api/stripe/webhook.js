// /api/stripe/webhook.js
export const config = { runtime: 'nodejs' }; // Vercel serverless

import Stripe from 'stripe';

// Read raw body (no extra deps)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  // --- ENV guardrails ---
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return res.status(500).json({ ok: false, error: 'missing_stripe_env' });
  }

  const stripe = new Stripe(secretKey, { apiVersion: '2025-09-30.clover' /* matches your screenshot */ });

  // Stripe needs the raw body to validate the signature
  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { return res.status(400).json({ ok: false, error: 'raw_body_read_failed', detail: String(e?.message || e) }); }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'signature_verification_failed', detail: err.message });
  }

  // Handle events
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Metadata que mandamos desde create-checkout
        let meta = {};
        if (session?.metadata) {
          try { meta = JSON.parse(session.metadata.payload || '{}'); }
          catch { meta = session.metadata; }
        }

        // Sólo creamos evento si el checkout fue “paid” (modo live/test)
        if (session.payment_status === 'paid') {
          // Llamamos a nuestro helper para crear el evento en Google
          const resp = await fetch(`${process.env.PUBLIC_URL || 'https://manna-affiliate.vercel.app'}/api/create-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // create-event.js debe aceptar el mismo payload que create-booking,
            // pero **SIN** cobrar nada; sólo crear el evento de calendario.
            body: JSON.stringify({
              // Datos esenciales guardados en metadata en create-checkout
              pin: meta.pin,
              affiliateName: meta.affiliateName,
              affiliateEmail: meta.affiliateEmail,
              fullName: meta.fullName,
              email: meta.email,
              phone: meta.phone,
              venue: meta.venue,
              pkg: meta.pkg,
              mainBar: meta.mainBar,
              secondEnabled: meta.secondEnabled === 'true' || meta.secondEnabled === true,
              secondBar: meta.secondBar,
              secondSize: meta.secondSize,
              fountainEnabled: meta.fountainEnabled === 'true' || meta.fountainEnabled === true,
              fountainSize: meta.fountainSize,
              fountainType: meta.fountainType,
              dateISO: meta.dateISO,
              startISO: meta.startISO, // slot ISO
              notes: meta.notes || `Stripe ${session.id}`,
              // Totales informativos
              total: Number(meta.total || 0),
              deposit: Number(meta.deposit || 0),
              balance: Number(meta.balance || 0),
              // Pide que agreguemos invitados si hay email
              addGuests: true
            })
          });

          const j = await resp.json().catch(() => ({}));
          if (!resp.ok || !j.ok) {
            // Log para diagnosticar en Stripe logs
            console.error('create-event failed', resp.status, j);
            return res.status(500).json({ ok: false, error: 'create_event_failed', detail: j?.error || `HTTP ${resp.status}` });
          }
        }

        break;
      }

      default:
        // No-op for other events
        break;
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook handler error', e);
    return res.status(500).json({ ok: false, error: 'handler_exception', detail: String(e?.message || e) });
  }
}
