// /api/create-booking.js
export const config = { runtime: 'nodejs' };

import { google } from 'googleapis';

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

function titleMap(v){ return ({
  pancake:'Mini Pancake', maruchan:'Maruchan', esquites:'Esquites (Corn Cups)',
  snack:'Manna Snack — Classic', tostiloco:'Tostiloco (Premium)'
})[v] || 'Service'; }
function sizeMap(v){ return ({
  '50-150-5h':'50–150', '150-250-5h':'150–250', '250-350-6h':'250–350'
})[v] || v; }

function pkgToHours(pkg){ if(pkg==='50-150-5h') return 2; if(pkg==='150-250-5h') return 2.5; if(pkg==='250-350-6h') return 3; return 2; }

export default async function handler(req, res){
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
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

    const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
      return res.status(500).json({ ok:false, error:'Missing Google OAuth env vars' });
    }

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oAuth2Client.setCredentials({ refresh_token: refreshToken });

    const calendarId = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';

    const start = new Date(startISO);
    const liveHours = pkgToHours(String(pkg));
    const end = new Date(start.getTime() + liveHours * 3600 * 1000);

    const summary = `Manna Snack Bars — ${titleMap(String(mainBar||''))} — ${sizeMap(String(pkg||''))} — ${String(fullName||'')}`;

    // 💄 Formato igual al webhook + Totals
    const lines = [
      `📦 Package: ${sizeMap(String(pkg||''))}`,
      `🍫 Main bar: ${titleMap(String(mainBar||''))}`,
      venue ? `📍 Venue: ${venue}` : '',
      '',
      `⏱️ Prep: 1h before start`,
      `⏱️ Service: ${liveHours}h (+ 1h cleaning)`,
      '',
      `💰 Totals:`,
      `   • Total: $${Number(total||0).toFixed(0)}`,
      `   • Deposit: $${Number(deposit||0).toFixed(0)}`,
      `   • Balance: $${Number(balance||0).toFixed(0)}`,
      '',
      notes ? `📝 Notes: ${notes}` : '',
      '',
      `👤 Affiliate: ${affiliateName || ''}${affiliateEmail ? ` <${affiliateEmail}>` : ''}${pin ? ` (PIN: ${pin})` : ''}`,
      '',
      `👤 Client: ${fullName || ''}${email ? ` <${email}>` : ''}${phone ? ` | ${phone}` : ''}`,
    ].filter(Boolean);

    const attendees = [];
    if (email && /\S+@\S+\.\S+/.test(email)) attendees.push({ email: email.trim() });
    if (affiliateEmail && /\S+@\S+\.\S+/.test(affiliateEmail)) attendees.push({ email: affiliateEmail.trim() });

    const event = {
      summary,
      location: venue || '',
      description: lines.join('\n'),
      start: { dateTime: start.toISOString(), timeZone: tz },
      end:   { dateTime: end.toISOString(),   timeZone: tz },
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

    const cal = google.calendar({ version: 'v3', auth: oAuth2Client });

    const created = await cal.events.insert({
      calendarId,
      requestBody: event,
      sendUpdates: 'all'
    });

    return res.status(200).json({ ok: true, eventId: created?.data?.id || '', noDeposit: !!noDeposit });
  } catch (e) {
    const status = e?.response?.status || 500;
    const body = e?.response?.data || null;
    return res.status(status).json({
      ok: false,
      error: 'create_booking_failed',
      hint: body || String(e?.message || e)
    });
  }
}