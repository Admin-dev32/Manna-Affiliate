// /api/create-booking.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getCalendarForCreate, toRFC3339, tz, calId } from './_google.js';

function nameForBar(code) {
  switch (code) {
    case 'pancake': return 'Mini Pancake';
    case 'maruchan': return 'Maruchan';
    case 'esquites': return 'Esquites (Corn Cups)';
    case 'snack': return 'Manna Snack — Classic';
    case 'tostiloco': return 'Tostiloco (Premium)';
    default: return code || 'Bar';
  }
}

function titleForEvent(data) {
  const pkg = data.pkg || '';
  const who = (data.fullName || 'Client').trim();
  const main = nameForBar(data.mainBar);
  return `Manna Snack Bars — ${pkg.replaceAll('-', '–')} — ${who} (${main}${data.noDeposit ? ', No deposit' : ''})`;
}

function descriptionForEvent(data) {
  const lines = [
    `Client: ${data.fullName || '—'}`,
    `Email: ${data.email || '(none)'}`,
    `Phone: ${data.phone || '(none)'}`,
    `Venue: ${data.venue || '(none)'}`,
    `Package: ${data.pkg || '—'}${data.mainBar ? ` (${nameForBar(data.mainBar)})` : ''}`,
  ];

  if (data.secondEnabled && data.secondBar) {
    lines.push(`Second bar: ${nameForBar(data.secondBar)} — ${data.secondSize || ''}`);
  }
  if (data.fountainEnabled && data.fountainSize) {
    lines.push(`Chocolate fountain: ${data.fountainSize} (${data.fountainType || 'dark'})`);
  }

  lines.push(
    `Totals: total $${(data.total ?? 0)} — deposit $${(data.deposit ?? 0)} — balance $${(data.balance ?? 0)}`
  );

  const aff = data.affiliateName || '';
  const affEmail = data.affiliateEmail || '';
  lines.push(`Affiliate: ${aff}${affEmail ? ` — ${affEmail}` : ''}`);

  if (data.notes) {
    lines.push('');
    lines.push('Notes:');
    lines.push(data.notes);
  }

  return lines.join('\n');
}

// duration rules (live: 2 / 2.5 / 3h + prep/clean included in availability)
function liveHoursForPkg(pkg) {
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = req.body || {};
    const {
      startISO, pkg, fullName, venue,
      email, // client email (optional)
      affiliateEmail, // optional; add as guest only if present
    } = body;

    if (!startISO) return res.status(400).json({ ok: false, error: 'startISO required' });

    // Attendees list (OAuth required if non-empty)
    const attendees = [];
    if (email) attendees.push({ email: String(email).trim() });
    if (affiliateEmail) attendees.push({ email: String(affiliateEmail).trim() });

    const needsOAuth = attendees.length > 0;

    // Build calendar with correct auth
    const { calendar } = await getCalendarForCreate(needsOAuth);

    // Compute end by live-hours only (prep/cleanup are already blocked in availability)
    const liveHrs = liveHoursForPkg(pkg);
    const start = new Date(startISO);
    const end = new Date(start.getTime() + liveHrs * 3600 * 1000);

    const event = {
      summary: titleForEvent(body),
      description: descriptionForEvent(body),
      start: { dateTime: toRFC3339(start), timeZone: tz() },
      end: { dateTime: toRFC3339(end), timeZone: tz() },
      location: venue || '',
      attendees: attendees.length ? attendees : undefined, // only include if not empty
    };

    const created = await calendar.events.insert({
      calendarId: calId(),
      requestBody: event,
      sendUpdates: attendees.length ? 'all' : 'none',
    });

    return res.status(200).json({
      ok: true,
      eventId: created?.data?.id || null,
    });
  } catch (e) {
    // Surface the common OAuth/service account attendee issue clearly
    const msg = e?.response?.data?.error || e?.message || 'create_booking_failed';
    return res.status(500).json({
      ok: false,
      error: 'create_booking_failed',
      detail: msg,
    });
  }
}
