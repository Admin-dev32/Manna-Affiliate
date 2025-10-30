// /api/create-booking.js
export const config = { runtime: 'nodejs' };

// ---- tiny CORS helper (same for every response) ----
function applyCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function bad(res, code, msg, extra = {}) {
  res.status(code).json({ ok: false, error: msg, ...extra });
}

// ---- time helpers ----
function hours(n) { return n * 3600 * 1000; }

function pkgToLiveHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

// Build a title that shows the bar(s)
function buildTitle({ mainBar, secondEnabled, secondBar, pkg, fullName, noDeposit }) {
  const pkgLabel =
    pkg === '50-150-5h' ? '50–150' :
    pkg === '150-250-5h' ? '150–250' :
    pkg === '250-350-6h' ? '250–350' : pkg;

  const bars = [mainBar, (secondEnabled && secondBar) ? `+ ${secondBar}` : null]
    .filter(Boolean)
    .map(s => s[0].toUpperCase() + s.slice(1))
    .join(' — ');

  const suffix = noDeposit ? ' (No deposit)' : '';
  return `Manna Snack Bars — ${pkgLabel} — ${bars} — ${fullName}${suffix}`;
}

function zonedISO(dateISO, tz) {
  // dateISO like '2025-10-31T16:00:00' (local) -> return RFC3339 with tz offset
  const d = new Date(dateISO);
  // Convert the "local components" in the requested tz into an absolute instant
  const parts = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  // parts now carries the local wall-clock in tz; align ms
  const offsetMs = parts.getTime() - d.getTime();
  return new Date(d.getTime() - offsetMs).toISOString();
}

// ---- main handler ----
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  const tz = process.env.TIMEZONE || 'America/Los_Angeles';
  const calId =
    process.env.CALENDAR_ID ||
    process.env.GOOGLE_CALENDAR_ID || // fallback if you used this name earlier
    '';

  if (!calId) return bad(res, 400, 'Missing CALENDAR_ID env');

  let payload;
  try {
    payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return bad(res, 400, 'Invalid JSON body');
  }

  const {
    fullName = 'Client',
    email = '',
    phone = '',
    venue = '',
    pkg,
    mainBar,
    secondEnabled = false,
    secondBar = '',
    discountMode = 'none',
    discountValue = 0,
    payMode = 'deposit',
    deposit = 0,
    total = 0,
    balance = 0,
    notes = '',
    startISO,           // ISO produced by the embed
    affiliateName = '',
    affiliateEmail = '',// new from _affiliates.js
    noDeposit = false,
  } = payload || {};

  if (!pkg || !mainBar) return bad(res, 400, 'Missing required fields: pkg and mainBar');
  if (!startISO)        return bad(res, 400, 'Missing required field: startISO');

  // Google Calendar auth
  try {
    const { google } = await import('googleapis');

    // Service account credentials (support JSON or split envs)
    let clientEmail, privateKey;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      clientEmail = sa.client_email;
      privateKey = (sa.private_key || '').replace(/\\n/g, '\n');
    } else {
      clientEmail = process.env.GCP_CLIENT_EMAIL;
      privateKey = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    }
    if (!clientEmail || !privateKey) {
      return bad(res, 500, 'Missing Google service account credentials');
    }

    const jwt = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    // Compute times: 1h prep + live + 1h cleanup; we store the *live* block as event
    const liveHrs = pkgToLiveHours(pkg);
    const start = new Date(startISO);
    const end = new Date(start.getTime() + hours(liveHrs));
    const startRFC3339 = zonedISO(start.toISOString(), tz);
    const endRFC3339   = zonedISO(end.toISOString(), tz);

    const summary = buildTitle({ mainBar, secondEnabled, secondBar, pkg, fullName, noDeposit });

    // Description
    const desc =
`Client: ${fullName}
Email: ${email || '(none)'}
Phone: ${phone || '(none)'}
Venue: ${venue || '(none)'}
Package: ${pkg}
Main bar: ${mainBar}${secondEnabled && secondBar ? `  |  Second bar: ${secondBar}` : ''}
Totals: total $${Number(total||0).toFixed(0)} — deposit $${Number(deposit||0).toFixed(0)} — balance $${Number(balance||0).toFixed(0)}
Affiliate: ${affiliateName || '(none)'}
Notes:
${notes || '(none)'}
`;

    // Build attendees list (optional)
    const attendees = [];
    const clean = e => (e || '').trim();
    const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

    const cEmail = clean(email);
    const aEmail = clean(affiliateEmail);

    if (isEmail(cEmail)) attendees.push({ email: cEmail, responseStatus: 'needsAction' });
    if (isEmail(aEmail)) attendees.push({ email: aEmail, responseStatus: 'needsAction' });

    // Insert event
    const result = await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary,
        description: desc,
        location: venue || undefined,
        start: { dateTime: startRFC3339, timeZone: tz },
        end:   { dateTime: endRFC3339,   timeZone: tz },
        attendees: attendees.length ? attendees : undefined,
        extendedProperties: {
          private: {
            pkg,
            mainBar,
            secondEnabled: String(!!secondEnabled),
            secondBar,
            affiliateName: affiliateName || '',
            discountMode,
            discountValue: String(discountValue || 0),
            payMode,
            deposit: String(deposit || 0),
            total: String(total || 0),
            balance: String(balance || 0),
          }
        }
      },
      sendUpdates: attendees.length ? 'all' : 'none'
    });

    return res.status(200).json({ ok: true, eventId: result.data.id || null });
  } catch (e) {
    // Important: still send CORS headers with the error
    console.error('create-booking error:', e?.response?.data || e);
    return bad(res, 500, 'create_booking_failed', {
      hint: e?.response?.data?.error || e.message || String(e)
    });
  }
}
