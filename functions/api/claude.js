// POST /api/claude  {prompt}  ->  {result}  (the JSON object Claude replied with)
// Answers come from, in order:
//   1. public/answers/<id>.json -- written once a day by the research routine on the owner's Claude subscription (see ROUTINE.md);
//   2. the KV cache of earlier live answers;
//   3. live research on the owner's Anthropic API key, only when the LIVE_RESEARCH variable is "on".
// Otherwise the prompt joins the research queue (KV "q:<id>", read by GET /api/queue) and the visitor is told to check back tomorrow.
// Live spending is capped per day (DAILY_LIMIT_USD) and per visitor per hour (HOURLY_PER_VISITOR).
import Anthropic from "@anthropic-ai/sdk";

// The model is a setting: add a MODEL variable in Cloudflare (Settings -> Variables) to change it without code.
// Haiku 5.5 is the default because it costs about 1/40th of Opus 5.5.
const DEFAULT_MODEL = "claude-haiku-5-5";
// List prices in US$ per million tokens [input, output], used to estimate spend against DAILY_LIMIT_USD.
const PRICES = {"claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-fable-5-1": [10, 50]};
export const modelOf = env => (env.MODEL || DEFAULT_MODEL).trim();
const priceOf = model => PRICES[model] || [10, 50];      // unknown model: assume the dearest, so the cap stays safe
const CACHE_DAYS = 30;
const MAX_PROMPT_CHARS = 40000;
// Only the app's own prompts are accepted, so the endpoint can't be used as a general chatbot.
const PROMPT_STARTS = [
  "You are a meticulous equity research assistant.",
  "You are a careful equity research analyst.",
  "List the annual revenue of the listed company",
  "We measure whether ",
  "Someone typed ",
];

