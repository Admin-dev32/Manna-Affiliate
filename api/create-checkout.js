// /api/create-checkout.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';

const stripe = (() => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
  // eslint-disable-next-line global-require
  return require('stripe')(key, { apiVersion: '2023-10-16' });
})();

function moneyToCents(n) { return Math.round((Number(n) || 0) * 100); }

// keep metadata small (500 chars limit). We only keep essentials here.
function packMeta(data) {
  const keep = {
    fullName: data.fullName || '',
    email: data.email || '',
    phone: data.phone || '',
    venue: data.venue || '',
    startISO: data.startISO || '',
    pkg: data.pkg || '',
    mainBar: data.mainBar || '',
    secondEnabled: !!data.secondEnabled,
    secondBar: data.secondBar || '',
    secondSize: data.secondSize || '',
    fountainEnabled: !!data.fountainEnabled,
    fountainSize: data.fountainSize || '',
    fountainType: data.fountainType || '',
    notes: (data.notes || '').slice(0, 200), // trim
    total: String(data.total || 0),
    deposit: String(data.deposit || 0),
    balance: String(data.balance || 0),
    payMode: data.payMode || 'deposit',
    affName: data.affiliateName || '',
    affEmail: data.affiliateEmail || '',
  };
  // flatten to metadata key/values
  return Object.fromEntries(Object.entries(keep).map(([k,v])=>[k, String(v)]));
}

export default async function handler(req, res) {
  try {
    if (preflight(req, res)) return;
    applyCors(res);

    if (req.method !== 'POST') {
      return res.status(405).json({ ok:false, error: 'Method not allowed' });
    }

    const data = req.body || {};
    if (!data.startISO) {
      return res.status(400).json({ ok:false, error: 'Missing startISO (select a slot)' });
    }
    if (!data.fullName) {
      return res.status(400).json({ ok:false, error: 'Missing client name' });
    }

    // amount: deposit vs full (-$20 already handled client-side)
    const amount = data.payMode === 'full' ? Number(data.total||0) : Number(data.deposit||0);
    if (amount <= 0) {
      return res.status(400).json({ ok:false, error: 'Amount must be greater than 0' });
    }

    const site = process.env.PUBLIC_URL || 'https://mannasnackbars.com';
    const success = `${site.replace(/\/$/,'')}/thankyou?sid={CHECKOUT_SESSION_ID}`;
    const cancel  = `${site.replace(/\/$/,'')}/affiliated-booking`;

    const description = `Manna Snack Bars — ${data.mainBar || 'Package'} — ${data.fullName}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: data.payMode === 'full' ? 'Full payment' : 'Booking deposit',
            description,
          },
          unit_amount: moneyToCents(amount),
        },
        quantity: 1,
      }],
      success_url: success,
      cancel_url: cancel,
      client_reference_id: `${Date.now()}-${Math.random().toString(16).slice(2,8)}`,
      customer_email: (data.email || undefined),
      metadata: packMeta(data),
    });

    return res.status(200).json({ ok:true, url: session.url });
  } catch (e) {
    console.error('create-checkout error', e);
    return res.status(500).json({ ok:false, error: e.message || 'create_checkout_failed' });
  }
}
