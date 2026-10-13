// POST /api/claude  {prompt}  ->  {result}  (the JSON object Claude replied with)
// Runs the app's research prompts on the site owner's Anthropic API key.
// Every answer is saved in KV by prompt, so each company is paid for once and later visitors get it instantly.
// Spending is capped per day (DAILY_LIMIT_USD) and per visitor per hour (HOURLY_PER_VISITOR).
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const USD_PER_INPUT_TOKEN = 4 / 1e6, USD_PER_OUTPUT_TOKEN = 20 / 1e6;   // Claude Opus 5.5 list prices
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

  const key = "ai:" + await sha256(MODEL + "\n" + prompt);
  const hit = await env.KV.get(key, "json");
  if (hit) return json({result: hit, cached: true});

  if (!env.ANTHROPIC_API_KEY) return fail("not_configured", "Research isn't switched on for this site yet.", 503);

  // limits: per visitor per hour, then the site-wide daily budget
  const now = new Date(), day = now.toISOString().slice(0, 10), hour = now.toISOString().slice(0, 13);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipKey = `ip:${ip}:${hour}`, perHour = Number(env.HOURLY_PER_VISITOR || 15);
  const used = Number(await env.KV.get(ipKey) || 0);
  if (used >= perHour) return fail("rate_limited", "You've run a lot of new research this hour. Try again later.", 429);
  const spendKey = "spend:" + day, limit = Number(env.DAILY_LIMIT_USD || 5);
  const spent = Number(await env.KV.get(spendKey) || 0);
  if (spent >= limit) return fail("rate_limited", "Today's research limit has been reached. Companies already researched still work; new ones can be researched tomorrow.", 429);
  await env.KV.put(ipKey, String(used + 1), {expirationTtl: 7200});

  const client = new Anthropic({apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? {baseURL: env.ANTHROPIC_BASE_URL} : {})});
  let msg;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {effort: "medium"},
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{role: "user", content: prompt}],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return fail("rate_limited", "Research is busy right now. Wait a minute and try again.", 429);
    if (e instanceof Anthropic.AuthenticationError) return fail("not_configured", "The site's research key isn't working. The site owner needs to check it.", 503);
    if (e instanceof Anthropic.APIError) return fail("upstream", "Research failed. Try again in a moment.", 502);
    return fail("upstream", "Research couldn't be reached. Try again in a moment.", 502);
  }

  const u = msg.usage || {};
  const cost = (u.input_tokens || 0) * USD_PER_INPUT_TOKEN + (u.output_tokens || 0) * USD_PER_OUTPUT_TOKEN;
  await env.KV.put(spendKey, String(Math.round((Number(await env.KV.get(spendKey) || 0) + cost) * 1e4) / 1e4), {expirationTtl: 40 * 86400});

  if (msg.stop_reason === "refusal") return fail("refused", "Claude declined this request.", 422);
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const result = parseReply(text);
  if (!result) return fail("invalid_json", "Claude's reply couldn't be read as data.", 502);
  if (Object.keys(result).length)                          // an empty answer isn't saved, so a retry asks again
    await env.KV.put(key, JSON.stringify(result), {expirationTtl: CACHE_DAYS * 86400});
  return json({result, cached: false});
}
