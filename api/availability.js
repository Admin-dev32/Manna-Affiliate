// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, handlePreflight } from './_cors.js';
import { google } from 'googleapis';

// ---- Business rules ----
const WINDOW_START_HOUR = 7;   // 7 AM first selectable start
const WINDOW_END_HOUR   = 22;  // 10 PM last selectable start (hourly)
const PREP_HOURS   = 1;
const CLEAN_HOURS  = 1;
const PER_SLOT_CAP = 2;        // max bars overlapping the same full block
const DAY_CAP      = 3;        // max events per day

// Map package → live service hours
const LIVE_HOURS_BY_PKG = {
  '50-150-5h': 2,
  '150-250-5h': 2.5,
  '250-350-6h': 3
};

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Build an OAuth2 Google Calendar client from env (Option B)
function getOAuthCalendar() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error('Missing OAuth env vars (CLIENT_ID/SECRET/REDIRECT_URI/REFRESH_TOKEN)');
  }

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// Build an ISO string representing local (TZ) date + hour
function zonedISO(ymd /* YYYY-MM-DD */, hour /* 0-23 */, tz /* IANA TZ */) {
  const [y, m, d] = ymd.split('-').map(Number);
  // Start with UTC guess
  const guessUtcMs = Date.UTC(y, m - 1, d, hour, 0, 0);
  // Convert that moment to TZ local time, then get the offset difference
  const asLocal = new Date(new Date(guessUtcMs).toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = asLocal.getTime() - guessUtcMs;
  return new Date(guessUtcMs - offsetMs).toISOString();
}

// Check overlap between two [start,end) ranges (Date)
function overlaps(aStart, aEnd, bStart, bEnd) {
  return (aStart < bEnd) && (aEnd > bStart);
}

export default async function handler(req, res) {
  // CORS
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    const { date, pkg } = req.query || {};
    if (!date) {
      return res.status(400).json({ ok: false, error: 'date_required_YYYY_MM_DD' });
    }

    // Resolve live service hours (fallback = 2)
    const liveHours = LIVE_HOURS_BY_PKG[pkg] ?? 2;

    // If no calendar configured, just emit the plain hourly grid
    if (!CALENDAR_ID) {
      const slots = [];
      for (let h = WINDOW_START_HOUR; h <= WINDOW_END_HOUR; h++) {
        const startISO = zonedISO(date, h, TZ);
        // skip past times (compare in real now)
        if (new Date(startISO) < new Date()) continue;
        slots.push({ startISO });
      }
      return res.status(200).json({ ok: true, slots });
    }

    // Fetch all events for the day (in TZ window)
    const calendar = getOAuthCalendar();
    const timeMin = zonedISO(date, 0, TZ);   // 00:00 TZ
    const timeMax = zonedISO(date, 23, TZ);  // 23:00 TZ (covers the day)
    const rsp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500
    });

    const items = (rsp.data.items || []).filter(e => e.status !== 'cancelled');

    // Day cap (max events per day)
    if (items.length >= DAY_CAP) {
      return res.status(200).json({ ok: true, slots: [] });
    }

    // Normalize existing events to Date ranges
    const existing = items.map(e => {
      const s = e.start?.dateTime || e.start?.date; // all-day uses date
      const eend = e.end?.dateTime || e.end?.date;
      return {
        start: new Date(s),
        end: new Date(eend)
      };
    });

    const now = new Date();
    const slots = [];

    for (let h = WINDOW_START_HOUR; h <= WINDOW_END_HOUR; h++) {
      const startISO = zonedISO(date, h, TZ);
      const start = new Date(startISO);

      // skip past
      if (start < now) continue;

      // Full block = prep + live + clean
      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd   = new Date(start.getTime() + (liveHours + CLEAN_HOURS) * 3600e3);

      // Count overlaps against the full block
      const overlapsCount = existing.reduce((acc, ev) => acc + (overlaps(blockStart, blockEnd, ev.start, ev.end) ? 1 : 0), 0);

      // Respect per-slot cap (max 2 overlapping bars)
      if (overlapsCount >= PER_SLOT_CAP) continue;

      slots.push({ startISO });
    }

    return res.status(200).json({ ok: true, slots });
  } catch (e) {
    console.error('availability error', e);
    return res.status(500).json({ ok: false, error: 'availability_failed', detail: e.message });
  }
}
