// /api/availability.js
// Returns clickable start slots. Window: 9:00 → 22:00 (start times).
// Includes 1h prep before and 1h clean after when checking overlaps.
// Cap: max 3 events per day; max 2 concurrent per exact start.

export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getServiceAccountCalendar, toRFC3339, tz, calId } from './_google.js';

const HOURS_RANGE = { start: 9, end: 22 }; // 9am–10pm possible starts
const PREP_HOURS = 1;
const CLEAN_HOURS = 1;
const DAY_MAX = 3;
const SAME_START_CAP = 2;

function liveHoursForPkg(pkg) {
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function zonedStartISO(ymd, hour, zone) {
  const [y, m, d] = ymd.split('-').map(Number);
  // create local time and convert to ISO
  const guess = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const asLocal = new Date(guess.toLocaleString('en-US', { timeZone: zone }));
  const offset = asLocal.getTime() - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  try {
    const { date, pkg = '50-150-5h' } = req.query || {};
    if (!date) return res.status(400).json({ ok: false, error: 'date required (YYYY-MM-DD)' });

    // use service account to *read* calendar busy windows (OK)
    const { calendar } = await getServiceAccountCalendar();
    const zone = tz();
    const calendarId = calId();

    // read events in that day
    const timeMin = zonedStartISO(date, 0, zone);
    const timeMax = zonedStartISO(date, 23, zone);

    const rsp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = (rsp.data.items || []).filter(e => e.status !== 'cancelled');

    // Hard day cap
    if (items.length >= DAY_MAX) {
      return res.status(200).json({ ok: true, slots: [] });
    }

    const liveHrs = liveHoursForPkg(pkg);
    const slots = [];
    const countsByStartKey = {};

    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++) {
      const startISO = zonedStartISO(date, h, zone);
      const start = new Date(startISO);

      // past times not offered
      if (start < new Date()) continue;

      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd   = new Date(start.getTime() + (liveHrs * 3600e3) + CLEAN_HOURS * 3600e3);

      const overlaps = items.some(e => {
        const s = new Date(e.start?.dateTime || e.start?.date);
        const en = new Date(e.end?.dateTime || e.end?.date);
        return !(en <= blockStart || s >= blockEnd);
      });
      if (overlaps) continue;

      // same-start cap (2 max)
      const key = start.toISOString();
      countsByStartKey[key] = countsByStartKey[key] || 0;
      if (countsByStartKey[key] >= SAME_START_CAP) continue;
      countsByStartKey[key]++;

      slots.push({ startISO });
    }

    return res.status(200).json({ ok: true, slots });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'availability_failed', detail: e.message });
  }
}
