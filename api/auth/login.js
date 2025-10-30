// /api/auth/login.js
export const config = { runtime: 'nodejs' };

import { applyCors, handlePreflight } from '../_cors.js';
import { resolveAffiliate } from '../_affiliates.js';

export default async function handler(req, res) {
  // CORS
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    const { pin } = req.body || {};
    if (!pin) {
      return res.status(400).json({ ok: false, error: 'missing_pin' });
    }

    const affiliate = resolveAffiliate(String(pin).trim());
    if (!affiliate) {
      return res.status(401).json({ ok: false, error: 'Invalid PIN' });
    }

    // include email if present in your AFFILIATES_JSON entry
    return res.status(200).json({ ok: true, affiliate });
  } catch (e) {
    console.error('auth/login error', e);
    return res.status(500).json({ ok: false, error: 'login_failed', detail: e.message });
  }
}
