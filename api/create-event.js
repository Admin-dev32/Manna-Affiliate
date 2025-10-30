// /api/create-event.js
export const config = { runtime: 'nodejs' };

import { google } from 'googleapis';

function fmtTitle(data) {
  const pkgLabel = ({
    '50-150-5h': '50–150 (5h)',
    '150-250-5h': '150–250 (5h)',
    '250-350-6h': '250–350 (6h)',
  })[data.pkg] || data.pkg || 'Package';
  const depositTag = data.noDeposit ? 'No deposit' : (data.payMode === 'full' ? 'Paid in full' : 'Deposit paid');
  return `Manna Snack Bars — ${pkgLabel} — ${data.fullName} (${depositTag})`;
}

function buildDescription(d) {
  const lines = [
    `Client: ${d.fullName}`,
    `Email: ${d.email || '(none)'}`,
    `Phone: ${d.phone || '(none)'}`,
    `Venue: ${d.venue || '(none)'}`,
    `Package: ${d.pkg} | Main bar: ${d.mainBar}`,
    d.secondEnabled ? `Second bar: ${d.secondBar} — ${d.secondSize}` : null,
    d.fountainEnabled ? `Chocolate fountain: ${d.fountainSize} (${d.fountainType || 'dark'})` : null,
    `Totals: total $${d.total} — deposit $${d.deposit} — balance $${d.balance}`,
    `Affiliate: ${d.affiliateName || '(none)'}${d.affiliateEmail ? ` <${d.affiliateEmail}>` : ''}`,
    d.notes ? `Notes: ${d.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Builds JWT or OAuth2 client using your Option B (OAuth) */
function getOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth env vars');
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, process.env.GOOGLE_OAUTH_REDIRECT_URI);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

export async function createCalendarEvent(data) {
  const tz = process.env.TIMEZONE || 'America/Los_Angeles';
  const calendarId = process.env.CALENDAR_ID || 'primary';

  const start = new Date(data.startISO);
  if (Number.isNaN(+start)) throw new Error('Invalid startISO');

  // Service window by package (live service)
  const hoursByPkg = { '50-150-5h': 2, '150-250-5h': 2.5, '250-350-6h': 3 };
  const liveHours = hoursByPkg[data.pkg] || 2;
  const prepH = 1;
  const cleanH = 1;

  const evStart = new Date(start.getTime() - prepH * 3600e3);
  const evEnd   = new Date(start.getTime() + (liveHours + cleanH) * 3600e3);

  const auth = getOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const attendees = [];
  if (data.email) attendees.push({ email: data.email, displayName: data.fullName });
  if (data.affiliateEmail) attendees.push({ email: data.affiliateEmail, displayName: data.affiliateName });

  const eventBody = {
    summary: fmtTitle(data),
    description: buildDescription(data),
    location: data.venue || undefined,
    start: { dateTime: evStart.toISOString(), timeZone: tz },
    end:   { dateTime: evEnd.toISOString(),   timeZone: tz },
    attendees: attendees.length ? attendees : undefined,
  };

  const rsp = await calendar.events.insert({
    calendarId,
    sendUpdates: attendees.length ? 'all' : 'none',
    requestBody: eventBody,
  });

  return rsp.data;
}

// Allow direct HTTP call from your “Create booking — no deposit” path
import { applyCors, preflight } from './_cors.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error: 'Method not allowed' });
    const data = req.body || {};
    const ev = await createCalendarEvent(data);
    return res.status(200).json({ ok:true, eventId: ev.id });
  } catch (e) {
    console.error('create-event error', e);
    return res.status(500).json({ ok:false, error: 'create_event_failed', detail: e.message });
  }
}
