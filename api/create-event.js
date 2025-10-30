// /api/create-event.js
export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from './_cors.js';
import { getOAuthCalendar } from './_google.js';
import { resolveAffiliate } from './_affiliates.js';

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CAL_ID = process.env.CALENDAR_ID || 'primary';

const s = (v, fb='') => (typeof v === 'string' ? v : fb).trim();

function pkgLabel(v){
  const m = {
    '50-150-5h': '50–150 (5h window)',
    '150-250-5h': '150–250 (5h window)',
    '250-350-6h': '250–350 (6h window)',
  }; return m[v] || v || '';
}
function barLabel(v){
  const m = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites (Corn Cups)',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  }; return m[v] || v || 'Bar';
}
function serviceHours(pkg){
  if (pkg==='50-150-5h') return 2;
  if (pkg==='150-250-5h') return 2.5;
  if (pkg==='250-350-6h') return 3;
  return 2;
}
function opWindow(startISO, pkg){
  // Ventana operacional: 1h prep antes + servicio + 1h limpieza
  const PREP = 1, CLEAN = 1;
  const live = serviceHours(pkg);
  const start = new Date(startISO);
  const opStart = new Date(start.getTime() - PREP * 3600_000);
  const opEnd   = new Date(start.getTime() + (live + CLEAN) * 3600_000);
  return { opStartISO: opStart.toISOString(), opEndISO: opEnd.toISOString() };
}
function dayRange(dateISO){
  const d = new Date(dateISO);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start.getTime() + 24*3600_000);
  return { dayStartISO: start.toISOString(), dayEndISO: end.toISOString() };
}

export default async function handler(req, res){
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS'){
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

  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'method_not_allowed' });

  try{
    const body = req.body || {};
    const pin = s(body.pin);
    const aff = resolveAffiliate(pin);
    if (!aff) return res.status(400).json({ ok:false, error:'invalid_pin' });

    const startISO  = s(body.startISO);
    const pkg       = s(body.pkg);
    const mainBar   = s(body.mainBar);
    const fullName  = s(body.fullName);
    const venue     = s(body.venue);
    const notes     = s(body.notes);
    const dateISO   = s(body.dateISO) || startISO;

    if (!startISO || !pkg || !mainBar || !fullName){
      return res.status(400).json({ ok:false, error:'missing_fields' });
    }

    const { opStartISO, opEndISO } = opWindow(startISO, pkg);

    // === Reglas de capacidad ===
    const calendar = await getOAuthCalendar();

    // 1) Max 3 eventos por día (contando cualquiera que caiga en ese día)
    const { dayStartISO, dayEndISO } = dayRange(startISO);
    const dayList = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: dayStartISO,
      timeMax: dayEndISO,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const dayCount = (dayList.data.items || []).length;
    if (dayCount >= 3){
      return res.status(409).json({ ok:false, error:'capacity_day_limit', detail:'Max 3 events per day reached.' });
    }

    // 2) Max 2 eventos superpuestos dentro de la ventana operacional (prep + servicio + limpieza)
    const overlapList = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: opStartISO,
      timeMax: opEndISO,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const overlapping = (overlapList.data.items || []).filter(ev=>{
      const evStart = ev.start?.dateTime || ev.start?.date;
      const evEnd   = ev.end?.dateTime   || ev.end?.date;
      if (!evStart || !evEnd) return false;
      // si se tocan se consideran solapados (ventana cerrada)
      return !(new Date(evEnd) <= new Date(opStartISO) || new Date(evStart) >= new Date(opEndISO));
    }).length;
    if (overlapping >= 2){
      return res.status(409).json({ ok:false, error:'capacity_overlap_limit', detail:'Max 2 concurrent events in the operational window.' });
    }

    // ===== Crear evento (con invitados) =====
    const attendees = [];
    const clientEmail    = s(body.email);
    const affiliateEmail = s(body.affiliateEmail);
    if (clientEmail) attendees.push({ email: clientEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    const liveHrs = serviceHours(pkg);
    const endServiceISO = new Date(new Date(startISO).getTime() + liveHrs * 3600_000).toISOString();

    const title = `Manna Snack Bars — ${barLabel(mainBar)} — ${pkgLabel(pkg)} — ${fullName}`;

    const event = {
      summary: title,
      location: venue || undefined,
      description: [
        `📦 Package: ${pkgLabel(pkg)}`,
        `🍫 Main bar: ${barLabel(mainBar)}`,
        body.secondEnabled ? `➕ Second bar: ${barLabel(s(body.secondBar))} (${pkgLabel(s(body.secondSize))})` : '',
        body.fountainEnabled ? `🍫 Chocolate fountain: ${s(body.fountainType)} for ${s(body.fountainSize)} ppl` : '',
        notes ? `📝 Notes: ${notes}` : '',
        '',
        `⏱️ Prep: 1h before start`,
        `⏱️ Service: ${liveHrs}h (+ 1h cleanup)`,
        `🧮 Operational window: ${new Date(opStartISO).toLocaleString('en-US',{timeZone:TZ})} → ${new Date(opEndISO).toLocaleString('en-US',{timeZone:TZ})}`,
        '',
        `👤 Affiliate: ${aff.name} (PIN: ${pin})`,
      ].filter(Boolean).join('\n'),
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endServiceISO, timeZone: TZ },
      attendees: attendees.length ? attendees : undefined,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: true },
    };

    const rsp = await calendar.events.insert({
      calendarId: CAL_ID,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: event,
    });

    return res.status(200).json({ ok:true, eventId: rsp.data?.id || null });
  } catch (e){
    const detail = e?.response?.data || e?.message || String(e);
    console.error('[create-event] error', detail);
    return res.status(500).json({ ok:false, error:'create_event_failed', detail });
  }
}
