// /api/create-booking.js
export const config = { runtime: 'nodejs' };

import { resolveAffiliate } from './_affiliates.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') try { return JSON.parse(req.body); } catch { return {}; }
  return req.body;
}

function labelForPkg(pkg){
  const map = {
    "50-150-5h":"50–150",
    "150-250-5h":"150–250",
    "250-350-6h":"250–350",
  };
  return map[pkg] || pkg;
}
function labelForBar(key){
  const map = {
    pancake: 'Mini Pancake',
    maruchan: 'Maruchan',
    esquites: 'Esquites',
    snack: 'Manna Snack — Classic',
    tostiloco: 'Tostiloco (Premium)',
  };
  return map[key] || key;
}
function isEmail(x){ return typeof x === 'string' && /\S+@\S+\.\S+/.test(x); }

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try {
    const data = parseBody(req);

    // ---------- Required fields ----------
    const {
      fullName='', email='', phone='', venue='',
      dateISO='', startISO='',
      pkg='', mainBar='',
      secondEnabled=false, secondBar='', secondSize='',
      fountainEnabled=false, fountainSize='', fountainType='',
      notes='',
      total=0, deposit=0, balance=0,
      noDeposit=false,
      pin=''
    } = data || {};

    if (!startISO) return res.status(400).json({ ok:false, error:'Missing startISO' });

    const aff = resolveAffiliate(pin) || { id:'', name:'', email:'' };

    // ---------- Time math ----------
    const liveHoursByPkg = { "50-150-5h":2, "150-250-5h":2.5, "250-350-6h":3 };
    const PREP_H = 1, CLEAN_H = 1;
    const live = liveHoursByPkg[pkg] || 2;
    const start = new Date(startISO);
    const end = new Date(start.getTime() + live*3600e3 + CLEAN_H*3600e3); // service + cleanup
    const blockStart = new Date(start.getTime() - PREP_H*3600e3);         // arrive 1h early

    // ---------- Event title ----------
    const parts = [
      'Manna Snack Bars',
      `— ${labelForPkg(pkg)}`,
      `— ${labelForBar(mainBar)}`
    ];
    if (secondEnabled && secondBar) parts.push(`+ ${labelForBar(secondBar)}`);
    parts.push(`— ${fullName || 'Client'}`);
    if (noDeposit) parts.push(' (No deposit)');
    const summary = parts.join(' ');

    // ---------- Description ----------
    const lines = [
      `Client: ${fullName || '(none)'}`,
      `Email: ${email || '(none)'}`,
      `Phone: ${phone || '(none)'}`,
      `Venue: ${venue || '(none)'}`,
      `Package: ${labelForPkg(pkg)} — main: ${labelForBar(mainBar)}`,
    ];
    if (secondEnabled && secondBar) lines.push(`Second bar: ${labelForBar(secondBar)} (${labelForPkg(secondSize) || secondSize || '-'})`);
    if (fountainEnabled) lines.push(`Fountain: ${fountainSize || '?'} — ${fountainType || 'dark'}`);
    lines.push(`Totals: total $${total} — deposit $${deposit} — balance $${balance}`);
    lines.push(`Affiliate: ${aff.name || '(none)'}${aff.email ? ' <'+aff.email+'>' : ''}`);
    if (notes) lines.push('', `Notes: ${notes}`);
    const description = lines.join('\n');

    // ---------- Google Calendar client ----------
    const { google } = await import('googleapis');
    let clientEmail, privateKey;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      clientEmail = sa.client_email;
      privateKey = (sa.private_key || '').replace(/\\n/g, '\n');
    } else {
      clientEmail = process.env.GCP_CLIENT_EMAIL;
      privateKey = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    }
    const jwt = new google.auth.JWT(clientEmail, null, privateKey, [
      'https://www.googleapis.com/auth/calendar'
    ]);
    const calendar = google.calendar({ version:'v3', auth: jwt });

    const calendarId = process.env.CALENDAR_ID || 'primary';
    const timezone = process.env.TIMEZONE || 'America/Los_Angeles';

    // ---------- Attendees (client + affiliate) ----------
    const attendees = [];
    if (isEmail(email)) attendees.push({ email });
    if (isEmail(aff.email)) attendees.push({ email: aff.email });

    // ---------- Insert event ----------
    const rsp = await calendar.events.insert({
      calendarId,
      sendUpdates: attendees.length ? 'all' : 'none',
      requestBody: {
        summary,
        description,
        location: venue || undefined,
        start: { dateTime: blockStart.toISOString(), timeZone: timezone },
        end:   { dateTime: end.toISOString(),        timeZone: timezone },
        attendees: attendees.length ? attendees : undefined,
        extendedProperties: {
          private: {
            pkg,
            mainBar,
            secondEnabled: String(!!secondEnabled),
            secondBar,
            secondSize,
            fountainEnabled: String(!!fountainEnabled),
            fountainSize, fountainType,
            total: String(total), deposit: String(deposit), balance: String(balance),
            affiliateId: aff.id || '', affiliateName: aff.name || '', affiliateEmail: aff.email || ''
          }
        }
      }
    });

    return res.status(200).json({ ok:true, eventId: rsp.data.id || null });
  } catch (e) {
    console.error('create-booking error', e);
    return res.status(500).json({ ok:false, error:e.message || 'create_booking_failed' });
  }
}
