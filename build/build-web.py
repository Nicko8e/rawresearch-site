#!/usr/bin/env python3
"""Build the RawResearch website page from the app's public edition.

    python3 build/build-web.py [source/app-public-edition.html] [public/index.html]

The public edition runs inside Claude, where the page asks Claude through window.claude. The website has no
Claude runtime, so this script:
  1. adds a small web runtime that answers window.claude.use("sample") through /api/claude (the site's own API key);
     "db" and "user" are not available, so notes stay in the visitor's browser;
  2. replaces three functions: fetchFinancials (SEC figures straight from the data domain), livePrice (/api/price)
     and the feedback sender (/api/feedback);
  3. rewords the messages that told visitors to open the page in Claude.
Every replacement is checked: if the source changed so a step no longer matches, the build stops with an error.
Re-run it whenever the public edition changes.
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "source/app-public-edition.html"
out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "public/index.html"
DATA_BASE = "https://data.companyresearch.io/"
html = src.read_text()

def replace_once(old, new):
    global html
    n = html.count(old)
    if n != 1: sys.exit(f"build-web: expected exactly one match, found {n}: {old[:80]!r}")
    html = html.replace(old, new)

def replace_function(header, body):
    """Replace a top-level function: from its header line up to the next line that is just '}'."""
    global html
    lines = html.split("\n")
    starts = [i for i, l in enumerate(lines) if l.startswith(header)]
    if len(starts) != 1: sys.exit(f"build-web: function {header!r} found {len(starts)} times")
    s = starts[0]
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    lines[s:e + 1] = body.strip("\n").split("\n")
    html = "\n".join(lines)

# ---------- 1. web runtime ----------
RUNTIME = """<script>
/* Website runtime (added by build/build-web.py). The app was written for Claude, where window.claude.use() gives it
   Claude ("sample"), a shared database ("db") and the viewer's identity ("user"). Here only Claude is available,
   through the site's /api/claude endpoint; notes stay in this browser. */
window.RR_WEB={dataBase:%r};
(function(){
  async function ask(prompt){
    let r, j=null;
    try{ r=await fetch("/api/claude",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt})}); j=await r.json(); }
    catch(e){ throw Object.assign(new Error("Research couldn't be reached. Check your connection and try again."),{code:"network",web:true}); }
    if(!r.ok || !j || j.error){ const er=(j&&j.error)||{}; throw Object.assign(new Error(er.message||"Research failed. Try again in a moment."),{code:er.code||"error",web:true}); }
    return j.result;
  }
  const sample=async(prompt)=>JSON.stringify(await ask(prompt));
  sample.json=ask;
  window.claude={use:async(name)=>name==="sample"? sample : null};
})();
</script>
""" % DATA_BASE
replace_once("\n<script>\n", "\n" + RUNTIME + "<script>\n")

# ---------- 2a. SEC figures straight from the data domain ----------
replace_function("async function fetchFinancials(t){", r"""
/* Website: SEC figures straight from the data domain. sheet/balance_sheet.csv gives each ticker's company name, SEC number
   (CIK) and latest balance sheet; company/<CIK>.csv is the full annual history. They are assembled into the same shape the
   Google Sheet's 'Tool financials' tab has, so the rest of the app reads them unchanged. */
