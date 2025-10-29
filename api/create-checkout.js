// /api/create-checkout.js
// Crea una sesión de Stripe Checkout. Cobra "due now":
// - Si payMode === 'full' → total - $20
// - Si no → depósito (si no mandan depósito, usa 25% del total)

export const config = { runtime: "nodejs" };

import Stripe from "stripe";

function setCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  const okOrigin = allow.length ? allow.includes(origin) : true;

  res.setHeader("Access-Control-Allow-Origin", okOrigin ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret)
      return res.status(500).json({ ok: false, error: "STRIPE_SECRET_KEY missing" });

    const stripe = new Stripe(stripeSecret, { apiVersion: "2022-11-15" });

    const body = req.body || {};

    // Datos esperados desde el HTML (ver gather() en tu frontend)
    const {
      fullName, email, phone, venue,
      dateISO, startISO,
      pkg, mainBar,
      secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      discountMode, discountValue,
      payMode, deposit, total, balance,
      pin, affiliateName, notes
    } = body;

    if (!pkg || !startISO || total == null) {
      return res.status(400).json({ ok: false, error: "Missing pkg/startISO/total" });
    }

    // ====== Cálculo del "due now" ======
    let amountDue;
    if (payMode === "full") {
      const fullFlatOff = 20;
      amountDue = Math.max(0, Math.round((Number(total) - fullFlatOff) * 100)); // cents
    } else {
      const dep = (deposit != null && deposit !== "") ? Number(deposit) : Math.round(Number(total) * 0.25);
      amountDue = Math.max(0, Math.round(dep * 100));
    }
    if (amountDue <= 0) {
      return res.status(400).json({ ok: false, error: "Amount due is zero" });
    }

    // ====== Líneas de producto (1 ítem con resumen) ======
    const title = `Manna — ${mainBar || "Booking"} (${pkg})`;
    const descriptionParts = [
      fullName ? `Client: ${fullName}` : "",
      phone ? `Phone: ${phone}` : "",
      venue ? `Venue: ${venue}` : "",
      `Date: ${dateISO || startISO?.slice(0, 10)}`,
      `Start live: ${startISO}`,
      secondEnabled ? `2nd Bar: ${secondBar} (${secondSize})` : "",
      fountainEnabled ? `Fountain: ${fountainSize} ${fountainType ? "(" + fountainType + ")" : ""}` : "",
      discountMode && discountMode !== "none" ? `Discount: ${discountMode} ${discountValue || ""}` : "",
      payMode === "full" ? "Mode: Pay in full (auto -$20)" : "Mode: Deposit",
      balance != null ? `Balance after payment: $${balance}` : "",
      notes ? `Notes: ${notes}` : ""
    ].filter(Boolean);

    // ====== Metadata (para el webhook) ======
    const metadata = {
      fullName: String(fullName || ""),
      email: String(email || ""),
      phone: String(phone || ""),
      venue: String(venue || ""),
      dateISO: String(dateISO || ""),
      startISO: String(startISO || ""),
      pkg: String(pkg || ""),
      mainBar: String(mainBar || ""),
      secondEnabled: String(!!secondEnabled),
      secondBar: String(secondBar || ""),
      secondSize: String(secondSize || ""),
      fountainEnabled: String(!!fountainEnabled),
      fountainSize: String(fountainSize || ""),
      fountainType: String(fountainType || ""),
      discountMode: String(discountMode || ""),
      discountValue: String(discountValue || ""),
      payMode: String(payMode || ""),
      deposit: deposit != null ? String(deposit) : "",
      total: total != null ? String(total) : "",
      balance: balance != null ? String(balance) : "",
      pin: String(pin || ""),
      affiliateName: String(affiliateName || ""),
      notes: String(notes || "")
    };

    const successBase = process.env.PUBLIC_URL || "https://example.com";
    const cancelBase = process.env.PUBLIC_URL || "https://example.com";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      billing_address_collection: "auto",
      customer_email: email || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: title,
              description: descriptionParts.join(" • ")
            },
            unit_amount: amountDue
          },
          quantity: 1
        }
      ],
      success_url: `${successBase}/thank-you?status=paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cancelBase}/checkout-cancelled`,
      metadata
    });

    return res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("create-checkout error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
