// GET /api/price?t=NVDA  ->  {price, currency, time, source}
// Latest share price from Yahoo Finance's public chart feed, with Stooq as a backup. Cached for 10 minutes.
const json = (body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), {status,
  headers: {"content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store"}});
const UA = {"user-agent": "Mozilla/5.0 (compatible; RawResearch/1.0)"};

async function yahoo(t) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=1d`, {headers: UA});
  if (!r.ok) return null;
  const m = (((await r.json()).chart || {}).result || [])[0]?.meta;
  if (!m || !(m.regularMarketPrice > 0)) return null;
  return {price: m.regularMarketPrice, currency: m.currency || null, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, source: "Yahoo Finance"};
}

async function stooq(t) {
  if (t.includes(".")) return null;                       // US listings only
  const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(t.toLowerCase())}.us&f=sd2t2c&h&e=csv`, {headers: UA});
  if (!r.ok) return null;
  const [, row] = (await r.text()).trim().split("\n");
  const [, date, time, close] = (row || "").split(",");
  const price = Number(close);
  return price > 0 ? {price, currency: "USD", time: date && time ? `${date}T${time}Z` : null, source: "Stooq"} : null;
}

export async function onRequestGet({request, waitUntil}) {
  const t = (new URL(request.url).searchParams.get("t") || "").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(t)) return json({error: "Unknown ticker."}, 400);
  const cache = caches.default, cacheKey = new Request(`https://price.cache/${t}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let p = null;
  for (const src of [yahoo, stooq]) { try { p = await src(t); } catch { p = null; } if (p) break; }
  if (!p) return json({error: "No price found."}, 404);
  const res = json(p, 200, 600);
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
