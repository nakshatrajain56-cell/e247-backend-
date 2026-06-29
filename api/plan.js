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

// Verify the current model name at https://ai.google.dev/gemini-api/docs/models
// flash-lite is the cheapest; flash is a safe default.
const MODEL = "gemini-2.0-flash-lite";

export default async function handler(req, res) {
  // CORS (safe to keep even on same origin)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { goal, system } = req.body || {};
    if (!goal || typeof goal !== "string") {
      return res.status(400).json({ error: "Missing goal" });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "Server missing GEMINI_API_KEY" });

    const prompt = `${system || ""}\n\nUSER GOAL: ${goal}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048, temperature: 0.7 },
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: "Gemini error", detail: t.slice(0, 300) });
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let obj;
    try {
      obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      return res.status(502).json({ error: "Could not parse plan JSON" });
    }

    // The app refuses harmful goals on its own too, but double-check here.
    if (obj.refusal) return res.status(200).json({ plan: { refusal: obj.refusal } });

    return res.status(200).json({ plan: obj });
  } catch (e) {
    return res.status(500).json({ error: String(e).slice(0, 300) });
  }
}
