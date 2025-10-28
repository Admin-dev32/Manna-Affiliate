// /api/auth/login.js
export const config = { runtime: 'nodejs' };

import { resolveAffiliate } from '../_affiliates.js';

export default async function handler(req, res){
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

  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
    const { pin } = req.body || {};
    const aff = resolveAffiliate(String(pin||'').trim());
    if(!aff) return res.status(401).json({ ok:false, error:'Invalid PIN' });
    return res.json({ ok:true, affiliate: aff });
  }catch(e){
    return res.status(500).json({ ok:false, error: e.message });
  }
}
