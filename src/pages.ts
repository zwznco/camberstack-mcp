/**
 * The public pages. The homepage and privacy policy double as what Google's brand verification
 * reviews: they must name the app, say what it does with Google user data, and link the policy.
 */

import type { Release } from "./changelog.js";
import { z } from "zod";
import { ACCOUNT_WINDOW_DAYS, PRO_PRICE_LABEL } from "./plans.js";
import type { ToolDoc } from "./tools.js";

const CONTACT = "adam@camberstack.io";
// Each policy keeps its own date: changing the terms mustn't re-date a privacy policy Google is reviewing.
const PRIVACY_UPDATED = "2026-10-17";
const TERMS_UPDATED = "2026-10-15";

const CSS = `
.linkish{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}
@font-face{font-family:"IBM Plex Sans";font-weight:400;font-display:swap;src:url(/fonts/ibm-plex-sans-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Sans";font-weight:600;font-display:swap;src:url(/fonts/ibm-plex-sans-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}
:root{--bg:#fbfaf7;--fg:#151715;--muted:#585d58;--line:#e4e1d9;--card:#fff;--tint:#f3f1ec;--accent:#1f5f4a;--accent-fg:#fff;--accent-soft:#e3ede7;--code:#efede7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1110;--fg:#ebeae5;--muted:#a3a7a1;--line:#272b28;--card:#161917;--tint:#131614;--accent:#6fc4a4;--accent-fg:#0d1f19;--accent-soft:#183129;--code:#1c1f1d}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1,h2,h3,strong,b,th{font-weight:600}
.wrap{max-width:860px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(10px);backdrop-filter:saturate(1.4) blur(10px)}header .wrap{display:flex;justify-content:space-between;align-items:center;height:60px}
.brand{white-space:nowrap;font-weight:600;letter-spacing:-.01em;color:var(--fg);text-decoration:none}
nav{display:flex;align-items:center}nav a{color:var(--muted);text-decoration:none;margin-left:20px;font-size:15px}nav a:hover{color:var(--fg)}
nav a.nav-cta{color:var(--accent-fg);background:var(--accent);padding:7px 14px;border-radius:8px;font-weight:600}nav a.nav-cta:hover{color:var(--accent-fg);filter:brightness(1.08)}
h1{font-size:clamp(30px,5vw,44px);line-height:1.15;text-wrap:balance;letter-spacing:-.02em;margin:56px 0 16px}
h2{font-size:24px;letter-spacing:-.01em;margin:56px 0 12px}h3{font-size:18px;margin:24px 0 6px}
p,li{color:var(--fg)}.lede{font-size:20px;color:var(--muted);max-width:680px}
.muted{color:var(--muted)}a{color:var(--accent)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:12px 18px;border-radius:9px;text-decoration:none;font-weight:600;box-shadow:0 1px 0 rgba(255,255,255,.12) inset,0 1px 2px rgba(0,0,0,.12);transition:filter .15s}.btn:hover{filter:brightness(1.08)}
.btn-ghost{background:transparent;color:var(--fg);box-shadow:0 0 0 1px var(--line) inset}.btn-ghost:hover{background:var(--tint);filter:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
.card h3{margin-top:0}
code,pre{font:14px/1.5 "IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:2px 5px}pre{padding:14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.convo{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:24px}
.convo p{margin:8px 0}.who{font-weight:600;color:var(--muted);font-size:14px;margin:16px 0 4px!important}.convo .who:first-child{margin-top:0!important}
.convo .said{display:inline-block;background:var(--code);border-radius:12px;padding:8px 14px;margin-top:0}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
footer{border-top:1px solid var(--line);margin-top:72px;padding:28px 0;font-size:14px;color:var(--muted)}
footer a{color:var(--muted);margin-right:16px}
.legal h2{font-size:20px;margin-top:36px}
ol.steps>li{margin-bottom:28px}
.shot{display:block;width:100%;max-width:340px;height:auto;margin-top:12px;border:1px solid var(--line);border-radius:12px}
.url{display:flex;align-items:center;gap:10px;background:var(--code);border-radius:8px;padding:8px 8px 8px 14px;margin:8px 0 24px}
.url code{background:none;padding:0;flex:1;font-size:15px;overflow-x:auto;white-space:nowrap}
.cmd{display:flex;align-items:flex-start;gap:10px;background:var(--code);border-radius:8px;padding:8px 8px 8px 14px;margin:8px 0 16px}
.cmd pre{background:none;padding:4px 0;margin:0;flex:1}
.acct{padding:32px 0 8px}
.acct-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:20px}
.acct-head h1{font-size:28px;margin:0}.acct-head .who{text-transform:none;letter-spacing:0;font-weight:400;font-size:15px}
.acct h2{font-size:19px;margin:36px 0 12px}
.acct .grid{margin-top:0}.acct .card{display:flex;flex-direction:column;gap:10px}
.label{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0}
.big{font-size:26px;font-weight:600;letter-spacing:-.01em;margin:0}
.meter{display:flex;gap:6px}.meter i{flex:1;height:8px;border-radius:4px;background:var(--line)}.meter i.on{background:var(--accent)}
.acct .card p{margin:0}.acct .card .btn{align-self:flex-start;margin-top:auto}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.ok{background:#2f9e6e}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:13px;border:1px solid var(--line);border-radius:99px;padding:2px 10px;color:var(--muted)}
.change{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.change-top{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between}
.change-meta{font-size:14px;color:var(--muted)}.change-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.change-time{font-size:14px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}.change-acct{margin:2px 0 0;font-size:14px;color:var(--muted);overflow-wrap:anywhere}.change ul{margin:8px 0 0;padding-left:20px}.change li{margin:2px 0;overflow-wrap:anywhere}
.fold summary{display:block;cursor:pointer;list-style:none;margin-top:8px}.fold summary::-webkit-details-marker{display:none}
.fold .preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
.fold .toggle{display:inline-block;margin-top:4px;font-size:14px;font-weight:600;color:var(--accent)}
.fold .opened,.fold[open] .closed,.fold[open] .preview{display:none}.fold[open] .opened{display:inline}.fold[open] .toggle{margin:0}
.range{display:grid;grid-template-columns:repeat(5,1fr);gap:2px;padding:3px;background:var(--code);border:1px solid var(--line);border-radius:10px;max-width:440px;margin-bottom:10px}
.range a{display:flex;align-items:center;justify-content:center;min-height:34px;border-radius:7px;font-size:14px;color:var(--muted);text-decoration:none;white-space:nowrap}
.range a:hover{color:var(--fg)}.range a[aria-current]{background:var(--card);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12),0 0 0 1px var(--line)}
.range-note{font-size:14px;margin:0 0 4px}
.acct h3.day{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 8px}
.pill{font-size:12px;font-weight:600;border-radius:99px;padding:2px 9px;white-space:nowrap}
.pill.applied{background:color-mix(in srgb,#2f9e6e 16%,transparent);color:#2f9e6e}
.pill.undone{background:color-mix(in srgb,#3d6fd1 15%,transparent);color:#3d6fd1}
.pill.proposed{background:color-mix(in srgb,#c78a12 18%,transparent);color:#b07a10}
.pill.failed{background:color-mix(in srgb,#c2412d 16%,transparent);color:#c2412d}
.pill.discarded{background:var(--code);color:var(--muted)}
.change-foot{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-top:10px;font-size:13px;color:var(--muted)}
.copy{font:inherit;font-size:13px;background:none;border:1px solid var(--line);border-radius:6px;padding:3px 9px;color:var(--fg);cursor:pointer}
.pill.ro{background:color-mix(in srgb,#2f9e6e 16%,transparent);color:#2f9e6e}
.pill.prep{background:color-mix(in srgb,#c78a12 18%,transparent);color:#b07a10}
.pill.act{background:color-mix(in srgb,#c2412d 16%,transparent);color:#c2412d}
.tool{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:12px;scroll-margin-top:16px}
.tool h3{margin:0;font-size:18px}.tool p{margin:8px 0 0}.tool table{margin-top:10px;font-size:14px}.tool td:first-child{white-space:nowrap}
.danger{border:1px solid color-mix(in srgb,#c2412d 40%,var(--line));border-radius:10px;padding:16px}
.danger p{margin:0 0 12px}.danger label{display:block;margin-bottom:12px}
.impersonating{border:1px solid color-mix(in srgb,#d97706 60%,var(--line));margin-bottom:16px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.btn-danger{font:inherit;font-weight:600;background:#c2412d;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
.signin{max-width:440px;margin:72px auto 96px;text-align:center}.signin .card{display:flex;flex-direction:column;gap:16px;align-items:center;padding:36px 32px}.signin .btn{align-self:center}
.fb{max-width:600px;margin:56px auto 80px}.fb .card{padding:28px}.fb h1{font-size:28px;margin:0 0 8px}.fb .lede{margin:0;color:var(--muted)}
.fb fieldset{border:0;padding:0;margin:24px 0 20px}.fb legend,.fb .lbl{display:block;font-weight:600;margin-bottom:8px}
.fb .opt{display:flex;gap:10px;align-items:center;padding:6px 0;cursor:pointer}.fb .opt input{margin:0;width:18px;height:18px;accent-color:var(--accent)}
.fb textarea{display:block;width:100%;box-sizing:border-box;min-height:180px;font:inherit;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:inherit;resize:vertical}
.fb .hint{font-size:14px;color:var(--muted);margin:8px 0 20px}.fb .btn{border:0;cursor:pointer;font-size:16px}.fb .who{font-size:14px;color:var(--muted);margin:20px 0 0}
.home .wrap{max-width:1120px}
.home h2{font-size:clamp(26px,3.4vw,36px);line-height:1.15;letter-spacing:-.025em;margin:0 0 12px;text-wrap:balance}
.hero{padding:72px 0 80px}
.hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.02fr);gap:56px;align-items:center}
.hero h1{font-size:clamp(38px,5.6vw,64px);line-height:1.02;letter-spacing:-.04em;margin:18px 0 20px}
.hero .lede{font-size:19px;line-height:1.55;margin:0 0 28px;max-width:520px}
.eyebrow{display:inline-flex;align-items:center;margin:0;font-size:14px;color:var(--muted);border:1px solid var(--line);background:var(--card);border-radius:99px;padding:5px 12px 5px 10px}
.ctas{display:flex;flex-wrap:wrap;gap:12px}.btn-lg{padding:14px 22px;font-size:16px}
.works{margin:28px 0 0;font-size:14px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}
.works span{font:13px/1 "IBM Plex Mono",ui-monospace,monospace;color:var(--fg)}
.window{margin:0;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(20,24,20,.04),0 12px 32px -8px rgba(20,24,20,.12),0 32px 64px -24px rgba(31,95,74,.18);overflow:hidden}
.window-bar{display:flex;align-items:center;gap:6px;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--tint)}
.window-bar i{width:9px;height:9px;border-radius:50%;background:var(--line)}
.window-bar span{margin-left:8px;font:12px/1 "IBM Plex Mono",ui-monospace,monospace;color:var(--muted)}
.window-body{padding:20px 20px 22px;font-size:15px;line-height:1.55}
.window-body p{margin:0 0 14px}.window-body p:last-child{margin:0}
.said.you{margin-left:auto;width:fit-content;max-width:85%;background:var(--accent);color:var(--accent-fg);border-radius:14px 14px 4px 14px;padding:9px 14px}
.window .change{background:var(--bg);margin:0 0 14px;border-left:3px solid #c78a12}
.band{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--tint);padding:56px 0}
.pillars{display:grid;grid-template-columns:repeat(3,1fr);gap:40px}
.pillars h3{font-size:18px;margin:0 0 8px;padding-top:16px;border-top:2px solid var(--accent);width:100%}
.pillars p{margin:0;color:var(--muted);font-size:16px}
.also{list-style:none;padding:0;margin:40px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:10px 40px;font-size:15px;color:var(--muted)}
.also li{position:relative;padding-left:20px}.also li::before{content:"";position:absolute;left:2px;top:.62em;width:7px;height:7px;border-radius:2px;background:var(--accent);opacity:.55}
.sec{padding:88px 0}.sec-tint{background:var(--tint);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.sec-head{max-width:680px;margin-bottom:36px}.sec-head p{margin:0}
.kicker{font:12px/1 "IBM Plex Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:0 0 14px!important}
.small{font-size:14px}
.changes{list-style:none;padding:0;margin:0 0 24px;display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}
.changes li{display:flex;flex-direction:column;gap:4px;padding:14px 24px 14px 0;border-bottom:1px solid var(--line);font-size:15px;line-height:1.5}
.changes li:nth-child(even){padding-left:24px;padding-right:0;border-left:1px solid var(--line)}
.changes .undo{color:var(--muted);font-size:14px}.changes .undo::before{content:"↺ ";color:var(--accent);font-weight:600}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:64px}
.duo .changes{grid-template-columns:1fr}.duo .changes li:nth-child(even){padding-left:0;border-left:0}
.defs{margin:16px 0 20px;display:grid;grid-template-columns:auto 1fr;gap:10px 18px;font-size:15px}
.defs dt{font-weight:600;white-space:nowrap}.defs dd{margin:0;color:var(--muted)}
.url-lg{max-width:620px;padding:10px 10px 10px 18px;border:1px solid var(--line);background:var(--card);margin:0 0 32px}.url-lg code{font-size:16px}
.apps{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.app{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px}
.app h3{margin:0 0 8px;font-size:17px}.app h3 .muted{font-weight:400;font-size:14px;margin-left:6px}.app p{margin:0 0 8px;font-size:15px}.app p:last-child{margin:0}.app .cmd{margin:4px 0 0}
.demo{margin-top:32px;padding:22px 24px;border-radius:12px;background:var(--accent-soft);max-width:760px}.demo h3{margin:0 0 6px}.demo p{margin:0}
.plans{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:880px}
.plan{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;display:flex;flex-direction:column}
.plan h3{margin:0;font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.price{font-size:40px;font-weight:600;letter-spacing:-.03em;margin:6px 0 12px}
.plan>p{margin:0 0 12px}.plan-cta{margin-top:auto!important;padding-top:8px}
.plan-pro{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.faq{display:grid;grid-template-columns:1fr 1fr;gap:8px 56px}.faq h3{font-size:17px;margin:20px 0 6px}.faq p{margin:0;color:var(--muted);font-size:16px}
.closer{padding:96px 0;text-align:center;border-top:1px solid var(--line)}.closer h2{margin-bottom:10px}.closer p{margin:0 0 28px}.closer .ctas{justify-content:center}
.home footer{margin-top:0}
@media (max-width:900px){
.hero{padding:40px 0 56px}.hero-grid,.duo{grid-template-columns:1fr;gap:40px}
.pillars{grid-template-columns:1fr;gap:28px}.also,.changes,.apps,.plans,.faq{grid-template-columns:1fr}
.changes li:nth-child(even){padding-left:0;border-left:0}.changes li{padding-right:0}
.sec{padding:64px 0}.band{padding:44px 0}
}
@media (max-width:600px){
.hero{padding:28px 0 44px}.hero h1{margin:14px 0 14px}.hero .lede{font-size:17px;margin-bottom:22px}
.ctas .btn{flex:1 1 auto;text-align:center}.btn-lg{padding:12px 16px;font-size:15px}
.window-body{padding:16px;font-size:14px}.defs{grid-template-columns:1fr;gap:2px}.defs dd{margin-bottom:10px}
.url-lg code{font-size:13px}.nav-hide{display:none}
}
@media (max-width:600px){
nav a{margin-left:12px}nav{white-space:nowrap}
@media (max-width:400px){header .wrap{padding:0 16px}nav a{margin-left:10px;font-size:14px}}
.btn{padding:9px 14px;font-size:15px;border-radius:7px}
.btn-danger{padding:9px 14px;font-size:15px}
.signin{margin:40px auto 56px}.signin .card{padding:28px 20px}
.fb{margin:24px auto 48px}.fb .card{padding:20px 16px}.fb h1{font-size:24px}.fb .btn{width:100%}
.big{font-size:22px}
.change{padding:12px 14px}.change ul{padding-left:18px}.change li,.fold .preview{font-size:15px;line-height:1.5}
.range{max-width:none}.range a{min-height:38px}
}
`;

