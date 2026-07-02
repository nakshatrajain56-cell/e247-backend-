// ════════════════════════════════════════════════════════════════
//  E247 — RevenueCat Webhook (Vercel serverless function)
//
//  Purpose:
//    Receives purchase events from RevenueCat, verifies them, and
//    grants credits to the correct Supabase user. This replaces the
//    test-mode `add_test_credits` RPC for real Google Play purchases.
//
//  Flow:
//    1. Google Play → RevenueCat validates the receipt
//    2. RevenueCat → THIS webhook with the event
//    3. This webhook → Supabase `grant_credits_from_purchase` RPC
//    4. Supabase updates profiles.credits and inserts a purchases row
//
//  Security:
//    - Verifies REVENUECAT_WEBHOOK_SECRET in Authorization header
//    - Uses SUPABASE_SERVICE_ROLE_KEY (server-only, never in client)
//    - Deduplicates by event_id so replay attacks add credits once
//    - Product ID → credit amount mapping is server-side only
//
//  HOW TO DEPLOY (Vercel):
//    - Save this file at:  api/revenuecat-webhook.js
//    - Push to GitHub → Vercel auto-deploys
//    - Endpoint URL:  https://e247-backend.vercel.app/api/revenuecat-webhook
//    - Set this URL + secret in RevenueCat → Integrations → Webhooks
//
//  Required env vars (set in Vercel Project → Settings → Environment Variables):
//    - SUPABASE_URL
//    - SUPABASE_SERVICE_ROLE_KEY   (server-only, NEVER in frontend)
//    - REVENUECAT_WEBHOOK_SECRET   (any long random string you invent)
// ════════════════════════════════════════════════════════════════

// ── Server-side product catalog ────────────────────────────────
// This is the SINGLE SOURCE OF TRUTH for how many credits each
// product ID grants. Even if a client is hacked to lie about
// what was purchased, they cannot forge these amounts because
// they come from RevenueCat (validated by Google Play), not from
// the client.
const PRODUCT_CREDITS = {
  "e247_5_credits": 5,
  "e247_15_credits": 15,
  "e247_50_credits": 50,
  "e247_150_credits": 150,
  "e247_400_credits": 400,
};

// Event types that should grant credits.
// For consumables (credit packs), INITIAL_PURCHASE and NON_RENEWING_PURCHASE
// are the two we care about. Subscriptions would add RENEWAL etc.
const CREDIT_GRANTING_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "NON_RENEWING_PURCHASE",
  "UNCANCELLATION", // rare, but included for safety
]);

// ── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Security headers (same style as plan.js)
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Only POST is valid for webhooks
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // ── 1. Verify the webhook secret ────────────────────────────
  // RevenueCat sends the secret in the Authorization header exactly
  // as you configured it. We reject anything without a matching secret.
  const expectedSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error("Webhook: REVENUECAT_WEBHOOK_SECRET env var missing");
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const authHeader = req.headers.authorization || "";
  if (authHeader !== expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    console.warn("Webhook: bad Authorization header");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── 2. Parse the RevenueCat event ───────────────────────────
  let body = req.body;
  // Some Vercel setups deliver the body as a raw string; parse if needed
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const event = body?.event;
  if (!event || typeof event !== "object") {
    return res.status(400).json({ error: "Missing event object" });
  }

  const eventId = String(event.id || "").slice(0, 200);
  const eventType = String(event.type || "").slice(0, 60);
  const productId = String(event.product_id || "").slice(0, 100);
  const appUserId = String(event.app_user_id || "").slice(0, 200);
  const originalAppUserId = String(event.original_app_user_id || appUserId || "").slice(0, 200);
  const originalTxnId = String(event.original_transaction_id || "").slice(0, 200);
  const priceInPurchasedCurrency = event.price_in_purchased_currency;
  const currency = String(event.currency || "").slice(0, 8);
  const store = String(event.store || "").toLowerCase().slice(0, 40); // 'play_store' | 'app_store'

  if (!eventId || !eventType) {
    return res.status(400).json({ error: "Missing event.id or event.type" });
  }

  // ── 3. Ignore events that do not grant credits ──────────────
  // We still return 200 so RevenueCat does not retry these forever.
  if (!CREDIT_GRANTING_EVENTS.has(eventType)) {
    console.log(`Webhook: ignoring event type ${eventType} (event ${eventId})`);
    return res.status(200).json({ status: "ignored", reason: "event_type_not_credit_granting", event_type: eventType });
  }

  // ── 4. Map product ID → credit amount (server-side only) ────
  const credits = PRODUCT_CREDITS[productId];
  if (!credits) {
    console.error(`Webhook: unknown product_id "${productId}" in event ${eventId}`);
    return res.status(200).json({ status: "ignored", reason: "unknown_product", product_id: productId });
  }

  // ── 5. Resolve app_user_id to a Supabase user_id ────────────
  // In the mobile app, we call `Purchases.logIn(supabaseUserId)` at
  // login time so RevenueCat's app_user_id IS the Supabase user UUID.
  // If someone passed a different mapping id, we look it up in
  // public.revenuecat_users.
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Webhook: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var missing");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let userId = null;

  if (uuidRegex.test(originalAppUserId)) {
    userId = originalAppUserId;
  } else if (uuidRegex.test(appUserId)) {
    userId = appUserId;
  } else {
    // Look up via the revenuecat_users mapping table
    const lookupUrl = `${supabaseUrl}/rest/v1/revenuecat_users?app_user_id=eq.${encodeURIComponent(originalAppUserId || appUserId)}&select=user_id&limit=1`;
    try {
      const lookupRes = await fetch(lookupUrl, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      });
      if (lookupRes.ok) {
        const rows = await lookupRes.json();
        if (rows?.[0]?.user_id) userId = rows[0].user_id;
      }
    } catch (e) {
      console.error("Webhook: mapping lookup failed", String(e).slice(0, 200));
    }
  }

  if (!userId) {
    console.error(`Webhook: cannot resolve app_user_id "${appUserId}" to a Supabase user (event ${eventId})`);
    // Return 200 so RevenueCat stops retrying; we log for manual review
    return res.status(200).json({ status: "ignored", reason: "unknown_user", app_user_id: appUserId });
  }

  // ── 6. Call the SECURITY DEFINER RPC to grant credits ───────
  // The RPC is idempotent: same event_id twice = duplicate, credits granted once.
  const rpcUrl = `${supabaseUrl}/rest/v1/rpc/grant_credits_from_purchase`;
  const priceCents = Number.isFinite(priceInPurchasedCurrency)
    ? Math.round(priceInPurchasedCurrency * 100)
    : null;

  let rpcRes;
  try {
    rpcRes = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_event_id: eventId,
        p_event_type: eventType,
        p_product_id: productId,
        p_credits: credits,
        p_price_cents: priceCents,
        p_currency: currency || null,
        p_store: store || null,
        p_original_txn_id: originalTxnId || null,
        p_raw_event: event,
      }),
    });
  } catch (e) {
    console.error("Webhook: RPC fetch failed", String(e).slice(0, 300));
    // 500 = RevenueCat will retry, which is what we want on transient errors
    return res.status(500).json({ error: "Supabase RPC unreachable" });
  }

  if (!rpcRes.ok) {
    const errText = (await rpcRes.text()).slice(0, 500);
    console.error(`Webhook: RPC returned ${rpcRes.status}: ${errText}`);
    return res.status(500).json({ error: "Supabase RPC error", detail: errText });
  }

  const result = await rpcRes.json();
  console.log(`Webhook: event ${eventId} processed:`, JSON.stringify(result));

  return res.status(200).json({
    status: "ok",
    event_id: eventId,
    result,
  });
}
