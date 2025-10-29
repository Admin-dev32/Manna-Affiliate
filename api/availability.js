// /api/availability.js
export const config = { runtime: 'nodejs' };

/**
 * Env you can set:
 * - TIMEZONE            (default: America/Los_Angeles)
 * - GOOGLE_SERVICE_ACCOUNT_JSON  (or GCP_CLIENT_EMAIL + GCP_PRIVATE_KEY)
 * - CALENDAR_ID         (default: primary)
 * - ALLOWED_ORIGINS     (comma-separated list; * if unset)
 */

const BUSINESS_TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const OPEN_HOUR = 9;   // 09:00 local
const CLOSE_HOUR = 22; // 22:00 local (last allowed start)
const MAX_CONCURRENT = 2; // max bars running at once
const MAX_PER_DAY = 3;    // max bars per day (any time)

/** Map package => service hours */
function serviceHoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2; // default
}

/** Build a Date for a wall-clock time in a given IANA TZ, then return ISO in UTC */
function zonedISO(yyyy_MM_dd, hour = 0, minute = 0, tz = BUSINESS_TZ) {
  const [y, m, d] = yyyy_MM_dd.split('-').map(Number);
  // Create a "guessed" UTC moment for that local time…
  const guessUtc = new Date(Date.UTC(y, m - 1, d, hour, minute, 0, 0));
  // Get what that UTC moment looks like in the target tz
  const inTz = new Date(guessUtc.toLocaleString('en-US', { timeZone: tz }));
  // Offset difference between local tz and the simple UTC guess
  const offsetMs = inTz.getTime() - guessUtc.getTime();
  // Corrected UTC timestamp that corresponds to local tz wall-clock time
  return new Date(guessUtc.getTime() - offsetMs).toISOString();
}

/** Add hours to a Date (ms-based) */
function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3600e3);
}

/** Overlap check: [aStart,aEnd) vs [bStart,bEnd) */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/** Generate 30-min step start times from OPEN_HOUR..CLOSE_HOUR inclusive */
function* generateStartTimes(yyyy_MM_dd) {
  // start-of-day in local tz 00:00 for boundary checks
  const dayStartISO = zonedISO(yyyy_MM_dd, 0, 0, BUSINESS_TZ);
  const dayStart = new Date(dayStartISO);
  const lastStartISO = zonedISO(yyyy_MM_dd, CLOSE_HOUR, 0, BUSINESS_TZ);
  const lastStart = new Date(lastStartISO);

  for (let h = OPEN_HOUR; h <= CLOSE_HOUR; h++) {
    for (let m = 0; m < 60; m += 30) {
      const startISO = zonedISO(yyyy_MM_dd, h, m, BUSINESS_TZ);
      const start = new Date(startISO);
      if (start > lastStart) continue; // just in case (minute loop)
      yield start;
    }
  }
}

/** Soft Google Calendar loader; returns [] if not configured/available */
async function listEventsForDay(yyyy_MM_dd) {
  // Figure day bounds in local tz
  const timeMin = zonedISO(yyyy_MM_dd, 0, 0, BUSINESS_TZ);
  const timeMax = zonedISO(yyyy_MM_dd, 23, 59, BUSINESS_TZ);
  const calendarId = process.env.CALENDAR_ID || 'primary';

  try {
    const { google } = await import('googleapis');
    let clientEmail, privateKey;

    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      clientEmail = sa.client_email;
      privateKey = (sa.private_key || '').replace(/\\n/g, '\n');
    } else {
      clientEmail = process.env.GCP_CLIENT_EMAIL;
      privateKey = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    }
    if (!clientEmail || !privateKey) return []; // not configured

    const jwt = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    const rsp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
    });

    const items = (rsp.data.items || []).filter(e => e.status !== 'cancelled');

    // Normalize to concrete Date ranges
    return items.map(e => {
      const s = e.start?.dateTime || e.start?.date; // all-day events have 'date'
      const e_ = e.end?.dateTime || e.end?.date;
      const start = new Date(s);
      const end = new Date(e_);
      return { start, end };
    });
  } catch {
    // any error => treat as no events
    return [];
  }
}

/** CORS */
function setCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { date, pkg, hours } = req.query || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid ?date=YYYY-MM-DD' });
    }

    // Accept either pkg or hours
    let liveHours = Number(hours);
    if (!liveHours || Number.isNaN(liveHours)) {
      liveHours = serviceHoursFromPkg(String(pkg || '').trim());
    }
    // Full block = 1h buffer + live + 1h cleanup
    const blockHours = 1 + liveHours + 1;

    // Fetch all existing events for that day (or [] if not configured)
    const events = await listEventsForDay(date);

    // Hard daily cap
    if (events.length >= MAX_PER_DAY) {
      return res.status(200).json({ ok: true, slots: [] });
    }

    const now = new Date();
    const dayEnd = new Date(zonedISO(date, 23, 59, BUSINESS_TZ));
    const out = [];

    for (const start of generateStartTimes(date)) {
      // Skip past starts for today
      if (start < now) continue;

      const blockStart = addHours(start, -1); // 1h buffer
      const blockEnd = addHours(start, blockHours - 1); // already subtracted 1h above

      // Keep entire block within the same local day
      if (blockEnd > dayEnd) continue;

      // Count overlaps with existing events
      let concurrent = 0;
      for (const ev of events) {
        if (overlaps(blockStart, blockEnd, ev.start, ev.end)) {
          concurrent++;
          if (concurrent >= MAX_CONCURRENT) break;
        }
      }
      if (concurrent >= MAX_CONCURRENT) continue;

      // If we added this, would it break the daily cap?
      if (events.length + out.length + 1 > MAX_PER_DAY) continue;

      out.push({ startISO: start.toISOString(), endISO: blockEnd.toISOString() });
    }

    return res.status(200).json({ ok: true, slots: out });
  } catch (e) {
    console.error('availability error', e);
    // Fail soft: return ok with empty slots to avoid frontend error banners
    return res.status(200).json({ ok: true, slots: [], error: 'availability_failed' });
  }
}
