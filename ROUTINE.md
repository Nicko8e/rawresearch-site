# Daily research routine

A scheduled Claude task runs this once a day on the site owner's Claude subscription. It answers the research
visitors asked for and commits the answers, so the website serves them free to everyone.

1. In this repository, run `node tools/research-queue.mjs fetch 25`. It lists up to 25 prompts, most-requested first,
   and writes each to `tools/work/<id>.prompt.txt`. If it says 0 prompts, stop: there's nothing to do.
2. For each prompt file, in order:
   - Read the whole prompt and answer it exactly as it asks, as a careful equity research analyst would. It asks for
     one JSON object with a given shape; keep every field name and type it specifies.
   - Use web search to check recent facts (latest fiscal year, share counts, management, competitors) where the
     prompt asks for current information. Never invent figures: where the prompt allows null, use null.
   - Write only the JSON object to `tools/work/<id>.answer.json`, then run
     `node tools/research-queue.mjs save <id> tools/work/<id>.answer.json`. If it reports an error, fix the JSON and
     run it again. If a prompt can't be answered, skip it; it stays in the queue for the next run.
3. Commit the new files in `public/answers/` with the message `Daily research: N answers`, and push to `main`.
   Cloudflare redeploys the site by itself, and the queue drops answered items.
4. Reply with one line: how many answers were saved, and how many prompts are still waiting.

Rules: change nothing outside `public/answers/`. Never put keys or passwords anywhere.
