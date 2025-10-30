// /api/create-event.js
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const { google } = await import('googleapis');

    // --- service account (supports JSON or split secrets) ---
    let clientEmail, privateKey;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      clientEmail = sa.client_email;
      privateKey = (sa.private_key || '').replace(/\\n/g, '\n');
    } else {
      clientEmail = process.env.GCP_CLIENT_EMAIL;
      privateKey = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    }

    const jwt = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    // ✅ Always use CALENDAR_ID (or fallback to primary)
    const calendarId = process.env.CALENDAR_ID || 'primary';

    const {
      startISO, endISO, title, description,
      affiliateEmail, email: customerEmail, location
    } = req.body || {};

    // Optional attendees (only push valid emails)
    const attendees = [];
    if (customerEmail) attendees.push({ email: customerEmail });
    if (affiliateEmail) attendees.push({ email: affiliateEmail });

    const { data: ev } = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: title || 'Manna Snack Bars — Booking',
        description: description || '',
        location: location || '',
        start: { dateTime: startISO },
        end:   { dateTime: endISO },
        attendees,
      },
      sendUpdates: 'all'
    });

    return res.status(200).json({ ok: true, eventId: ev.id });
  } catch (e) {
    console.error('create-event error', e);
    return res.status(500).json({ ok: false, error: e.message || 'create_event_failed' });
  }
}
