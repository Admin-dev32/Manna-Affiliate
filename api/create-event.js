// /api/create-event.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';   // returns an OAuth2-authenticated Calendar client
import { resolveAffiliate } from './_affiliates.js';

function s(v, fb = '') { return (typeof v === 'string' ? v : fb).trim(); }

function pkgLabel(v) {
  const map = {
    '50-150-5h': '50–150 (5h window)',
    '150-250-5h': '150–250 (5h window)',
    '250-350-6h': '250–350 (6h window)',
  };
  return map[v] || v || '';
}

function barLabel(v) {
  const map = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites (Corn Cups)',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  };
  return map[v] || v || 'Bar';
}

function serviceHoursFromPkg(pkg) {
  // “live” service hours (prep/clean noted in description)
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function computeEndISO(startISO, pkg) {
  const live = serviceHoursFromPkg(pkg);
  const CLEAN_HOURS = 1;
  const start = new Date(startISO);
  const end = new Date(start.getTime() + (live + CLEAN_HOURS) * 3600 * 1000);
  return end.toISOString();
}

export default async function handler(req, res) {
  // Basic allowlist CORS (plus shared helpers)
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

    // Validate affiliate by PIN
    const pin = s(body.pin);
    const aff = resolveAffiliate(pin);
    if (!aff) {
      return res.status(400).json({ ok: false, error: 'invalid_pin' });
    }

    // Required booking fields
    const startISO = s(body.startISO);
    const pkg = s(body.pkg);
    const mainBar = s(body.mainBar);
    const fullName = s(body.fullName);

    if (!startISO || !pkg || !mainBar || !fullName) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        need: { startISO: !!startISO, pkg: !!pkg, mainBar: !!mainBar, fullName: !!fullName }
      });
    }

    // Optional fields
    const venue = s(body.venue);
    const notes = s(body.notes);
    const endISO = computeEndISO(startISO, pkg);

    // Attendees (client + affiliate if email provided)
    const attendees = [];
    const clientEmail = s(body.email);
    const affiliateEmail = s(body.affiliateEmail);
    if (clientEmail) attendees.push({ email: clientEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    // Event title (no “Manager”)
    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;

    // Choose calendar id from envs (supports either name)
    const calId = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

    // OAuth calendar client (user-consent flow)
    const calendar = await getOAuthCalendar();

    // Build event body
    const event = {
      summary: title,
      location: venue || undefined,
      description: [
        `📦 Package: ${pkgLabel(pkg)}`,
        `🍫 Main bar: ${barLabel(mainBar)}`,
        body.secondEnabled ? `➕ Second bar: ${barLabel(s(body.secondBar))} (${pkgLabel(s(body.secondSize))})` : '',
        body.fountainEnabled ? `🍫 Chocolate fountain: ${s(body.fountainType)} for ${s(body.fountainSize)} guests` : '',
        notes ? `📝 Notes: ${notes}` : '',
        '',
        `⏱️ Prep: 1h before start`,
        `⏱️ Service: ${serviceHoursFromPkg(pkg)}h (+ 1h cleanup)`,
        '',
        `👤 Affiliate: ${aff.name} (PIN: ${pin})`
      ].filter(Boolean).join('\n'),
      start: { dateTime: startISO },
      end:   { dateTime: endISO },
      attendees: attendees.length ? attendees : undefined,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: true }
    };

    // Create event and send invitations if we have attendees
    const rsp = await calendar.events.insert({
      calendarId: calId,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: event
    });

    const created = rsp.data || {};
    return res.status(200).json({ ok: true, eventId: created.id || null });
  } catch (e) {
    console.error('create-event error', e);
    return res.status(500).json({ ok: false, error: 'create_event_failed', detail: e.message });
  }
}
