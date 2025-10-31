export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { getOAuthCalendar } from '../_google.js';

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CAL_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

const HOURS_RANGE = { start: 9, end: 22 };
const MAX_PER_SLOT = 2;
const MAX_PER_DAY  = 3;

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

function opWindow(startISO, pkg){
  const PREP = 1, CLEAN = 1;
  const live = hoursFromPkg(pkg);
  const start = new Date(startISO);
  const opStart = new Date(start.getTime() - PREP * 3600_000);
  const opEnd   = new Date(start.getTime() + (live + CLEAN) * 3600_000);
  return { opStartISO: opStart.toISOString(), opEndISO: opEnd.toISOString(), live };
}
function dayRange(startISO){
  const d = new Date(startISO);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start.getTime() + 24*3600_000);
  return { dayStartISO: start.toISOString(), dayEndISO: end.toISOString() };
}
function localHour(iso, tz){
  const parts = new Intl.DateTimeFormat('en-US',{ timeZone: tz, hour:'2-digit', hour12:false })
    .formatToParts(new Date(iso));
  return Number(parts.find(p=>p.type==='hour')?.value || '0');
}
function isWithinHours(startISO, tz){
  const hh = localHour(startISO, tz);
  return (hh >= HOURS_RANGE.start && hh < HOURS_RANGE.end);
}

// Read raw body for Stripe signature verification
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

    // Hours + capacity guard (return 200 with ok:false to stop retries but deny booking)
    if (!isWithinHours(startISO, TZ)) {
      return res.status(200).json({ ok:false, error:'outside_business_hours' });
    }

    const { opStartISO, opEndISO, live } = opWindow(startISO, pkg);
    const { calendar } = await getOAuthCalendar();

    const { dayStartISO, dayEndISO } = dayRange(startISO);
    const dayList = await calendar.events.list({
      calendarId: CAL_ID, timeMin: dayStartISO, timeMax: dayEndISO,
      singleEvents: true, orderBy: 'startTime'
    });
    const dayCount = (dayList.data.items || []).filter(e => e.status !== 'cancelled').length;
    if (dayCount >= MAX_PER_DAY){
      return res.status(200).json({ ok:false, error:'capacity_day_limit' });
    }

    const overlapList = await calendar.events.list({
      calendarId: CAL_ID, timeMin: opStartISO, timeMax: opEndISO,
      singleEvents: true, orderBy: 'startTime'
    });
    const overlapping = (overlapList.data.items || []).filter(ev=>{
      if (ev.status === 'cancelled') return false;
      const evStart = ev.start?.dateTime || ev.start?.date;
      const evEnd   = ev.end?.dateTime   || ev.end?.date;
      if (!evStart || !evEnd) return false;
      return !(new Date(evEnd) <= new Date(opStartISO) || new Date(evStart) >= new Date(opEndISO));
    }).length;
    if (overlapping >= MAX_PER_SLOT){
      return res.status(200).json({ ok:false, error:'capacity_overlap_limit' });
    }

    // Build pretty description with totals
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
      `   • Service: ${live}h`,
      `   • Clean up: +1h after`,
      '',
      affiliateName ? `🤝 Affiliate: ${affiliateName}` : ''
    ].filter(Boolean).join('\n');

    // Idempotency via session.id
    const sessionId = safeStr(session.id);
    if (sessionId) {
      const day = new Date(startISO);
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0).toISOString();
      const dayEnd   = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59).toISOString();

      const existing = await calendar.events.list({
        calendarId: CAL_ID,
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

    // Block the full operational window
    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;
    const eventBody = {
      summary: title,
      location: venue || undefined,
      description: desc,
      start: { dateTime: opStartISO },
      end:   { dateTime: opEndISO },
      attendees: (() => {
        const list = [];
        const checkoutEmail = safeStr(session.customer_details?.email);
        if (checkoutEmail) list.push({ email: checkoutEmail });
        if (affiliateEmail) list.push({ email: affiliateEmail });
        return list.length ? list : undefined;
      })(),
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: true },
      extendedProperties: { private: { sessionId: sessionId || '' } }
    };

    const resp = await calendar.events.insert({
      calendarId: CAL_ID,
      sendUpdates: eventBody.attendees ? 'all' : 'none',
      requestBody: eventBody
    });

    return res.status(200).json({ ok: true, created: resp.data?.id || null });
  } catch (err) {
    console.error('webhook create-event error:', err?.response?.data || err);
    // 200 so Stripe doesn't retry forever; we include ok:false for your logs
    return res.status(200).json({ ok: false, error: 'create_event_failed', detail: String(err?.message || err) });
  }
}