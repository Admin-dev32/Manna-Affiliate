// /api/stripe/webhook.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { getOAuthCalendar } from '../_google.js';

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}
function barLabel(v) {
  const map = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites (Corn Cups)',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  };
  return map[v] || v || 'Service';
}
function pkgLabel(v) {
  const map = {
    '50-150-5h': '50–150 (5h window)',
    '150-250-5h': '150–250 (5h window)',
    '250-350-6h': '250–350 (6h window)',
  };
  return map[v] || v || '';
}
function safeStr(v, fb = '') { return (typeof v === 'string' ? v : fb).trim(); }

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const stripeSecret  = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) { res.status(500).send('Server misconfigured'); return; }

  const stripe = new Stripe(stripeSecret, { apiVersion: '2022-11-15' });

  let event;
  try {
    const buf = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err?.message || err);
    res.status(400).send(`Webhook Error: ${err.message || 'invalid signature'}`);
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ ok: true, ignored: event.type });
    return;
  }

  try {
    const session = event.data.object;
    if (session.payment_status !== 'paid') {
      return res.status(200).json({ ok: true, skipped: 'not_paid' });
    }

    const md = session.metadata || {};
    const pkg = safeStr(md.pkg);
    const mainBar = safeStr(md.mainBar);
    const fullName = safeStr(md.fullName || session.customer_details?.name || 'Client');
    const venue = safeStr(md.venue);
    const startISO = safeStr(md.startISO);
    const affiliateEmail = safeStr(md.affiliateEmail);
    const affiliateName  = safeStr(md.affiliateName);

    if (!startISO || !pkg || !mainBar || !fullName) {
      console.error('Missing required fields in metadata:', md);
      return res.status(200).json({ ok: true, skipped: 'missing_metadata' });
    }

    // --- Build pretty description with totals
    const depositPaid = Number(md.deposit || Math.round((session.amount_total || 0) / 100));
    const totalAll    = Number(md.total   || 0);
    const balanceDue  = Number(md.balance || Math.max(0, totalAll - depositPaid));

    const desc = [
      `👤 Client: ${fullName}`,
      session.customer_details?.email ? `✉️ Email: ${session.customer_details.email}` : '',
      venue ? `📍 Venue: ${venue}` : '',
      '',
      `🍫 Main bar: ${barLabel(mainBar)} — ${pkgLabel(pkg)}`,
      '',
      '💰 Totals:',
      `   • Total: $${totalAll ? totalAll.toFixed(0) : '—'}`,
      `   • Deposit: $${depositPaid.toFixed(0)} (paid)`,
      `   • Balance: $${balanceDue ? balanceDue.toFixed(0) : '—'}`,
      '',
      '⏱️ Timing:',
      `   • Prep: 1h before start`,
      `   • Service: ${hoursFromPkg(pkg)}h`,
      `   • Clean up: +1h after`,
      '',
      affiliateName ? `🤝 Affiliate: ${affiliateName}` : ''
    ].filter(Boolean).join('\n');

    const end = new Date(new Date(startISO).getTime() + (hoursFromPkg(pkg) * 3600 * 1000)).toISOString();

    // Attendees
    const attendees = [];
    const checkoutEmail = safeStr(session.customer_details?.email);
    if (checkoutEmail) attendees.push({ email: checkoutEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const { calendar } = await getOAuthCalendar();

    // Idempotency via session.id stored in private extended properties
    const sessionId = safeStr(session.id);
    if (sessionId) {
      const day = new Date(startISO);
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0).toISOString();
      const dayEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59).toISOString();

      const existing = await calendar.events.list({
        calendarId,
        timeMin: dayStart,
        timeMax: dayEnd,
        singleEvents: true,
        orderBy: 'startTime',
        privateExtendedProperty: `sessionId=${sessionId}`
      });
      if ((existing.data.items || []).length > 0) {
        return res.status(200).json({ ok: true, already: true });
      }
    }

    const eventBody = {
      summary: title,
      location: venue || undefined,
      description: desc,
      start: { dateTime: startISO },
      end:   { dateTime: end },
      attendees: attendees.length ? attendees : undefined,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: true },
      extendedProperties: { private: { sessionId: sessionId || '' } }
    };

    const resp = await calendar.events.insert({
      calendarId,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: eventBody
    });

    return res.status(200).json({ ok: true, created: resp.data?.id || null });
  } catch (err) {
    console.error('webhook create-event error:', err?.response?.data || err);
    return res.status(200).json({ ok: false, error: 'create_event_failed', detail: String(err?.message || err) });
  }
}