// /api/create-booking.js
export const config = { runtime: 'nodejs' };

import { getOAuthCalendar } from './_google_oauth.js';
import { applyCors, preflight } from './_cors.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Vary', 'Origin'); return res.status(204).end(); }
  if (preflight?.(req, res)) return;
  applyCors?.(res);

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calendarId = process.env.CALENDAR_ID || 'primary';

    const {
      // basics
      fullName, email, phone, venue,
      dateISO, startISO,
      // products
      pkg, mainBar, secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      // money
      total, deposit, balance,
      // aff
      affiliateName, affiliateEmail, // <— make sure your frontend sends affiliateEmail
      // flags
      noDeposit,
      notes
    } = req.body || {};

    if (!startISO) return res.status(400).json({ ok: false, error: 'Missing startISO' });

    // Build title
    const pkgLabel = (pkg === '50-150-5h' ? '50–150' : pkg === '150-250-5h' ? '150–250' : '250–350');
    const mainBarLabel = (mainBar || '').replace(/\b\w/g, m => m.toUpperCase());
    const title = `Manna Snack Bars — ${pkgLabel} — ${fullName || 'Client'}${noDeposit ? ' (No deposit)' : ''} — ${mainBarLabel}`;

    // Event start/end (startISO is already ISO from client; keep timezone consistent)
    const start = { dateTime: startISO, timeZone: tz };

    // Package live hours (2 / 2.5 / 3) + 1h cleanup
    const liveHours = pkg === '50-150-5h' ? 2 : pkg === '150-250-5h' ? 2.5 : 3;
    const endDate = new Date(new Date(startISO).getTime() + (liveHours * 3600e3) + (1 * 3600e3));
    const end = { dateTime: endDate.toISOString(), timeZone: tz };

    // Attendees — only include if we have emails, otherwise omit the property
    const attendees = []
    if (email && /\S+@\S+\.\S+/.test(email)) attendees.push({ email, displayName: fullName || undefined });
    if (affiliateEmail && /\S+@\S+\.\S+/.test(affiliateEmail)) attendees.push({ email: affiliateEmail, displayName: affiliateName || undefined });

    // Description
    const descLines = [
      `Client: ${fullName || '(unknown)'}`,
      `Email: ${email || '(none)'}`,
      `Phone: ${phone || '(none)'}`,
      `Venue: ${venue || '(none)'}`,
      `Package: ${pkgLabel}`,
      `Main bar: ${mainBarLabel}`,
      secondEnabled ? `Second bar: ${secondBar || ''} — ${secondSize || ''}` : null,
      fountainEnabled ? `Fountain: ${fountainSize || ''} — ${fountainType || ''}` : null,
      `Totals: total $${(total||0)} — deposit $${(deposit||0)} — balance $${(balance||0)}`,
      `Affiliate: ${affiliateName || '(none)'}${affiliateEmail ? ` — ${affiliateEmail}` : ''}`,
      notes ? `\nNotes:\n${notes}` : ''
    ].filter(Boolean).join('\n');

    const calendar = await getOAuthCalendar();

    const created = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: title,
        location: venue || '',
        description: descLines,
        start,
        end,
        attendees: attendees.length ? attendees : undefined, // omit if empty (avoids errors)
        // Leave default guests permissions; Google will email invitations automatically.
      },
      sendUpdates: attendees.length ? 'all' : 'none'
    });

    return res.status(200).json({ ok: true, eventId: created.data.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'create_booking_failed', hint: e?.response?.data || e.message });
  }
}
