# Research routine

A scheduled Claude task runs this every hour on the site owner's Claude subscription. It researches every company,
largest market cap first, plus anything visitors asked for, and commits the answers. The website serves them free
to everyone. When the subscription's usage runs out, the run simply stops; the next hourly run carries on from where
it left off, because the work list is worked out from the answers already saved.

## Each run

1. In this repository, `git pull --rebase origin main`.
2. Repeat, batch after batch, until usage runs out (the owner wants as many companies as the plan allows):
   1. `node tools/research-queue.mjs next 20` writes the next 20 prompts to `tools/work/<file>.prompt.txt`:
      visitors' requests first, then every company largest first (Research and Valuation), then refreshes of
      answers older than 30 days. If it says 0 prompts, everything is done: stop.
   2. Split the prompt files between 5 helper agents (4 each) and run them in parallel. Give each helper the
      instructions under "Answering a prompt" below and its list of files.
   3. `node tools/research-queue.mjs commit` commits and pushes what was saved. The site rebuilds at most every
      2 hours; other pushes wait for the next rebuild.
3. If you're stopping for any other reason, end with `node tools/research-queue.mjs commit --deploy`, then `node tools/research-queue.mjs status`, and put the
   status line in the thread's status checklist. Reply in the thread only if something failed or the owner must act.

## Answering a prompt

For each file `tools/work/<file>.prompt.txt` you were given:
- Read the whole prompt and answer it exactly as it asks, as a careful equity research analyst would. It asks for
  one JSON object with a given shape; keep every field name and type it specifies.
- Use web search to check current facts (latest fiscal year, revenue, share counts, management, competitors,
  analyst forecasts) where the prompt asks for current information. Never invent figures: where the prompt allows
  null, use null.
- The owner's data rule: figures for companies that file with the SEC must be exact reported figures (SEC filings,
  company releases) or calculated exactly from them, never recalled from memory, rounded or scaled. If you can't
  check one, use null. Only companies that don't file with the SEC (private or foreign-only) may get estimates, and
  the answer's notes must say they are estimates.
- Write only the JSON object to `tools/work/<file>.answer.json`, then run
  `node tools/research-queue.mjs save <file> tools/work/<file>.answer.json`. If it reports an error, fix the JSON
  and save again. If the ticker is a fund, ETF or trust rather than an operating company, or a prompt can't be
  answered (for example the company no longer exists), run `node tools/research-queue.mjs skip <file>`.
- Report which files were saved and which were skipped.

Rules: change nothing outside `public/answers/` and `tools/work/`. Never put keys or passwords anywhere.
