// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, handlePreflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// Business rules
const HOURS_RANGE = { start: 9, end: 22 }; // 09:00 → 22:00 local (America/Los_Angeles)
const PREP_HOURS  = 1;                     // 1h before
const CLEAN_HOURS = 1;                     // 1h after
const MAX_PER_SLOT = 2;                    // max 2 events colliding the full service block
const MAX_PER_DAY  = 3;                    // max 3 events per calendar day
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

// Figure out LA offset (“-07:00” PDT or “-08:00” PST) for a given date
function laOffsetForYMD(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
    .formatToParts(noonUTC);
  const abbr = (parts.find(p => p.type === 'timeZoneName')?.value || '').toUpperCase();
  return abbr.includes('PDT') ? '-07:00' : '-08:00';
}

// Build RFC3339 with LA offset (no DST bugs)
function startISOFor(ymd, hour) {
  const pad = n => String(n).padStart(2, '0');
  const offset = laOffsetForYMD(ymd);
  return `${ymd}T${pad(hour)}:00:00${offset}`;
}

function fullBlock(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
  const blockEnd   = new Date(start.getTime() + (liveHours + CLEAN_HOURS) * 3600e3);
  return { blockStart, blockEnd };
}

export default async function handler(req, res) {
  // CORS
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { date, pkg } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const calId = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const liveHours = hoursFromPkg(String(pkg || ''));

    // getOAuthCalendar returns { calendar, auth }
    const { calendar } = await getOAuthCalendar();

    // Day range in LA (00:00–23:59 with correct offset)
    const dayStartISO = startISOFor(date, 0);
    const dayEndISO   = startISOFor(date, 23);

    const rsp = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const events = (rsp.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        start: new Date(e.start?.dateTime || e.start?.date),
        end:   new Date(e.end?.dateTime   || e.end?.date),
      }));

    // Hard-cap: 3 events per day
    if (events.length >= MAX_PER_DAY) {
      return res.status(200).json({ slots: [] });
    }

    // Generate 9–22 candidates and allow only if <2 overlaps across the full operational window
    const now = new Date();
    const slots = [];

    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++) {
      const startISO = startISOFor(date, h);
      if (new Date(startISO) < now) continue;

      const { blockStart, blockEnd } = fullBlock(startISO, liveHours);
      const overlapping = events.filter(
        ev => !(ev.end <= blockStart || ev.start >= blockEnd)
      ).length;

      if (overlapping < MAX_PER_SLOT) {
        // ✅ Frontend expects { startISO }
        slots.push({ startISO });
      }
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    return res.status(500).json({ error: 'availability_failed', detail: String(e.message || e) });
  }
}