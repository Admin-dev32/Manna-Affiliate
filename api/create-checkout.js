// /api/create-checkout.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { applyCors, handlePreflight } from './_cors.js';

function bad(res, msg, extra = {}) {
  return res.status(400).json({ ok: false, error: msg, ...extra });
}

export default async function handler(req, res) {
  // CORS
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const {
      fullName, email, phone, venue,
      dateISO, startISO, // we use startISO as the actual start time
      pkg, mainBar,
      secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      discountMode, discountValue,
      payMode, deposit, total, balance,
      affiliateName, affiliateEmail, pin, notes
    } = req.body || {};

    // Basic validation
    if (!pin) return bad(res, 'missing_pin');
    if (!startISO) return bad(res, 'missing_startISO');
    if (!pkg) return bad(res, 'missing_pkg');
    if (typeof total !== 'number') return bad(res, 'missing_total_number');
    if (typeof balance !== 'number') return bad(res, 'missing_balance_number');

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return bad(res, 'missing_STRIPE_SECRET_KEY');

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

    // Decide what the customer will pay on Checkout
    // - If payMode === 'full', charge `total - 20` (your $20 flat off)
    // - Else charge `deposit` (if provided), otherwise default to $50 deposit
    let amountToCharge = 0;
    if (payMode === 'full') {
      amountToCharge = Math.max(0, Math.round((total - 20) * 100));
    } else {
      const dep = (typeof deposit === 'number' && deposit > 0) ? deposit : 50;
      amountToCharge = Math.max(0, Math.round(dep * 100));
    }
    if (!amountToCharge) return bad(res, 'invalid_amount');

    // Line item title (show enough info for you + the client)
    const title = `Manna Snack Bars — ${mainBar || 'Package'} (${pkg})`;
    const whenLabel = new Date(startISO).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Los_Angeles' });

    // Build metadata so the webhook can create the calendar event reliably
    const metadata = {
      fullName: String(fullName || ''),
      email: String(email || ''),
      phone: String(phone || ''),
      venue: String(venue || ''),
      dateISO: String(dateISO || startISO.slice(0, 10)),
      startISO: String(startISO),
      pkg: String(pkg || ''),
      mainBar: String(mainBar || ''),
      secondEnabled: String(!!secondEnabled),
      secondBar: String(secondBar || ''),
      secondSize: String(secondSize || ''),
      fountainEnabled: String(!!fountainEnabled),
      fountainSize: String(fountainSize || ''),
      fountainType: String(fountainType || ''),
      discountMode: String(discountMode || 'none'),
      discountValue: String(discountValue ?? ''),
      payMode: String(payMode || 'deposit'),
      total: String(total),
      deposit: String(deposit ?? ''),
      balance: String(balance),
      affiliateName: String(affiliateName || ''),
      affiliateEmail: String(affiliateEmail || ''),
      pin: String(pin || ''),
      notes: String(notes || ''),
      // marker for your webhook
      manna_checkout: '1'
    };

    // Success/Cancel URLs (open outside iframe)
    const successUrl = process.env.CHECKOUT_SUCCESS_URL || 'https://mannasnackbars.com/thankyou';
    const cancelUrl  = process.env.CHECKOUT_CANCEL_URL  || 'https://mannasnackbars.com/';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountToCharge,
            product_data: {
              name: title,
              description: `Event: ${whenLabel} — ${venue || 'TBD'}`
            }
          },
          quantity: 1
        }
      ],
      customer_email: email || undefined,
      metadata,
      success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl,
    });

    // return JSON with url for the client to redirect (window.top.location.assign)
    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    console.error('create-checkout error', e);
    // Ensure we ALWAYS return JSON so the frontend .json() doesn’t explode
    return res.status(500).json({ ok: false, error: 'create_checkout_failed', detail: e.message });
  }
}
