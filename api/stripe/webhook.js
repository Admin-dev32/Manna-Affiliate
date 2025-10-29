// /api/stripe/webhook.js
// Crea/actualiza evento de Google Calendar cuando Stripe confirma el pago.
// Incluye datos de afiliado (pin / affiliateName) si vienen en metadata.

export const config = { runtime: "nodejs" };

import Stripe from "stripe";

// ====== Ajustes de tiempo del bloque ======
const PREP_HOURS = 1;   // horas antes de la hora de inicio real
const CLEAN_HOURS = 1;  // horas después del final real

function pkgToHours(pkg) {
  if (pkg === "50-150-5h") return 2;
  if (pkg === "150-250-5h") return 2.5;
  if (pkg === "250-350-6h") return 3;
  return 2;
}
function addHours(d, h) {
  return new Date(d.getTime() + h * 3600e3);
}

function setCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  const okOrigin = allow.length ? allow.includes(origin) : true;

  res.setHeader("Access-Control-Allow-Origin", okOrigin ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Stripe-Signature");
  res.setHeader("Vary", "Origin");
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    return res
      .status(500)
      .json({ ok: false, error: "Stripe env vars missing" });
  }

  const stripe = new Stripe(stripeSecret, { apiVersion: "2022-11-15" });

  let event;
  try {
    const raw = await readRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (e) {
    console.error("Stripe signature error:", e);
    return res.status(400).json({ ok: false, error: `Webhook error: ${e.message}` });
  }

  // Solo actuamos cuando el pago está completado
  if (event.type !== "checkout.session.completed") {
    return res.json({ ok: true, ignored: event.type });
  }

  try {
    const session = event.data.object;
    const md = session.metadata || {};

    // Datos clave que esperamos del Checkout
    const startISO = md.startISO;
    const pkg = md.pkg;
    const mainBar = md.mainBar;
    const fullName = md.fullName || "";
    const email = md.email || "";
    const phone = md.phone || "";
    const venue = md.venue || "";
    const dateISO = md.dateISO || ""; // YYYY-MM-DD si lo mandaste
    const pin = md.pin || "";
    const affiliateName = md.affiliateName || "";

    const secondEnabled = md.secondEnabled === "true" || md.secondEnabled === true;
    const secondBar = md.secondBar || "";
    const secondSize = md.secondSize || "";

    const fountainEnabled = md.fountainEnabled === "true" || md.fountainEnabled === true;
    const fountainSize = md.fountainSize || "";
    const fountainType = md.fountainType || "";

    // Totales (opcional, solo para descripción)
    const total = md.total ? Number(md.total) : null;
    const deposit = md.deposit ? Number(md.deposit) : null;
    const balance = md.balance ? Number(md.balance) : null;

    if (!startISO || !pkg) {
      console.warn("Missing startISO/pkg in metadata");
      return res.json({ ok: true, skipped: "missing_start_or_pkg" });
    }

    // ====== Google Calendar client (con Service Account) ======
    const { google } = await import("googleapis");
    let saJSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}";
    const sa = JSON.parse(saJSON);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");

    const jwt = new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ["https://www.googleapis.com/auth/calendar"]
    );
    const calendar = google.calendar({ version: "v3", auth: jwt });

    const tz = process.env.TIMEZONE || "America/Los_Angeles";
    const calendarId = process.env.CALENDAR_ID || "primary";

    // ====== Construcción del bloque ======
    const liveHrs = pkgToHours(pkg);
    const start = new Date(startISO);
    const blockStart = addHours(start, -PREP_HOURS);
    const blockEnd = addHours(start, liveHrs + CLEAN_HOURS);

    const descriptionLines = [
      `Name: ${fullName}`,
      email ? `Email: ${email}` : "",
      phone ? `Phone: ${phone}` : "",
      venue ? `Venue: ${venue}` : "",
      `Package: ${pkg} • Bar: ${mainBar || ""}`,
      secondEnabled ? `2nd Bar: ${secondBar} (${secondSize})` : "",
      fountainEnabled ? `Fountain: ${fountainSize} ${fountainType ? "(" + fountainType + ")" : ""}` : "",
      total != null ? `Totals: total $${total} | deposit $${deposit || 0} | balance $${balance || 0}` : "",
      affiliateName ? `Affiliate: ${affiliateName} (PIN ${pin})` : (pin ? `Affiliate PIN: ${pin}` : ""),
      dateISO ? `Date: ${dateISO}` : "",
      `Start live: ${startISO}`,
      `Service hours: ${liveHrs}`,
      `Stripe Session: ${session.id}`
    ].filter(Boolean);

    // Creamos el evento (sin attendees para evitar permisos de delegación)
    const ev = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: `Manna Snack Bars — ${mainBar || "Booking"} (${pkg})`,
        description: descriptionLines.join("\n"),
        location: venue || "",
        start: { dateTime: blockStart.toISOString(), timeZone: tz },
        end: { dateTime: blockEnd.toISOString(), timeZone: tz },
        guestsCanInviteOthers: false,
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
        extendedProperties: { private: { stripeSessionId: session.id, type: "manna" } }
      },
      sendUpdates: "none"
    });

    return res.json({ ok: true, eventId: ev.data.id });
  } catch (e) {
    console.error("webhook error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
