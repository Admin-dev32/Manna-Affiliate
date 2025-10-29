// /api/health.js
import { applyCors, preflight } from './_cors.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.status(200).json({ ok: true, service: 'manna-affiliate', ts: Date.now() });
}
