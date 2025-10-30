// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, handlePreflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// Business rules
const HOURS_RANGE = { start: 9, end: 22 }; // 09:00 → 22:00 local wall clock
const PREP_HOURS  = 1;
const CLEAN_HOURS = 1;
const MAX_PER_SLOT = 2; // max overlapping in full op window
const MAX_PER_DAY  = 3; // max per day

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function toISO(date) { return new Date(date).toISOString(); }
function fullBlockFromLocalParts(ymd, hour, liveHours, tz) {
  // Build a Date from local parts by letting JS create a local time,
  // then we *only* use it to compute the operational window length.
  // We never return this as the "slot ISO" anymore (client will).
  const [y,m,d] = ymd.split('-').map(Number);
  const startLocal = new Date(y, m-1, d, hour, 0, 0);
  const blockStart = new Date(startLocal.getTime() - PREP_HOURS*3600e3);
  const blockEnd   = new Date(startLocal.getTime() + (liveHours + CLEAN_HOURS)*3600e3);
  return { blockStart, blockEnd };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  try{
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { date, pkg } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const tz       = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId    = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const liveHrs  = hoursFromPkg(String(pkg || ''));

    const { calendar } = await getOAuthCalendar();

    // Pull all events covering this day (00:00–23:59 local) — we approximate with system local
    const day = new Date(date + 'T00:00:00');
    const dayStartISO = toISO(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0));
    const dayEndISO   = toISO(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59));

    const rsp = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 200
    });

    const events = (rsp.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        start: new Date(e.start?.dateTime || e.start?.date),
        end:   new Date(e.end?.dateTime   || e.end?.date)
      }));

    // Day cap
    if (events.length >= MAX_PER_DAY) {
      return res.status(200).json({ slots: [] });
    }

    // Build candidate hours; test overlap against op-window for that hour
    const now = new Date();
    const slots = [];
    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++) {
      // full operational window for that hour
      const { blockStart, blockEnd } = fullBlockFromLocalParts(date, h, liveHrs, tz);

      // Don’t offer past times (compare with now)
      if (blockEnd <= now) continue;

      // overlap count
      const overlapping = events.filter(ev => !(ev.end <= blockStart || ev.start >= blockEnd)).length;
      if (overlapping < MAX_PER_SLOT) {
        // return just the HOUR; client will build ISO in the browser TZ
        slots.push({ hour: h });
      }
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    return res.status(500).json({ error: 'availability_failed', detail: String(e.message || e) });
  }
}
