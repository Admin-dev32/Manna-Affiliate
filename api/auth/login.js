// /api/auth/login.js
// Simple PIN login using your AFFILIATES_JSON env var.

export const config = { runtime: 'nodejs' };

import { applyCors, preflight } from '../_cors.js';

function getAffiliates() {
  try {
    const raw = process.env.AFFILIATES_JSON || '{}';
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const { pin } = req.body || {};
    if (!pin) {
      return res.status(400).json({ ok: false, error: 'PIN required' });
    }

    const affs = getAffiliates();
    const affiliate = affs[pin];

    if (!affiliate) {
      return res.status(200).json({ ok: false, error: 'Invalid PIN' });
    }

    // expose email (used to add as Google Calendar guest)
    return res.status(200).json({ ok: true, affiliate });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'login_failed' });
  }
}