const SOURCE_URL = "https://github.com/zwznco/camberstack-mcp";

function layout(o: { title: string; description: string; path: string; body: string; baseUrl: string; jsonLd?: object; noindex?: boolean; wide?: boolean }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${o.baseUrl}${o.path}">${o.noindex ? '\n<meta name="robots" content="noindex">' : ""}
<meta property="og:title" content="${o.title}"><meta property="og:description" content="${o.description}">
<meta property="og:url" content="${o.baseUrl}${o.path}"><meta property="og:type" content="website">
<meta property="og:image" content="${o.baseUrl}/logo.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/logo.png">
<style>${CSS}</style>
${o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd)}</script>` : ""}
</head><body${o.wide ? ' class="home"' : ""}>
<header><div class="wrap"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24" style="vertical-align:-5px;margin-right:8px">Camberstack</a>
<nav><a href="/docs">Docs</a><a class="nav-hide" href="/#pricing">Pricing</a><a href="/account">Account</a><a class="nav-cta" href="/#setup">Connect</a></nav></div></header>
<main${o.wide ? "" : ' class="wrap"'}>${o.body}</main>
<footer><div class="wrap">
<a href="/docs">Docs</a><a href="/tools">Tools</a><a href="/changelog">Changelog</a><a href="/about">About</a><a href="/feedback">Feedback</a><a href="${SOURCE_URL}">Source code (MIT)</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a><a href="mailto:${CONTACT}">${CONTACT}</a>
<p>Camberstack is independent and not affiliated with or endorsed by Google. Google Ads is a trademark of Google LLC.</p>
</div></footer>
<script src="/e.js" defer></script>
</body></html>`;
}

/** Copies a [data-copy] button's text to the clipboard. Include once per page. */
export const COPY_JS = `<script>document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b||!navigator.clipboard)return;
navigator.clipboard.writeText(b.dataset.copy).then(function(){var t=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=t},1500)})});</script>`;

/** A command or config line with a Copy button; needs COPY_JS on the page. */
export function cmd(text: string): string {
  return `<div class="cmd"><pre>${esc(text)}</pre><button class="copy" type="button" data-copy="${esc(text)}">Copy</button></div>`;
}

/** A guide screenshot from brand/shots/ (served at /shots/). */
const shot = (file: string, w: number, h: number, alt: string) =>
  `<img class="shot" src="/shots/${file}" width="${w}" height="${h}" alt="${alt}" loading="lazy">`;

const CHANGES: [string, string][] = [
  ["Add negative keywords to a campaign", "Removes exactly the negatives it added"],
  ["Pause or re-enable a campaign, ad group or keyword", "Restores the previous status"],
  ["Change a campaign's daily budget (not shared budgets)", "Restores the previous amount"],
  ["Set or remove the last day a campaign runs", "Restores the previous end date"],
  ["Build a Search campaign: budget, bidding, locations, languages, ad groups, keywords, responsive search ads, negatives, sitelinks. Created paused", "Removes the campaign it built"],
  ["Build a Display campaign: responsive display ads from your image URLs or existing image assets, budget, bidding, locations, languages. Created paused", "Removes the campaign it built"],
  ["Build a Demand Gen campaign with YouTube video ads (the API's route onto YouTube; Google doesn't let it create Video campaigns). Created paused", "Removes the campaign it built"],
  ["Build a Performance Max campaign: asset groups of headlines, descriptions, images and videos, business name and logo, conversion bidding, locations, languages (no shopping feed). Created paused", "Removes the campaign it built"],
  ["Add an ad group, keywords, a responsive search ad or sitelinks to an existing campaign", "Removes exactly what it added"],
  ["Make a campaign count and bid on one conversion category only (e.g. sign-ups)", "Restores the previous goals"],
  ["Change a keyword's or ad group's max CPC", "Restores the previous bid"],
  ["Pause or re-enable an ad (add the new ad and pause the old one to replace it)", "Restores the previous status"],
  ["Add or remove a campaign's locations and languages; in-location-only or also interested", "Restores the previous targeting"],
  ["Switch bid strategy: manual CPC, maximize clicks, maximize conversions", "Restores the previous strategy"],
  ["Set a campaign's tracking URL suffix", "Restores the previous suffix"],
  ["Create a conversion action, or set how many conversions a click can count", "Removes it / restores the previous setting"],
];

const changeList = (rows: [string, string][]) =>
  `<ul class="changes">${rows.map(([c, u]) => `<li><span>${c}</span><span class="undo">${u}</span></li>`).join("")}</ul>`;

