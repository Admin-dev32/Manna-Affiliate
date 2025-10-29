// /api/_cors.js
export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // or your Hostinger domain
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

export function preflight(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.status(200).end();
    return true; // handled
  }
  return false;
}
