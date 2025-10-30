// /api/_cors.js
export function isAllowedOrigin(origin) {
  const allowList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!allowList.length) return true; // allow all if not configured
  return allowList.includes(origin);
}

export function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const ok = isAllowedOrigin(origin);
  res.setHeader('Access-Control-Allow-Origin', ok ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    return res.status(204).end();
  }
  return false;
}
