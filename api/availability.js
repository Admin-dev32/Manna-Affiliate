// /api/availability.js
// Returns available start slots for a given date and duration (hours).
// Example: /api/availability?date=2025-11-30&hours=2.5

import { google } from 'googleapis';
import { setCORS, handlePreflight } from './_utils/cors.js';

const TZ = process.env.CALENDAR_TZ || 'America/Los_Angeles';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Build a Google Calendar client using service account keys from env.
function getCalendar() {
  const email = process.env.GCP_CLIENT_EMAIL;
  let key = process.env.GCP_PRIVATE_KEY || '';
  // Vercel stores \n as literal backslashes; fix them:
  key = key.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT(
    email,
    null,
    key,
    ['https://www.googleapis.com/auth/calendar']
  );
  return google.calendar({ version: 'v3', auth });
}

// Utility: convert local (TZ) date + time to ISO
function z(dt) { return new Date(dt).toISOString(); }

// Working window for the day (adjust if you want)
const DAY_START_HOUR = Number(process.env.WORK_START || 10); // 10:00
const DAY_END_HOUR   = Number(process.env.WORK_END   || 21); // 21:00
const STEP_MINUTES   = Number(process.env.SLOT_STEP  || 30); // step between start slots

function makeSlotsForDay(dateYYYYMMDD, hours) {
  const [y,m,d] = dateYYYYMMDD.split('-').map(n=>Number(n));
  const starts = [];
  const stepMs = STEP_MINUTES * 60 * 1000;
  const durMs  = hours * 60 * 60 * 1000;

  const dayStart = new Date(Date.UTC(y, m-1, d, DAY_START_HOUR, 0, 0));
  const dayEnd   = new Date(Date.UTC(y, m-1, d, DAY_END_HOUR, 0, 0));

  for (let t = dayStart.getTime(); t + durMs <= dayEnd.getTime(); t += stepMs) {
    const s = new Date(t);
    const e = new Date(t + durMs);
    starts.push({ startISO: s.toISOString(), endISO: e.toISOString() });
  }
  return { dayStartISO: dayStart.toISOString(), dayEndISO: dayEnd.toISOString(), slots: starts };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export default async function handler(req, res) {
  const origin = '*'; // if you want to lock it down: 'https://your-hostinger-site'
  if (handlePreflight(req, res, origin)) return;

  setCORS(res, origin);

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  try {
    const date = String(req.query.date || '').trim();
    const hours = Number(req.query.hours || 0);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok:false, error:'Invalid date (YYYY-MM-DD)' });
    }
    if (!(hours > 0)) {
      return res.status(400).json({ ok:false, error:'Invalid hours' });
    }

    // Build candidate slots for the day
    const { dayStartISO, dayEndISO, slots } = makeSlotsForDay(date, hours);

    // Query busy time from Google Calendar
    const calendar = getCalendar();
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: dayStartISO,
        timeMax: dayEndISO,
        timeZone: TZ,
        items: [{ id: CALENDAR_ID }]
      }
    });

    const busy = (fb.data.calendars?.[CALENDAR_ID]?.busy) || (fb.data.calendars?.primary?.busy) || [];

    // Filter out any slot that overlaps a busy period
    const free = slots.filter(s => {
      const s0 = new Date(s.startISO).getTime();
      const s1 = new Date(s.endISO).getTime();
      for (const b of busy) {
        const b0 = new Date(b.start).getTime();
        const b1 = new Date(b.end).getTime();
        if (overlaps(s0, s1, b0, b1)) return false;
      }
      return true;
    });

    return res.status(200).json({ ok:true, slots: free, tz: TZ });
  } catch (e) {
    // Surface a readable error (and never forget CORS headers)
    return res.status(200).json({
      ok:false,
      error: e?.message || 'availability_error'
    });
  }
}
