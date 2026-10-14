# RawResearch website (companyresearch.io)

The RawResearch app as a public website, hosted on Cloudflare Pages.

| Path | What it is |
|---|---|
| `public/index.html` | The app page. Generated, so don't edit it by hand. |
| `functions/api/claude.js` | `/api/claude`: answers the app's research prompts from `public/answers/` (written by the hourly research routine on your Claude subscription, which works through every company largest first; see `ROUTINE.md`). Anything not answered yet joins the research queue and the visitor is told to check back tomorrow. Live research on an Anthropic API key runs only if you set `LIVE_RESEARCH` to `on`. |
| `functions/api/queue.js` | `/api/queue`: the research visitors asked for that has no answer yet, most-requested first. |
| `tools/research-queue.mjs`, `ROUTINE.md` | The daily routine's helper and steps. |
| `functions/api/price.js` | `/api/price`: latest share price from Yahoo Finance, with Stooq as a backup. |
| `functions/api/feedback.js` | `/api/feedback`: stores visitors' feedback in KV, under keys starting `fb:`. |
| `build/build-web.py` | Turns the public edition (`source/app-public-edition.html`) into `public/index.html`. |

SEC figures load in the visitor's browser straight from `https://data.companyresearch.io` (the R2 bucket the daily GitHub job fills).

## Deploy (one time)

### 1. Free the main address
In Cloudflare, go to **R2 → ivd-sec-data → Settings**:
- Under **Custom Domains**, use **⋯ → Remove** on `companyresearch.io`. Keep `data.companyresearch.io`.
- Under **CORS Policy**, if it's still empty, click **Add** and paste:
  ```json
  [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400}]
  ```
  The website needs this to read the SEC files.

### 2. Put the files on GitHub
1. On GitHub, create a new repository named `rawresearch-site`. It can be private.
2. Unzip `rawresearch-site.zip`. In the repository, use **Add file → Upload files** and drag in everything inside the unzipped folder, keeping the folders. Then commit.

### 3. Create an Anthropic API key
1. At console.anthropic.com, open **API keys → Create key** and copy it.
2. Under **Settings → Limits**, set a monthly spend limit as a second safety cap.
3. Never paste the key into a chat or a file.

### 4. Create the Pages project
1. In Cloudflare, open **Workers & Pages → Create → Pages → Connect to Git**, then pick `rawresearch-site`.
2. Use these build settings:
   - Framework preset: **None**
   - Build command: `npm install`
   - Build output directory: `public`
3. Click **Save and Deploy**.

### 5. Storage and settings
1. Open **Storage & databases → KV → Create namespace** and name it `rawresearch`.
2. In the Pages project, open **Settings → Bindings → Add → KV namespace**. Set the variable name to `KV` and pick `rawresearch`.
3. In **Settings → Variables and Secrets**, add:
   - `ANTHROPIC_API_KEY`, type **Secret**: your key.
   - `DAILY_LIMIT_USD`: for example `5`. New research stops for the day once this much has been spent.
   - `HOURLY_PER_VISITOR`: for example `15`. This many new research runs are allowed per visitor per hour.
4. Open **Deployments**, then **⋯ → Retry deployment** on the latest one, so the new settings take effect.

### 6. Connect the domain
1. In the Pages project, open **Custom domains → Set up a custom domain**.
2. Enter `companyresearch.io` and confirm. Optionally add `www.companyresearch.io` too.

## Updating the app later
1. When the public edition changes, copy it over `source/app-public-edition.html`.
2. Run `python3 build/build-web.py`.
3. Upload the changed `public/index.html` to the repository. Cloudflare redeploys by itself.

## Notes
- The model is Claude Haiku 5.5 at medium effort (about 1/40th the cost of Opus 5.5). To change it, add a `MODEL` variable in Cloudflare, e.g. `claude-opus-5-5`, and retry the deployment. Spending is estimated from token counts at list prices.
- On Cloudflare's free plan, each request gets a small CPU-time allowance. If research requests fail with "exceeded CPU" errors in the Pages logs, switch to Workers Paid ($5 a month).
- Notes are kept in each visitor's browser only. The website has no sign-in yet, so public notes are off.