const FIN_WEB={bal:null, files:{}};
function parseCSVText(t){            // RFC 4180: quoted fields may hold commas, quotes and line breaks
  const rows=[]; let row=[], f="", q=false;
  for(let i=0;i<t.length;i++){ const c=t[i];
    if(q){ if(c==='"'){ if(t[i+1]==='"'){ f+='"'; i++; } else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===","){ row.push(f); f=""; }
    else if(c==="\n"){ row.push(f.replace(/\r$/,"")); rows.push(row); row=[]; f=""; }
    else f+=c; }
  if(f||row.length){ row.push(f); rows.push(row); }
  return rows;
}
async function dataText(path, what){
  let r; try{ r=await withTimeout(fetch(RR_WEB.dataBase+path),30000,`Loading ${what} is taking too long. Try again in a moment.`); }
  catch(e){ if(e.code==="timeout") throw e; throw new Error(`${what[0].toUpperCase()+what.slice(1)} couldn't be loaded. Check your connection and try again.`); }
  if(r.status===404) return null;
  if(!r.ok) throw new Error(`${what[0].toUpperCase()+what.slice(1)} couldn't be loaded right now. Try again in a moment.`);
  return r.text();
}
function balanceTable(){
  if(!FIN_WEB.bal) FIN_WEB.bal=(async()=>{
    const t=await dataText("sheet/balance_sheet.csv","the SEC company list");
    if(!t) throw new Error("The SEC company list isn't available right now. Try again later.");
    const m=new Map(); for(const r of parseCSVText(t).slice(1)) if(r[0]) m.set(r[0].toUpperCase(), r);
    return m;
  })().catch(e=>{ FIN_WEB.bal=null; throw e; });
  return FIN_WEB.bal;
}
async function fetchFinancials(t){
  t=docId(t);
  if(!FIN_WEB.files[t]) FIN_WEB.files[t]=(async()=>{
    const b=(await balanceTable()).get(t);
    if(!b) throw Object.assign(new Error(`${t} isn't in the SEC company list. Full financial history covers companies listed in the US that file with the SEC. Companies listed only elsewhere, like ${/\./.test(t)?t:"0700.HK"}, aren't included.`),{final:true, missing:true});
    const [, name, cik, cash, sti, ltd, cur, , asOf, qsh, qEnd]=b;
    const text=await dataText("company/"+cik+".csv", "the SEC figures for "+t);
    const rows=text? parseCSVText(text).filter(r=>r.length>1) : [];
    if(!rows.length || rows[0][0]!=="Line item") throw Object.assign(new Error(`The SEC hasn't published structured figures for ${name||t} (common for funds, very new listings and some foreign companies).`),{final:true, missing:true});
    const values=[["", t], ["Company", name, "", cash, sti, ltd, cur, asOf, qsh, qEnd], ["SEC CIK", cik], [], ...rows];
    return {values, fetchedAt:new Date().toISOString()};
  })().catch(e=>{ delete FIN_WEB.files[t]; throw e; });
  return FIN_WEB.files[t];
}
""")

# ---------- 2b. live price ----------
replace_function("async function livePrice(t){", r"""
async function livePrice(t){          // website: /api/price (Yahoo Finance, Stooq as backup)
  state.priceNeedsSheet=false;
  try{
    const r=await withTimeout(fetch("/api/price?t="+encodeURIComponent(t)),15000,"slow"), j=await r.json();
    if(state.data && docId(state.data.ticker||"")!==docId(t)) return;
    if(r.ok && j.price>0){
      state.price=j.price; state.priceCur=j.currency||null;
      const when=j.time? new Date(j.time) : null;
      state.priceNote=`Latest price from ${j.source||"the market"}${when&&!isNaN(when)? " · "+when.toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}) : ""} · may be delayed up to 20 min`;
    } else state.priceNote=`No live price found for ${t}. Enter the current share price under Assumptions.`;
  }catch(e){ state.priceNote="Live price unavailable right now. Enter the current share price under Assumptions."; }
}
""")

# ---------- 2c. famous investors from the data domain ----------
replace_function("async function loadInvestors(force){", r"""
async function loadInvestors(force){   // website: the 13F tables straight from the data domain
  if(INV.loading) return; INV.loading=true;
  $("invStatus").hidden=false; $("invStatus").className="status loading"; $("invStatus").innerHTML='<div class="lhead"><span class="spin" aria-hidden="true"></span><span>Loading the latest 13F portfolios…</span></div>';
  try{
    const [a,b]=await Promise.all([dataText("sheet/investors.csv","the investor list"), dataText("sheet/investor_holdings.csv","the investor holdings")]);
    const rows=a? csvRows(parseCSVText(a)) : [], hold=b? csvRows(parseCSVText(b)) : [];
    if(!rows.length) throw new Error("13F portfolios aren't available right now. Try again later.");
    INV.rows=rows; INV.hold=hold; INV.fetchedAt=new Date().toISOString();
    $("invStatus").hidden=true; renderInvestors();
  }catch(e){ $("invStatus").className="status err"; $("invStatus").textContent=e.message||String(e); }
  finally{ INV.loading=false; }
}
""")

# ---------- 2d. feedback goes to /api/feedback ----------
replace_once("const FB_EDITION='public', FB_URL='https://claude.ai/artifact/UqgUFZYemAQZzJwwk7hRtW'",
             "const FB_EDITION='website', FB_URL=location.origin")
replace_function("function fbInit(){", r"""
function fbInit(){                    // website: anyone can send feedback; it is stored for the site owner
  if(!FB.init) FB.init=(async()=>{ FB.canWrite=true; })();
  return FB.init;
}
""")
replace_function("async function fbSend(){", r"""
async function fbSend(){
  await fbInit(); const it=fbDraft(); if(!it) return;
  $("fbSend").disabled=true; fbMsg("Sending…");
  try{
    const r=await withTimeout(fetch("/api/feedback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(it)}),15000,"slow");
    if(!r.ok) throw new Error(String(r.status));
    $("fbText").value=""; $("fbOut").hidden=true; fbMsg("Sent. Thank you!");
  }catch(e){ fbMsg("It couldn't be sent right now. Press Copy my feedback and send it another way."); }
  finally{ $("fbSend").disabled=false; }
}
""")

# ---------- 2e. show the site's own error message (it says what went wrong) instead of a generic one ----------
html, n = re.subn(r'map\[e&&e\.code\]\|\|\(e&&e\.code==="timeout"\? e\.message : ', 'map[e&&e.code]||(e&&(e.code==="timeout"||e.web)? e.message : ', html)
if n != 2: sys.exit(f"build-web: expected 2 generic request-failed messages, found {n}")

# ---------- 2f. point visitors to the free Claude edition for deeper research ----------
CLAUDE_EDITION = "https://claude.ai/artifact/UqgUFZYemAQZzJwwk7hRtW"
replace_once('<p class="note" style="margin:0" id="resMeta"></p>',
             '<p class="note" style="margin:0" id="resMeta"></p>\n        <p class="note" style="margin:4px 0 0">Want deeper research? <a href="%s" target="_blank" rel="noopener">Open Company Research in Claude</a>. It runs on Claude\'s most capable models and is free with your own Claude account.</p>' % CLAUDE_EDITION)

# ---------- 2g. let the research routine build the exact prompts the page sends (tools/research-queue.mjs) ----------
replace_once("\n})();\n</script>\n\n</body>", "\nwindow.RR_PROMPTS={researchPrompt, samplePrompt, fwPrompt};   // used by tools/research-queue.mjs\n})();\n</script>\n\n</body>")

# ---------- 2h. frameworks: show the site's message (e.g. "on the research list") instead of a generic retry ----------
replace_once("""catch(e){ throw new Error(e&&e.code==="timeout"? e.message : "Claude couldn't apply this framework just now. Choose it again to retry."); }""",
             """catch(e){ throw new Error(e&&(e.code==="timeout"||e.web)? e.message : "Claude couldn't apply this framework just now. Choose it again to retry."); }""")

# ---------- 3. wording that pointed visitors to Claude ----------
for old, new in [
    ("This view can't ask Claude for company data. Open the page in Claude, or ask Claude in chat to research this ticker for the tool.",
     "Research isn't available right now. Try again later."),
    (", or ask Claude in chat to web-research it.", "."),
    ("Figures come from Claude's knowledge. Ask Claude in chat to run the SEC check for this ticker.",
     "Figures come from Claude's knowledge. SEC figures aren't available for this ticker."),
    ("Frameworks need Claude. Open this page in Claude, then try again.", "Frameworks aren't available right now. Try again later."),
    ("Research needs Claude. Open this page in Claude, then try again.", "Research isn't available right now. Try again later."),
    ("Open this page in Claude while signed in to keep notes in your account and share them publicly.",
     "Notes are kept in this browser. Sharing notes publicly isn't available on the website yet."),
]:
    replace_once(old, new)
html, n = re.subn(r"Claude is busy for your account right now\.", "Research is busy or has reached today's limit.", html)
if n != 2: sys.exit(f"build-web: expected 2 'Claude is busy' messages, found {n}")
replace_once("<!-- APP NAME: to rename the app, change the two names on the next two lines (the title is what Claude's gallery shows). -->",
             "<!-- APP NAME: to rename the app, change the two names on the next two lines. Built from the public edition by build/build-web.py; edit the source, not this file. -->")

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html)
print(f"build-web: wrote {out} ({len(html):,} bytes)")
