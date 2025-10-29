// /api/auth/login.js
import { resolveAffiliate } from './_affiliates.js';

export default async function handler(req, res) {
  try {
    // Asegura parseo de body en cualquier runtime
    let pin = null;
    if (req.body && typeof req.body === 'object') {
      pin = req.body.pin;
    } else {
      // fallback: intenta leer el raw body
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const parsed = JSON.parse(raw);
      pin = parsed.pin;
    }

    const aff = resolveAffiliate(pin);
    if (!aff) {
      return res.status(200).json({ ok: false, error: 'Invalid PIN' });
    }

    return res.status(200).json({ ok: true, affiliate: aff });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || 'Login error' });
  }
}
