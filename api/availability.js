// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// Business rules
const HOURS_RANGE = { start: 9, end: 22 }; // 09:00 → 22:00 candidate starts (local time)
const PREP_HOURS  = 1;                     // 1h before
const CLEAN_HOURS = 1;                     // 1h after
const MAX_PER_SLOT = 2;                    // max 2 events colliding the full service block
const MAX_PER_DAY  = 3;                    // max 3 events per calendar day

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function zonedStartISO(ymd, hour, tz) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  // Build local time in tz, then convert to ISO reliably
  const localStr = new Date(Date.UTC(y, m - 1, d, hour, 0, 0)).toLocaleString('en-US', { timeZone: tz });
  const localDate = new Date(localStr);
  // localDate now represents that wall time in tz; produce ISO in UTC
  return new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60000).toISOString();
}

function fullBlock(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
  const blockEnd   = new Date(start.getTime() + (liveHours * 3600e3) + CLEAN_HOURS * 3600e3);
  return { blockStart, blockEnd };
}

export default async function handler(req, res) {
  // CORS
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

  try {
    const { date, pkg } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const liveHours = hoursFromPkg(String(pkg || ''));

    // Use the SAME OAuth calendar identity you just set up
    const calendar = await getOAuthCalendar();

    // Pull all events for the day
    const dayStart = zonedStartISO(date, 0, tz);
    const dayEnd   = zonedStartISO(date, 23, tz);

    const rsp = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart,
      timeMax: dayEnd,
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

    // Day hard-cap: if already 3, return none
    if (events.length >= MAX_PER_DAY) {
      return res.status(200).json({ slots: [] });
    }

    // Generate candidate starts and allow slot only if < 2 overlaps
    const now = new Date();
    const slots = [];
    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++) {
      const startISO = zonedStartISO(date, h, tz);
      if (new Date(startISO) < now) continue;

      const { blockStart, blockEnd } = fullBlock(startISO, liveHours);
      const overlapping = events.filter(ev => !(ev.end <= blockStart || ev.start >= blockEnd)).length;

      if (overlapping < MAX_PER_SLOT) {
        slots.push({ startISO });
      }
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    return res.status(500).json({ error: 'availability_failed', detail: String(e.message || e) });
  }
}
