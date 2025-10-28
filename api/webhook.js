// /api/stripe/webhook.js
export const config = { api:{ bodyParser:false }, runtime:'nodejs' };

import Stripe from 'stripe';
import { getCalendarClient } from '../_google.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion:'2024-06-20' });
const PREP_HOURS=1, CLEAN_HOURS=1, DAY_CAP=2;

function pkgToHours(pkg){ if(pkg==='50-150-5h')return 2; if(pkg==='150-250-5h')return 2.5; if(pkg==='250-350-6h')return 3; return 2; }
function addH(d,h){ return new Date(d.getTime()+h*3600e3); }
async function raw(req){ const chunks=[]; for await(const c of req) chunks.push(c); return Buffer.concat(chunks); }
function overlaps(a1,a2,b1,b2){ return !(a2<=b1 || a1>=b2); }

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).send('Method not allowed');

  // verificar firma de ESTE webhook
  let event;
  try{
    const buf = await raw(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET_AFF);
  }catch(err){
    console.error('[aff webhook] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if(event.type!=='checkout.session.completed'){
    return res.json({ received:true, ignored:event.type });
  }

  const s = event.data.object;
  const md = s.metadata || {};
  try{
    const calendar = getCalendarClient();
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';

    const live = Number(md.hours||0) || pkgToHours(md.pkg);
    const startISO = md.startISO;
    if(!startISO || !live) return res.json({ received:true, skipped:true });

    const blockStart = addH(new Date(startISO), -PREP_HOURS);
    const blockEnd   = addH(new Date(startISO),  live + CLEAN_HOURS);

    const day = new Date(startISO);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0,0,0));
    const dayEnd   = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23,59,59));

    const list = await calendar.events.list({
      calendarId: calId, timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
      singleEvents:true, orderBy:'startTime', maxResults:100
    });
    const items = (list.data.items||[]).filter(e=>e.status!=='cancelled');

    // capacidad/traslape
    if(items.length >= DAY_CAP) return res.json({ received:true, capacity:'full' });
    const clash = items.some(e=>{
      const s1 = new Date(e.start?.dateTime || e.start?.date);
      const e1 = new Date(e.end?.dateTime   || e.end?.date);
      return overlaps(blockStart, blockEnd, s1, e1);
    });
    if(clash) return res.json({ received:true, conflict:'overlap' });

    const desc = [
      `AFFILIATE CHECKOUT — ${md.affiliateName || md.affiliateId || ''}`,
      `Commission: main $${md.affMain||0} + second $${md.affSecond||0} = total $${md.affTotal||0}`,
      md.fullName ? `Client: ${md.fullName}` : '',
      md.email ? `Email: ${md.email}` : '',
      md.phone ? `Phone: ${md.phone}` : '',
      md.venue ? `Venue: ${md.venue}` : '',
      `Package: ${md.pkg} — Main: ${md.mainBar}`,
      md.secondEnabled==='true' ? `Second: ${md.secondBar} — size ${md.secondSize}` : '',
      md.fountainEnabled==='true' ? `Fountain: ${md.fountainSize} (${md.fountainType})` : '',
      `Total: $${md.total} | Paid now: $${md.dueNow}`,
      `Stripe session: ${s.id}`
    ].filter(Boolean).join('\n');

    await calendar.events.insert({
      calendarId: calId,
      requestBody:{
        summary:`Manna — ${md.mainBar || 'Booking'} (${md.pkg}) — AFF:${md.affiliateId || ''}`,
        description: desc,
        start:{ dateTime:blockStart.toISOString(), timeZone:tz },
        end:{   dateTime:blockEnd.toISOString(),   timeZone:tz },
        guestsCanInviteOthers:false, guestsCanModify:false, guestsCanSeeOtherGuests:false,
        extendedProperties:{ private:{ orderId:s.id, affiliateId: md.affiliateId || '' } }
      },
      sendUpdates:'none'
    });

    return res.json({ received:true, created:true });
  }catch(e){
    console.error('[aff webhook] error:', e);
    return res.status(200).json({ received:true, error:e.message });
  }
}
