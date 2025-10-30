// /api/create-event.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';
import { resolveAffiliate } from './_affiliates.js';

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CAL_ID = process.env.CALENDAR_ID || 'primary';

const s = (v, fb = '') => (typeof v === 'string' ? v : fb).trim();

function pkgLabel(v) {
  const m = {
    '50-150-5h': '50–150 (5h window)',
    '150-250-5h': '150–250 (5h window)',
    '250-350-6h': '250–350 (6h window)',
  };
  return m[v] || v || '';
}
function barLabel(v) {
  const m = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites (Corn Cups)',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  };
  return m[v] || v || 'Bar';
}
function serviceHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}
function endFrom(startISO, pkg) {
  const live = serviceHours(pkg);
  const CLEAN = 1;
  const start = new Date(startISO);
  const end = new Date(start.getTime() + (live + CLEAN) * 3600 * 1000);
  return end.toISOString();
}

export default async function handler(req, res) {
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const body = req.body || {};
    const pin = s(body.pin);
    const aff = resolveAffiliate(pin);
    if (!aff) return res.status(400).json({ ok: false, error: 'invalid_pin' });

    const startISO     = s(body.startISO);
    const pkg          = s(body.pkg);
    const mainBar      = s(body.mainBar);
    const fullName     = s(body.fullName);
    const venue        = s(body.venue);
    const notes        = s(body.notes);

    if (!startISO || !pkg || !mainBar || !fullName) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const endISO = endFrom(startISO, pkg);

    // attendees (client + affiliate if provided)
    const attendees = [];
    const clientEmail    = s(body.email);
    const affiliateEmail = s(body.affiliateEmail);
    if (clientEmail) attendees.push({ email: clientEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;

    const calendar = await getOAuthCalendar();

    const event = {
      summary: title,
      location: venue || undefined,
      description: [
        `📦 Package: ${pkgLabel(pkg)}`,
        `🍫 Main bar: ${barLabel(mainBar)}`,
        body.secondEnabled ? `➕ Second bar: ${barLabel(s(body.secondBar))} (${pkgLabel(s(body.secondSize))})` : '',
        body.fountainEnabled ? `🍫 Chocolate fountain: ${s(body.fountainType)} for ${s(body.fountainSize)} ppl` : '',
        notes ? `📝 Notes: ${notes}` : '',
        '',
        `⏱️ Prep: 1h before start`,
        `⏱️ Service: ${serviceHours(pkg)}h (+ 1h cleanup)`,
        '',
        `👤 Affiliate: ${aff.name} (PIN: ${pin})`,
      ].filter(Boolean).join('\n'),
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ },
      attendees: attendees.length ? attendees : undefined,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: true },
    };

    const rsp = await calendar.events.insert({
      calendarId: CAL_ID,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: event,
    });

    return res.status(200).json({ ok: true, eventId: rsp.data?.id || null });
  } catch (e) {
    // Surface the real Google error in the response so Stripe shows it
    const detail = e?.response?.data || e?.message || String(e);
    console.error('[create-event] error', detail);
    return res.status(500).json({ ok: false, error: 'create_event_failed', detail });
  }
}
