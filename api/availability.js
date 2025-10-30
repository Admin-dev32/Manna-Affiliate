// /api/availability.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';

// === Parámetros de negocio ===
const TIMEZONE = process.env.TIMEZONE || 'America/Los_Angeles';
const HOURS_RANGE = { start: 9, end: 22 };          // Start times permitidos: 09:00 → 22:00
const PREP_HOURS = 1;
const CLEAN_HOURS = 1;
const MAX_CONCURRENT = 2;                            // Máximo 2 eventos superpuestos en la ventana completa
const MAX_PER_DAY = 3;                               // Máximo 3 eventos por día

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  // default
  return 2;
}

// Convierte YYYY-MM-DD + hora local -> ISO UTC estable
function zonedISO(ymd, hour, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  // Creamos un Date en UTC “aproximado”
  const guessUtc = Date.UTC(y, m - 1, d, hour, 0, 0);
  // Lo renderizamos en tz y medimos el offset real
  const asLocal = new Date(new Date(guessUtc).toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = asLocal.getTime() - guessUtc;
  return new Date(guessUtc - offsetMs).toISOString();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return (aStart < bEnd) && (aEnd > bStart);
}

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
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const { date, pkg } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const liveHours = hoursFromPkg(String(pkg || ''));

    // OAuth Calendar
    const calendar = await getOAuthCalendar(); // ya debe tener tokens (GOOGLE_OAUTH_REFRESH_TOKEN)
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    // Rango del día (local 00:00 → 24:00) convertido a ISO
    const dayStartISO = zonedISO(date, 0, TIMEZONE);
    const dayEndISO   = zonedISO(date, 24, TIMEZONE);

    // Leemos todos los eventos del día
    const list = await calendar.events.list({
      calendarId,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250
    });

    const items = (list.data.items || []).filter(e => e.status !== 'cancelled');

    // Tope diario: si ya hay >= MAX_PER_DAY → no slots
    if (items.length >= MAX_PER_DAY) {
      return res.status(200).json({ slots: [] });
    }

    // Normalizamos a rangos Date (start/end)
    const existing = items.map(e => {
      const s = e.start?.dateTime || e.start?.date;
      const en = e.end?.dateTime || e.end?.date;
      return {
        start: new Date(s),
        end: new Date(en)
      };
    });

    // Generamos candidatos (cada hora)
    const now = new Date();
    const slots = [];
    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++) {
      const startISO = zonedISO(date, h, TIMEZONE);
      const start = new Date(startISO);

      // omitimos horas pasadas
      if (start < now) continue;

      // Ventana completa que debemos respetar
      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd   = new Date(start.getTime() + (liveHours + CLEAN_HOURS) * 3600e3);

      // Contamos cuántos eventos del calendario pisan esta ventana completa
      const concurrent = existing.reduce((acc, ev) => {
        return acc + (overlaps(blockStart, blockEnd, ev.start, ev.end) ? 1 : 0);
      }, 0);

      // Permitimos el slot solo si hay menos de MAX_CONCURRENT superpuestos
      if (concurrent < MAX_CONCURRENT) {
        slots.push({ startISO: start.toISOString() });
      }
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error('availability error', e?.response?.data || e);
    return res.status(500).json({ error: 'availability_failed', detail: String(e?.message || e) });
  }
}
