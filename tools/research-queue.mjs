#!/usr/bin/env node
// Helper for the daily research routine (ROUTINE.md). No dependencies.
//
//   node tools/research-queue.mjs fetch [N] [queue.json]
//       Reads the website's research queue (https://companyresearch.io/api/queue, or a saved copy) and writes the N
//       most-requested prompts that have no saved answer yet to tools/work/<id>.prompt.txt (default N = 25).
//   node tools/research-queue.mjs save <id> <answer-file>
//       Checks the answer is a JSON object and writes public/answers/<id>.json, which the website serves to everyone.
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WORK = path.join(ROOT, "tools/work"), ANSWERS = path.join(ROOT, "public/answers");
const QUEUE_URL = process.env.QUEUE_URL || "https://companyresearch.io/api/queue";
const answerId = p => createHash("sha256").update(p, "utf8").digest("hex").slice(0, 40);   // same as functions/api/claude.js
const die = m => { console.error("research-queue: " + m); process.exit(1); };

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "fetch") {
  const n = Number(a || 25);
  let q;
  if (b) q = JSON.parse(fs.readFileSync(b, "utf8"));
  else { const r = await fetch(QUEUE_URL); if (!r.ok) die(`queue request failed: HTTP ${r.status}`); q = await r.json(); }
  fs.mkdirSync(WORK, {recursive: true});
  let picked = 0;
  for (const it of q.items || []) {
    if (picked >= n) break;
    if (typeof it.prompt !== "string" || answerId(it.prompt) !== it.id) { console.log(`skip ${it.id}: prompt doesn't match its id`); continue; }
    if (fs.existsSync(path.join(ANSWERS, it.id + ".json"))) continue;
    fs.writeFileSync(path.join(WORK, it.id + ".prompt.txt"), it.prompt);
    console.log(`${it.id}  (asked ${it.count}x)  ${it.prompt.slice(0, 110).replace(/\s+/g, " ")}`);
    picked++;
  }
  console.log(`${picked} prompt(s) to answer, of ${(q.items || []).length} in the queue. Files: tools/work/<id>.prompt.txt`);
} else if (cmd === "save") {
  if (!a || !b) die("usage: save <id> <answer-file>");
  const pf = path.join(WORK, a + ".prompt.txt");
  if (!fs.existsSync(pf)) die(`no prompt file for ${a}; run fetch first`);
  const prompt = fs.readFileSync(pf, "utf8");
  if (answerId(prompt) !== a) die("prompt file doesn't match the id");
  const text = fs.readFileSync(b, "utf8"), s = text.indexOf("{"), e = text.lastIndexOf("}");
  let result;
  try { result = JSON.parse(text.slice(s, e + 1)); } catch (err) { die("the answer isn't valid JSON: " + err.message); }
  if (!result || typeof result !== "object" || Array.isArray(result) || !Object.keys(result).length) die("the answer must be a non-empty JSON object");
  fs.mkdirSync(ANSWERS, {recursive: true});
  fs.writeFileSync(path.join(ANSWERS, a + ".json"), JSON.stringify({id: a, answeredAt: new Date().toISOString(), by: "daily research routine", prompt, result}));
  console.log(`saved public/answers/${a}.json`);
} else die("usage: fetch [N] [queue.json] | save <id> <answer-file>");
