export const config = { runtime: 'nodejs' };

import { applyCors, handlePreflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// Business rules
const HOURS_RANGE = { start: 9, end: 22 }; // allowed service START hours: 09:00..21:59 (last candidate = 21:00)
const PREP_HOURS  = 1;
const CLEAN_HOURS = 1;
const MAX_PER_SLOT = 2;
const MAX_PER_DAY  = 3;
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

// Detect PDT/PST offset (-07:00 or -08:00) for given date
function laOffsetForYMD(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
    .formatToParts(noonUTC);
  const abbr = (parts.find(p => p.type === 'timeZoneName')?.value || '').toUpperCase();
  return abbr.includes('PDT') ? '-07:00' : '-08:00';
}
const pad = n => String(n).padStart(2, '0');
function isoAt(ymd, hour) { return `${ymd}T${pad(hour)}:00:00${laOffsetForYMD(ymd)}`; }

function fullBlock(startISO, liveHours) {
  const start = new Date(startISO);
  return {
    blockStart: new Date(start.getTime() - PREP_HOURS * 3600e3),
    blockEnd:   new Date(start.getTime() + (liveHours + CLEAN_HOURS) * 3600e3),
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const { date, pkg } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const calId = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const liveHours = hoursFromPkg(String(pkg || ''));

    const { calendar } = await getOAuthCalendar();

    // Pull events for the local day
    const dayStartISO = isoAt(date, 0);
    const dayEndISO   = isoAt(date, 23);

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

    // Hard cap per day
    if (events.length >= MAX_PER_DAY) {
      return res.status(200).json({ slots: [] });
    }

    // Candidates strictly 09:00..21:00 (so service starts in-window)
    const now = new Date();
    const slots = [];
    for (let h = HOURS_RANGE.start; h < HOURS_RANGE.end; h++) { // NOTE: < end (not <=)
      const startISO = isoAt(date, h);
      if (new Date(startISO) < now) continue;

      const { blockStart, blockEnd } = fullBlock(startISO, liveHours);
      const overlapping = events.filter(
        ev => !(ev.end <= blockStart || ev.start >= blockEnd)
      ).length;

      if (overlapping < MAX_PER_SLOT) {
        slots.push({ startISO });
      }
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    return res.status(500).json({ error: 'availability_failed', detail: String(e?.message || e) });
  }
}