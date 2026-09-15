// ════════════════════════════════════════════════════════════════
//  E247 — OPTIONAL real-AI backend (Google Gemini)
//  This is only needed when you want REAL AI plans instead of the
//  built-in offline planner. Your API key stays here on the server,
//  never in the app. Deploy this to Vercel or Netlify (both free).
//
//  HOW TO USE (Vercel):
//   1. Put this file at:  api/plan.js   in your project folder.
//   2. Get a free Gemini key: https://aistudio.google.com/apikey
//   3. In Vercel → Project → Settings → Environment Variables,
//      add:  GEMINI_API_KEY = <your key>
//   4. Deploy. Your endpoint will be:  https://YOURSITE.vercel.app/api/plan
//   5. In index.html, set:  const AI_ENDPOINT = "https://YOURSITE.vercel.app/api/plan";
//
//  (Netlify is almost identical — put it in netlify/functions/plan.js
//   and the URL becomes /.netlify/functions/plan)
// ════════════════════════════════════════════════════════════════

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Model fallback chain. Tries each in order. First one that works wins.
// Add new aliases at the top when Google ships them.
const MODELS = [
  "gemini-2.5-flash",          // GA, current primary (2.0 was shut down Jun 2026)
  "gemini-2.5-flash-lite",     // cheaper GA fallback
  "gemini-flash-latest",       // rolling alias to newest flash
  "gemini-2.5-pro",            // last-resort higher-quality fallback
];
const MAX_GOAL_CHARS = 1200;
const MAX_TEXT_CHARS = 240;

// ── Upstash Redis rate limiter ─────────────────────────────────
// Two windows: burst (per-minute) and daily cap.
// Falls back to "open" (no limiting) if env vars missing — function
// still works, but is unprotected. Vercel logs flag this on cold start.
let burstLimiter = null;
let dailyLimiter = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = Redis.fromEnv();
    burstLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "60 s"),
      prefix: "e247:burst",
      analytics: true,
    });
    dailyLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(50, "1 d"),
      prefix: "e247:daily",
      analytics: true,
    });
    console.log("rate-limit: active (Upstash Redis)");
  } else {
    console.warn("rate-limit: SKIPPED (Upstash env vars missing)");
  }
} catch (e) {
  console.warn("rate-limit: setup failed", String(e).slice(0, 200));
}


// ════════════════════════════════════════════════════════════════
//  The planning prompt lives HERE, on the server. It is never taken
//  from the request: if the client could supply it, anyone could turn
//  this endpoint (and the Gemini key behind it) into a free general
//  purpose LLM. Client-supplied `system` values are ignored.
// ════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are the planning engine for "24/7 education" — a gamified quest app used by students including minors as young as 10.
SAFETY: Only build plans for constructive goals (studies, fitness, skills, habits). If harmful, return {"refusal":"reason"}.
OUTPUT: ONLY valid minified JSON, no markdown, no backticks.

First, work out the plan's total duration in DAYS from the user's deadline:
- "30 days" / "1 month" → ~30, "3 months" → ~90, "6 months" → ~180, "1 year" → 365
- If no deadline given, choose a sensible duration for the goal (e.g. 30).
- Clamp between 1 and 365.

Schema:
{"title":"<=5 words","deadline":"short label","totalDays":<int 1-365>,"phases":[{"name":"phase name","window":"e.g. Weeks 1-3","focus":"one line","startDay":<int>,"endDay":<int>}],"weekTemplate":[{"track":"study|fitness|skill|habit|mind","task":"specific repeatable daily action","xp":<10-40>,"tag":"1-2 word label","dow":<0-6, day of week this applies: 0=Mon..6=Sun, or -1 for every day>}],"milestones":[{"day":<int>,"task":"specific milestone action","track":"...","xp":<25-60>,"tag":"1-2 word"}],"firstWeek":[{"id":"q1","task":"specific action for the very first days","track":"...","xp":<10-40>,"tag":"1-2 word","day":<1-7>}],"tip":"one motivating line"}

