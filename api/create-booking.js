// /api/create-booking.js
export const config = { runtime: 'nodejs' };

import { getCalendarClient } from './_google.js';
import { resolveAffiliate, calcAffiliateCommissions } from './_affiliates.js';

const PREP_HOURS = 1, CLEAN_HOURS = 1;
function pkgToHours(pkg){ if(pkg==='50-150-5h')return 2; if(pkg==='150-250-5h')return 2.5; if(pkg==='250-350-6h')return 3; return 2; }
function addH(d,h){ return new Date(d.getTime()+h*3600e3); }

export default async function handler(req,res){
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary','Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary','Origin');

  if (req.method!=='POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
    const pb = req.body || {};
    // 🔐 Afiliado obligatorio
    const aff = resolveAffiliate(String(pb.pin||'').trim());
    if(!aff) return res.status(401).json({ ok:false, error:'Invalid affiliate PIN' });

    if(!pb.startISO || !pb.pkg) return res.status(400).json({ ok:false, error:'startISO and pkg required' });

    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const calendar = getCalendarClient();

    const live = pkgToHours(pb.pkg);
    const startLive = new Date(pb.startISO);
    const startISO = addH(startLive, -PREP_HOURS).toISOString();
    const endISO   = addH(startLive,  live + CLEAN_HOURS).toISOString();

    // comisiones
    const comm = calcAffiliateCommissions(aff, { pkg: pb.pkg, secondEnabled: !!pb.secondEnabled });

    const description = [
      `MANAGER CREATE — affiliate`,
      `Affiliate: ${aff.name} (${aff.id}) — Commission: $${comm.main} + $${comm.second} = $${comm.totalCommission}`,
      pb.fullName ? `Client: ${pb.fullName}` : '',
      pb.email ? `Email: ${pb.email}` : '',
      pb.phone ? `Phone: ${pb.phone}` : '',
      pb.venue ? `Venue: ${pb.venue}` : '',
      `Package: ${pb.pkg} — Main: ${pb.mainBar}`,
      pb.secondEnabled ? `Second: ${pb.secondBar} — size ${pb.secondSize}` : '',
      pb.fountainEnabled ? `Fountain: ${pb.fountainSize} (${pb.fountainType})` : '',
      `Total: $${pb.total} | Deposit: $${pb.deposit} | Balance: $${pb.balance}`,
      pb.notes ? `Notes: ${pb.notes}` : ''
    ].filter(Boolean).join('\n');

    const ev = await calendar.events.insert({
      calendarId: calId,
      requestBody:{
        summary:`Manna — ${pb.mainBar || 'Booking'} (${pb.pkg}) — AFF:${aff.id}`,
        description,
        start:{ dateTime: startISO, timeZone: tz },
        end:{ dateTime: endISO, timeZone: tz },
        colorId:'7',
        guestsCanInviteOthers:false, guestsCanModify:false, guestsCanSeeOtherGuests:false,
        extendedProperties:{ private:{ affiliateId: aff.id } }
      },
      sendUpdates:'none'
    });

    return res.json({ ok:true, message:'Booking created', id:ev.data.id });
  }catch(e){
    console.error('create-booking (aff) error', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
