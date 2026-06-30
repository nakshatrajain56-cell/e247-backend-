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
  "gemini-flash-latest",       // Google's promised-stable alias
  "gemini-flash-lite-latest",  // cheaper alias
  "gemini-2.5-flash",          // stable fallback (no -lite)
  "gemini-2.0-flash",          // older fallback
];
const MAX_GOAL_CHARS = 1200;
const MAX_SYSTEM_CHARS = 5000;
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

const DEFAULT_ALLOWED_ORIGINS = [
  "https://endearing-sunshine-e5d262.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
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

function cleanSystem(system) {
  if (typeof system !== "string") return "";
  return system.slice(0, MAX_SYSTEM_CHARS);
}

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/[\u0000-\u001F<>]/g, "").trim().slice(0, MAX_TEXT_CHARS);
}

function safeInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanQuest(q, index, totalDays) {
  return {
    id: safeText(q?.id, `q${index + 1}`).slice(0, 32),
    task: safeText(q?.task, "Complete one focused action today"),
    track: safeText(q?.track, "study").slice(0, 24),
    xp: safeInt(q?.xp, 10, 60, 20),
    tag: safeText(q?.tag, "Quest").slice(0, 24),
    day: safeInt(q?.day, 1, Math.min(7, totalDays), Math.min(index + 1, totalDays)),
    dow: safeInt(q?.dow, -1, 6, -1),
  };
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
    weekTemplate: Array.isArray(obj?.weekTemplate) ? obj.weekTemplate.slice(0, 8).map((q, i) => cleanQuest(q, i, totalDays)) : [],
    milestones: Array.isArray(obj?.milestones) ? obj.milestones.slice(0, 10).map((q, i) => cleanQuest(q, i, totalDays)) : [],
    firstWeek: Array.isArray(obj?.firstWeek) ? obj.firstWeek.slice(0, 10).map((q, i) => cleanQuest(q, i, totalDays)) : [],
    tip: safeText(obj?.tip, "Small consistent action wins."),
  };
}

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const origin = req.headers.origin;
  const allowedOrigins = getAllowedOrigins();
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || allowedOrigins[0]);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ error: "Origin not allowed" });
  if (!String(req.headers["content-type"] || "").includes("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }

  try {
    const { goal, system } = req.body || {};
    const validationError = validateGoal(goal);
    if (validationError) return res.status(400).json({ error: validationError });

    const retryAfter = await checkRateLimit(getClientId(req));
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many plan requests. Please wait a minute and try again." });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "Server missing GEMINI_API_KEY" });

    const safeGoal = maskSensitiveText(goal.trim());
    const prompt = `${cleanSystem(system)}\n\nUSER GOAL: ${safeGoal}`;

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
      return res.status(502).json({
        error: "Could not parse plan JSON",
        finishReason,
        textLength: text.length,
        parseError: String(parseErr).slice(0, 200),
        rawPreview: text.slice(0, 500),
      });
    }

    // The app refuses harmful goals on its own too, but double-check here.
    if (obj.refusal) return res.status(200).json({ plan: { refusal: obj.refusal } });

    return res.status(200).json({ plan: cleanPlan(obj) });
  } catch (e) {
    return res.status(500).json({ error: String(e).slice(0, 300) });
  }
}
