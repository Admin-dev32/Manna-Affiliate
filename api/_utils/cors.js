// api/_utils/cors.js
export function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,     // you can replace '*' with your Hostinger origin
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Stripe-Signature',
    'Access-Control-Max-Age': '86400',
  };
}

export function sendJSON(res, status, obj, origin = '*') {
  const headers = corsHeaders(origin);
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.status(status).json(obj);
}

export function handleOptions(req, res, origin = '*') {
  if (req.method === 'OPTIONS') {
    const headers = corsHeaders(origin);
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }
  return false;
}