Rules:
- 3-5 phases that span the WHOLE duration (use startDay/endDay covering 1..totalDays).
- weekTemplate: 4-8 recurring daily/weekly quests that repeat through the plan (the user's routine). Spread across days of week. Attack weak areas with more reps.
- milestones: 4-10 key checkpoint quests. Their "day" values MUST be spread right across 1..totalDays — early, middle AND late (e.g. on a 30-day plan use days near 5, 12, 20, 27). Never bunch them on the same day and never put them all in the first week.
- firstWeek: 7-10 concrete quests for days 1-7 to kick things off.

BE SPECIFIC AND MEASURABLE. Every task must contain a real number the person can check off:
- Fitness: state distance, time, sets/reps or calories — "Walk 5 km at brisk pace (~350 kcal)", not "go for a walk".
- Study: state chapters, question counts or minutes — "Solve 40 MCQs from Kinematics in 60 min", not "practice physics".
- Skill: state the concrete output — "Build a to-do app with add + delete working", not "practice coding".
Scale the numbers to the user's stated time budget and starting point, and make them get harder across the phases.
- Keep strings short so JSON stays compact.`;

// ── Supabase (server-side, service role) ───────────────────────
function sbEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || serviceKey;
  return { url, serviceKey, anonKey };
}

// Verify the caller's Supabase access token and return their user id.
// No valid token => no plan. This is what stops anonymous curl requests.
async function resolveUser(req) {
  const { url, anonKey } = sbEnv();
  if (!url || !anonKey) return { error: "server-misconfigured" };
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { error: "no-token" };
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!r.ok) return { error: "bad-token" };
    const u = await r.json();
    if (!u || !u.id) return { error: "bad-token" };
    return { uid: u.id };
  } catch (e) {
    console.error("resolveUser:", String(e).slice(0, 200));
    return { error: "auth-unavailable" };
  }
}

async function rpcRaw(fn, payload) {
  const { url, serviceKey } = sbEnv();
  if (!url || !serviceKey) return null;
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(payload || {}),
  });
  if (!r.ok) {
    console.error(`${fn} failed:`, r.status, (await r.text()).slice(0, 200));
    return null;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function creditRpc(fn, uid) {
  const { url, serviceKey } = sbEnv();
  if (!url || !serviceKey) return null;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ p_uid: uid }),
    });
    if (!r.ok) {
      console.error(`${fn} failed:`, r.status, (await r.text()).slice(0, 200));
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(`${fn} error:`, String(e).slice(0, 200));
    return null;
  }
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://endearing-sunshine-e5d262.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
  // Capacitor native app (Android/iOS) origins — the webview serves from localhost.
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost",
];

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
}

function getClientId(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwarded) ? forwarded[0] : (forwarded || req.socket?.remoteAddress || "");
  return String(ip).split(",")[0].trim() || "unknown";
}

// Returns 0 if allowed, or seconds-to-retry if blocked.
async function checkRateLimit(clientId) {
  if (!burstLimiter || !dailyLimiter) return 0; // fail-open if Upstash missing
  try {
    const burst = await burstLimiter.limit(clientId);
    if (!burst.success) return 60;
    const daily = await dailyLimiter.limit(clientId);
    if (!daily.success) return 86400;
    return 0;
  } catch (e) {
    console.warn("rate-limit check failed:", String(e).slice(0, 200));
    return 0; // fail-open on Redis flake
  }
}

function validateGoal(goal) {
  if (typeof goal !== "string") return "Missing goal";
  const trimmed = goal.trim();
  if (!trimmed) return "Missing goal";
  if (trimmed.length > MAX_GOAL_CHARS) return `Goal must be ${MAX_GOAL_CHARS} characters or less`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmed)) return "Goal contains unsupported characters";
  if (/(ignore|override|forget|bypass|reveal|print|show)\s+(all\s+)?(previous|system|developer|safety|hidden)\s+(instructions?|rules?|prompt)/i.test(trimmed)) {
    return "Please describe a normal learning, fitness, skill, or habit goal";
  }
  return "";
}

function maskSensitiveText(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?91[-\s]?)?[6-9]\d{9}\b/g, "[phone]")
    .replace(/\b(?:EDU|E247)-[A-Z0-9-]{4,}\b/gi, "[app-code]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]");
}


function safeText(value, fallback = "") {
  return String(value || fallback).replace(/[\u0000-\u001F<>]/g, "").trim().slice(0, MAX_TEXT_CHARS);
}

function safeInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// `maxDay` differs by quest type. firstWeek really is days 1-7, but milestones
// are spread across the WHOLE plan. Clamping everything to 7 collapsed every
// milestone of a 30-day plan onto day 7.
function cleanQuest(q, index, totalDays, maxDay) {
  const cap = Math.max(1, Math.min(maxDay || totalDays, totalDays));
  return {
    id: safeText(q?.id, `q${index + 1}`).slice(0, 32),
    task: safeText(q?.task, "Complete one focused action today"),
    track: safeText(q?.track, "study").slice(0, 24),
    xp: safeInt(q?.xp, 10, 60, 20),
    tag: safeText(q?.tag, "Quest").slice(0, 24),
    day: safeInt(q?.day, 1, cap, Math.min(index + 1, cap)),
    dow: safeInt(q?.dow, -1, 6, -1),
  };
}

// If the model bunched milestones together (or left days off), spread them
// evenly across the plan so a long plan has checkpoints all the way through.
function spreadMilestones(list, totalDays) {
  if (!list.length) return list;
  const distinct = new Set(list.map(m => m.day));
  if (distinct.size >= Math.min(list.length, 3) && Math.max(...list.map(m => m.day)) > totalDays * 0.5) {
    return list.sort((a, b) => a.day - b.day);
  }
  const step = totalDays / (list.length + 1);
  return list.map((m, i) => ({ ...m, day: Math.max(1, Math.min(totalDays, Math.round(step * (i + 1)))) }));
}

function cleanPlan(obj) {
  const totalDays = safeInt(obj?.totalDays, 1, 365, 30);
  return {
    title: safeText(obj?.title, "Study Plan").slice(0, 60),
    deadline: safeText(obj?.deadline, `${totalDays} days`).slice(0, 40),
    totalDays,
    phases: Array.isArray(obj?.phases) ? obj.phases.slice(0, 5).map((p, i) => ({
      name: safeText(p?.name, `Phase ${i + 1}`).slice(0, 60),
      window: safeText(p?.window, ""),
      focus: safeText(p?.focus, ""),
      startDay: safeInt(p?.startDay, 1, totalDays, 1),
      endDay: safeInt(p?.endDay, 1, totalDays, totalDays),
    })) : [],
    weekTemplate: Array.isArray(obj?.weekTemplate) ? obj.weekTemplate.slice(0, 8).map((q, i) => cleanQuest(q, i, totalDays, totalDays)) : [],
    milestones: Array.isArray(obj?.milestones) ? spreadMilestones(obj.milestones.slice(0, 10).map((q, i) => cleanQuest(q, i, totalDays, totalDays)), totalDays) : [],
    firstWeek: Array.isArray(obj?.firstWeek) ? obj.firstWeek.slice(0, 10).map((q, i) => cleanQuest(q, i, totalDays, 7)) : [],
    tip: safeText(obj?.tip, "Small consistent action wins."),
  };
}

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const origin = req.headers.origin;
  const allowedOrigins = getAllowedOrigins();
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ error: "Origin not allowed" });
  if (!String(req.headers["content-type"] || "").includes("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }

  try {
    const { goal } = req.body || {};
    const validationError = validateGoal(goal);
    if (validationError) return res.status(400).json({ error: validationError });

    // ── Who is asking? No valid Supabase session => no plan. ──
    const who = await resolveUser(req);
    if (who.error === "server-misconfigured") {
      return res.status(500).json({ error: "Server auth not configured" });
    }
    if (who.error) {
      return res.status(401).json({ error: "Please sign in to build a plan." });
    }
    const uid = who.uid;

    const retryAfter = await checkRateLimit(uid);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many plan requests. Please wait a minute and try again." });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "Server missing GEMINI_API_KEY" });

    // ── Pay first. The credit is taken BEFORE Gemini is called, so a
    // request that was never paid for can never reach the model. ──
    const spent = await creditRpc("spend_credit_for_user", uid);
    if (spent !== true) {
      return res.status(402).json({ error: "No plan credits left.", code: "NO_CREDITS" });
    }
    let charged = true;
    // Vercel Hobby keeps only 1 hour of runtime logs, so every refund also
    // records why it happened. Read it back from the control centre.
    const refund = async (reason, detail, status) => {
      if (!charged) return;
      charged = false;
      await creditRpc("refund_credit_for_user", uid);
      try {
        await rpcRaw("log_generation_failure", {
          p_uid: uid,
          p_reason: reason || "unknown",
          p_detail: detail ? String(detail).slice(0, 1000) : null,
          p_status: Number.isFinite(status) ? status : null,
        });
      } catch (e) {
        console.error("log_generation_failure:", String(e).slice(0, 200));
      }
    };

    const safeGoal = maskSensitiveText(goal.trim());
    const prompt = `${SYSTEM_PROMPT}\n\nUSER GOAL: ${safeGoal}`;

    // Try each model in order. Surface the LAST error if all fail.
    let r = null;
    let lastDetail = "";
    let lastStatus = 0;
    let usedModel = "";
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      try {
        r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              maxOutputTokens: 8192,
              temperature: 0.7,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });
      } catch (e) {
        lastDetail = `fetch failed: ${String(e).slice(0, 200)}`;
        continue;
      }
      if (r.ok) { usedModel = model; break; }
      lastStatus = r.status;
      lastDetail = (await r.text()).slice(0, 500);
      console.error(`Model ${model} failed: ${r.status} ${lastDetail}`);
    }

    if (!r || !r.ok) {
      await refund("all_models_failed", lastDetail, lastStatus);
      return res.status(502).json({
        error: "All Gemini models failed",
        lastStatus,
        tried: MODELS,
        detail: lastDetail,
      });
    }
    console.log(`Used model: ${usedModel}`);

    const data = await r.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || "";
    const finishReason = candidate?.finishReason || "UNKNOWN";
    let obj;
    try {
      // Strip markdown fences if present, then extract first {...} blob
      let clean = text.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const first = clean.indexOf("{");
      const last = clean.lastIndexOf("}");
      if (first === -1 || last === -1 || last <= first) {
        console.error("No JSON object. finishReason:", finishReason, "Raw:", text.slice(0, 500));
        await refund("no_json_in_reply", `finishReason=${finishReason} raw=${text.slice(0, 300)}`);
        return res.status(502).json({
          error: "AI returned no JSON",
          finishReason,
          textLength: text.length,
          rawPreview: text.slice(0, 500),
        });
      }
      obj = JSON.parse(clean.slice(first, last + 1));
    } catch (parseErr) {
      console.error("Parse error:", parseErr, "finishReason:", finishReason, "len:", text.length);
      await refund("json_parse_error", `finishReason=${finishReason} len=${text.length} err=${String(parseErr).slice(0,200)}`);
      return res.status(502).json({
        error: "Could not parse plan JSON",
        finishReason,
        textLength: text.length,
        parseError: String(parseErr).slice(0, 200),
        rawPreview: text.slice(0, 500),
      });
    }

    // The app refuses harmful goals on its own too, but double-check here.
    // A refused goal costs nothing — give the credit back.
    if (obj.refusal) {
      await refund("model_refusal", String(obj.refusal).slice(0, 300));
      return res.status(200).json({ plan: { refusal: obj.refusal } });
    }

    return res.status(200).json({ plan: cleanPlan(obj) });
  } catch (e) {
    console.error("plan handler:", String(e).slice(0, 300));
    return res.status(500).json({ error: String(e).slice(0, 300) });
  }
}
