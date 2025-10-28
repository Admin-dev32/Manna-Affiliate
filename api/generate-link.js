// /api/generate-link.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { resolveAffiliate, calcAffiliateCommissions } from './_affiliates.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ====== tabla de precios (igual que clientes) ======
const BASE_PRICES   = { "50-150-5h": 550, "150-250-5h": 700, "250-350-6h": 900 };
const SECOND_DISCOUNT = { "50-150-5h": 50, "150-250-5h": 75, "250-350-6h": 100 };
const FOUNTAIN_PRICE  = { "50": 350, "100": 450, "150": 550 };
const FOUNTAIN_WHITE_UPCHARGE = 50;
const FULL_FLAT_OFF = 20;

const BAR_META = {
  pancake:{ title:"🥞 Mini Pancake", priceAdd:0 },
  esquites:{ title:"🌽 Esquites", priceAdd:0 },
  maruchan:{ title:"🍜 Maruchan", priceAdd:0 },
  tostiloco:{ title:"🌶️ Tostiloco (Premium)", priceAdd:50 },
  snack:{ title:"🍭 Manna Snack Bar — “La Clásica”", priceAdd:0 }
};

function pkgToHours(pkg){ if(pkg==='50-150-5h')return 2; if(pkg==='150-250-5h')return 2.5; if(pkg==='250-350-6h')return 3; return 2; }
function usd(n){ return Math.round(n*100); }

function computeTotals(pb){
  const base0 = BASE_PRICES[pb.pkg]||0;
  const addMain = (BAR_META[pb.mainBar]?.priceAdd)||0;
  let sub = base0 + addMain;

  if(pb.secondEnabled && pb.secondSize){
    const b = BASE_PRICES[pb.secondSize]||0;
    const d = SECOND_DISCOUNT[pb.secondSize]||0;
    sub += Math.max(b - d, 0);
  }
  if(pb.fountainEnabled && pb.fountainSize){
    const f = FOUNTAIN_PRICE[pb.fountainSize]||0;
    const up = (pb.fountainType==='white'||pb.fountainType==='mixed')?FOUNTAIN_WHITE_UPCHARGE:0;
    sub += (f + up);
  }

  // descuentos del manager (amount o percent)
  let discount = 0;
  if(pb.discountMode==='amount') discount = Math.max(0, Number(pb.discountValue||0));
  if(pb.discountMode==='percent') discount = Math.max(0, sub * (Number(pb.discountValue||0)/100));

  const total = Math.max(0, sub - discount);
  let dueNow = 0, savings=0;
  if(pb.payMode==='full'){ savings = FULL_FLAT_OFF; dueNow = Math.max(0, total - FULL_FLAT_OFF); }
  else { dueNow = Math.round(total*0.25); }

  return { sub, discount, total, dueNow, savings };
}

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
    const pb = req.body || {};
    // 🔐 Afiliado obligatorio
    const aff = resolveAffiliate(String(pb.pin||'').trim());
    if(!aff) return res.status(401).json({ ok:false, error:'Invalid affiliate PIN' });

    if(!pb.pkg || !pb.mainBar || !pb.payMode){
      return res.status(400).json({ ok:false, error:'Missing fields (pkg, mainBar, payMode)' });
    }

    const totals = computeTotals(pb);
    const comm   = calcAffiliateCommissions(aff, { pkg: pb.pkg, secondEnabled: !!pb.secondEnabled });

    // Nombre de línea
    const labels = { "50-150-5h":"50–150 (5 hrs)", "150-250-5h":"150–250 (5 hrs)", "250-350-6h":"250–350 (6 hrs)" };
    const name = `Manna — ${(BAR_META[pb.mainBar]?.title)||'Snack Bar'} • ${labels[pb.pkg]||''} • ${pb.payMode==='full'?'Pay in full':'25% deposit'}`;

    const BASE_URL = (process.env.PUBLIC_URL || 'https://mannasnackbars.com').replace(/\/+$/,'');
    const successUrl = `${BASE_URL}/`;
    const cancelUrl  = `${BASE_URL}/`;

    const session = await stripe.checkout.sessions.create({
      mode:'payment',
      payment_method_types:['card'],
      allow_promotion_codes:false,
      line_items:[{ price_data:{ currency:'usd', product_data:{ name }, unit_amount: usd(totals.dueNow) }, quantity:1 }],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: {
        // booking / calendar
        pkg: pb.pkg, mainBar: pb.mainBar, payMode: pb.payMode,
        secondEnabled: String(!!pb.secondEnabled), secondBar: pb.secondBar||'', secondSize: pb.secondSize||'',
        fountainEnabled: String(!!pb.fountainEnabled), fountainSize: pb.fountainSize||'', fountainType: pb.fountainType||'',
        total: String(totals.total), dueNow: String(totals.dueNow),
        dateISO: pb.dateISO || '', startISO: pb.startISO || '',
        fullName: pb.fullName || pb.name || '', email: pb.email || '', phone: pb.phone || '',
        venue: pb.venue || '', setup: pb.setup || '', power: pb.power || '',
        hours: String(pkgToHours(pb.pkg)),

        // affiliate meta
        affiliateId: aff.id, affiliateName: aff.name,
        affMain: String(comm.main), affSecond: String(comm.second), affTotal: String(comm.totalCommission),

        // desglose precios (útil para debug)
        discountMode: pb.discountMode || 'none', discountValue: String(pb.discountValue||0),
        subtotal: String(totals.sub), discount: String(totals.discount)
      }
    });

    return res.json({ ok:true, url: session.url });
  }catch(e){
    console.error('generate-link error', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