const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}});
const fail = (code, message, status) => json({error: {code, message}}, status);

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// The model settings, shared with /api/health so its test sends the same kind of request.
// Opus, Sonnet and Fable get Anthropic's automatic fallback when a request is declined; Haiku has none.
export const requestOptions = model => ({
  model,
  max_tokens: 16000,
  output_config: {effort: "medium"},
  ...(/haiku/.test(model) ? {} : {betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"}),
});

// "400 invalid_request_error: <Anthropic's message>" -- short, and safe to show
export function describe(e) {
  const inner = e && e.error && e.error.error;
  const text = inner ? `${e.status || ""} ${inner.type || ""}: ${inner.message || ""}` : `${(e && e.status) || ""} ${(e && e.message) || String(e)}`;
  return text.trim().slice(0, 300);
}

// A prompt's id, which names its answer file public/answers/<id>.json. tools/research-queue.mjs computes the same.
// The two main prompts are keyed by company, so the routine can research every company ahead of time:
//   "valuation/<TICKER>" (Valuation tab) and "research/<TICKER>" (Research tab).
// Any other prompt is keyed by the first 40 hex digits of its SHA-256.
export async function answerId(prompt) {
  let m;
  if (prompt.startsWith("You are a meticulous equity research assistant.") && (m = prompt.match(/ticker "([A-Z0-9._-]{1,40})"/))) return "valuation/" + m[1];
  if (prompt.startsWith("You are a careful equity research analyst. Assess the competitive advantages") && (m = prompt.match(/\(ticker ([A-Z0-9._-]{1,40})\)/))) return "research/" + m[1];
  return (await sha256(prompt)).slice(0, 40);
}

// The routine's saved answer, if there is one. Pages serves index.html for missing files, so check it's JSON.
async function assetJSON(request, env, file) {
  if (!env.ASSETS) return null;
  const r = await env.ASSETS.fetch(new URL(file, request.url));
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return null;
  try { return await r.json(); } catch { return null; }
}
// Another share class of a researched company (GOOG for GOOGL) uses that company's answer: answers/aliases.json.
export async function savedAnswer(request, env, id) {
  const hit = await assetJSON(request, env, `/answers/${id}.json`);
  if (hit) return hit.result || null;
  const m = id.match(/^(research|valuation)\/(.+)$/);
  if (!m) return null;
  const alias = ((await assetJSON(request, env, "/answers/aliases.json")) || {})[m[2]];
  return alias ? ((await assetJSON(request, env, `/answers/${m[1]}/${alias}.json`)) || {}).result || null : null;
}

const CLAUDE_EDITION = "https://claude.ai/artifact/UqgUFZYemAQZzJwwk7hRtW";
const QUEUED = `This hasn't been researched yet. It's now at the front of the research list, so check back later today or tomorrow. To research it right now, open RawResearch in Claude (free with your Claude account): ${CLAUDE_EDITION}`;

async function enqueue(request, env, id, prompt) {
  const k = "q:" + id, now = new Date().toISOString(), old = await env.KV.get(k, "json");
  if (!old) {                                     // a new entry: limit how many one visitor can add per hour
    const ip = request.headers.get("cf-connecting-ip") || "unknown", ipKey = `qip:${ip}:${now.slice(0, 13)}`;
    const n = Number(await env.KV.get(ipKey) || 0);
    if (n >= Number(env.HOURLY_PER_VISITOR || 15)) return false;
    await env.KV.put(ipKey, String(n + 1), {expirationTtl: 7200});
  }
  await env.KV.put(k, JSON.stringify({prompt, first: old ? old.first : now, last: now, count: (old ? old.count : 0) + 1}), {expirationTtl: 60 * 86400});
  return true;
}

function parseReply(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

export async function onRequestPost({request, env}) {
  if (!env.KV) return fail("not_configured", "The site's storage isn't set up yet.", 503);
  let prompt;
  try { ({prompt} = await request.json()); } catch { return fail("bad_request", "Bad request.", 400); }
  if (typeof prompt !== "string" || !prompt || prompt.length > MAX_PROMPT_CHARS || !PROMPT_STARTS.some(p => prompt.startsWith(p)))
    return fail("bad_request", "This request isn't one the app makes.", 400);

  const id = await answerId(prompt);
  const saved = await savedAnswer(request, env, id);
  if (saved) return json({result: saved, cached: true});

  const MODEL = modelOf(env);
  const key = "ai:" + await sha256(MODEL + "\n" + prompt);
  const hit = await env.KV.get(key, "json");
  if (hit) return json({result: hit, cached: true});

  if (env.LIVE_RESEARCH !== "on" || !env.ANTHROPIC_API_KEY) {
    if (!await enqueue(request, env, id, prompt)) return fail("rate_limited", "You've asked for a lot of new research this hour. Try again later.", 429);
    return fail("queued", QUEUED, 202);
  }

  // limits: per visitor per hour, then the site-wide daily budget
  const now = new Date(), day = now.toISOString().slice(0, 10), hour = now.toISOString().slice(0, 13);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipKey = `ip:${ip}:${hour}`, perHour = Number(env.HOURLY_PER_VISITOR || 15);
  const used = Number(await env.KV.get(ipKey) || 0);
  if (used >= perHour) return fail("rate_limited", "You've run a lot of new research this hour. Try again later.", 429);
  const spendKey = "spend:" + day, limit = Number(env.DAILY_LIMIT_USD || 5);
  const spent = Number(await env.KV.get(spendKey) || 0);
  if (spent >= limit) {
    await enqueue(request, env, id, prompt);
    return fail("queued", QUEUED, 202);
  }
  await env.KV.put(ipKey, String(used + 1), {expirationTtl: 7200});

  const client = new Anthropic({apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? {baseURL: env.ANTHROPIC_BASE_URL} : {})});
  let msg;
  try {
    msg = await client.beta.messages.create({...requestOptions(MODEL), messages: [{role: "user", content: prompt}]});
  } catch (e) {
    // The reason is shown to the visitor (it never contains the key), so a setup problem can be seen and fixed.
    const why = `(${describe(e)})`;
    console.log("anthropic error", why);
    if (e instanceof Anthropic.RateLimitError) return fail("rate_limited", "Research is busy right now. Wait a minute and try again. " + why, 429);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return fail("not_configured", "The site's research key isn't working. The site owner needs to check it. " + why, 503);
    if (e instanceof Anthropic.APIError) return fail("upstream", "Research failed. Try again in a moment. " + why, 502);
    return fail("upstream", "Research couldn't be reached. Try again in a moment. " + why, 502);
  }

  const u = msg.usage || {};
  const [pin, pout] = priceOf(MODEL);
  const cost = ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout) / 1e6;
  await env.KV.put(spendKey, String(Math.round((Number(await env.KV.get(spendKey) || 0) + cost) * 1e4) / 1e4), {expirationTtl: 40 * 86400});

  if (msg.stop_reason === "refusal") return fail("refused", "Claude declined this request.", 422);
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const result = parseReply(text);
  if (!result) return fail("invalid_json", `Claude's reply couldn't be read as data (stop reason: ${msg.stop_reason}).`, 502);
  if (Object.keys(result).length)                          // an empty answer isn't saved, so a retry asks again
    await env.KV.put(key, JSON.stringify(result), {expirationTtl: CACHE_DAYS * 86400});
  return json({result, cached: false});
}