export function homePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/", wide: true,
    title: "Camberstack: hosted Google Ads MCP for Claude and ChatGPT",
    description: "A hosted Google Ads MCP server for Claude, ChatGPT and Cursor. Your AI proposes changes, you approve each one, and any applied change can be undone in one step. Free for 1 account with unlimited changes; $15/month for 10.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Camberstack",
      applicationCategory: "BusinessApplication", operatingSystem: "Web", url: baseUrl,
      description: "Hosted Google Ads MCP server for Claude, ChatGPT and other MCP apps: read-only queries, optional Search Console and Google Analytics 4 data, and approved changes with undo.",
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD",
          description: "Every tool, with unlimited applied changes, on 1 Google Ads account." },
        { "@type": "Offer", name: "Pro", price: "15", priceCurrency: "USD", description: "Every tool on up to 10 Google Ads accounts.",
          priceSpecification: { "@type": "UnitPriceSpecification", price: "15", priceCurrency: "USD", billingDuration: "P1M", unitCode: "MON" } },
      ],
    },
    body: `
<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy">
<p class="eyebrow"><span class="dot ok"></span>Free for 1 Google Ads account. No card.</p>
<h1>A hosted Google Ads MCP server</h1>
<p class="lede">Your AI reads your Google Ads account and proposes changes. Nothing changes until you approve, and every change can be undone.</p>
<div class="ctas"><a class="btn btn-lg" href="#setup">Connect for free</a><a class="btn btn-lg btn-ghost" href="#demo">Try the demo account</a></div>
<p class="works">Works with <span>Claude</span><span>ChatGPT</span><span>Cursor</span><span>Claude Code</span><span>any MCP app</span></p>
</div>
<figure class="window" id="example" aria-label="What a change looks like, from the demo account">
<div class="window-bar"><i></i><i></i><i></i><span>Demo account · sample plumbing business</span></div>
<div class="window-body">
<p class="said you">Which search terms are wasting money in Emergency Plumbing?</p>
<p class="ai"><em>"plumber jobs near me"</em> cost $84.60 and <em>"plumber salary"</em> $41.20, with no conversions: people looking for work, not a plumber. I can add "jobs" and "salary" as negative keywords.</p>
<div class="change"><div class="change-top"><strong>Proposal</strong><span class="pill proposed">proposed</span></div>
<ul><li>Add 2 negative keyword(s) to campaign "Emergency Plumbing – Search": "jobs", "salary"</li></ul>
<div class="change-foot">Checked with Google, nothing changed yet</div></div>
<p class="said you">Apply it.</p>
<p class="ai"><span class="pill applied">applied</span>&nbsp; Done. If it blocks searches you wanted, ask me to undo it: that removes exactly these two negatives.</p>
</div>
</figure>
</div></section>

<section class="band"><div class="wrap">
<div class="pillars">
<div><h3>Undo on every plan</h3><p>Ask your AI to undo a change, and it reverses exactly that change. Every applied change is listed with its undo on your <a href="/account">account page</a>.</p></div>
<div><h3>Warnings before you approve</h3><p>Turning a campaign on, more than doubling a budget or bid, or switching bid strategy is flagged in the proposal.</p></div>
<div><h3>A demo account to try first</h3><p>Every tool works on a <a href="#demo">sample account</a> before you use your own. Changes there never reach Google.</p></div>
</div>
<ul class="also">
<li>Negative keywords and budgets up to whole new Search, Performance Max, Display and YouTube campaigns</li>
<li>One URL and a Google sign-in for Claude, ChatGPT, Cursor or any MCP app. Works with manager (MCC) accounts</li>
<li>Optional, read-only <a href="#search-console">Search Console</a>: where you already rank, and which searches you may be paying for twice</li>
<li>Optional <a href="#analytics">Google Analytics 4</a>: which landing pages turn ad clicks into conversions</li>
</ul>
</div></section>

<section class="sec" id="changes"><div class="wrap">
<div class="sec-head"><p class="kicker">Google Ads</p><h2>What it can change</h2>
<p class="muted">Every change is a proposal you approve, and every one has an undo. A new campaign is always created paused, so building it and letting it spend are two separate approvals.</p></div>
${changeList(CHANGES)}
<p class="muted small">Besides the warnings above, a proposal also warns before removing a campaign's last location.
It cannot delete anything you built, touch billing, or edit anything outside Google Ads and the <a href="#analytics">Google Analytics setup changes</a> below.
Any question beyond these tools is answered with read-only queries. <a href="/tools">Every tool and what it can do</a>;
the code is <a href="${SOURCE_URL}">open source</a>.</p>
</div></section>

<section class="sec sec-tint"><div class="wrap duo">
<div id="search-console"><p class="kicker">Optional · read-only</p><h2>Search Console</h2>
<p>Leave the Search Console box ticked when you connect, and your AI can read your site's Google Search clicks, impressions,
queries and positions, and line them up against your ads:</p>
<dl class="defs">
<dt>Paid and already ranking</dt><dd>Searches you pay for where your site is already in the top few organic results, with the ad spend on each.</dd>
<dt>Organic gaps</dt><dd>Searches your site shows up for on page 2 or lower, with no ad covering them.</dd>
<dt>Site totals</dt><dd>Clicks, impressions, CTR and position against the previous period.</dd>
<dt>Trends</dt><dd>Which searches and pages are rising, falling, new or gone since the period before.</dd>
<dt>Opportunities</dt><dd>Searches just off page 1, and top results with a click-through rate low enough to point at the title.</dd>
<dt>Indexing</dt><dd>Whether Google has indexed a page and why not, when it last crawled it, and when it last read your sitemap.</dd>
</dl>
<p class="muted small">Camberstack can't change anything in Search Console. The Search Console tools work without a Google Ads account too: <a href="/google-search-console-mcp">Search Console MCP</a>.</p>
</div>
<div id="analytics"><p class="kicker">Optional</p><h2>Google Analytics 4</h2>
<p>Leave the Google Analytics box ticked when you connect, and your AI can read your GA4 properties next to your ads:</p>
<dl class="defs">
<dt>Landing pages</dt><dd>Sessions, engagement and key events (GA4's conversions) per landing page, for all traffic or one channel, such as Paid Search.</dd>
<dt>Reports</dt><dd>Any GA4 report by dimension and metric, for example paid against organic traffic last month.</dd>
<dt>Setup check</dt><dd>Each property's web streams and measurement IDs, which events count as key events, and which Google Ads accounts it's linked to.</dd>
</dl>
<p>It can also change that setup, with the same proposal, approval and undo as a Google Ads change:</p>
${changeList([
  ["Create a GA4 property with a web stream (the result gives the measurement ID and the tag your site needs)", "Moves the property it created to Google Analytics' trash (restorable there for 35 days)"],
  ["Mark or unmark an event as a key event", "Restores the previous setting"],
  ["Link or unlink a Google Ads account", "Restores the previous link"],
])}
<p class="muted small">Google Ads, Search Console and Google Analytics are each optional: untick any of them, and when you later ask about it Camberstack gives you a one-click link that adds it. The <a href="#demo">demo</a> includes a sample GA4 property.</p>
</div>
</div></section>

<section class="sec" id="setup"><div class="wrap">
<div class="sec-head"><p class="kicker">Two minutes</p><h2>Connect</h2>
<p>Add this server URL to your AI app, then sign in with Google.</p></div>
<div class="url url-lg"><code>${mcpUrl}</code><button class="copy" type="button" data-copy="${mcpUrl}">Copy</button></div>
${COPY_JS}
<div class="apps">
<div class="app"><h3>Claude <span class="muted">web and desktop</span></h3>
<p>Camberstack is in Claude's connector directory: <a href="https://claude.ai/directory/connectors/camberstack">open it there and click Connect</a>, then sign in with Google.</p>
<p><a href="/google-ads-claude">Setup guide →</a></p></div>
<div class="app"><h3>ChatGPT <span class="muted">Plus, Pro, Business, Enterprise</span></h3>
<p>Turn on developer mode, add it as an MCP app, then type <strong>@Camberstack</strong> in a chat.</p>
<p><a href="/google-ads-chatgpt">Step-by-step setup guide →</a></p></div>
<div class="app"><h3>Claude Code</h3>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}</div>
<div class="app"><h3>Cursor, VS Code, others</h3>
${cmd(`{ "mcpServers": { "camberstack": { "url": "${mcpUrl}" } } }`)}</div>
</div>
<p class="muted small">Your AI app handles sign-in. Google shows exactly what Camberstack asks for before anything is shared: your Google Ads, and (optional) read-only Search Console and Google Analytics, which changes nothing without your approval.</p>
<div class="demo" id="demo"><h3>Want to look first?</h3>
<p>Connect, then ask <em>"Show me Camberstack's demo account"</em>. It's a sample plumbing business with six months of
campaigns and search terms, so you can try questions, proposals, applying and undo without touching a real account.
Changes there never reach Google, and the demo doesn't count as one of your plan's accounts. A Google login with no Google Ads access gets the demo automatically.</p></div>
</div></section>

<section class="sec sec-tint" id="pricing"><div class="wrap">
<div class="sec-head"><p class="kicker">Pricing</p><h2>Free for one account. ${PRO_PRICE_LABEL} for ten.</h2></div>
<div class="plans">
<div class="plan"><h3>Free</h3><p class="price">$0</p><p>Every tool, with unlimited applied changes and undo, on <strong>1 Google Ads account</strong>. No card.</p>
<p class="plan-cta"><a class="btn btn-ghost" href="#setup">Connect for free</a></p></div>
<div class="plan plan-pro"><h3>Pro</h3><p class="price">${PRO_PRICE_LABEL}</p><p>Everything in Free, on <strong>up to 10 Google Ads accounts</strong>, for agencies and anyone managing clients through a manager (MCC) account. Cancel any time; you keep Pro until the end of the month you paid for.</p>
<p class="plan-cta"><a class="btn" href="/account?upgrade=1">Upgrade to Pro</a></p><p class="muted small">Connect Camberstack to your AI app first; you'll sign in with the same Google account.</p></div>
</div>
</div></section>

<section class="sec"><div class="wrap">
<div class="sec-head"><h2>Questions</h2></div>
<div class="faq">
<div><h3>Can the AI change my account without asking?</h3>
<p>Not without a proposal. Every change is first stored as a proposal and checked with Google; applying it is a separate
tool call, and the server refuses anything that wasn't proposed first or belongs to someone else. If the account changed since the
proposal, it isn't applied: you get an updated proposal to approve instead.
Claude and ChatGPT normally ask you before running a tool that changes things, but if you've set that tool to "always allow",
the AI could propose and apply in one go. Keep the confirmation on for <code>apply_changes</code>.</p></div>
<div><h3>What data do you keep?</h3>
<p>Your Google email, an encrypted Google refresh token, and the proposals you make (with their results, so you can undo them).
Reports and query results are not stored. Details in the <a href="/privacy">privacy policy</a>.</p></div>
<div><h3>How do I disconnect?</h3>
<p>Sign in at <a href="/account">camberstack.io/account</a> and choose <strong>Disconnect Google Ads</strong>, or remove Camberstack at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. You can also ask your AI to use the <code>disconnect</code>
tool, though some apps (ChatGPT, for one) block disconnect requests from chat.</p></div>
<div><h3>What counts as an account?</h3>
<p>Each Google Ads account you actually use Camberstack on in the last ${ACCOUNT_WINDOW_DAYS} days, not every account your login can see.
A manager (MCC) account and the demo account don't count. Free covers one account at a time, and you can switch to another once
every ${ACCOUNT_WINDOW_DAYS} days: the new one becomes active and the old one is locked. Past that, a plan-limit error comes with a personal
checkout link. Undo and change history always work.</p></div>
</div>
</div></section>

<section class="closer"><div class="wrap">
<h2>Ask your Google Ads account a question.</h2>
<p class="muted">Free for one account, with unlimited changes and undo.</p>
<div class="ctas"><a class="btn btn-lg" href="#setup">Connect for free</a><a class="btn btn-lg btn-ghost" href="#demo">Try the demo account</a></div>
</div></section>
`,
  });
}

// ---------------------------------------------------------------- shared by the setup guides

const ASK_FIRST = `<h2>What to ask first</h2>
<ul>
<li><em>"How did each campaign do last month: spend, clicks, conversions?"</em></li>
<li><em>"Which search terms cost the most in the last 30 days?"</em></li>
<li><em>"Add 'jobs' as a negative keyword to my Search campaign. Show me the change first."</em></li>
<li><em>"Build a paused Performance Max campaign for my homepage, using the images already in my account."</em></li>
<li><em>"What did you change this week? Undo the last change."</em></li>
<li><em>"Which searches am I paying for that my site already ranks for organically?"</em></li>
<li>Not ready to use your real account? <em>"Show me Camberstack's demo account."</em></li>
</ul>`;

const CAN_CHANGE = `<h2>What it can change</h2>
<p>Negative keywords, budgets and end dates, pausing and re-enabling, bids, targeting and bid strategy, conversion goals, and whole new
Search, Performance Max, Display and YouTube campaigns (always created paused). You approve each change, and each one can be undone. <a href="/#changes">The full list</a>, and <a href="/tools">every tool</a>.</p>`;

/** The two troubleshooting entries that differ per app. `notUsed` and `reAdd` are the app-specific steps. */
const appTroubleshooting = (app: string, notUsed: string, reAdd: string) => `<h3>${app} answers without using Camberstack</h3>
<p>${notUsed}</p>
<h3>A tool or feature mentioned here isn't available</h3>
<p>${app} reads Camberstack's list of tools when you add it, and keeps that list. After Camberstack adds tools, ${reAdd}
Your Camberstack plan, proposals and change history are kept.</p>`;

