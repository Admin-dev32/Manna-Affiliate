// /api/create-booking.js
export const config = { runtime: 'nodejs' };

/**
 * Robust booking creator:
 * - Solid CORS
 * - Accepts affiliate info
 * - Tolerates missing client email
 * - Uses CALENDAR_ID (fallbacks supported)
 * - Returns clear errors
 */
export default async function handler(req, res) {
  // ---------- CORS ----------
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

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    // ---------- Basic validation ----------
    const {
      pin,
      affiliateName,            // string
      affiliateEmail,           // string (optional)
      fullName, email, phone, venue,
      startISO,                 // ISO string (UTC)
      pkg,                      // "50-150-5h" | ...
      notes,                    // optional
      total, deposit, balance,  // numbers
      noDeposit                 // boolean
    } = body || {};

    if (!pin)         return res.status(400).json({ ok: false, error: 'Missing pin' });
    if (!fullName)    return res.status(400).json({ ok: false, error: 'Missing fullName' });
    if (!startISO)    return res.status(400).json({ ok: false, error: 'Missing startISO' });
    if (!pkg)         return res.status(400).json({ ok: false, error: 'Missing pkg' });

    // ---------- Durations (live time) ----------
    const liveHours = (pkg === '50-150-5h') ? 2 : (pkg === '150-250-5h') ? 2.5 : 3; // service time
    const PREP_H = 1, CLEAN_H = 1;

    const start = new Date(startISO);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ ok: false, error: 'Invalid startISO' });
    }

    const startPrep = new Date(start.getTime() - PREP_H * 3600e3);
    const endClean  = new Date(start.getTime() + (liveHours + CLEAN_H) * 3600e3);

    // ---------- Calendar ID (robust) ----------
    const calendarId =
      process.env.CALENDAR_ID ||
      process.env.GOOGLE_CALENDAR_ID || // legacy name, just in case
      'primary';

    if (!calendarId) {
      return res.status(500).json({ ok: false, error: 'Missing CALENDAR_ID environment variable' });
    }

    // ---------- Google auth ----------
    const { google } = await import('googleapis');

    // Allow both single JSON var and split vars
    let clientEmail, privateKey;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      clientEmail = sa.client_email;
      privateKey = (sa.private_key || '').replace(/\\n/g, '\n');
    } else {
      clientEmail = process.env.GCP_CLIENT_EMAIL;
      privateKey  = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    }
    if (!clientEmail || !privateKey) {
      return res.status(500).json({ ok: false, error: 'Missing Google service account credentials' });
    }

    const jwt = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    // ---------- Build event ----------
    const titlePkg =
      pkg === '50-150-5h'   ? '50–150' :
      pkg === '150-250-5h'  ? '150–250' :
      pkg === '250-350-6h'  ? '250–350' : pkg;

    const summary = `Manna Snack Bars — ${titlePkg} — ${fullName}${noDeposit ? ' (No deposit)' : ''}`;

    const attendees = [];
    // Only push valid emails (avoid Google API error)
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) attendees.push({ email, displayName: fullName });
    if (affiliateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(affiliateEmail)) {
      attendees.push({ email: affiliateEmail, displayName: affiliateName || 'Affiliate' });
    }

    const descriptionLines = [
      `Client: ${fullName}`,
      email ? `Email: ${email}` : 'Email: (none)',
      phone ? `Phone: ${phone}` : 'Phone: (none)',
      venue ? `Venue: ${venue}` : 'Venue: (none)',
      `Package: ${titlePkg}`,
      `Totals: total $${Number(total||0).toFixed(0)} — deposit $${Number(deposit||0).toFixed(0)} — balance $${Number(balance||0).toFixed(0)}`,
      `Affiliate: ${affiliateName || '(none)'}${affiliateEmail ? ` <${affiliateEmail}>` : ''}`,
      notes ? `Notes: ${notes}` : ''
    ].filter(Boolean).join('\n');

    const event = {
      summary,
      location: venue || '',
      description: descriptionLines,
      start: { dateTime: startPrep.toISOString() },
      end:   { dateTime: endClean.toISOString() },
      attendees,
      extendedProperties: {
        private: {
          pin: String(pin),
          affiliateName: String(affiliateName || ''),
          affiliateEmail: String(affiliateEmail || ''),
          pkg: String(pkg),
          noDeposit: String(!!noDeposit),
          total: String(total ?? ''),
          deposit: String(deposit ?? ''),
          balance: String(balance ?? '')
        }
      }
    };

    // ---------- Insert ----------
    const insert = await calendar.events.insert({
      calendarId,
      requestBody: event,
      sendUpdates: 'all' // email attendees if present
    });

    const eventId = insert?.data?.id || '';
    return res.status(200).json({ ok: true, eventId });
  } catch (e) {
    // Return the message so the frontend shows a useful error
    return res.status(500).json({ ok: false, error: e?.message || 'create_booking_failed' });
  }
}
