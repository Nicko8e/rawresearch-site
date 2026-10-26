#!/usr/bin/env node
// Helper for the research routine (ROUTINE.md). Needs Node 18+, and Playwright + Chromium for `next`.
//
//   node tools/research-queue.mjs next [N]
//       Picks the next N prompts to answer and writes each to tools/work/<file>.prompt.txt (default N = 20):
//         1. visitors' requests waiting in tools/queue.json, most-requested first;
//         2. every company in tools/order-ranked.txt (largest market cap first) that has no Research, Valuation or
//            investor-frameworks answer;
//         3. once all are done, the oldest answers (older than 30 days), so the research stays current.
//   node tools/research-queue.mjs save <file> <answer-file>
//       Checks the answer and writes public/answers/<id>.json, which the website serves to everyone.
//   node tools/research-queue.mjs commit [--deploy]
//       Commits and pushes new answers. Cloudflare rebuilds the site at most every 2 hours (or with --deploy);
//       other commits carry "[CI Skip]" so the free plan's build allowance isn't used up.
//   node tools/research-queue.mjs skip <file>
//       Leaves a prompt out of future runs (tools/skip.txt), for example a company that no longer exists.
//   node tools/research-queue.mjs status
//       How many companies are done.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {execSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORK = path.join(ROOT, "tools/work"), ANSWERS = path.join(ROOT, "public/answers");
const REFRESH_DAYS = 30, UNCLEAR_AT = 200, DEPLOY_EVERY_H = 2;
// Every company gets Research, Valuation and every investor framework (one combined prompt) ahead of time.
const kindsFor = () => ["research", "valuation", "frameworks"];
const FW_TOPUP_TOP = 100;
const VAL_PROJ_SINCE = Date.parse("2026-10-26T01:05:00Z");   // valuation answers before this lack the 3- and 5-year forecast rules     // frameworks answers saved before a framework was added are all in the largest 100
const die = m => { console.error("research-queue: " + m); process.exit(1); };
const read = f => fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
const fileOf = id => id.replace(/\//g, "__"), idOf = file => file.replace(/__/g, "/");
const answerPath = id => path.join(ANSWERS, id + ".json");

// Same ids as functions/api/claude.js answerId().
function answerId(prompt) {
  let m;
  if (prompt.startsWith("You are a meticulous equity research assistant.") && (m = prompt.match(/ticker "([A-Z0-9._-]{1,40})"/))) return "valuation/" + m[1];
  if (prompt.startsWith("You are a careful equity research analyst. Assess the competitive advantages") && (m = prompt.match(/\(ticker ([A-Z0-9._-]{1,40})\)/))) return "research/" + m[1];
  if (prompt.startsWith("You are a careful equity research analyst. Apply famous investors' frameworks") && (m = prompt.match(/\(ticker ([A-Z0-9._-]{1,40})\)/))) return "frameworks/" + m[1];
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 40);
}

// tickers, largest first; the companies whose size couldn't be worked out (foreign shares priced in other currencies) go at rank 200
function order() {
  const ranked = read(path.join(ROOT, "tools/order-ranked.txt")).split(/\s+/).filter(Boolean);
  const unclear = read(path.join(ROOT, "tools/order-unclear.txt")).split(/\s+/).filter(Boolean);
  return [...ranked.slice(0, UNCLEAR_AT), ...unclear, ...ranked.slice(UNCLEAR_AT)];
}

// ticker -> company name, from the SEC company list the GitHub Action copies to tools/companies.csv
function names() {
  const m = new Map();
  for (const line of read(path.join(ROOT, "tools/companies.csv")).split("\n").slice(1)) {
    const r = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*)/);
    if (r) m.set(r[1].toUpperCase(), r[2].replace(/^"|"$/g, "").replace(/""/g, '"'));
  }
  return m;
}

const answeredAt = id => { try { return Date.parse(JSON.parse(read(answerPath(id))).answeredAt) || 0; } catch { return 0; } };

