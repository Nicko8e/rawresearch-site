// POST /api/feedback  {type, where, text, edition, url}  ->  {ok:true}
// Saved in KV under fb:<time>:<id>. Read it in Cloudflare: Workers & Pages -> KV -> the site's namespace.
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}});
const MAX = 3000, PER_HOUR = 10;

export async function onRequestPost({request, env}) {
  if (!env.KV) return json({error: "not_configured"}, 503);
  let it; try { it = await request.json(); } catch { return json({error: "bad_request"}, 400); }
  const text = typeof it.text === "string" ? it.text.trim().slice(0, MAX) : "";
  if (!text) return json({error: "bad_request"}, 400);
  const ip = request.headers.get("cf-connecting-ip") || "unknown", hour = new Date().toISOString().slice(0, 13);
  const k = `fbip:${ip}:${hour}`, n = Number(await env.KV.get(k) || 0);
  if (n >= PER_HOUR) return json({error: "rate_limited"}, 429);
  await env.KV.put(k, String(n + 1), {expirationTtl: 7200});
  const s = v => typeof v === "string" ? v.slice(0, 300) : "";
  const at = new Date().toISOString(), id = crypto.randomUUID().slice(0, 8);
  await env.KV.put(`fb:${at}:${id}`, JSON.stringify({at, type: s(it.type), where: s(it.where), edition: s(it.edition), url: s(it.url), text}));
  return json({ok: true});
}
