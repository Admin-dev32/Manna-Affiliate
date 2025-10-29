// /api/create-event.js
import { getCalendarClient } from './_google.js';

export async function createCalendarEvent({ startISO, durationMinutes, summary, description, location }) {
  const cal = await getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const start = new Date(startISO);
  const end = new Date(start.getTime() + (Number(durationMinutes || 120) * 60 * 1000));

  const insert = await cal.events.insert({
    calendarId,
    requestBody: {
      summary: summary || 'Manna Booking',
      description: description || '',
      location: location || '',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    }
  });

  return { eventId: insert.data.id };
}
