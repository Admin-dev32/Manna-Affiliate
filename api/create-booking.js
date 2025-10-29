// /api/create-booking.js
export const config = { runtime: 'nodejs' };

const PREP_HOURS = 1;
const CLEAN_HOURS = 1;

function pkgToHours(pkg){
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function addHours(d, h){ return new Date(d.getTime() + h*3600e3); }

export default async function handler(req, res){
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
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

  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
    const body = req.body || {};
    const {
      startISO, dateISO, pkg, mainBar, fullName, email, phone, venue,
      secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      total, deposit, balance,
      pin, affiliateName
    } = body;

    if (!startISO || !pkg) return res.status(400).json({ ok:false, error:'Missing startISO or pkg' });

    // Google client (igual que health/availability)
    const { google } = await import('googleapis');               // :contentReference[oaicite:11]{index=11}
    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
    const sa = JSON.parse(saRaw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

    const jwt = new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version:'v3', auth: jwt }); // :contentReference[oaicite:12]{index=12}
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';

    const liveHrs = pkgToHours(pkg);
    const start = new Date(startISO);
    const blockStart = addHours(start, -PREP_HOURS);
    const blockEnd   = addHours(start,  liveHrs + CLEAN_HOURS);

    const description = [
      `Name: ${fullName||''}`,
      email ? `Email: ${email}` : '',
      phone ? `Phone: ${phone}` : '',
      venue ? `Venue: ${venue}` : '',
      `Package: ${pkg} • Bar: ${mainBar||''}`,
      secondEnabled ? `2nd Bar: ${secondBar||''} (${secondSize||''})` : '',
      fountainEnabled ? `Fountain: ${fountainSize||''} ${fountainType ? '('+fountainType+')':''}` : '',
      (total!=null) ? `Totals: total $${total} | deposit $${deposit||0} | balance $${balance||0}` : '',
      affiliateName ? `Affiliate: ${affiliateName} (PIN ${pin||''})` : (pin ? `Affiliate PIN: ${pin}` : ''),
      dateISO ? `Date: ${dateISO}` : '',
      `Start live: ${startISO}`,
      `Service hours: ${liveHrs}`
    ].filter(Boolean).join('\n');

    const ev = await calendar.events.insert({
      calendarId: calId,
      requestBody:{
        summary: `Manna Snack Bars — ${mainBar||'Booking'} (${pkg})`,
        description,
        location: venue || '',
        start: { dateTime: blockStart.toISOString(), timeZone: tz },
        end:   { dateTime: blockEnd.toISOString(),   timeZone: tz },
        // sin attendees para evitar problemas de delegación (igual que webhook) :contentReference[oaicite:13]{index=13}
        extendedProperties: { private: { orderId: `no-deposit-${Date.now()}` } },
        guestsCanInviteOthers:false, guestsCanModify:false, guestsCanSeeOtherGuests:false
      },
      sendUpdates:'none'
    });

    return res.json({ ok:true, eventId: ev.data.id });
  }catch(e){
    console.error('create-booking error', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
