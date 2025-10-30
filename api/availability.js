// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// ------- Settings -------
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CAL_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const HOURS = { start: 9, end: 22 };   // candidate start hours: 9 → 22 local
const PREP_H = 1;
const CLEAN_H = 1;
const MAX_PER_DAY = 3;  // max total events per day
const MAX_OVERLAP = 2;  // max concurrent bars (including prep+clean)

// ------- Helpers -------
function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  // Build a local-time Date for TZ, without depending on server TZ.
  const guessUTC = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  const asDate = new Date(guessUTC);
  const localized = new Date(asDate.toLocaleString('en-US', { timeZone: TZ }));
  const offset = localized.getTime() - asDate.getTime();
  return new Date(guessUTC - offset);
}

function localISO(ymd, hour) {
  const [y, m, d] = ymd.split('-').map(Number);
  return localDate(y, m, d, hour, 0, 0, 0).toISOString();
}

function withPrepClean(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = new Date(start.getTime() - PREP_H * 3600_000);
  const blockEnd   = new Date(start.getTime() + (liveHours + CLEAN_H) * 3600_000);
  return { blockStart, blockEnd };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function fallbackSlots(ymd) {
  const out = [];
  for (let h = HOURS.start; h <= HOURS.end; h++) {
    const iso = localISO(ymd, h);
    if (new Date(iso) > new Date()) out.push({ startISO: iso });
  }
  return out;
}

function json(res, code, body) {
  try { return res.status(code).json(body); }
  catch { return res.status(500).end(); }
}

// ------- Handler -------
export default async function handler(req, res) {
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
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
    return json(res, 405, { error: 'method_not_allowed' });
  }

  const { date, pkg } = req.query || {};
  if (!date) return json(res, 400, { error: 'date required (YYYY-MM-DD)' });

  const live = hoursFromPkg(String(pkg || '50-150-5h'));

  try {
    // Day window in TZ
    const dayStartISO = localISO(date, 0);
    const dayEndISO   = localISO(date, 23);

    // OAuth calendar client (uses your stored refresh token)
    const calendar = await getOAuthCalendar();

    // Pull events for the day
    const rsp = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = (rsp?.data?.items || []).filter(e => e.status !== 'cancelled');

    // Hard cap per day
    if (items.length >= MAX_PER_DAY) {
      return json(res, 200, { slots: [], source: 'google', note: 'day_cap_reached' });
    }

    const existing = items.map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end:   new Date(e.end?.dateTime   || e.end?.date),
    }));

    // Build candidate slots hourly from 9 → 22
    const now = new Date();
    const slots = [];
    for (let h = HOURS.start; h <= HOURS.end; h++) {
      const startISO = localISO(date, h);
      const start = new Date(startISO);
      if (start <= now) continue;

      const { blockStart, blockEnd } = withPrepClean(startISO, live);
      const overlapsCount = existing.reduce(
        (acc, ev) => acc + (overlaps(blockStart, blockEnd, ev.start, ev.end) ? 1 : 0),
        0
      );

      if (overlapsCount < MAX_OVERLAP && items.length < MAX_PER_DAY) {
        slots.push({ startISO });
      }
    }

    return json(res, 200, { slots, source: 'google' });
  } catch (e) {
    // Never 500 the UI; show fallback slots so buttons render.
    console.error('availability error:', e?.response?.data || e?.message || e);
    return json(res, 200, {
      slots: fallbackSlots(date),
      source: 'fallback',
      note: 'google_calendar_unavailable'
    });
  }
}