/**
 * Problems users actually hit (tool_calls.error, 2026-10), with the wording they see, so a search for the message finds
 * the fix. The full list lives on /docs only; the guides link to it (see guideTroubleshooting).
 */
const troubleshooting = (app: string, notUsed: string, reAdd: string) => `<h2 id="troubleshooting">Troubleshooting</h2>
${appTroubleshooting(app, notUsed, reAdd)}
<h3>"No Google Ads accounts" or only the demo account</h3>
<p>The Google login you connected with has no access to a Google Ads account (Google's message is <code>NOT_ADS_USER</code>), so Camberstack
offers the demo account instead. Check which Google login has access in Google Ads, under <strong>Admin</strong>, then
<strong>Access and security</strong>, and connect again with that one. ${reAdd.replace(/^\w/, (c) => c.toUpperCase())}</p>
<h3>"Enable 2-Step Verification" (<code>TWO_STEP_VERIFICATION_NOT_ENROLLED</code>)</h3>
<p>The Google Ads account requires 2-Step Verification on every login that uses it, including through apps like this one. Turn it on
at <a href="https://myaccount.google.com/security">myaccount.google.com/security</a>, then ask again.</p>
<h3>A change is refused for lack of permission</h3>
<p>Reading needs any access to the account; applying a change needs <strong>Standard</strong> or <strong>Admin</strong> access.
With Read only access, ask an account admin to raise it in Google Ads, under <strong>Admin</strong>, then <strong>Access and security</strong>.</p>
<h3>"The account changed since it was proposed"</h3>
<p>Before applying, Camberstack checks the proposal against your account as it is now. If something it would change has moved
since (a budget, a status, an end date), nothing is applied and ${app} shows you an updated proposal instead. Approve that one to go ahead.
If everything in it is already in place, there's nothing left to apply. Proposals don't expire: an older one that still matches your account applies as approved.</p>
<h3>"Plan limit"</h3>
<p>The Free plan covers one Google Ads account at a time, with one switch to another account every ${ACCOUNT_WINDOW_DAYS} days. Past that, it asks you
to upgrade, with a personal checkout link, and says when your next switch opens. Undo and change history always work. <a href="/#pricing">Plans</a>.</p>
<h3>"Search Console access isn't part of this Google connection"</h3>
<p>The Search Console box was unticked on Google's sign-in screen, or you connected before the Search Console tools existed.
The same message comes with a personal link: open it and Google adds Search Console to your connection, no reconnecting. The same goes for Google Ads.</p>
<h3>"User does not have sufficient permission for site"</h3>
<p>The website name must match a Search Console property exactly: <code>sc-domain:example.com</code> and
<code>https://www.example.com/</code> are different properties. Ask <em>"List my Search Console sites"</em> first. If the site isn't
listed, it's verified under a different Google login.</p>`;

/**
 * The guides' troubleshooting: only the app-specific fixes, then a link to the full list on /docs. Repeating the full list
 * made the Claude and ChatGPT guides 54% identical, and Google declined to index both (Crawled - currently not indexed, 2026-10-13).
 */
const guideTroubleshooting = (app: string, notUsed: string, reAdd: string) => `<h2 id="troubleshooting">Troubleshooting</h2>
${appTroubleshooting(app, notUsed, reAdd)}
<p>Error messages from Google Ads or Search Console, such as <code>NOT_ADS_USER</code>, 2-Step Verification, a plan limit or an
expired proposal, are covered in <a href="/docs#troubleshooting">the documentation</a>.</p>`;

/** Questions the Claude and Gemini guides share (ChatGPT's answers its own); `app` is the AI app's name. */
const commonQuestions = (app: string) => `<h3>Do I need a Google Ads developer token?</h3>
<p>No. Camberstack has its own Google Ads API access. You sign in with Google and choose what to share.</p>
<h3>Does ${app} see my whole Google account?</h3>
<p>No. It gets Google Ads access, your email address and, if you leave them ticked, read-only Search Console and Google Analytics (changed only when you approve a proposal). Nothing else: no Gmail, Drive or calendar. Details in the <a href="/privacy">privacy policy</a>.</p>
<h3>What does it cost?</h3>
<p>Free on one Google Ads account, with every tool and unlimited changes. <a href="/#pricing">Pro</a> covers up to 10 accounts for ${PRO_PRICE_LABEL}.</p>`;

/**
 * Use-case page for "claude google ads" / "google ads claude" / "google ads mcp server" (keyword data:
 * project-research/keywords-ads-mcp.json).
 */
export function claudeGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-claude",
    title: "Connect Google Ads to Claude: MCP setup in 2 minutes | Camberstack",
    description: "Connect your Google Ads account to Claude with an MCP server. No developer token or Google Cloud project: sign in with Google, then ask Claude about your account.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to Claude", url: `${baseUrl}/google-ads-claude`, dateModified: "2026-10-17",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to Claude</h1>
<p class="lede">Claude can read your Google Ads account, answer questions about it,
and make the changes you approve. Camberstack is in Claude's connector directory, so it takes a few clicks and a Google sign-in. No developer token, no Google Cloud project.</p>
<p><a class="btn" href="https://claude.ai/directory/connectors/camberstack">Open in Claude's directory</a></p>
<p id="demo"><strong>Try it on a demo account first.</strong> Once connected, ask <em>"Show me Camberstack's demo account"</em>: a sample
plumbing business where you can try questions, proposals and undo. Changes there never reach Google.</p>

<h2>Set it up</h2>
<p>Camberstack is a hosted Google Ads MCP server. MCP (Model Context Protocol) is how Claude connects to outside tools.</p>
<h3>Claude on the web or desktop app</h3>
<ol class="steps">
<li>Open <a href="https://claude.ai/directory/connectors/camberstack">Camberstack in Claude's connector directory</a> and click <strong>Connect</strong>.
You can also find it from <strong>Settings</strong>, under <strong>Connectors</strong>, by browsing the directory for Camberstack.</li>
<li>Sign in with the Google account that has access to your Google Ads.
Google shows exactly what's being shared before you agree.</li>
<li>In a chat, click <strong>+</strong> at the bottom left, open <strong>Connectors</strong> and make sure Camberstack is switched on.</li>
</ol>
<p class="muted">On a Team or Enterprise plan, an Owner may need to allow Camberstack for the organization first, in <strong>Organization settings</strong>, under <strong>Connectors</strong>.</p>
<details><summary>Added Camberstack as a custom connector before it was in the directory?</summary>
<p>It keeps working, but you can switch to the directory version: remove the custom one in <strong>Settings</strong>, under
<strong>Connectors</strong>, then connect from <a href="https://claude.ai/directory/connectors/camberstack">the directory</a>. Your Camberstack plan, proposals and change history are kept,
because they belong to your Google login, not the connector.</p>
</details>
<h3>Claude Code</h3>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}
${COPY_JS}
<p class="muted">Also works in <a href="/google-ads-chatgpt">ChatGPT</a>, Cursor and other MCP apps: see <a href="/#setup">all setup options</a>.</p>

${ASK_FIRST}

${CAN_CHANGE}

${guideTroubleshooting("Claude",
  "Claude only uses a connector that's switched on for the chat. Click <strong>+</strong> at the bottom left, open <strong>Connectors</strong> and turn Camberstack on. Naming it helps too: <em>\"Use Camberstack to…\"</em>.",
  "disconnect Camberstack in <strong>Settings</strong>, under <strong>Connectors</strong>, and connect it again from <a href=\"https://claude.ai/directory/connectors/camberstack\">the directory</a>.")}

<h2>How it compares with Google's own Google Ads MCP</h2>
<p>Google publishes an open-source Google Ads MCP server. As of September 2026 it is <strong>read-only</strong>, and you run it
yourself: you need your own Google Ads API developer token, a Google Cloud project and an OAuth client. That suits developers
who only want reporting. Camberstack is hosted, so you only sign in with Google, and it can <strong>make</strong> the changes
you approve, with undo.</p>

<h2>Questions</h2>
${commonQuestions("Claude")}

