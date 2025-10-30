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
    const cleanPin = String(pin || '').trim();
    if (!cleanPin) {
      return res.status(400).json({ ok: false, error: 'missing_pin' });
    }

    const aff = resolveAffiliate(cleanPin);
    if (!aff) {
      return res.status(200).json({ ok: false, error: 'Invalid PIN' });
    }

    // Return the affiliate object including allowDiscount/email/etc.
    return res.status(200).json({
      ok: true,
      affiliate: {
        id: aff.id,
        name: aff.name,
        email: aff.email || '',
        allowDiscount: !!aff.allowDiscount,
        bundleRate: aff.bundleRate,
        commissionsByPkg: aff.commissionsByPkg,
        fountainCommission: aff.fountainCommission,
      },
    });
  } catch (e) {
    console.error('auth/login error', e);
    return res.status(500).json({ ok: false, error: 'login_failed', detail: e.message });
  }
}
