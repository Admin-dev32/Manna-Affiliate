// /api/create-event.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';
import { resolveAffiliate } from './_affiliates.js';

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';

const S = (v, fb = '') => (typeof v === 'string' ? v : fb).trim();

const pkgLabel = v => ({
  '50-150-5h': '50–150 (5h window)',
  '150-250-5h': '150–250 (5h window)',
  '250-350-6h': '250–350 (6h window)',
}[v] || v || '');

const barLabel = v => ({
  pancake: 'Mini Pancake',
  maruchan: 'Maruchan',
  esquites: 'Esquites (Corn Cups)',
  snack: 'Manna Snack — Classic',
  tostiloco: 'Tostiloco (Premium)',
}[v] || v || 'Bar');

function liveHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}
function computeEndISO(startISO, pkg) {
  const end = new Date(new Date(startISO).getTime() + (liveHours(pkg) + 1) * 3600 * 1000);
  return end.toISOString();
}

export default async function handler(req, res) {
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
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
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  try {
    const b = req.body || {};

    // Validate affiliate PIN
    const pin = S(b.pin);
    const aff = resolveAffiliate(pin);
    if (!aff) return res.status(400).json({ ok:false, error:'invalid_pin' });

    // Required
    const startISO = S(b.startISO);
    const pkg = S(b.pkg);
    const mainBar = S(b.mainBar);
    const fullName = S(b.fullName);
    if (!startISO || !pkg || !mainBar || !fullName) {
      return res.status(400).json({
        ok:false, error:'missing_fields',
        need:{ startISO:!!startISO, pkg:!!pkg, mainBar:!!mainBar, fullName:!!fullName }
      });
    }

    // Optional
    const venue = S(b.venue);
    const notes = S(b.notes);
    const endISO = computeEndISO(startISO, pkg);

    // Attendees (only if non-empty)
    const attendees = [];
    const clientEmail = S(b.email);
    const affiliateEmail = S(b.affiliateEmail);
    if (clientEmail) attendees.push({ email: clientEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;

    const calId = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const calendar = await getOAuthCalendar();

    const event = {
      summary: title,
      location: venue || undefined,
      description: [
        `📦 Package: ${pkgLabel(pkg)}`,
        `🍫 Main bar: ${barLabel(mainBar)}`,
        b.secondEnabled ? `➕ Second bar: ${barLabel(S(b.secondBar))} (${pkgLabel(S(b.secondSize))})` : '',
        b.fountainEnabled ? `🍫 Chocolate fountain: ${S(b.fountainType)} for ${S(b.fountainSize)} guests` : '',
        notes ? `📝 Notes: ${notes}` : '',
        '',
        `⏱️ Prep: 1h before start`,
        `⏱️ Service: ${liveHours(pkg)}h (+ 1h cleanup)`,
        '',
        `👤 Affiliate: ${aff.name} (PIN: ${pin})`
      ].filter(Boolean).join('\n'),
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ },
      attendees: attendees.length ? attendees : undefined,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: true }
    };

    const rsp = await calendar.events.insert({
      calendarId: calId,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: event
    });

    const created = rsp.data || {};
    return res.status(200).json({ ok:true, eventId: created.id || null });
  } catch (e) {
    // Bubble up real Google error when possible
    const msg = e?.response?.data?.error?.message || e?.message || String(e);
    return res.status(500).json({ ok:false, error:'create_event_failed', detail: msg });
  }
}