<p><a class="btn" href="/#setup">Connect Google Ads to Claude</a></p>
`,
  });
}

/**
 * Use-case page for "chatgpt google ads". ChatGPT only takes plugins outside its directory through developer
 * mode, which is several menus deep and warns that "custom MCP servers introduce risk", so this page walks through both.
 * Menu labels, the OAuth option, @-mention use and mobile confirmed by the operator in a live account, 2026-10-01; the Plugins path
 * (+, Create custom MCP server, Create MCP App) re-confirmed with screenshots 2026-10-02. Developer mode IS required: with it off,
 * Create custom MCP server is not offered (operator, 2026-10-02). They move, so re-check when editing.
 */
export function chatgptGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-chatgpt",
    title: "Connect Google Ads to ChatGPT: MCP setup, step by step | Camberstack",
    description: "Connect your Google Ads account to ChatGPT with a plugin. No developer token or Google Cloud project: turn on developer mode, add one URL, sign in with Google, then ask about your account.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to ChatGPT", url: `${baseUrl}/google-ads-chatgpt`, dateModified: "2026-10-13",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to ChatGPT</h1>
<p class="lede">ChatGPT can read your Google Ads account, answer questions about it,
and make the changes you approve. Setup takes a few menus in ChatGPT's settings and a Google sign-in. No developer token,
no Google Cloud project.</p>

<h2 id="before">Before you start</h2>
<ul>
<li><strong>A paid ChatGPT plan:</strong> Plus, Pro, Business, Enterprise or Edu. The free plan can't add plugins like this one.</li>
<li><strong>ChatGPT on the web</strong> (chatgpt.com) for setup. Once it's added, it works in the ChatGPT phone app too.</li>
<li><strong>On Business or Enterprise,</strong> a workspace admin may need to allow developer mode first, under
<strong>Workspace settings</strong>, under <strong>Permissions &amp; roles</strong>.</li>
</ul>

<h2>Set it up</h2>
<ol>
<li>In ChatGPT, click your name at the bottom of the sidebar and choose <strong>Settings</strong>.
${shot("chatgpt-dev-1.webp", 540, 521, "ChatGPT's account menu with Settings highlighted")}</li>
<li>Open the <strong>Plugins</strong> tab and choose <strong>Developer mode</strong>.
${shot("chatgpt-dev-2.webp", 540, 809, "ChatGPT's Settings on the Plugins tab, with Developer mode highlighted")}</li>
<li>Turn on the <strong>Developer mode</strong> switch.
${shot("chatgpt-dev-3.webp", 540, 612, "The Developer mode switch, marked Elevated risk")}</li>
<li>Open <strong>Plugins</strong> from the sidebar.
${shot("chatgpt-1.webp", 540, 497, "ChatGPT's sidebar with Plugins highlighted")}</li>
<li>Click <strong>+</strong> next to the search box and choose <strong>Create custom MCP server</strong>.
${shot("chatgpt-2.webp", 540, 503, "ChatGPT's Plugins page with the + button and Create custom MCP server highlighted")}</li>
<li>Click <strong>Create MCP App</strong>.
${shot("chatgpt-3.webp", 540, 582, "The New Plugin dialog with Create MCP App highlighted")}</li>
<li>Name it Camberstack, paste the server URL <code>${mcpUrl}</code> under <strong>Connection</strong>, leave
<strong>Authentication</strong> on <strong>OAuth</strong>, and tick <strong>I understand and want to continue</strong>.
${shot("chatgpt-4.webp", 540, 994, "ChatGPT's New Plugin form with the Name, server URL, Authentication and I understand checkbox highlighted")}</li>
<li>Sign in with the Google account that has access to your Google Ads. Google shows exactly what's being shared before you agree.</li>
<li>In a chat, type <strong>@</strong> and the name you gave it, then your question:
<em>"@Camberstack how did my campaigns do last month?"</em></li>
</ol>

<h2>About the "Custom MCP servers introduce risk" warning</h2>
<p>ChatGPT shows that warning for every custom MCP server, which is the only way to add one that isn't in
ChatGPT's plugin directory yet. It isn't specific to Camberstack. What protects your account here:</p>
<ul>
<li>Changes are stored as a proposal and checked with Google first; applying is a separate tool call. ChatGPT asks you to
confirm tool calls that change things unless you've turned that off.</li>
<li>Every applied change can be undone with one more message.</li>
<li>New campaigns are created paused, and risky changes (turning a campaign on, a big budget or bid jump) carry a warning before you approve. Nothing you built can be deleted.</li>
</ul>

<h2>Using it in ChatGPT</h2>
<p>Start each message with <strong>@Camberstack</strong>. Without the mention, ChatGPT answers from what it already knows
and never looks at your account. Some first questions:</p>
<ul>
<li><em>"@Camberstack which campaign had the highest cost per conversion in the last 30 days?"</em></li>
<li><em>"@Camberstack list the search terms that spent money without a conversion this month."</em></li>
<li><em>"@Camberstack find keyword ideas for my landing page and tell me their monthly searches."</em></li>
<li><em>"@Camberstack show me the demo account"</em>, to try it before using your real account.</li>
</ul>
<p>When you ask for a change, ChatGPT first shows what Camberstack proposes, then asks before it calls the tool that applies it.
Approve in the chat and the change is made in Google Ads; ask <em>"@Camberstack undo that"</em> to reverse it.
It can change negatives, budgets, bids, targeting and conversion goals, and build paused campaigns: <a href="/#changes">the full list</a>
and <a href="/tools">every tool</a>. In the phone app, the same @-mention works once you've set it up on the web.</p>

${guideTroubleshooting("ChatGPT",
  "ChatGPT uses a custom plugin only when you mention it. Start the message with <strong>@</strong> and its name: <em>\"@Camberstack how did my campaigns do last month?\"</em>",
  "delete Camberstack under <strong>Plugins</strong> and create it again with the same URL, as in the steps above.")}

<h2>Questions</h2>
<h3>Why does it take so many steps?</h3>
<p>Until Camberstack is listed in ChatGPT's plugin directory, developer mode is how ChatGPT lets you add it. You only do it once.
If you use Claude too, setup there is shorter: see <a href="/google-ads-claude">the Claude guide</a>.</p>
<h3>How do I disconnect?</h3>
<p>ChatGPT blocks disconnect requests from chat, so sign in at <a href="/account">camberstack.io/account</a> and choose
<strong>Disconnect Google Ads</strong>, or remove Camberstack at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<h3>Does ChatGPT see my whole Google account?</h3>
<p>No. The Google sign-in is Camberstack's, not ChatGPT's, and it shares only Google Ads, your email address and, if you leave them
ticked, read-only Search Console and Google Analytics (changed only when you approve a proposal). ChatGPT sees the answers Camberstack returns to the questions you ask, nothing else.</p>
<h3>Does it need a paid Camberstack plan?</h3>
<p>No. One Google Ads account is free with every tool; <a href="/#pricing">Pro</a> is for managing up to 10. The paid ChatGPT plan
in <a href="#before">Before you start</a> is OpenAI's requirement, not ours.</p>

<p><a class="btn" href="/#setup">Connect Google Ads to ChatGPT</a></p>
`,
  });
}

/**
 * Use-case page for "google search console mcp" (480/mo, rising, low competition; scripts/seo/audits/camberstack.md,
 * 2026-10-10). The Search Console tools are ungated (tools.ts GATED), so they work with no Google Ads account and don't
 * count toward the plan; only paid_organic_overlap needs an Ads account.
 */
export function searchConsolePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-search-console-mcp",
    title: "Google Search Console MCP server, hosted and read-only | Camberstack",
    description: "A hosted Google Search Console MCP server for Claude, ChatGPT and Cursor. Sign in with Google: no Cloud project, service account or API key. Queries, trends, indexing and sitemaps, read-only.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Google Search Console MCP server", url: `${baseUrl}/google-search-console-mcp`, dateModified: "2026-10-13",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Google Search Console MCP server</h1>
<p class="lede">Ask your AI assistant how your site is doing in Google Search, and it reads your Search Console data to answer:
clicks, queries, pages, what's rising or falling, and why a page isn't indexed. Camberstack is hosted, so setup is a Google
sign-in. It can't change anything in Search Console.</p>

<h2>Questions it answers</h2>
<table>
<tr><th>Ask</th><th>What it reads</th></tr>
<tr><td><em>"How did my site do in Google Search last month, against the month before?"</em></td><td>Site totals for both periods: clicks, impressions, CTR, average position</td></tr>
<tr><td><em>"Which pages lost the most clicks in the last 28 days?"</em></td><td>Every query and page compared with the period before: rising, falling, new and lost</td></tr>
<tr><td><em>"Which searches am I on page 2 for?"</em></td><td>Queries in positions 4 to 20, with the clicks a realistic climb would add, and top results whose CTR is low enough to point at the title</td></tr>
<tr><td><em>"Is /pricing indexed? If not, why?"</em></td><td>Google's index record for the page: the coverage reason, last crawl, robots.txt, and the canonical Google chose</td></tr>
<tr><td><em>"When did Google last read my sitemap?"</em></td><td>Each submitted sitemap's last download, URL count, errors and warnings</td></tr>
<tr><td><em>"Which searches do I pay for that I already rank for?"</em></td><td>Your Google Ads search terms joined with your organic queries over the same days (needs a Google Ads account)</td></tr>
</table>
<p>Answers come from the Search Console API, so they match what Search Console shows, with its limits: data goes back 16 months,
the last two or three days are still filling in, and Google leaves rare queries out of per-query rows for privacy. Site totals
are the complete numbers, so your AI leads with those.</p>

<h2>Set it up</h2>
<p>Connect Camberstack in your AI app (<a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, or any MCP
client with <code>${mcpUrl}</code>). On Google's sign-in screen, leave the <strong>Search Console</strong> box ticked: it grants
read-only access (<code>webmasters.readonly</code>), nothing more. Then ask <em>"List my Search Console sites"</em> and use a site
from that list.</p>
<p>Google's screen also asks for Google Ads access, because Camberstack is a Google Ads tool too. You don't need a Google Ads account
to use the Search Console tools. Without one, Camberstack offers its demo Ads account and every Search Console tool works on your real sites.</p>

<h2>Domain and URL-prefix properties</h2>
<p>Search Console treats <code>sc-domain:example.com</code> (a Domain property, verified by DNS, covering every subdomain and
protocol) and <code>https://www.example.com/</code> (a URL-prefix property) as different sites, with different data. If your AI
says it has no access to a site you can see in Search Console, it's usually using the other form. The site list shows the exact
names your login can read.</p>

<h2>What it can't do</h2>
<ul>
<li>Change anything in Search Console. The access is read-only.</li>
<li>Request indexing or submit a sitemap. Google offers no API for requesting indexing of ordinary pages, so you still do that in Search Console.</li>
<li>Read the Enhancements reports (rich results, Core Web Vitals) as Search Console's UI shows them. URL inspection includes each page's
structured-data items and their errors, which covers the same ground one page at a time.</li>
</ul>

<h2>Compared with running your own</h2>
<p>Open-source Search Console MCP servers run on your machine and need a Google Cloud project with the Search Console API enabled,
plus an OAuth client or a service account added as a user on each property. That suits a developer on one laptop. Camberstack
runs that part for you: one Google sign-in, and it works the same in Claude on the web, on your phone, and in ChatGPT.</p>

<h2>Questions</h2>
<h3>What does it cost?</h3>
<p>The Search Console tools are free and don't count toward a plan. Plans count Google Ads accounts only: <a href="/#pricing">Free covers one, Pro ten</a>.</p>
<h3>Which Search Console permission do I need?</h3>
<p>Any user of the property can read its performance data. Only the sites your Google login can see in Search Console are listed.</p>
<h3>Do you store my search data?</h3>
<p>No. Camberstack fetches it when your AI asks and passes it on; reports and query results aren't kept. Details in the <a href="/privacy">privacy policy</a>.</p>

