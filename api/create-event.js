// /api/create-event.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js'; // debe devolver cliente OAuth2 con token válido
import { resolveAffiliate } from './_affiliates.js';

function safeStr(v, fb = '') { return (typeof v === 'string' ? v : fb).trim(); }

function pkgLabel(v) {
  const map = {
    '50-150-5h': '50–150 (5h ventana)',
    '150-250-5h': '150–250 (5h ventana)',
    '250-350-6h': '250–350 (6h ventana)',
  };
  return map[v] || v || '';
}

function barLabel(v) {
  const map = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  };
  return map[v] || v || 'Bar';
}

function hoursFromPkg(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

// Convierte startISO a endISO sumando servicio + 1h clean, y asume 1h de prep antes (solo lo ponemos en descripción)
function computeEndISO(startISO, pkg) {
  const live = hoursFromPkg(pkg);
  const CLEAN_HOURS = 1;
  const start = new Date(startISO);
  const end = new Date(start.getTime() + (live + CLEAN_HOURS) * 3600 * 1000);
  return end.toISOString();
}

export default async function handler(req, res) {
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const body = req.body || {};
    const pin = safeStr(body.pin);
    const aff = resolveAffiliate(pin);
    if (!aff) {
      return res.status(400).json({ ok: false, error: 'invalid_pin' });
    }

    const startISO = safeStr(body.startISO);
    const pkg = safeStr(body.pkg);
    const mainBar = safeStr(body.mainBar);
    const fullName = safeStr(body.fullName);
    const venue = safeStr(body.venue);
    const notes = safeStr(body.notes);

    if (!startISO || !pkg || !mainBar || !fullName) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const endISO = computeEndISO(startISO, pkg);

    // 📧 Invitados (cliente + afiliado si tienen correo)
    const attendees = [];
    const clientEmail = safeStr(body.email);
    const affiliateEmail = safeStr(body.affiliateEmail);
    if (clientEmail) attendees.push({ email: clientEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    // Título claro (sin "Manager")
    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;

    const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const calendar = await getOAuthCalendar(); // usa OAUTH (no service account)

    const event = {
      summary: title,
      location: venue || undefined,
      description: [
        `📦 Paquete: ${pkgLabel(pkg)}`,
        `🍫 Barra principal: ${barLabel(mainBar)}`,
        body.secondEnabled ? `➕ Segunda barra: ${barLabel(safeStr(body.secondBar))} (${pkgLabel(safeStr(body.secondSize))})` : '',
        body.fountainEnabled ? `🍫 Fuente de chocolate: ${safeStr(body.fountainType)} para ${safeStr(body.fountainSize)} personas` : '',
        notes ? `📝 Notas: ${notes}` : '',
        '',
        `⏱️ Preparación: 1h antes del inicio`,
        `⏱️ Servicio: ${hoursFromPkg(pkg)}h (+ 1h limpieza)`,
        '',
        `👤 Afiliado: ${aff.name} (PIN: ${pin})`
      ].filter(Boolean).join('\n'),
      start: { dateTime: startISO },
      end:   { dateTime: endISO },
      attendees: attendees.length ? attendees : undefined,
      guestsCanSeeOtherGuests: true,
      reminders: {
        useDefault: true
      },
    };

    // Enviar invitaciones a los asistentes
    const rsp = await calendar.events.insert({
      calendarId: calId,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: event
    });

    const created = rsp.data || {};
    return res.status(200).json({ ok: true, eventId: created.id || null });
  } catch (e) {
    console.error('create-event error', e);
    return res.status(500).json({ ok: false, error: 'create_event_failed', detail: e.message });
  }
}
