// /api/auth/login.js
import { applyCors, preflight } from '../_cors.js';
import { resolveAffiliate } from '../_affiliates.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ ok:false, error:'Missing pin' });

    const affiliate = resolveAffiliate(pin);
    if (!affiliate) return res.status(401).json({ ok:false, error:'Invalid PIN' });

    return res.status(200).json({ ok:true, affiliate });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message || 'Login error' });
  }
}
