// /api/health.js
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  // CORS (reuse your ALLOWED_ORIGINS env)
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const willAllow = allow.length ? allow.includes(origin) : true;

  res.setHeader('Access-Control-Allow-Origin', willAllow ? origin || '*' : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const has = (k) => Boolean(process.env[k] && String(process.env[k]).trim());

  try {
    const out = {
      ok: true,
      service: 'manna-affiliate',
      ts: Date.now(),
      paths: {
        login: '/api/auth/login',
        availability: '/api/availability',
        createBooking: '/api/create-booking',
        createCheckout: '/api/create-checkout',
        stripeWebhook: '/api/stripe/webhook',
        oauth: '/api/oauth'
      },
      cors: {
        requestOrigin: origin || '(none)',
        allowedOrigins: allow.length ? allow : '(not set, using *)',
        willAllow
      },
      stripe: {
        hasSecret: has('STRIPE_SECRET_KEY'),
        hasWebhookSecret: has('STRIPE_WEBHOOK_SECRET')
      },
      googleOAuth: {
        hasClientId: has('GOOGLE_OAUTH_CLIENT_ID'),
        hasClientSecret: has('GOOGLE_OAUTH_CLIENT_SECRET'),
        hasRedirect: has('GOOGLE_OAUTH_REDIRECT_URI'),
        hasRefresh: has('GOOGLE_OAUTH_REFRESH_TOKEN')
      },
      calendar: {
        calendarId: process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary'
      }
    };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
