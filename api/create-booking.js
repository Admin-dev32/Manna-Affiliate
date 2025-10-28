// api/create-booking.js
import { sendJSON, handleOptions } from './_utils/cors';
// import your existing Google Calendar utilities here:
import { createEvent } from './_google'; // keep your working implementation/signature

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') return sendJSON(res, 405, { ok:false, error:'Method not allowed' });

  try {
    const data = req.body || {};
    const {
      fullName, email, phone, venue,
      pkg, mainBar, secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      discountMode, discountValue, payMode,
      total, deposit, balance,
      startISO, pin, notes,
    } = data;

    if (!fullName) return sendJSON(res, 400, { ok:false, error:'Missing client name' });
    if (!startISO) return sendJSON(res, 400, { ok:false, error:'Missing start time' });

    // Build event details
    const start = new Date(startISO);
    const durationHours =
      pkg === '50-150-5h' ? 2 :
      pkg === '150-250-5h' ? 2.5 :
      pkg === '250-350-6h' ? 3 : 2;
    const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

    const title = `Manna — ${pkg} — ${mainBar} — ${fullName}`;
    const description = [
      `Affiliate PIN: ${pin || '-'}`,
      `Client: ${fullName}`,
      email ? `Email: ${email}` : null,
      phone ? `Phone: ${phone}` : null,
      venue ? `Venue: ${venue}` : null,
      `Main bar: ${mainBar}`,
      secondEnabled ? `Second bar: ${secondBar || '-'} (${secondSize || '-'})` : null,
      fountainEnabled ? `Chocolate fountain: ${fountainSize || '-'} (${fountainType || '-'})` : null,
      `Payment: ${payMode} | Deposit: $${deposit || 0} | Balance: $${balance || 0} | Total: $${total || 0}`,
      discountMode && discountMode !== 'none' ? `Discount: ${discountMode} ${discountValue || 0}` : null,
      notes ? `Notes: ${notes}` : null,
      `Source: affiliate`
    ].filter(Boolean).join('\n');

    // createEvent should return { id, htmlLink, ... }
    const evt = await createEvent({
      summary: title,
      location: venue || '',
      description,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      attendees: email ? [{ email }] : [],
      // pass metadata if your implementation supports it
      metadata: {
        pkg, mainBar, secondEnabled, secondBar, secondSize,
        fountainEnabled, fountainSize, fountainType,
        discountMode, discountValue, payMode, total, deposit, balance,
        pin, source: 'affiliate',
      }
    });

    return sendJSON(res, 200, { ok:true, eventId: evt?.id || null, link: evt?.htmlLink || null });
  } catch (e) {
    return sendJSON(res, 500, { ok:false, error:e.message });
  }
}