async function promptsFor(items) {             // builds the page's own prompts, so they match what visitors send
  const require = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/node-tools/node_modules/");
  const {chromium} = require("playwright");
  const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find(f => fs.existsSync(f));
  const browser = await chromium.launch(exe ? {executablePath: exe} : {});
  const page = await browser.newPage();
  await page.route("**/*", r => r.request().url().startsWith("file:") ? r.continue() : r.abort());
  await page.goto("file://" + path.join(ROOT, "public/index.html"));
  const out = await page.evaluate(items => items.map(([kind, t, name]) =>
    kind === "research" ? RR_PROMPTS.researchPrompt(t, name || undefined) : kind === "frameworks" ? RR_PROMPTS.fwPrompt(name || undefined, t) : RR_PROMPTS.samplePrompt(t)), items);
  await browser.close();
  return out;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "next") {
  const n = Number(a || 20), picked = [];
  fs.rmSync(WORK, {recursive: true, force: true}); fs.mkdirSync(WORK, {recursive: true});
  // 1. visitors' requests
  const skip = new Set(read(path.join(ROOT, "tools/skip.txt")).split(/\s+/).filter(Boolean));
  const q = read(path.join(ROOT, "tools/queue.json"));
  for (const it of (q ? JSON.parse(q).items : []) || []) {
    if (picked.length >= n) break;
    if (typeof it.prompt !== "string" || answerId(it.prompt) !== it.id || fs.existsSync(answerPath(it.id)) || skip.has(it.id)) continue;
    if (/^You are a careful equity research analyst\. Apply (?!famous investors' frameworks)/.test(it.prompt)) continue;   // one framework at a time: replaced by frameworks/<TICKER>
    picked.push({id: it.id, prompt: it.prompt, why: `requested ${it.count}x`});
  }
  const nm = names(), todo = [];
  const ord = order();
  // 1b. frameworks answers saved before a framework was added: ask only the new questions (tools/work/<file>.update.txt)
  const fwOld = ord.slice(0, FW_TOPUP_TOP).filter(t => fs.existsSync(answerPath(`frameworks/${t}`)));
  if (fwOld.length && picked.length < n) {
    const ps = await promptsFor(fwOld.map(t => ["frameworks", t, nm.get(t)]));
    fwOld.forEach((t, i) => {
      if (picked.length >= n) return;
      const r = JSON.parse(read(answerPath(`frameworks/${t}`))).result || {}, [sums, cks] = ps[i].split('"checklist"');
      const ids = re => [...re.matchAll(/^   "([A-Za-z0-9]+)":/gm)].map(m => m[1]);
      const need = [...ids(sums).filter(id => !(r.summaries || {})[id]).map(id => `summaries.${id}`),
                    ...ids(cks).filter(id => !(r.checklist || {})[id]).map(id => `checklist.${id}`)];
      if (need.length) picked.push({id: `frameworks/${t}`, prompt: ps[i], why: `add ${need.length} new answers`,
        update: `This company already has an answer: public/answers/frameworks/${t}.json. Keep its "result" exactly as it is and add only these missing entries (the prompt says what each one asks), then save the whole object:\n${need.join("\n")}\n`});
    });
  }
  // 1b. Valuation answers saved before the 3- and 5-year forecast rules (2026-10-26): redo only their "projections"
  const valOld = ord.filter(t => { const at = answeredAt(`valuation/${t}`); return at && at < VAL_PROJ_SINCE; });
  if (valOld.length && picked.length < n) {
    const ps = await promptsFor(valOld.slice(0, n - picked.length).map(t => ["valuation", t, nm.get(t)]));
    ps.forEach((pr, i) => picked.push({id: `valuation/${valOld[i]}`, prompt: pr, why: "add 3- and 5-year forecasts",
      update: `This company already has an answer: public/answers/valuation/${valOld[i]}.json. Keep its "result" exactly as it is except "projections": research them again following the prompt's rules for "projections" (look hard for 3- and 5-year forecasts and the low and high estimates for each horizon), replace "projections" with the new list, set "dataAsOf" to the newest data used, then save the whole object.\n`}));
  }
  // 2. every company, largest first; 3. then the oldest answers
  for (let i = 0; i < ord.length && picked.length + todo.length < n; i++)
    for (const kind of kindsFor(i))
      if (picked.length + todo.length < n && !picked.some(p => p.id === `${kind}/${ord[i]}`) && !skip.has(`${kind}/${ord[i]}`) && !skip.has(`research/${ord[i]}`) && !fs.existsSync(answerPath(`${kind}/${ord[i]}`)))
        todo.push({kind, t: ord[i], why: `rank ${i + 1}`});
  if (picked.length + todo.length < n) {
    const old = [];
    ord.forEach((t, i) => { for (const kind of kindsFor(i)) {
      const at = answeredAt(`${kind}/${t}`);
      if (at && Date.now() - at > REFRESH_DAYS * 864e5) old.push({kind, t, at, why: "refresh"});
    } });
    old.sort((x, y) => x.at - y.at);
    todo.push(...old.slice(0, n - picked.length - todo.length));
  }
  if (todo.length) {
    const ps = await promptsFor(todo.map(x => [x.kind, x.t, nm.get(x.t)]));
    todo.forEach((x, i) => picked.push({id: answerId(ps[i]), prompt: ps[i], why: x.why}));
  }
  for (const p of picked) {
    fs.writeFileSync(path.join(WORK, fileOf(p.id) + ".prompt.txt"), p.prompt);
    if (p.update) fs.writeFileSync(path.join(WORK, fileOf(p.id) + ".update.txt"), p.update);
    console.log(`${fileOf(p.id)}  (${p.why})`);
  }
  console.log(`${picked.length} prompt(s) to answer in tools/work/`);
} else if (cmd === "save") {
  if (!a || !b) die("usage: save <file> <answer-file>");
  const id = idOf(a.replace(/\.prompt\.txt$/, "").replace(/^.*\//, ""));
  const prompt = read(path.join(WORK, fileOf(id) + ".prompt.txt"));
  if (!prompt) die(`no prompt file for ${id}; run next first`);
  if (answerId(prompt) !== id) die("prompt file doesn't match its name");
  const text = read(b), s = text.indexOf("{"), e = text.lastIndexOf("}");
  let result;
  try { result = JSON.parse(text.slice(s, e + 1)); } catch (err) { die("the answer isn't valid JSON: " + err.message); }
  if (!result || typeof result !== "object" || Array.isArray(result) || !Object.keys(result).length) die("the answer must be a non-empty JSON object");
  if (id.startsWith("research/") && !Array.isArray(result.competitors)) die('a Research answer needs a "competitors" array');
  if (id.startsWith("valuation/") && !Array.isArray(result.revenueHistory)) die('a Valuation answer needs a "revenueHistory" array');
  if (id.startsWith("frameworks/") && !(result.checklist && result.summaries)) die('a frameworks answer needs "summaries" and "checklist" objects');
  fs.mkdirSync(path.dirname(answerPath(id)), {recursive: true});
  fs.writeFileSync(answerPath(id), JSON.stringify({id, answeredAt: new Date().toISOString(), by: "research routine", prompt, result}));
  console.log(`saved public/answers/${id}.json`);
} else if (cmd === "skip") {
  if (!a) die("usage: skip <file>");
  const id = idOf(a.replace(/\.prompt\.txt$/, "").replace(/^.*\//, ""));
  fs.appendFileSync(path.join(ROOT, "tools/skip.txt"), id + "\n");
  console.log(`${id} will be left out of future runs`);
} else if (cmd === "commit") {
  const git = c => execSync("git " + c, {cwd: ROOT, encoding: "utf8"}).trim();
  // Share classes of one company (GOOG and GOOGL) use one answer: aliases.json maps each other ticker to the researched one.
  const cik = new Map(), first = new Map(), alias = {}, ord = order();
  for (const line of read(path.join(ROOT, "tools/companies.csv")).split("\n").slice(1)) {
    const r = line.match(/^([^,]+),(?:"(?:[^"]|"")*"|[^,]*),(\d+)/); if (r) cik.set(r[1].toUpperCase(), r[2]);
  }
  for (const t of ord) if (cik.has(t) && !first.has(cik.get(t))) first.set(cik.get(t), t);
  for (const [t, c] of cik) if (first.has(c) && first.get(c) !== t) alias[t] = first.get(c);
  if (Object.keys(alias).length) { fs.mkdirSync(ANSWERS, {recursive: true}); fs.writeFileSync(path.join(ANSWERS, "aliases.json"), JSON.stringify(alias)); }
  git("add public/answers" + ["tools/skip.txt", "tools/run-log.csv"].filter(f => fs.existsSync(path.join(ROOT, f))).map(f => " " + f).join(""));
  const n = git("diff --cached --name-only -- public/answers").split("\n").filter(Boolean).length;
  if (!n) { console.log("nothing new to commit"); process.exit(0); }
  const lastDeploy = Number(git(`log -1 --format=%ct --invert-grep --grep="CI Skip" -- public/answers`) || 0);
  const deploy = a === "--deploy" || Date.now() / 1000 - lastDeploy > DEPLOY_EVERY_H * 3600;
  git(`-c user.name="RawResearch routine" -c user.email="noreply@anthropic.com" commit -q -m "Research: ${n} answers${deploy ? "" : " [CI Skip]"}"`);
  for (let i = 0; ; i++) {
    try { git("pull -q --rebase origin main"); git("push -q origin HEAD:main"); break; }
    catch (err) { if (i >= 4) die("push failed: " + err.message); execSync(`sleep ${2 ** (i + 1)}`); }
  }
  console.log(`pushed ${n} answer(s)${deploy ? "; the website will update in a few minutes" : " (published with the next deploy)"}`);
} else if (cmd === "status") {
  const ord = order(), has = k => ord.filter(t => fs.existsSync(answerPath(`${k}/${t}`))).length;
  console.log(`${ord.length} companies: Research done for ${has("research")}, Valuation done for ${has("valuation")}, investor frameworks for ${has("frameworks")}.`);
} else die("usage: next [N] | save <file> <answer-file> | commit [--deploy] | status");
