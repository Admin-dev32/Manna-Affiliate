// api/health.js
import { sendJSON, handleOptions } from './_utils/cors';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return sendJSON(res, 405, { ok:false, error:'Method not allowed' });
  return sendJSON(res, 200, { ok:true, service:'affiliate-api', ts:Date.now() });
}
