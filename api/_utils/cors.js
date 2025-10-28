// /api/_utils/cors.js
export function setCORS(res, origin = '*') {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Stripe-Signature');
  res.setHeader('Access-Control-Max-Age', '86400');
}
export function handlePreflight(req, res, origin = '*') {
  setCORS(res, origin);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