<p><a class="btn" href="/#setup">Connect Search Console</a> <a href="/tools#search_console_sites">See the Search Console tools</a></p>
`,
  });
}

/**
 * Use-case page for "gemini google ads". Gemini takes outside MCP servers as "custom apps" (Gemini Spark), which
 * Google limits to personal accounts, 18+, in the US, with Keep Activity on, on a Google AI Pro or Ultra plan
 * (support.google.com/gemini/answer/17209137, read 2026-10-02). Screenshots are the operator's, mobile web, 2026-10-02; the path (Settings, Personal Intelligence,
 * Connected Apps, Custom apps) confirmed by the operator the same day.
 * Gemini supports dynamic client registration, so Additional settings stays closed.
 * NOT WORKING as of 2026-10-02: Gemini registers and the user signs in, but Gemini never calls /token (code issued, never
 * redeemed; same with Google sign-in bypassed). Page is noindex and unlinked until it does. Reported to Google:
 * https://discuss.ai.google.dev/t/186405 (and in-app feedback). Same bug open since 2026-08-06, reproduced there with static
 * (non-DCR) credentials, no Google fix as of 2026-10-02: https://discuss.ai.google.dev/t/177327. Re-list it in homePage,
 * sitemapXml and llmsTxt when fixed.
 */
export function geminiGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-gemini", noindex: true,
    title: "Connect Google Ads to Gemini: custom app (MCP) setup | Camberstack",
    description: "Connect your Google Ads account to Google Gemini as a custom app. No developer token or Google Cloud project: add one URL, sign in with Google, then ask Gemini about your account.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to Gemini", url: `${baseUrl}/google-ads-gemini`, dateModified: "2026-10-02",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to Gemini</h1>
<div class="card"><p><strong>Not working yet.</strong> Gemini accepts Camberstack and you can sign in, but Gemini then stops
before finishing the connection, with "Cannot Complete Request". We've reported it to Google. Until it's fixed, use
<a href="/google-ads-claude">Claude</a> or <a href="/google-ads-chatgpt">ChatGPT</a>. The steps below are kept for when it works.</p></div>
<p class="lede">Gemini can read your Google Ads account, answer questions about it,
and make the changes you approve. You add Camberstack as a custom app with one URL, then sign in with Google.
No developer token, no Google Cloud project.</p>

<h2>Before you start</h2>
<p>Google only offers custom apps in Gemini when all of these are true. If the <strong>Custom apps</strong> option is missing, one of them is why.</p>
<ul>
<li><strong>A personal Google account.</strong> Work and school (Google Workspace) accounts don't get custom apps.</li>
<li><strong>Google AI Pro or Ultra</strong>, the plans that include Gemini Spark.</li>
<li><strong>18 or over, in the US,</strong> with Gemini set to English.</li>
<li><strong>Keep Activity turned on</strong> in Gemini's activity settings. Custom apps are switched off without it.</li>
</ul>

<h2>Set it up</h2>
<ol>
<li>In Gemini, open <strong>Settings</strong> and choose <strong>Personal Intelligence</strong>.
${shot("gemini-menu.webp", 540, 285, "Gemini's settings menu with Personal Intelligence highlighted")}</li>
<li>Tap <strong>Connected Apps</strong>.
(Shortcut: <a href="https://gemini.google.com/apps">gemini.google.com/apps</a> opens it directly.)
${shot("gemini-connected.webp", 540, 299, "Gemini's Personal Intelligence page with the Connected Apps card highlighted")}</li>
<li>Tap <strong>Custom apps</strong>.
${shot("gemini-1.webp", 540, 334, "Gemini's Connected Apps page with the Custom apps filter highlighted")}</li>
<li>Under <strong>Custom apps for Spark</strong>, paste the server URL <code>${mcpUrl}</code> and tap <strong>Next</strong>.
${shot("gemini-2.webp", 540, 218, "The Custom apps for Spark box, with the app link field and Next button highlighted")}</li>
<li>In <strong>Connect to an MCP server</strong>, check the URL is <code>${mcpUrl}</code> and tap <strong>Next</strong>.
Leave <strong>Additional settings</strong> alone: Camberstack registers itself with Gemini, so there's no client ID or secret to enter.
${shot("gemini-3.webp", 540, 655, "Gemini's Connect to an MCP server dialog, with the MCP Server URL field and Next button highlighted")}</li>
<li>Sign in with the Google account that has access to your Google Ads. Google shows exactly what's being shared before you agree.
It can be a different Google account from the one you use Gemini with.</li>
<li>Start a new chat and ask your question. Gemini uses Camberstack when the question is about your Google Ads.</li>
</ol>
<p class="muted">Setup works on the Gemini website on a computer or phone. Once it's added, it's there in the Gemini app too.</p>

${ASK_FIRST}

${CAN_CHANGE}

<h2>Questions</h2>
<h3>Why does Gemini say the app "hasn't been reviewed by Google"?</h3>
<p>Gemini shows that for every custom app. It isn't specific to Camberstack. Nothing in your account changes until you approve
a specific proposal, every applied change can be undone, and nothing can be deleted.</p>
<h3>Isn't Gemini already connected to my Google account?</h3>
<p>Gemini's built-in Google apps don't include Google Ads. Camberstack adds it, with its own Google sign-in limited to Google Ads and your email address.</p>
${commonQuestions("Gemini")}

<p class="muted">Also works in <a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, Cursor and other MCP apps: see <a href="/#setup">all setup options</a>.</p>
<p><a class="btn" href="/#setup">Connect Google Ads to Gemini</a></p>
`,
  });
}

/**
 * The documentation page: the one URL the MCP directory listing, OAuth metadata and llms.txt point at for "how do I set
 * this up and what does it do". Links out to the per-app guides and /tools rather than repeating them.
 */
export function docsPage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/docs",
    title: "Camberstack documentation: set up and use the Google Ads MCP server",
    description: "How to connect Camberstack to Claude, ChatGPT or any MCP client, how proposals, approval and undo work, plans and limits, data, and troubleshooting.",
    body: `
<h1>Camberstack documentation</h1>
<p class="lede">Camberstack is a hosted MCP server that gives your AI assistant access to your Google Ads account and, optionally,
read-only Search Console. The AI reads the account and proposes changes. Nothing changes until you approve a specific proposal, and every applied change can be undone.</p>
<ul>
<li><a href="#connect">Connect</a></li>
<li><a href="#how-it-works">How it works: read, propose, approve, apply, undo</a></li>
<li><a href="#building">Building campaigns: Search, Performance Max, Display, YouTube</a></li>
<li><a href="#search-console">Search Console</a></li>
<li><a href="#demo">Demo account</a></li>
<li><a href="#plans">Plans and limits</a></li>
<li><a href="#access">Google API access and your data</a></li>
<li><a href="#disconnect">Disconnect</a></li>
<li><a href="#troubleshooting">Troubleshooting</a></li>
</ul>

<h2 id="connect">Connect</h2>
<p>The server URL is:</p>
<div class="url"><code>${mcpUrl}</code><button class="copy" type="button" data-copy="${mcpUrl}">Copy</button></div>
${COPY_JS}
<p>It speaks Streamable HTTP with OAuth 2.1 (dynamic client registration), so your AI app handles sign-in: you sign in with Google
and choose what to share. No Google Ads developer token or API key is needed.</p>
<h3>Claude (web and desktop app)</h3>
<p>Connect from <a href="https://claude.ai/directory/connectors/camberstack">Camberstack's page in Claude's connector directory</a>, or browse the directory in <strong>Settings</strong>, under <strong>Connectors</strong>.
You don't need the URL above. <a href="/google-ads-claude">Setup guide</a>.</p>
<h3>ChatGPT</h3>
<p>Turn on developer mode, add the URL as an MCP app, then type <strong>@Camberstack</strong> in a chat. <a href="/google-ads-chatgpt">Step-by-step guide</a>.</p>
<h3>Claude Code</h3>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}
<h3>Cursor, VS Code and other MCP clients</h3>
${cmd(`{ "mcpServers": { "camberstack": { "url": "${mcpUrl}" } } }`)}
<p>Start by asking <em>"List my Google Ads accounts"</em>. A manager (MCC) login lists the client accounts under it.</p>

<h2 id="how-it-works">How it works</h2>
<ol>
<li><strong>Read.</strong> <code>account_overview</code> summarises an account; <code>run_gaql</code> runs any read-only Google Ads query;
<code>keyword_ideas</code> and <code>keyword_metrics</code> size search demand. None of these change anything.</li>
<li><strong>Propose.</strong> <code>propose_changes</code> stores the change as a proposal and checks it with Google (validate-only). Nothing is applied.</li>
<li><strong>Approve.</strong> Your AI shows you the proposal. You approve that specific proposal in the conversation.</li>
<li><strong>Apply.</strong> <code>apply_changes</code> applies an approved proposal. The server refuses anything that wasn't proposed first
or belongs to someone else, and checks it against the account first: if the account changed since, you get an updated proposal to approve instead. Keep your AI app's confirmation prompt on for <code>apply_changes</code>.</li>
<li><strong>Undo.</strong> <code>undo_changes</code> builds the reverse of an applied proposal, which you approve and apply the same way.
<code>change_history</code> lists everything applied.</li>
</ol>
${CAN_CHANGE}

<h2 id="building">Building campaigns</h2>
<p>Your AI can build four kinds of campaign. Each is created <strong>paused</strong>, so building it and letting it spend are two separate approvals, and undo removes it.</p>
<ul>
<li><strong>Search</strong>: ad groups, keywords, responsive search ads, negatives and sitelinks.</li>
<li><strong>Performance Max</strong>: asset groups of headlines (at least 3), long headlines, descriptions (at least 2), images and optional YouTube videos.
Google requires the business name and logo on the campaign itself. Bidding is for conversions (with an optional target cost per conversion) or conversion value,
so conversion tracking needs to work first. Shopping feeds (retail Performance Max) aren't supported.</li>
<li><strong>Display</strong>: responsive display ads, from which Google assembles image ads on its Display Network.</li>
<li><strong>YouTube</strong>, through a Demand Gen campaign with video ads that run on YouTube (in-stream, in-feed and Shorts), Discover and Gmail.
Google's API doesn't allow creating classic Video campaigns, so Demand Gen is the way in. Give YouTube video links or IDs; the videos must be public or unlisted.
Demand Gen sets locations and languages per ad group.</li>
</ul>
<p><strong>Images</strong> can be ones already in your Google Ads account (your AI finds them with a query) or public https links to PNG, JPEG or GIF files of up to 5 MB,
which Camberstack downloads and uploads to your account. Shapes: landscape 1.91:1 (e.g. 1200×628), square 1:1 (e.g. 1200×1200), portrait 4:5 (Performance Max),
and logos square 1:1 or landscape 4:1. Google reviews every new ad against its policies; if it rejects one, your AI gets the reason and can reword it.</p>

<h2 id="search-console">Search Console</h2>
<p>If you leave the Search Console box ticked when you sign in, your AI can read (never change) your sites' search data: totals against the previous
period, queries and pages, rising and falling queries, near-page-1 opportunities, index status for given URLs, sitemap status, and
searches you pay for that already rank organically. Camberstack can't request indexing or submit sitemaps; you do that in Search Console.
<a href="/google-search-console-mcp">More on the Search Console tools</a>.</p>

<h2 id="demo">Demo account</h2>
<p>Account <code>000-000-0001</code> is a sample plumbing business with six months of campaigns and search terms. Every tool works on it,
changes there never reach Google, and it doesn't count toward your plan. Ask <em>"Show me Camberstack's demo account"</em>.</p>

<h2 id="plans">Plans and limits</h2>
<table><tr><th>Plan</th><th>Covers</th></tr>
<tr><td>Free</td><td>Every tool, unlimited applied changes, on 1 Google Ads account. No card.</td></tr>
<tr><td>Pro, ${PRO_PRICE_LABEL}</td><td>The same, on up to 10 Google Ads accounts. Cancel any time.</td></tr></table>
<p>An account counts when you use Camberstack on it; it stops counting ${ACCOUNT_WINDOW_DAYS} days after its last use. Manager (MCC) accounts and the demo don't count.
Each plan also gets one switch every ${ACCOUNT_WINDOW_DAYS} days: a new account becomes active and the least recently used one is locked.
Using one more account than your plan covers returns a <code>plan_limit</code> error listing the accounts in use, when one frees up, and, on Free,
a personal upgrade link valid for 7 days. Undo, change history and billing are never limited. Ask <em>"What plan am I on?"</em> to see your usage.</p>

<h2 id="access">Google API access and your data</h2>
<p>Camberstack accesses the Google Ads API under its own developer-token access, with the user's Google OAuth consent. Search Console is read
through Google's Search Console API under the same consent, with a read-only scope. Camberstack is independent and not affiliated with Google.</p>
<p>It stores your Google email, an encrypted Google refresh token, and your proposals with their results so you can undo them. Reports and query results are not stored.
Details in the <a href="/privacy">privacy policy</a>.</p>

<h2 id="disconnect">Disconnect</h2>
<p>Sign in at <a href="/account">camberstack.io/account</a> and choose <strong>Disconnect Google Ads</strong>, or remove Camberstack at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. You can also ask your AI to use the <code>disconnect</code> tool.</p>

${troubleshooting("Your AI app",
  "Mention Camberstack by name, for example <em>\"Using Camberstack, how did my campaigns do last month?\"</em>, and check the connector is enabled for this chat.",
  "remove Camberstack from your AI app and add it again.")}

<h2>More</h2>
<p><a href="/tools">Every tool and its parameters</a> · <a href="${SOURCE_URL}">Source code (MIT)</a> · Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
  });
}

export function privacyPage(baseUrl: string): string {
  return layout({
    baseUrl, path: "/privacy",
    title: "Privacy policy | Camberstack",
    description: "What Camberstack does with your Google account and Google Ads data.",
    body: `<div class="legal">
<h1>Privacy policy</h1>
<p class="muted">Last updated ${PRIVACY_UPDATED}</p>
<p>Camberstack ("we") runs camberstack.io, a connector that lets an AI assistant you choose read and, with your approval,
change your Google Ads account. This policy explains what we access, why, and what we keep.</p>

