// GET /api/health  ->  is the site set up?  {kv, key, limits, spentToday}
// GET /api/health?test=1  ->  also sends Claude a one-word request and reports {test: "ok" | the error}.
// Never shows the key itself. The test is limited to 20 a day so it can't run up costs.
import Anthropic from "@anthropic-ai/sdk";
import {modelOf, requestOptions, describe} from "./claude.js";

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}});

export async function onRequestGet({request, env}) {
  const day = new Date().toISOString().slice(0, 10);
  const out = {
    kv: !!env.KV,
    key: !!env.ANTHROPIC_API_KEY,
    dailyLimitUsd: Number(env.DAILY_LIMIT_USD || 5),
    hourlyPerVisitor: Number(env.HOURLY_PER_VISITOR || 15),
    spentTodayUsd: env.KV ? Number(await env.KV.get("spend:" + day) || 0) : null,
    model: modelOf(env),
  };
  if (new URL(request.url).searchParams.get("test") && out.key) {
    const tk = "healthtest:" + day, n = env.KV ? Number(await env.KV.get(tk) || 0) : 0;
    if (n >= 20) out.test = "skipped: 20 tests already run today";
    else {
      if (env.KV) await env.KV.put(tk, String(n + 1), {expirationTtl: 2 * 86400});
      try {
        const client = new Anthropic({apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? {baseURL: env.ANTHROPIC_BASE_URL} : {})});
        const msg = await client.beta.messages.create({...requestOptions(modelOf(env)), max_tokens: 16, messages: [{role: "user", content: "Reply with the word ok."}]});
        out.test = "ok";
        out.servedBy = msg.model;
      } catch (e) { out.test = describe(e); }
    }
  }
  return json(out);
}
