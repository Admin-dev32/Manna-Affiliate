// /api/create-booking.js
import { applyCors, preflight } from './_cors.js';
import { resolveAffiliate, calcAffiliateCommissions } from './_affiliates.js';
import { createCalendarEvent } from './create-event.js';

// PKG → suggested service duration (you can tweak)
const PKG_TO_MIN = {
  '50-150-5h': 120,   // 2h service
  '150-250-5h': 150,  // 2.5h
  '250-350-6h': 180   // 3h
};

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};
    const {
      pin, startISO, fullName, email, phone, venue, pkg,
      secondEnabled, fountainEnabled
    } = payload;

    const aff = resolveAffiliate(pin);
    if (!aff) return res.status(401).json({ ok: false, error: 'Invalid PIN' });

    if (!startISO) return res.status(400).json({ ok: false, error: 'Missing startISO' });
    if (!fullName) return res.status(400).json({ ok: false, error: 'Missing client name' });
    if (!pkg) return res.status(400).json({ ok: false, error: 'Missing package' });

    const comm = calcAffiliateCommissions(aff, { pkg, secondEnabled, fountainEnabled });

    const minutes = PKG_TO_MIN[pkg] || 120;
    const { eventId } = await createCalendarEvent({
      startISO,
      durationMinutes: minutes,
      summary: `Manna Booking – ${fullName}`,
      description: [
        `Affiliate: ${aff.name} (${aff.id})`,
        `Client: ${fullName}${email ? ' | ' + email : ''}${phone ? ' | ' + phone : ''}`,
        `Venue: ${venue || ''}`,
        `Package: ${pkg}`,
        `Second bar: ${secondEnabled ? 'yes' : 'no'}`,
        `Fountain: ${fountainEnabled ? 'yes' : 'no'}`,
        `Commission preview: $${comm.totalCommission} (main $${comm.main}, second $${comm.second}, fountain $${comm.fountain})`
      ].join('\n'),
      location: venue || ''
    });

    return res.status(200).json({ ok: true, eventId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Create booking error' });
  }
}
