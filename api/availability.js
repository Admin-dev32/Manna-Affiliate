// api/availability.js
import { sendJSON, handleOptions } from './_utils/cors';

// Expect query: ?date=YYYY-MM-DD&hours=2.5
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method !== 'GET') return sendJSON(res, 405, { ok:false, error:'Method not allowed' });

  try {
    const { date, hours } = req.query || {};
    if (!date) return sendJSON(res, 400, { ok:false, error:'Missing date' });
    const h = parseFloat(hours || '2');
    if (Number.isNaN(h) || h <= 0) return sendJSON(res, 400, { ok:false, error:'Invalid hours' });

    // TODO: plug your real availability logic here (Google Calendar free/busy, etc.)
    // For now, return a basic set of demo slots each hour from 10:00–17:00.
    const base = new Date(`${date}T10:00:00Z`);
    const slots = [];
    for (let i = 0; i < 8; i++) {
      const start = new Date(base.getTime() + i * 60 * 60 * 1000);
      slots.push({ startISO: start.toISOString(), hours: h });
    }
    return sendJSON(res, 200, { ok:true, slots });
  } catch (e) {
    return sendJSON(res, 500, { ok:false, error:e.message });
  }
}
