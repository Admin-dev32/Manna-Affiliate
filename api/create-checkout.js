// /api/create-checkout.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { resolveAffiliate, calcAffiliateCommissions } from './_affiliates.js';

// If you already have a CORS helper, keep this import; otherwise you can remove it.
let cors = null;
try { ({ cors } = await import('./_cors.js')); } catch {}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ===== Customer-facing base prices (same as client flow) =====
const BASE_PRICES   = { "50-150-5h": 550, "150-250-5h": 700, "250-350-6h": 900 };
const SECOND_DISCOUNT = { "50-150-5h": 50, "150-250-5h": 75, "250-350-6h": 100 };
const FOUNTAIN_PRICE  = { "50": 350, "100": 450, "150": 550 };
const FOUNTAIN_WHITE_UPCHARGE = 50;
const FULL_FLAT_OFF = 20;

const BAR_META = {
  pancake:{ title:"Mini Pancake", priceAdd:0 },
  esquites:{ title:"Esquites (Corn Cups)", priceAdd:0 },
  maruchan:{ title:"Maruchan", priceAdd:0 },
  tostiloco:{ title:"Tostiloco (Premium)", priceAdd:50 },
  snack:{ title:"Manna Snack Bar — Classic", priceAdd:0 }
};

function usd(n){ return Math.round(Number(n||0) * 100); }
function pkgToHours(pkg){
  if(pkg==='50-150-5h') return 2;
  if(pkg==='150-250-5h') return 2.5;
  if(pkg==='250-350-6h') return 3;
  return 2;
}

function computeTotals(pb){
  const base0 = BASE_PRICES[pb.pkg] || 0;
  const addMain = (BAR_META[pb.mainBar]?.priceAdd) || 0;
  let subtotal = base0 + addMain;

  if(pb.secondEnabled && pb.secondSize){
    const b = BASE_PRICES[pb.secondSize] || 0;
    const d = SECOND_DISCOUNT[pb.secondSize] || 0;
    subtotal += Math.max(b - d, 0);
  }

  if(pb.fountainEnabled && pb.fountainSize){
    const f = FOUNTAIN_PRICE[pb.fountainSize] || 0;
    const up = (pb.fountainType==='white' || pb.fountainType==='mixed') ? FOUNTAIN_WHITE_UPCHARGE : 0;
    subtotal += (f + up);
  }

  let discount = 0;
  if(pb.discountMode === 'amount')  discount = Math.max(0, Number(pb.discountValue || 0));
  if(pb.discountMode === 'percent') discount = Math.max(0, subtotal * (Number(pb.discountValue || 0)/100));

  const total  = Math.max(0, subtotal - discount);

  // Due now (what we actually charge in Checkout)
  let dueNow = 0;
  if(pb.payMode === 'full'){
    dueNow = Math.max(0, total - FULL_FLAT_OFF);
  } else {
    // If manager typed a deposit, honor it; else default 25% deposit
    const customDeposit = Number(pb.deposit || 0);
    dueNow = customDeposit > 0 ? customDeposit : Math.round(total * 0.25);
  }

  // Balance for calendar notes
  const balance = Math.max(0, total - dueNow);

  return { subtotal, discount, total, dueNow, balance };
}

export default async function handler(req, res){
  try{
    if (typeof cors === 'function' && cors(req, res)) return;
    if(req.method !== 'POST'){
      return res.status(405).json({ ok:false, error:'Method not allowed' });
    }

    const pb = req.body || {};
    const pin = String(pb.pin || '').trim();
    const aff = resolveAffiliate(pin);
    if(!aff) return res.status(401).json({ ok:false, error:'Invalid affiliate PIN' });

    if(!pb.pkg || !pb.mainBar || !pb.payMode){
      return res.status(400).json({ ok:false, error:'Missing fields: pkg, mainBar, payMode are required' });
    }

    const totals = computeTotals(pb);
    if(!(totals.dueNow > 0)){
      return res.status(400).json({ ok:false, error:'Charge amount must be greater than $0' });
    }

    const comm = calcAffiliateCommissions(aff, {
      pkg: pb.pkg,
      secondEnabled: !!pb.secondEnabled,
      fountainEnabled: !!pb.fountainEnabled
    });

    const labels = {
      "50-150-5h":"50–150 (5 hrs)",
      "150-250-5h":"150–250 (5 hrs)",
      "250-350-6h":"250–350 (6 hrs)"
    };
    const productName = `Manna — ${(BAR_META[pb.mainBar]?.title)||'Snack Bar'} • ${labels[pb.pkg]||''} • ${pb.payMode==='full'?'Pay in full':'Deposit'}`;

    const BASE_URL = (process.env.PUBLIC_URL || 'https://mannasnackbars.com').replace(/\/+$/,'');
    const successUrl = `${BASE_URL}/`;
    const cancelUrl  = `${BASE_URL}/`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      allow_promotion_codes: false,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          product_data: { name: productName },
          unit_amount: usd(totals.dueNow)
        }
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        // Booking/Calendar
        fullName: pb.fullName || pb.name || '',
        email:    pb.email || '',
        phone:    pb.phone || '',
        venue:    pb.venue || '',
        dateISO:  pb.dateISO || '',
        startISO: pb.startISO || '',
        pkg:      pb.pkg,
        hours:    String(pkgToHours(pb.pkg)),
        mainBar:  pb.mainBar,
        secondEnabled: String(!!pb.secondEnabled),
        secondBar:     pb.secondBar || '',
        secondSize:    pb.secondSize || '',
        fountainEnabled: String(!!pb.fountainEnabled),
        fountainSize:    pb.fountainSize || '',
        fountainType:    pb.fountainType || '',

        // Money
        subtotal:    String(totals.subtotal),
        discount:    String(totals.discount),
        total:       String(totals.total),
        dueNow:      String(totals.dueNow),
        balance:     String(totals.balance),
        payMode:     pb.payMode || 'deposit',
        discountMode: pb.discountMode || 'none',
        discountValue: String(pb.discountValue || 0),

        // Affiliate breakdown
        affiliateId:   aff.id,
        affiliateName: aff.name,
        affMain:   String(comm.main),
        affSecond: String(comm.second),
        affFountain: String(comm.fountain),
        affTotal: String(comm.totalCommission),

        // Free-form notes
        notes: pb.notes || ''
      }
    });

    return res.json({ ok:true, url: session.url });
  }catch(err){
    console.error('create-checkout error', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
