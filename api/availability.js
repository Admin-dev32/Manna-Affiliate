// /api/availability.js
import { getCalendar, TZ, toDateTz, listEventsOnDate } from '../_google';

// Reglas de negocio
const BUSINESS_OPEN_HOUR = 9;   // 9 AM
const BUSINESS_CLOSE_HOUR = 22; // 10 PM (la hora de inicio no puede pasar de aquí)
const MAX_CONCURRENT = 2;       // máx. 2 eventos a la vez
const MAX_PER_DAY = 3;          // máx. 3 eventos por día

// Duración por paquete (solo servicio)
function serviceHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

// Duración total = 1h buffer + servicio + 1h limpieza
function totalHours(pkg) {
  return 1 + serviceHours(pkg) + 1;
}

function addHours(date, h) {
  return new Date(date.getTime() + h * 60 * 60 * 1000);
}

function* generateStartTimes(dayStart) {
  // Genera cada 30 minutos entre 9:00 y 22:00
  const start = new Date(dayStart);
  start.setHours(BUSINESS_OPEN_HOUR, 0, 0, 0);

  const end = new Date(dayStart);
  end.setHours(BUSINESS_CLOSE_HOUR, 0, 0, 0);

  for (let t = new Date(start); t < end; t = new Date(t.getTime() + 30 * 60 * 1000)) {
    yield new Date(t);
  }
}

// Cuenta cuántos eventos existen solapando [start, end)
function concurrentAt(events, start, end) {
  let c = 0;
  for (const ev of events) {
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    // solapamiento: inicio < finOtro && fin > inicioOtro
    if (start < evEnd && end > evStart) c++;
  }
  return c;
}

export default async function handler(req, res) {
  try {
    const { date, hours, pkg } = req.query;

    if (!date) return res.status(400).json({ ok: false, error: 'Missing date' });

    const cal = await getCalendar();
    // Día en zona horaria de negocio
    const dayLocal = toDateTz(date, TZ); // 00:00 de ese día en TZ
    const dayEndLocal = addHours(dayLocal, 24);

    // Trae eventos del día (en TZ) para checar topes y solapamientos
    const events = await listEventsOnDate(cal, dayLocal, dayEndLocal);

    // Máximo por día
    if ((events || []).length >= MAX_PER_DAY) {
      return res.json({ ok: true, slots: [] });
    }

    // Duración total de la reserva por paquete
    const totalH = Number.isFinite(Number(hours)) ? Number(hours) : totalHours(pkg || '');
    const slots = [];

    for (const startLocal of generateStartTimes(dayLocal)) {
      const endLocal = addHours(startLocal, totalH);

      // No permitir que el bloque total empuje el fin del trabajo más allá de 23:59 del día
      if (endLocal > dayEndLocal) continue;

      // Checar concurrencia
      const conc = concurrentAt(events, startLocal, endLocal);
      if (conc >= MAX_CONCURRENT) continue;

      // Si al agregar este evento rebasaría el máximo por día, también descártalo
      if (events.length + 1 > MAX_PER_DAY) continue;

      // Publicar la hora en ISO (TZ correcta)
      slots.push({
        startISO: new Date(startLocal).toISOString(),
        endISO: new Date(endLocal).toISOString()
      });
    }

    res.json({ ok: true, slots });
  } catch (e) {
    console.error('availability error', e);
    res.status(500).json({ ok: false, error: e.message || 'Availability failed' });
  }
}
