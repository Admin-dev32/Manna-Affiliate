// /api/stripe/webhook.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';

function readRawBody(req){
  return new Promise((resolve, reject)=>{
    const chunks=[];
    req.on('data', c=>chunks.push(Buffer.from(c)));
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'method_not_allowed' });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return res.status(500).json({ ok:false, error:'missing_stripe_env' });

  const stripe = new Stripe(secretKey, { apiVersion: '2025-09-30.clover' });

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { return res.status(400).json({ ok:false, error:'raw_body_failed', detail:String(e) }); }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (e) {
    return res.status(400).json({ ok:false, error:'signature_verification_failed', detail:e.message });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // ✅ Prefer flat metadata; only parse payload if present
      let meta = session?.metadata || {};
      if (meta && typeof meta.payload === 'string' && meta.payload.trim()) {
        try { meta = JSON.parse(meta.payload); } catch { /* keep flat */ }
      }

      if (session.payment_status === 'paid') {
        const resp = await fetch(`${process.env.PUBLIC_URL || 'https://manna-affiliate.vercel.app'}/api/create-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // essentials
            pin: meta.pin || '',
            affiliateName: meta.affiliateName || '',
            affiliateEmail: meta.affiliateEmail || '',
            fullName: meta.fullName || '',
            email: meta.email || '',
            phone: meta.phone || '',
            venue: meta.venue || '',
            pkg: meta.pkg || '',
            mainBar: meta.mainBar || '',
            secondEnabled: meta.secondEnabled === 'true' || meta.secondEnabled === true,
            secondBar: meta.secondBar || '',
            secondSize: meta.secondSize || '',
            fountainEnabled: meta.fountainEnabled === 'true' || meta.fountainEnabled === true,
            fountainSize: meta.fountainSize || '',
            fountainType: meta.fountainType || '',
            dateISO: meta.dateISO || '',
            startISO: meta.startISO || '',
            notes: (meta.notes || `Stripe ${session.id}`),
            total: Number(meta.total || 0),
            deposit: Number(meta.deposit || 0),
            balance: Number(meta.balance || 0),
            addGuests: true
          })
        });

        // Better error surface back to Stripe logs
        const text = await resp.text();
        if (!resp.ok) {
          console.error('create-event failed', resp.status, text);
          return res.status(500).json({ ok:false, error:'create_event_failed', detail:`HTTP ${resp.status}`, body:text });
        }
      }
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('webhook handler error', e);
    return res.status(500).json({ ok:false, error:'handler_exception', detail:String(e?.message || e) });
  }
}