<h2>What we access</h2>
<ul>
<li><strong>Your Google account email and a stable Google account ID</strong> (the <code>openid</code> and <code>email</code> scopes), so the same person gets the same account and change history each time.</li>
<li><strong>Your Google Ads data</strong> (the <code>https://www.googleapis.com/auth/adwords</code> scope): account and campaign structure, performance metrics, search terms, keywords and conversion settings, read when your AI assistant calls a Camberstack tool.</li>
<li><strong>Your Search Console data, read-only and optional</strong> (the <code>https://www.googleapis.com/auth/webmasters.readonly</code> scope): the websites you have verified, their Google Search clicks, impressions, queries and positions, Google's index status for pages you ask about, and the sitemaps you have submitted, read when your AI assistant calls a Search Console tool, for example to compare what you pay for with where you already rank. Google Ads and Search Console are each optional: you can untick either on Google's consent screen and add it later through a link Camberstack gives you. Camberstack cannot change anything in Search Console.</li>
<li><strong>Your Google Analytics data and setup, optional</strong> (the <code>https://www.googleapis.com/auth/analytics.readonly</code> and <code>https://www.googleapis.com/auth/analytics.edit</code> scopes): the names of the Google Analytics accounts and properties you can access; reports on your properties' traffic, such as sessions, users, engagement, key events (conversions), landing pages and traffic sources; and each property's setup (web streams and their measurement IDs, key events, Google Ads links), read when your AI assistant calls a Google Analytics tool, for example to see whether visitors from your ads convert. With edit access Camberstack can set up tracking for you, <strong>only</strong> when you approve a specific proposal: create a property with a web stream, mark or unmark an event as a key event, and link or unlink a Google Ads account. Every such change is logged and can be undone. Google Analytics is optional: both scopes come as one box on Google's consent screen, which you can untick and add later through a link Camberstack gives you.</li>
</ul>
<p>We request nothing else from your Google account: no Gmail, Drive, contacts or calendar.</p>

<h2>How we use it</h2>
<ul>
<li>To answer the requests your AI assistant makes on your behalf (reports and read-only queries).</li>
<li>To apply changes to your Google Ads account, or to your Google Analytics setup, <strong>only</strong> when you approve a specific proposal, and to reverse them if you ask.</li>
</ul>
<p>We do not sell your data, use it for advertising, share it with data brokers, or use it to train AI or machine-learning models.
Humans at Camberstack do not read your Google Ads data unless you ask us to for support, it is needed for security or abuse investigation, or the law requires it.</p>

<h2>Google API Services: Limited Use</h2>
<p>Camberstack's use and transfer of information received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>What we store</h2>
<table>
<tr><th>Data</th><th>Why</th><th>Kept until</th></tr>
<tr><td>Google email and account ID</td><td>Identify you across connections</td><td>You ask us to delete it</td></tr>
<tr><td>Google refresh token, encrypted (AES-256-GCM)</td><td>Call Google's APIs (Google Ads, and Search Console or Google Analytics if you granted them) when you use a tool</td><td>You disconnect or revoke access</td></tr>
<tr><td>A sign-in session for the account page (a cookie; we store only its hash)</td><td>Keep you signed in to camberstack.io/account</td><td>7 days, or until you sign out</td></tr>
<tr><td>A random value in a cookie while you connect an AI app</td><td>Check that the browser finishing the Google sign-in is the one that approved the connection</td><td>The sign-in finishes, or 1 hour</td></tr>
<tr><td>A random value in a cookie while you add a Google service (Google Ads, Search Console or Google Analytics) to your connection</td><td>Check that the browser finishing Google's consent is the one that opened your link</td><td>The consent finishes, or 10 minutes</td></tr>
<tr><td>Tokens we issue to your AI app (stored as hashes)</td><td>Authenticate your AI app</td><td>Expiry (1 hour access, 90 days refresh) or disconnect</td></tr>
<tr><td>Proposals: the changes requested, their summary and results</td><td>Show what changed and let you undo it</td><td>You ask us to delete them</td></tr>
<tr><td>Feedback you send from camberstack.io/feedback: your message, what it's about, and the Google email you signed in with</td><td>Read it and reply to you</td><td>You ask us to delete it</td></tr>
<tr><td>A sign-in session for the feedback page (a cookie; we store only its hash)</td><td>Know who a message is from, so we can reply and keep spam out</td><td>1 day, or until you sign out</td></tr>
<tr><td>A usage log: which tool ran, for which Google Ads account ID, when, how long it took and any error message. For a custom Google Ads query, which fields and resources it asked for, with every value in it (names, keywords, IDs, dates) removed. Never the tool's other inputs, or any results</td><td>Find and fix failures, see which features are used, and count how many Google Ads accounts you use for your plan</td><td>You ask us to delete it</td></tr>
</table>
<p>Reports, search-term lists, query results and Google Analytics reports are computed on request and returned to your AI assistant. We do not store them.
When a proposed ad uses an image URL, we download that image only to upload it to your Google Ads account as an image asset; we do not keep the file.
Standard web server logs (IP address, time, path) are kept for a limited period for security and then deleted.
When the server hits a bug, the error and where in the code it happened go to an error tracker we host ourselves; no request contents, cookies or tokens are sent with it.</p>

<h2>Your AI assistant</h2>
<p>Tool results go to the AI app you connected (for example Claude or ChatGPT). How that provider handles the conversation is governed by its own privacy policy.</p>

<h2>Where it runs</h2>
<p>Camberstack runs on infrastructure we operate in the United States. We use no third-party analytics on your Google data.</p>

<h2>Emails</h2>
<p>We may send you two short emails about using Camberstack: one if you connect but don't try it within a couple of days,
and one if you try Camberstack on more Google Ads accounts than the Free plan covers. Each is sent once. We may also send occasional one-time announcements
about changes to your account or to Camberstack's features. All of them come from adam@camberstack.io, to the email address of the Google account
you connected, and never contain your Google Ads data. Every email has an unsubscribe link, and replies reach a person.</p>

<h2>Our own Google ads</h2>
<p>If you reach this site by clicking one of our Google ads, we keep the ad click identifier Google adds to the link in a cookie on
this site for up to 90 days. If you then connect Camberstack for the first time, we report that click to our own Google Ads account
as a conversion, so we can tell which ads work. We send only the click identifier and the time: no email, account ID or Google Ads data of yours.</p>

<h2>Website analytics</h2>
<p>We count visits to this website's pages with Matomo, which we host ourselves on the same infrastructure. A small script served from this site sends the page you opened, the site that linked you here, and the name of the ad or campaign that brought you, if any (never the ad's click identifier); we also record that a Google Ads account was connected, with no account, email or ID attached. Matomo sets no cookie and stores nothing in your browser. Matomo uses your IP address to estimate roughly where a visit came from and removes the last part of it before saving. Visits are grouped by a salted hash of your IP address and browser, with the salt changed daily and kept only in memory, so it cannot identify you or link visits across days.</p>
<p>We also use Google Analytics (GA4) on this website's pages, loaded by the same script. It records the pages you visit, how you arrived
(for example from one of our Google ads or a search), and roughly where and on what kind of device, and it sets first-party cookies
(<code>_ga</code> and <code>_ga_&lt;id&gt;</code>, kept up to 2 years) so repeat visits are counted once. Google processes this under
<a href="https://policies.google.com/privacy">its privacy policy</a>; you can block it with your browser's cookie settings or
<a href="https://tools.google.com/dlpage/gaoptout">Google's opt-out add-on</a>. This covers only visits to camberstack.io.
None of your Google Ads, Search Console or Google Analytics data that Camberstack reads for you is ever sent to either analytics tool.</p>

<h2>Your choices</h2>
<ul>
<li><strong>Disconnect:</strong> ask your AI to run the <code>disconnect</code> tool, or remove Camberstack at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Either stops all access; the tool also deletes the stored token.</li>
<li><strong>Delete everything:</strong> email <a href="mailto:${CONTACT}">${CONTACT}</a> from your Google account's address and we delete your account and change history within 30 days.</li>
</ul>

<h2>Security</h2>
<p>All traffic uses HTTPS. Google refresh tokens are encrypted at rest; tokens we issue are stored only as SHA-256 hashes.
Changes are validated with Google before you approve them and are limited to the operations listed on the homepage.</p>

<h2>Children</h2>
<p>Camberstack is a business tool and not directed at anyone under 18.</p>

<h2>Changes and contact</h2>
<p>We will post changes here and update the date above. Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
</div>`,
  });
}

export function termsPage(baseUrl: string): string {
  return layout({
    baseUrl, path: "/terms",
    title: "Terms of service | Camberstack",
    description: "Terms for using Camberstack.",
    body: `<div class="legal">
<h1>Terms of service</h1>
<p class="muted">Last updated ${TERMS_UPDATED}</p>
<h2>The service</h2>
<p>Camberstack lets an AI assistant read your Google Ads account and, when you approve a specific proposal, change it.
If you add them to your connection, it can also read your Search Console data (read-only) and your Google Analytics data,
and change your Google Analytics setup when you approve a specific proposal.
There is a free plan and a paid Pro plan, described at <a href="/#pricing">camberstack.io/#pricing</a>.</p>
<h2>Pro subscription</h2>
<p>Pro is billed monthly in advance through Stripe until you cancel. You can cancel any time from the billing link the <code>billing</code> tool gives you; Pro continues until the end of the period you paid for, and we don't refund partial months. If we change the price we will email you at least 30 days before it applies to you.</p>
<h2>You stay in control, and responsible</h2>
<p>Recommendations are generated from your account data and may be wrong. You decide what to approve, and you are responsible
for changes you approve, for your Google Ads spend, and for the tracking and consent on any website you measure with Google Analytics. Review proposals before approving them.</p>
<h2>Acceptable use</h2>
<p>Use Camberstack only on Google Ads accounts, Search Console sites and Google Analytics properties you are authorized to manage, and in line with Google's policies. Don't attempt to access other users' data or overload the service.</p>
<h2>No warranty</h2>
<p>The service is provided "as is", without warranties of any kind, including fitness for a particular purpose or uninterrupted availability.</p>
<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, Camberstack is not liable for indirect or consequential losses, including lost profits or ad spend,
and our total liability is limited to the amount you paid us in the 12 months before the claim (zero if you have only used the free plan).</p>
<h2>Ending</h2>
<p>You can disconnect at any time. We may suspend access that breaks these terms or Google's policies.</p>
<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
</div>`,
  });
}

// Who runs it and how to reach them: the same shape as npiradar.com/about and theqrcode.io/about. Company-data
// crawlers probe /contact, /contact-us and /about-us; server.ts 301s those here. Unlike those sites, this domain has a
// live mailbox, so email comes first. The photo is brand/adam-williams.webp (the one redbudway and npiradar use).
const FOUNDER = { name: "Adam Williams", role: "Founder & software engineer", photo: "/adam-williams.webp", linkedin: "https://www.linkedin.com/in/awilliams1989" };

export function aboutPage(baseUrl: string): string {
  return layout({
    baseUrl, path: "/about",
    title: "About Camberstack: who runs it and how to get in touch",
    description: "Camberstack is an independent Google Ads connector for AI assistants, built and run by Adam Williams, a software engineer. How to reach him.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "AboutPage", url: `${baseUrl}/about`,
      mainEntity: {
        "@type": "Organization", name: "Camberstack", url: baseUrl, logo: `${baseUrl}/logo.png`, email: CONTACT, sameAs: [SOURCE_URL],
        founder: { "@type": "Person", name: FOUNDER.name, jobTitle: FOUNDER.role, image: `${baseUrl}${FOUNDER.photo}`, sameAs: [FOUNDER.linkedin] },
      },
    },
    body: `<h1>About Camberstack</h1>
<div style="display:flex;gap:16px;align-items:center;margin:24px 0">
<img src="${FOUNDER.photo}" alt="${FOUNDER.name}" width="96" height="96" style="border-radius:50%">
<div><strong>${FOUNDER.name}</strong><br><span class="muted">${FOUNDER.role}</span><br><a href="${FOUNDER.linkedin}" rel="noopener noreferrer me">Connect on LinkedIn</a></div>
</div>
<h2>Who's behind it</h2>
<p>Camberstack is built and run by me, ${FOUNDER.name}, a software engineer. There's no company behind it and no sales team: email reaches me.</p>
<h2>Contact</h2>
<p>Email <a href="mailto:${CONTACT}">${CONTACT}</a> for support, billing, or to have your data deleted. The code is public: <a href="${SOURCE_URL}">${SOURCE_URL.replace("https://", "")}</a>.</p>
<h2>What it does</h2>
<p>Camberstack connects your Google Ads account, and optionally Search Console, to an AI assistant such as Claude or ChatGPT. It reads your data, and it changes your account only when you approve a specific proposal. <a href="/tools">The tools page</a> lists everything it can do.</p>
<p class="muted">Camberstack is independent and not affiliated with or endorsed by Google.</p>`,
  });
}

/** /changelog: every release, newest first, from changelog.ts (the same entries the GitHub releases carry). */
export function changelogPage(baseUrl: string, releases: Release[]): string {
  // Entries are ours, not user input; still escaped, then **bold** and `code` turned into markup.
  const md = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  return layout({
    baseUrl, path: "/changelog",
    title: "Camberstack changelog: what's new in the Google Ads connector",
    description: "Every Camberstack release, newest first: new tools, campaign types and fixes in the Google Ads and Search Console connector for Claude and ChatGPT.",
    body: `<h1>Changelog</h1>
<p class="muted">What's new in Camberstack, newest first. Fixes and improvements apply on your next request, with nothing to install.</p>
<p class="muted"><strong>Seeing a new tool</strong> needs your AI app to reload Camberstack's tool list. In <strong>ChatGPT</strong>: Settings → Connectors → Camberstack → Refresh. In <strong>Claude</strong>: start a new chat; if a new tool still isn't there, it should show up within a day (on Claude's phone and desktop apps, removing and re-adding the connector is quicker).</p>
${releases.map((r) => `<section id="v${r.version}">
<h2>${r.version} <span class="muted" style="font-size:15px;font-weight:400">${r.date}</span></h2>
<p>${md(r.summary)}</p>${r.items?.length ? `<ul>${r.items.map((i) => `<li>${md(i)}</li>`).join("")}</ul>` : ""}
</section>`).join("\n")}
<p class="muted">Source and release notes: <a href="${SOURCE_URL}/releases">${SOURCE_URL.replace("https://", "")}/releases</a>.</p>`,
  });
}

/** A page that brings its own heading (the account page); body is trusted HTML built by the caller. */
export function appPage(baseUrl: string, title: string, path: string, body: string): string {
  return layout({ baseUrl, path, title: `${esc(title)} | Camberstack`, description: title, body });
}

/** Plain page for billing outcomes; body is trusted HTML built by the caller. */
export function infoPage(baseUrl: string, title: string, body: string): string {
  return layout({ baseUrl, path: "/", title: `${esc(title)} | Camberstack`, description: title, body: `<h1>${esc(title)}</h1>${body}` });
}

/**
 * /authorize: which app is asking, and where the sign-in goes back to, before we send anyone to Google.
 * Google's own screen names only Camberstack, so without this a link built by a stranger looks identical.
 * A bare card, not the site shell: the buttons are the page. The warning is the one line that matters.
 */
export function consentPage(_baseUrl: string, o: { id: string; clientName: string; redirectHost: string; known: boolean }): string {
  const host = esc(o.redirectHost);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Camberstack</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
<style>${CSS}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.consent{width:100%;max-width:420px;text-align:center}
.consent h1{font-size:24px;margin:16px 0 8px}.consent p{margin:0 0 20px}
.consent .warn{border:1px solid #c0392b;border-radius:8px;padding:10px 12px;font-size:15px;text-align:left}
.consent .btn{width:100%;border:0;cursor:pointer;font-size:16px}.consent .linkish{margin-top:14px;color:var(--muted)}
</style></head><body>
<main class="card consent">
<img src="/favicon.svg" alt="Camberstack" width="40" height="40">
<h1>Connect ${esc(o.clientName || "this app")} to Camberstack?</h1>
<p class="muted">You'll return to <strong>${host}</strong> after signing in with Google.</p>
${o.known ? "" : `<p class="warn"><strong>Unrecognized address.</strong> If someone sent you this link, cancel: ${host} would get access to your Google Ads.</p>\n`}<form method="post" action="/oauth/consent">
<input type="hidden" name="id" value="${esc(o.id)}">
<button class="btn" name="decision" value="approve">Continue to Google</button><br>
<button class="linkish" name="decision" value="deny">Cancel</button>
</form>
</main>
</body></html>`;
}

export function errorPage(baseUrl: string, message: string): string {
  return layout({ baseUrl, path: "/", title: "Connection problem | Camberstack", description: message,
    body: `<h1>That didn't work</h1><p class="lede">${esc(message)}</p><p><a href="/#setup">Connection instructions</a></p>` });
}

/** What a tool can do to the account, from its MCP annotations. */
function effect(t: ToolDoc): { cls: string; label: string } {
  if (t.annotations.readOnlyHint) return { cls: "ro", label: "Read-only" };
  if (t.annotations.destructiveHint) return { cls: "act", label: "Needs your go-ahead" };
  return { cls: "prep", label: "Changes nothing in Google Ads" };
}

/** /tools: generated from the registered tool definitions, so it can't drift from what the server offers. */
export function toolsPage(baseUrl: string, tools: ToolDoc[]): string {
  const params = (t: ToolDoc) => {
    if (!t.inputSchema || !Object.keys(t.inputSchema).length) return "";
    const js = z.toJSONSchema(z.object(t.inputSchema), { io: "input", unrepresentable: "any" }) as
      { properties: Record<string, { description?: string; default?: unknown }>; required?: string[] };
    const rows = Object.entries(js.properties).map(([name, p]) => {
      const note = p.default !== undefined ? `Default ${esc(JSON.stringify(p.default))}.`
        : js.required?.includes(name) ? "Required." : "Optional.";
      return `<tr><td><code>${esc(name)}</code></td><td>${esc(p.description ?? "")} <span class="muted">${note}</span></td></tr>`;
    });
    return `<table><tr><th>Parameter</th><th>What it is</th></tr>${rows.join("")}</table>`;
  };
  const cards = tools.map((t) => {
    const e = effect(t);
    return `<div class="tool" id="${esc(t.name)}"><div class="change-top"><h3><code>${esc(t.name)}</code> ${esc(t.title)}</h3>
<span class="pill ${e.cls}">${e.label}</span></div><p>${esc(t.description)}</p>${params(t)}</div>`;
  }).join("\n");
  return layout({
    baseUrl, path: "/tools",
    title: "Camberstack tools: every Google Ads MCP tool and parameter",
    description: `The ${tools.length} tools your AI gets when you connect Camberstack to Google Ads: what each reads, what it can change, and its parameters.`,
    body: `
<h1>Every Camberstack tool</h1>
<p class="lede">These are the ${tools.length} tools your AI assistant gets when you connect Camberstack. This page is built from the
same definitions the server uses, so it always matches what's live, and the descriptions are the ones your AI reads. The code is open source: <a href="${SOURCE_URL}">read it on GitHub</a>.</p>
<p><span class="pill ro">Read-only</span> tools never change anything. <span class="pill prep">Changes nothing in Google Ads</span>
tools prepare or manage proposals. Only <code>apply_changes</code> edits your ads, and only after you approve a specific proposal.
<code>disconnect</code> asks you to confirm before it revokes access.</p>
${cards}
<p class="muted">You don't call these yourself: ask your AI in plain English and it picks the tools. <a href="/#setup">Connect Camberstack</a>.</p>`,
  });
}

export function robotsTxt(baseUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /oauth/\nDisallow: /authorize\nDisallow: /token\nDisallow: /register\nDisallow: /account\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

/** The indexable pages, in sitemap order. */
export const SITEMAP_PATHS = ["/", "/docs", "/google-ads-claude", "/google-ads-chatgpt", "/google-search-console-mcp", "/tools", "/changelog", "/about", "/privacy", "/terms"];

/** `lastmod`: each page's own last-changed date (lastmod.ts), never one date for the whole site. */
export function sitemapXml(baseUrl: string, lastmod: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${SITEMAP_PATHS
    .map((u) => `  <url><loc>${baseUrl}${u}</loc>${lastmod[u] ? `<lastmod>${lastmod[u]}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;
}

export function llmsTxt(baseUrl: string, tools: ToolDoc[]): string {
  return `# Camberstack

> Google Ads MCP server. Connect Google Ads to Claude, ChatGPT or any MCP client; the AI reads the account and applies only changes the user approves.

- MCP endpoint (Streamable HTTP, OAuth 2.1 with dynamic client registration): ${baseUrl}/mcp
- Tools: ${tools.map((t) => t.name).join(", ")}
- Writes (each one proposed, approved, then applied; every applied change can be undone): negative keywords; pause/enable campaign, ad group, keyword or ad; daily budget; end date; build a Search, Display, Demand Gen (YouTube video) or Performance Max campaign (created paused); add ad groups, keywords, ads, sitelinks; bids; bid strategy; location/language targeting; URL suffix; conversion actions and goals.
- Search Console (optional, read-only scope): site totals, query/page performance, period-over-period trends, ranking opportunities, URL Inspection (index status), sitemap status, and paid vs organic overlap with the Ads account.
- Demo: account 000-000-0001 is a sample business (sample data) anyone can try every tool on; changes there never touch Google. Logins with no Google Ads access get it automatically.
- Pricing: Free plan covers 1 Google Ads account (every tool, unlimited applied changes); Pro ${PRO_PRICE_LABEL} covers up to 10. Accounts are counted as those used in the last ${ACCOUNT_WINDOW_DAYS} days, with one switch to another account every ${ACCOUNT_WINDOW_DAYS} days; manager (MCC) and demo accounts don't count. Undo is always free.
- [Documentation](${baseUrl}/docs)
- [Setup](${baseUrl}/#setup)
- [Pricing](${baseUrl}/#pricing)
- [Connect Google Ads to Claude (guide with a worked example)](${baseUrl}/google-ads-claude)
- [Connect Google Ads to ChatGPT (step-by-step guide)](${baseUrl}/google-ads-chatgpt)
- [Google Search Console MCP (read-only; works without a Google Ads account)](${baseUrl}/google-search-console-mcp)
- [Every tool, with its parameters](${baseUrl}/tools)
- [Source (MIT)](${SOURCE_URL})
- [Privacy](${baseUrl}/privacy)
- [Terms](${baseUrl}/terms)
`;
}

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
