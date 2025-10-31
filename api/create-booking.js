export const config = { runtime: 'nodejs' };

import { google } from 'googleapis';

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const CAL_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

const HOURS_RANGE = { start: 9, end: 22 };
const MAX_PER_SLOT = 2;
const MAX_PER_DAY  = 3;

function cors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const willAllow = allow.length ? allow.includes(origin) : true;

  res.setHeader('Access-Control-Allow-Origin', willAllow ? origin || '*' : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

function pkgToHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}
function opWindow(startISO, pkg){
  const PREP = 1, CLEAN = 1;
  const live = pkgToHours(pkg);
  const start = new Date(startISO);
  const opStart = new Date(start.getTime() - PREP * 3600_000);
  const opEnd   = new Date(start.getTime() + (live + CLEAN) * 3600_000);
  return { opStartISO: opStart.toISOString(), opEndISO: opEnd.toISOString(), live };
}
function dayRange(startISO){
  const d = new Date(startISO);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start.getTime() + 24*3600_000);
  return { dayStartISO: start.toISOString(), dayEndISO: end.toISOString() };
}
function localHour(iso, tz){
  const parts = new Intl.DateTimeFormat('en-US',{ timeZone: tz, hour:'2-digit', hour12:false })
    .formatToParts(new Date(iso));
  return Number(parts.find(p=>p.type==='hour')?.value || '0');
}
function assertWithinHours(startISO, tz){
  const hh = localHour(startISO, tz);
  if (hh < HOURS_RANGE.start || hh >= HOURS_RANGE.end) {
    const e = new Error(`outside_business_hours: ${hh}:00 not in ${HOURS_RANGE.start}:00–${HOURS_RANGE.end}:00 ${tz}`);
    e.status = 409; throw e;
  }
}
function pickTitle(mainBar, pkg) {
  const titleMap = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites (Corn Cups)',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  };
  const sizeMap = {
    '50-150-5h': '50–150',
    '150-250-5h': '150–250',
    '250-350-6h': '250–350',
  };
  return `${titleMap[mainBar] || 'Service'} — ${sizeMap[pkg] || pkg}`;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try {
    const {
      fullName, email, phone, venue,
      dateISO, startISO, pkg, mainBar,
      secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      discountMode, discountValue,
      deposit, total, balance, notes,
      affiliateName, affiliateEmail, pin,
      noDeposit
    } = req.body || {};

    if (!startISO) return res.status(400).json({ ok:false, error:'Missing startISO (pick a slot)' });

    // OAuth client
    const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
      return res.status(500).json({ ok:false, error:'Missing Google OAuth env vars' });
    }
    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
    const cal = google.calendar({ version: 'v3', auth: oAuth2Client });

    // Enforce hours + capacity BEFORE inserting
    assertWithinHours(startISO, TZ);

    const { opStartISO, opEndISO, live } = opWindow(startISO, String(pkg));
    const { dayStartISO, dayEndISO } = dayRange(startISO);

    const dayList = await cal.events.list({
      calendarId: CAL_ID, timeMin: dayStartISO, timeMax: dayEndISO,
      singleEvents: true, orderBy: 'startTime'
    });
    const dayCount = (dayList.data.items || []).filter(e => e.status !== 'cancelled').length;
    if (dayCount >= MAX_PER_DAY){
      return res.status(409).json({ ok:false, error:'capacity_day_limit', detail:'Max 3 events per day reached.' });
    }

    const overlapList = await cal.events.list({
      calendarId: CAL_ID, timeMin: opStartISO, timeMax: opEndISO,
      singleEvents: true, orderBy: 'startTime'
    });
    const overlapping = (overlapList.data.items || []).filter(ev=>{
      if (ev.status === 'cancelled') return false;
      const evStart = ev.start?.dateTime || ev.start?.date;
      const evEnd   = ev.end?.dateTime   || ev.end?.date;
      if (!evStart || !evEnd) return false;
      return !(new Date(evEnd) <= new Date(opStartISO) || new Date(evStart) >= new Date(opEndISO));
    }).length;
    if (overlapping >= MAX_PER_SLOT){
      return res.status(409).json({ ok:false, error:'capacity_overlap_limit', detail:'Max 2 concurrent events in the operational window.' });
    }

    // Build event (pretty description + totals)
    const summary = pickTitle(String(mainBar || ''), String(pkg || ''));
    const descriptionLines = [
      `👤 Client: ${fullName || ''}`,
      email ? `✉️ Email: ${email}` : '',
      phone ? `📞 Phone: ${phone}` : '',
      venue ? `📍 Venue: ${venue}` : '',
      '',
      `🍫 Main bar: ${summary}`,
      secondEnabled ? `➕ Second bar: ${String(secondBar||'-')} — ${String(secondSize||'-')}` : '',
      fountainEnabled ? `🫗 Chocolate fountain: ${String(fountainType||'-')} — ${String(fountainSize||'-')} ppl` : '',
      '',
      '💰 Totals:',
      `   • Total: $${Number(total||0).toFixed(0)}`,
      `   • Deposit: $${Number(deposit||0).toFixed(0)}`,
      `   • Balance: $${Number(balance||0).toFixed(0)}`,
      (discountMode && discountMode!=='none') ? `   • Discount: ${discountMode} ${discountValue||0}` : '',
      '',
      '⏱️ Timing:',
      `   • Prep: 1h before start`,
      `   • Service: ${live}h`,
      `   • Clean up: +1h after`,
      '',
      `🤝 Affiliate: ${affiliateName || ''}${affiliateEmail ? ` <${affiliateEmail}>` : ''}`,
      pin ? `🔑 PIN: ${pin}` : ''
    ].filter(Boolean);

    const attendees = [];
    if (email && /\S+@\S+\.\S+/.test(email)) attendees.push({ email: email.trim() });
    if (affiliateEmail && /\S+@\S+\.\S+/.test(affiliateEmail)) attendees.push({ email: affiliateEmail.trim() });

    // Block the full operational window
    const event = {
      summary,
      location: venue || '',
      description: descriptionLines.join('\n'),
      start: { dateTime: opStartISO, timeZone: TZ },
      end:   { dateTime: opEndISO,   timeZone: TZ },
      attendees,
      extendedProperties: {
        private: {
          pkg: String(pkg || ''),
          mainBar: String(mainBar || ''),
          secondEnabled: String(!!secondEnabled),
          secondBar: String(secondBar || ''),
          secondSize: String(secondSize || ''),
          fountainEnabled: String(!!fountainEnabled),
          fountainSize: String(fountainSize || ''),
          fountainType: String(fountainType || ''),
          affiliateName: String(affiliateName || ''),
          affiliateEmail: String(affiliateEmail || ''),
          pin: String(pin || '')
        }
      }
    };

    const created = await cal.events.insert({
      calendarId: CAL_ID,
      requestBody: event,
      sendUpdates: 'all'
    });

    const eventId = created?.data?.id || '';
    return res.status(200).json({ ok: true, eventId, noDeposit: !!noDeposit });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const body = e?.response?.data || null;
    return res.status(status).json({
      ok: false,
      error: 'create_booking_failed',
      hint: body || String(e?.message || e)
    });
  }
}