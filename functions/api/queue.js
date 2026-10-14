// GET /api/queue  ->  {items: [{id, prompt, count, first, last}]}  most-requested first
// The research the website's visitors asked for that has no saved answer yet. The daily routine (ROUTINE.md) reads it,
// answers each prompt and commits public/answers/<id>.json. Entries already answered are dropped here.
// Prompts are the app's own fixed templates with a ticker filled in, so nothing private is listed.
import {savedAnswer} from "./claude.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}});

export async function onRequestGet({request, env}) {
  if (!env.KV) return json({error: "not_configured"}, 503);
  const items = [];
  let cursor;
  do {
    const page = await env.KV.list({prefix: "q:", cursor, limit: 1000});
    for (const k of page.keys) {
      const id = k.name.slice(2);
      if (await savedAnswer(request, env, id)) { await env.KV.delete(k.name); continue; }
      const v = await env.KV.get(k.name, "json");
      if (v) items.push({id, ...v});
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && items.length < 500);
  items.sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));
  return json({items});
}
