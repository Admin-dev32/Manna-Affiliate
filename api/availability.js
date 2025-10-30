// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// ---------- CONFIG ----------
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CAL_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Business window (candidate start times)
const HOURS = { start: 9, end: 22 }; // 9:00 → 22:00 local
const PREP_H = 1;
const CLEAN_H = 1;

// Daily & concurrent caps
const MAX_PER_DAY = 3;     // no more than 3 bookings in a day
const MAX_OVERLAP = 2;     // up to 2 overlapping bars allowed

// ---------- HELPERS ----------
function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}
function toLocalDate(y, m, d, h = 0, min = 0, sec = 0, ms = 0) {
  // Construct local time in TZ, return Date in system timezone
  // We’ll compute the UTC ISO via toLocaleString offset trick.
  const tentativeUTC = Date.UTC(y, m - 1, d, h, min, sec, ms);
  const asDate = new Date(tentativeUTC);
  const localized = new Date(
    asDate.toLocaleString('en-US', { timeZone: TZ })
  );
  const offsetMs = localized.getTime() - asDate.getTime();
  return new Date(tentativeUTC - offsetMs);
}
function localStartISO(ymd, hour) {
  const [y, m, d] = ymd.split('-').map(Number);
  return toLocalDate(y, m, d, hour, 0, 0, 0).toISOString();
}
function endISOFrom(startISO, liveHours) {
  const start = new Date(startISO);
  return new Date(start.getTime() + liveHours * 3600_000).toISOString();
}
function withPrepAndClean(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = new Date(start.getTime() - PREP_H * 3600_000);
  const blockEnd = new Date(start.getTime() + (liveHours + CLEAN_H) * 3600_000);
  return { blockStart, blockEnd };
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
function safeJson(res, code, body) {
  try { return res.status(code).json(body); }
  catch { return res.status(500).end(); }
}

// ---------- MAIN ----------
export default async function handler(req, res) {
  // CORS (same style as your other routes)
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
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'GET') {
    return safeJson(res, 405, { error: 'method_not_allowed' });
  }

  try {
    const { date, pkg } = req.query || {};
    if (!date) return safeJson(res, 400, { error: 'date required (YYYY-MM-DD)' });

    const liveHours = hoursFromPkg(String(pkg || '50-150-5h')); // default 2h if missing

    // Build day range in TZ
    const [y, m, d] = date.split('-').map(Number);
    const dayStartISO = localStartISO(date, 0);
    const dayEndISO   = localStartISO(date, 23); // inclusive day bound

    // OAuth calendar client
    const calendar = await getOAuthCalendar();

    // Get the day’s events (we’ll count overlaps and daily cap)
    const list = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250
    });

    const items = (list.data.items || []).filter(e => e.status !== 'cancelled');

    // Hard daily cap: if already >= MAX_PER_DAY, no slots
    if (items.length >= MAX_PER_DAY) {
      return safeJson(res, 200, { slots: [] });
    }

    // Normalize existing events to Date ranges
    const existing = items.map(e => {
      const s = e.start?.dateTime || e.start?.date;
      const en = e.end?.dateTime || e.end?.date;
      return { start: new Date(s), end: new Date(en) };
    });

    // Candidate starts: every hour 9 → 22 local
    const slots = [];
    for (let h = HOURS.start; h <= HOURS.end; h++) {
      const startISO = localStartISO(date, h);
      const now = new Date();
      // Skip past starts
      if (new Date(startISO) < now) continue;

      // Compute blocks for concurrency check (prep + live + clean)
      const { blockStart, blockEnd } = withPrepAndClean(startISO, liveHours);

      // Count how many existing events overlap this block
      const overlappingCount = existing.reduce((acc, ev) => {
        return acc + (overlaps(blockStart, blockEnd, ev.start, ev.end) ? 1 : 0);
      }, 0);

      // Also cap daily total if this slot would become > MAX_PER_DAY
      if (overlappingCount < MAX_OVERLAP && items.length < MAX_PER_DAY) {
        slots.push({ startISO }); // UI only needs startISO
      }
    }

    return safeJson(res, 200, { slots });
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    return safeJson(res, 500, { error: 'availability_failed', detail: String(e?.message || e) });
  }
}
