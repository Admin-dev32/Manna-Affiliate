export const config = { runtime: 'nodejs' };

import { applyCors, handlePreflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// Business rules
const HOURS_RANGE = { start: 9, end: 22 }; // service START allowed: 09:00..21:59
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

// --- NEW: accept YYYY-MM-DD, MM/DD/YYYY, or YYYY/MM/DD and normalize
function toYMD(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;

  // 2025-11-01
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // 11/01/2025 or 2025/11/01
  m = /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/.exec(str);
  if (m) {
    let y, mo, d;
    if (m[1].length === 4) {        // YYYY/MM/DD
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else {                         // MM/DD/YYYY
      y = +m[3]; mo = +m[1]; d = +m[2];
    }
    const pad = n => String(n).padStart(2,'0');
    if (y>=1900 && mo>=1 && mo<=12 && d>=1 && d<=31) {
      return `${y}-${pad(mo)}-${pad(d)}`;
    }
  }

  // Fallback: try Date parse and reformat in LA tz
  const dt = new Date(str);
  if (!isNaN(dt)) {
    const parts = new Intl.DateTimeFormat('en-CA',{ timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' })
      .formatToParts(dt);
    const y = parts.find(p=>p.type==='year')?.value;
    const mo = parts.find(p=>p.type==='month')?.value;
    const d = parts.find(p=>p.type==='day')?.value;
    if (y && mo && d) return `${y}-${mo}-${d}`;
  }
  return null;
}

// DST-safe local offset maker
function laOffsetForYMD(ymd) {
  const [y,m,d] = ymd.split('-').map(Number);
  const noonUTC = new Date(Date.UTC(y, m-1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US',{ timeZone: TZ, timeZoneName:'short' }).formatToParts(noonUTC);
  const abbr = (parts.find(p=>p.type==='timeZoneName')?.value || '').toUpperCase();
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

    // Accept `date` in several formats
    const ymd = toYMD((req.query || {}).date);
    if (!ymd) return res.status(400).json({ error: 'date required (YYYY-MM-DD or MM/DD/YYYY)' });

    const pkg = String((req.query || {}).pkg || '');
    const calId = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const liveHours = hoursFromPkg(pkg);

    const { calendar } = await getOAuthCalendar();

    // Pull events for the local day
    const dayStartISO = isoAt(ymd, 0);
    const dayEndISO   = isoAt(ymd, 23);

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
      .map(e => ({ start: new Date(e.start?.dateTime || e.start?.date),
                   end:   new Date(e.end?.dateTime   || e.end?.date) }));

    if (events.length >= MAX_PER_DAY) return res.status(200).json({ slots: [] });

    // Candidate starts: 09:00..21:00
    const now = new Date();
    const slots = [];
    for (let h = HOURS_RANGE.start; h < HOURS_RANGE.end; h++) {
      const startISO = isoAt(ymd, h);
      if (new Date(startISO) < now) continue;

      const { blockStart, blockEnd } = fullBlock(startISO, liveHours);
      const overlapping = events.filter(ev => !(ev.end <= blockStart || ev.start >= blockEnd)).length;

      if (overlapping < MAX_PER_SLOT) slots.push({ startISO });
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    return res.status(500).json({ error: 'availability_failed', detail: String(e?.message || e) });
  }
}