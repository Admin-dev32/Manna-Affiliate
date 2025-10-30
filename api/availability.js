// /api/availability.js
export const config = { runtime: 'nodejs' };

/**
 * Business rules
 * - Service start times offered hourly from START_HOUR .. END_HOUR (inclusive)
 * - Full block checked per slot = 1h prep + live service + 1h clean
 * - Max 2 overlapping events per slot (concurrency = 2)
 * - Max 3 events per day (hard cap)
 */
const START_HOUR = 7;     // 7:00 AM
const END_HOUR   = 22;    // 10:00 PM (latest *start* we’ll consider, see lastStart logic)
const PREP_HOURS   = 1;
const CLEAN_HOURS  = 1;
const MAX_CONCURRENT = 2; // “2 events Max Per Sample Time”
const MAX_PER_DAY    = 3; // “3 Events Max per day”

// ---- tiny helpers ----
function tzStartISO(ymd, hour, tz) {
  // build exact local time in tz and convert to ISO
  const [y, m, d] = ymd.split('-').map(Number);
  // start with naive UTC guess, then correct using tz offset at that instant
  const guessUTC = Date.UTC(y, m - 1, d, hour, 0, 0);
  const asDate = new Date(guessUTC);
  const local = new Date(asDate.toLocaleString('en-US', { timeZone: tz }));
  const offset = local.getTime() - asDate.getTime(); // tz offset in ms at that moment
  return new Date(guessUTC - offset).toISOString();  // true instant as ISO
}

function toDate(x) {
  return new Date(x?.dateTime || x?.date || x);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // (a starts before b ends) && (a ends after b starts)
  return aStart < bEnd && aEnd > bStart;
}

export default async function handler(req, res) {
  // ----- CORS (simple allowlist) -----
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  try {
    const { date, hours } = req.query || {};
    if (!date) return res.status(400).json({ ok: false, error: 'Missing date (YYYY-MM-DD)' });

    // live service hours for the selected package: 2, 2.5, or 3
    const LIVE_HOURS = Math.max(1, parseFloat(String(hours || '2')));

    const TIMEZONE   = process.env.TIMEZONE || 'America/Los_Angeles';
    const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

    // ---- Google Calendar client (service account) ----
    const { google } = await import('googleapis');
    let clientEmail, privateKey;

    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      clientEmail = sa.client_email;
      privateKey  = (sa.private_key || '').replace(/\\n/g, '\n');
    } else {
      clientEmail = process.env.GCP_CLIENT_EMAIL;
      privateKey  = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    }

    if (!clientEmail || !privateKey) {
      return res.status(500).json({ ok: false, error: 'Missing Google service account envs' });
    }

    const auth = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth });

    // Pull all events for the day (local day bounds in TIMEZONE)
    const dayMin = tzStartISO(date, 0, TIMEZONE);
    const dayMax = tzStartISO(date, 23, TIMEZONE);

    const list = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayMin,
      timeMax: dayMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250
    });

    const events = (list.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        id: e.id,
        start: toDate(e.start),
        end:   toDate(e.end),
      }));

    // ----- Per-day cap -----
    if (events.length >= MAX_PER_DAY) {
      return res.status(200).json({ ok: true, slots: [] });
    }

    // Generate hourly candidates in local time
    const slots = [];
    const now = new Date();

    // Choose a safe last start so that service+clean doesn’t run absurdly late.
    // We allow cleanup to cross midnight, but if you want to forbid that,
    // uncomment the clamp below.
    // const LAST_START = Math.min(END_HOUR, 24 - Math.ceil(LIVE_HOURS + CLEAN_HOURS));

    const LAST_START = END_HOUR;

    for (let H = START_HOUR; H <= LAST_START; H++) {
      const startISO = tzStartISO(date, H, TIMEZONE);
      const start = new Date(startISO);

      // Skip past times (today)
      if (start < now) continue;

      // Full operational block we must keep free around that start
      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd   = new Date(start.getTime() + (LIVE_HOURS + CLEAN_HOURS) * 3600e3);

      // Count how many existing events overlap this block
      let concurrent = 0;
      for (const ev of events) {
        if (overlaps(blockStart, blockEnd, ev.start, ev.end)) concurrent++;
      }

      if (concurrent < MAX_CONCURRENT) {
        slots.push({ startISO: start.toISOString() });
      }
    }

    return res.status(200).json({ ok: true, slots });
  } catch (e) {
    console.error('availability error', e);
    return res.status(500).json({ ok: false, error: 'availability_failed', detail: e.message });
  }
}
