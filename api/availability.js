// /api/availability.js
import { applyCors, preflight } from './_cors.js';
import { getCalendarClient, fetchBusyForDate } from './_google.js';

function toISO(date) { return new Date(date).toISOString(); }

// Generate candidate start times (local day → convert to UTC ISO)
function generateCandidateSlots(localDateStr, blockHours) {
  // business window: 9:00–20:00 local (feel free to adjust)
  const starts = [];
  const [y, m, d] = localDateStr.split('-').map(Number);
  for (let h = 9; h <= 18; h++) { // last start at 18:00 for 2h block
    const dt = new Date(y, m - 1, d, h, 0, 0); // local time
    const end = new Date(dt.getTime() + blockHours * 60 * 60 * 1000);
    starts.push({ start: dt, end });
  }
  return starts;
}

function isFree(candidate, busy) {
  return !busy.some(b => {
    // overlaps if candidate.start < b.end && candidate.end > b.start
    return candidate.start < b.end && candidate.end > b.start;
  });
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  try {
    const { date, hours } = req.query || {};
    if (!date) return res.status(400).json({ ok: false, error: 'Missing date' });
    const blockHours = Math.max(1, Number(hours || 2));

    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) {
      // Fallback: return simple “open” slots if calendar missing
      const simple = generateCandidateSlots(date, blockHours).map(s => ({
        startISO: toISO(s.start), endISO: toISO(s.end)
      }));
      return res.status(200).json({ ok: true, slots: simple });
    }

    const busy = await fetchBusyForDate(calendar, calendarId, date);
    const candidates = generateCandidateSlots(date, blockHours);
    const free = candidates.filter(c => isFree(c, busy))
      .map(s => ({ startISO: toISO(s.start), endISO: toISO(s.end) }));

    return res.status(200).json({ ok: true, slots: free });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Availability error' });
  }
}
