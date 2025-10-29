// /api/_google.js
import { google } from 'googleapis';

// Requires env vars:
// GOOGLE_CLIENT_EMAIL
// GOOGLE_PRIVATE_KEY (replace \n with real newlines in Vercel: “Add as plain text” toggled ON)
// GOOGLE_CALENDAR_ID
export async function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  const calendar = google.calendar({ version: 'v3', auth });
  return calendar;
}

// Helper: fetch busy ranges for a given date (UTC day window)
export async function fetchBusyForDate(calendar, calendarId, isoDate) {
  const start = new Date(isoDate + 'T00:00:00.000Z');
  const end = new Date(isoDate + 'T23:59:59.999Z');

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: calendarId }]
    }
  });

  const busy = fb.data.calendars?.[calendarId]?.busy || [];
  // Normalize to [{start:Date, end:Date}]
  return busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
}
