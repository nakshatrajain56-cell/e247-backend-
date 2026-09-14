// E247 Control Centre — read-only stats + a small set of guarded control actions.
// Auth: a single shared secret in the ADMIN_TOKEN env var, sent as `x-admin-token`.
// Everything here runs with the service-role key, so nothing else may reach it.

const OPS = new Set([
  "stop_all",
  "set_daily_cap",
  "set_monthly_cap",
  "set_per_user_cap",
  "set_cost",
  "block_user",
  "unblock_user",
]);

function sbEnv() {
  return {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function rpc(fn, body) {
  const { url, serviceKey } = sbEnv();
  if (!url || !serviceKey) throw new Error("supabase env missing");
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Constant-time-ish compare so the token can't be guessed a character at a time.
function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected.length < 16) {
    return res.status(500).json({ error: "ADMIN_TOKEN is not configured" });
  }

  const given =
    req.headers["x-admin-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (!sameToken(String(given || ""), expected)) {
    // Deliberately vague, and slowed down a little.
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: "unauthorised" });
  }

  try {
    if (req.method === "GET") {
      const data = await rpc("admin_dashboard", {});
      return res.status(200).json(data);
    }

    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const op = String(body.op || "");
      if (!OPS.has(op)) return res.status(400).json({ error: "unknown op" });

      const out = await rpc("admin_action", {
        p_op: op,
        p_value: body.value === undefined || body.value === null ? null : Number(body.value),
        p_uid: body.uid || null,
        p_reason: body.reason || null,
      });
      return res.status(200).json(out);
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("admin error:", String(e).slice(0, 400));
    return res.status(500).json({ error: "server error" });
  }
}
