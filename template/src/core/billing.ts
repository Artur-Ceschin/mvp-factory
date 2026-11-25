// Stripe subscriptions via Checkout + webhooks, using the REST API directly (no SDK).
// Price comes from env PRICE_CENTS / PRICE_CURRENCY (set from the idea spec), so no dashboard setup.
// Without STRIPE_SECRET_KEY billing answers 503 and the app keeps working on the free plan.
// CORE FILE — generated apps must not edit anything under src/core.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getUser, setPlan } from "./auth.js";
import { db } from "./db.js";
import { track } from "./events.js";
import { HttpError, json, type Router } from "./http.js";
import { t } from "./i18n.js";
import { secret } from "./secrets.js";

const STRIPE = "https://api.stripe.com/v1";

function form(obj: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])).toString();
}

async function stripe(path: string, body: Record<string, string | number>) {
  const key = await secret("STRIPE_SECRET_KEY");
  if (!key) throw new HttpError(503, t("billing_disabled"), "billing_disabled");
  const r = await fetch(`${STRIPE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form(body),
  });
  const data = (await r.json()) as any;
  if (!r.ok) throw new HttpError(502, data?.error?.message ?? "Stripe error", "stripe_error");
  return data;
}

/** Verifies a Stripe-Signature header (t=...,v1=...) with 5-minute tolerance. */
export function verifyStripeSignature(payload: string, header: string, secretKey: string, nowS = Date.now() / 1000) {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=") as [string, string]).filter((p) => p.length === 2),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1 || Math.abs(nowS - t) > 300) return false;
  const expected = createHmac("sha256", secretKey).update(`${t}.${payload}`).digest("hex");
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

export function registerBillingRoutes(r: Router) {
  r.get("/api/billing/plan", async () =>
    json({
      priceCents: Number(process.env.PRICE_CENTS ?? 0),
      currency: process.env.PRICE_CURRENCY ?? "usd",
      interval: "month",
      enabled: Boolean(await secret("STRIPE_SECRET_KEY")),
    }),
  );

  r.post(
    "/api/billing/checkout",
    async (req) => {
      const user = req.user!;
      if (user.plan === "pro") throw new HttpError(400, t("already_pro"), "already_pro");
      const origin = process.env.PUBLIC_URL ?? `https://${req.headers["host"]}`;
      const session = await stripe("/checkout/sessions", {
        mode: "subscription",
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancel`,
        customer_email: user.email,
        client_reference_id: user.id,
        "metadata[userId]": user.id,
        "subscription_data[metadata][userId]": user.id,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": process.env.PRICE_CURRENCY ?? "usd",
        "line_items[0][price_data][unit_amount]": Number(process.env.PRICE_CENTS ?? 1990),
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": `${process.env.APP_NAME ?? "App"} Pro`,
        allow_promotion_codes: "true",
      });
      await track("checkout_started", user.id);
      return json({ url: session.url });
    },
    "user",
  );

  r.post("/api/billing/webhook", async (req) => {
    const whsec = await secret("STRIPE_WEBHOOK_SECRET");
    if (!whsec) throw new HttpError(503, "Webhook not configured", "billing_disabled");
    if (!verifyStripeSignature(req.rawBody, req.headers["stripe-signature"] ?? "", whsec))
      throw new HttpError(400, "Invalid signature", "bad_signature");
    const event = JSON.parse(req.rawBody);
    const obj = event.data?.object ?? {};
    // Idempotency: Stripe retries deliveries.
    const seen = await db().get(`STRIPE_EVT#${event.id}`, "E");
    if (seen) return json({ received: true, duplicate: true });
    await db().put({ pk: `STRIPE_EVT#${event.id}`, sk: "E", ttl: Math.floor(Date.now() / 1000) + 30 * 86400 });

    if (event.type === "checkout.session.completed") {
      const userId = obj.metadata?.userId ?? obj.client_reference_id;
      if (userId && (await getUser(userId))) {
        await setPlan(userId, "pro", { stripeCustomerId: obj.customer });
        if (obj.customer) await db().put({ pk: `STRIPE_CUS#${obj.customer}`, sk: "C", userId });
        await track("subscription_activated", userId);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const ref = obj.customer ? await db().get(`STRIPE_CUS#${obj.customer}`, "C") : undefined;
      const userId = (obj.metadata?.userId as string) ?? (ref?.userId as string | undefined);
      if (userId) {
        await setPlan(userId, "free");
        await track("subscription_canceled", userId);
      }
    }
    return json({ received: true });
  });
}
