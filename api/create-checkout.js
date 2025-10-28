// api/create-checkout.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const ok = (body) => ({
  statusCode: 200,
  headers: cors(),
  body: JSON.stringify({ ok: true, ...body }),
});
const bad = (msg, code = 400) => ({
  statusCode: code,
  headers: cors(),
  body: JSON.stringify({ ok: false, error: msg }),
});
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.set(cors()); return res.status(200).end();
  }
  if (req.method !== 'POST') {
    res.set(cors()); return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

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

    // Build line items (simple single line item with metadata)
    const amount = Math.round((payMode === 'full' ? total : (deposit || 0)) * 100);

    if (!amount || amount < 50) {
      return res.status(400).set(cors()).json({ ok:false, error:'Amount must be ≥ $0.50' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${process.env.PUBLIC_SUCCESS_URL || 'https://manna-affiliate.vercel.app'}/success`,
      cancel_url: `${process.env.PUBLIC_CANCEL_URL || 'https://manna-affiliate.vercel.app'}/cancel`,
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

    res.set(cors());
    return res.status(200).json({ ok:true, url:session.url });
  } catch (e) {
    res.set(cors());
    return res.status(500).json({ ok:false, error:e.message });
  }
}
