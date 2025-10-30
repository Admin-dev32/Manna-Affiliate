// /api/stripe/webhook.js
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

function computeEndISO(startISO, pkg) {
  const live = hoursFromPkg(pkg);
  const CLEAN_HOURS = 1;
  const start = new Date(startISO);
  const end = new Date(start.getTime() + (live + CLEAN_HOURS) * 3600 * 1000);
  return end.toISOString();
}
function opWindow(startISO, pkg){
  const PREP = 1, CLEAN = 1;
  const live = hoursFromPkg(pkg);
  const start = new Date(startISO);
  const opStart = new Date(start.getTime() - PREP * 3600_000);
  const opEnd   = new Date(start.getTime() + (live + CLEAN) * 3600_000);
  return { opStartISO: opStart.toISOString(), opEndISO: opEnd.toISOString() };
}
function dayRange(startISO){
  const d = new Date(startISO);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start.getTime() + 24*3600_000);
  return { dayStartISO: start.toISOString(), dayEndISO: end.toISOString() };
}
function localHour(iso, tz){
  const dt = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US',{
    timeZone: tz, hour:'2-digit', hour12:false
  }).formatToParts(dt);
  const hh = Number(parts.find(p=>p.type==='hour')?.value || '0');
  return hh;
}
function assertWithinHours(startISO, tz){
  const hh = localHour(startISO, tz);
  if (hh < HOURS_RANGE.start || hh > HOURS_RANGE.end){
    const e = new Error(`outside_business_hours: ${hh}:00 not in ${HOURS_RANGE.start}:00–${HOURS_RANGE.end}:00 ${tz}`);
    e.status = 409; throw e;
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error('Missing Stripe secrets.');
    res.status(500).send('Server misconfigured');
    return;
  }

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
      console.error('Missing required booking fields in metadata:', md);
      return res.status(200).json({ ok: true, skipped: 'missing_metadata' });
    }

    // ✅ Enforce 9:00–22:00 local
    assertWithinHours(startISO, TZ);

    const { opStartISO, opEndISO } = opWindow(startISO, pkg);
    const { calendar } = await getOAuthCalendar();

    // Idempotency by sessionId (same-day)
    const sessionId = safeStr(session.id);
    if (sessionId) {
      const { dayStartISO, dayEndISO } = dayRange(startISO);
      const existing = await calendar.events.list({
        calendarId: CAL_ID,
        timeMin: dayStartISO,
        timeMax: dayEndISO,
        singleEvents: true,
        orderBy: 'startTime',
        privateExtendedProperty: `sessionId=${sessionId}`
      });
      if ((existing.data.items || []).length > 0) {
        return res.status(200).json({ ok: true, already: true });
      }
    }

    // 1) Max 3 events/day
    const { dayStartISO, dayEndISO } = dayRange(startISO);
    const dayList = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const dayCount = (dayList.data.items || []).filter(e => e.status !== 'cancelled').length;
    if (dayCount >= MAX_PER_DAY){
      // Return 200 so Stripe won’t retry; include reason
      return res.status(200).json({ ok:false, error:'capacity_day_limit' });
    }

    // 2) Max 2 overlapping within op window
    const overlapList = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: opStartISO,
      timeMax: opEndISO,
      singleEvents: true,
      orderBy: 'startTime'
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

    const attendees = [];
    const checkoutEmail = safeStr(session.customer_details?.email);
    if (checkoutEmail) attendees.push({ email: checkoutEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    const endISO = computeEndISO(startISO, pkg);
    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;
    const description = [
      `📦 Package: ${pkgLabel(pkg)}`,
      `🍫 Main bar: ${barLabel(mainBar)}`,
      venue ? `📍 Venue: ${venue}` : '',
      '',
      `⏱️ Prep: 1h before start`,
      `⏱️ Service: ${hoursFromPkg(pkg)}h (+ 1h cleaning)`,
      affiliateName ? `👤 Affiliate: ${affiliateName}` : '',
    ].filter(Boolean).join('\n');

    const resp = await calendar.events.insert({
      calendarId: CAL_ID,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: {
        summary: title,
        location: venue || undefined,
        description,
        start: { dateTime: startISO, timeZone: TZ },
        end:   { dateTime: endISO,   timeZone: TZ },
        attendees: attendees.length ? attendees : undefined,
        guestsCanSeeOtherGuests: true,
        reminders: { useDefault: true },
        extendedProperties: { private: { sessionId } }
      }
    });

    return res.status(200).json({ ok: true, created: resp.data?.id || null });
  } catch (err) {
    console.error('webhook create-event error:', err?.response?.data || err);
    // 200 so Stripe doesn’t retry forever; include reason for logs
    return res.status(200).json({ ok: false, error: 'create_event_failed', detail: String(err?.message || err) });
  }
}
