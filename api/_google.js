// /api/_google.js
// Builds a Google Calendar client using OAuth2 refresh-token (Option B).
// Falls back to service account ONLY when no attendees are involved.

export async function getOAuthCalendar() {
  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN,
  } = process.env;

  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('Missing OAuth env vars (CLIENT_ID/SECRET/REFRESH_TOKEN)');
  }

  const { google } = await import('googleapis');

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    // Redirect not needed here, it was only needed to mint the refresh token
  );

  oauth2Client.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  return { calendar, auth: oauth2Client };
}

export async function getServiceAccountCalendar() {
  const { GCP_CLIENT_EMAIL, GCP_PRIVATE_KEY } = process.env;
  if (!GCP_CLIENT_EMAIL || !GCP_PRIVATE_KEY) {
    throw new Error('Missing service-account env vars (GCP_CLIENT_EMAIL / GCP_PRIVATE_KEY)');
  }

  const { google } = await import('googleapis');
  const jwt = new google.auth.JWT(
    GCP_CLIENT_EMAIL,
    null,
    (GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
  );
  const calendar = google.calendar({ version: 'v3', auth: jwt });
  return { calendar, auth: jwt };
}

/**
 * getCalendarForCreate({ hasAttendees })
 * - If you need to invite attendees (guests), you MUST use OAuth (Option B).
 * - If no attendees, service account is fine.
 */
export async function getCalendarForCreate(hasAttendees) {
  if (hasAttendees) return getOAuthCalendar();
  return getServiceAccountCalendar();
}

/** Utility to format RFC3339 from local ISO */
export function toRFC3339(iso) {
  return new Date(iso).toISOString();
}

export function tz() {
  return process.env.TIMEZONE || 'America/Los_Angeles';
}

export function calId() {
  // Your Calendar ID env var name
  return process.env.CALENDAR_ID || 'primary';
}
