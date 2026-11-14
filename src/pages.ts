/**
 * The public pages. The homepage and privacy policy double as what Google's brand verification
 * reviews: they must name the app, say what it does with Google user data, and link the policy.
 */

import type { Release } from "./changelog.js";
import { z } from "zod";
import { ACCOUNT_WINDOW_DAYS, AGENCY_ACCOUNTS, listedServices, AGENCY_PRICE_LABEL, PLUS_PRICE_LABEL, PRO_ACCOUNTS, PRO_PRICE_LABEL, changeCap, freeChanges, freeChangesShort, servicesAnd, servicesOr } from "./plans.js";
import type { ToolDoc } from "./tools.js";

/** Plus, in a sentence; empty with the change cap off (Plus would equal Free). Leading space, for the end of a paragraph. */
const plusLine = () => (capOn() ? ` Plus (${PLUS_PRICE_LABEL}) has unlimited applied changes on 1 Google Ads account.` : "");
/** What Pro and Agency cover besides more accounts. */
const paidCovers = () => (capOn() ? "Everything in Free with unlimited applied changes, on" : "Everything in Free, on");
/**
 * The change cap (plans.ts changeCap) is on: Plus is sold, as unlimited changes on 1 account, and leads the pricing
 * (highlighted), since most users have one Google Ads account (69% on 2026-10-28). Off, Plus would equal Free and isn't shown.
 */
const capOn = () => !!changeCap();
/** A service page's "What does it cost?": included everywhere, and on Free its applied changes share the change cap. */
const serviceCost = (name: string, extra = "") => `${name} is included on every plan, <a href="/#pricing">Free</a> too${extra}.`
  + (capOn() ? ` On Free, its applied changes count toward the ${freeChanges()}, together with every other service's; reading never counts.${plusLine()}` : "");

const CONTACT = "adam@camberstack.io";
// Each policy keeps its own date: changing the terms mustn't re-date a privacy policy Google is reviewing.
const PRIVACY_UPDATED = "2026-11-11"; // Tag Manager
const TERMS_UPDATED = "2026-11-11"; // Tag Manager went public

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
.who{font-weight:600;color:var(--muted);font-size:14px;margin:16px 0 4px!important}
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
.acct .card p{margin:0}.acct .card .btn{align-self:flex-start;margin-top:auto}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.ok{background:#2f9e6e}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:13px;border:1px solid var(--line);border-radius:99px;padding:2px 10px;color:var(--muted)}
.change{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.change-top{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between}
.change-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.change-time{font-size:14px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}.change-acct{margin:2px 0 0;font-size:14px;color:var(--muted);overflow-wrap:anywhere}.change ul{margin:8px 0 0;padding-left:20px}.change li{margin:2px 0;overflow-wrap:anywhere}
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
.changes .undo{color:var(--muted);font-size:14px}.changes .undo b{color:var(--accent);font-weight:600}
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
.demo-note{margin:24px 0 0;font-size:15px;color:var(--muted);max-width:520px}.demo-note strong{color:var(--fg)}
.warn{margin-top:24px;max-width:560px;padding:14px 16px;border-radius:10px;border:1px solid color-mix(in srgb,#c78a12 45%,var(--line));background:color-mix(in srgb,#c78a12 8%,var(--card))}.warn p{margin:0;font-size:15px}
.mini{font-size:14px;margin:0 0 14px;font-variant-numeric:tabular-nums}.mini th{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.mini td,.mini th{padding:7px 8px 7px 0}.mini td+td,.mini th+th{text-align:right}
.guide{padding-top:24px;border-top:1px solid var(--line)}
.prose{max-width:800px}
.prose h2{margin:72px 0 16px;scroll-margin-top:76px}.prose>h2:first-child{margin-top:40px}
.prose h3{font-size:18px;margin:28px 0 6px}
.prose p,.prose li{font-size:17px}
.prose details{margin:16px 0;padding:12px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card)}.prose details p{margin:8px 0 0}.prose summary{cursor:pointer;font-weight:600}
ol.steps{list-style:none;padding:0;margin:20px 0;counter-reset:step}
ol.steps>li{counter-increment:step;position:relative;padding:0 0 28px 52px;margin:0}
ol.steps>li::before{content:counter(step);position:absolute;left:0;top:-2px;width:32px;height:32px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:center}
ol.steps>li:not(:last-child)::after{content:"";position:absolute;left:15.5px;top:36px;bottom:6px;width:1px;background:var(--line)}
ol.steps .shot{max-width:400px;box-shadow:0 8px 24px -12px rgba(20,24,20,.18)}
.prompts{list-style:none;padding:0;margin:20px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.prompts li{background:var(--card);border:1px solid var(--line);border-radius:12px 12px 12px 4px;padding:12px 16px;font-size:15px!important;line-height:1.5}
.prompts em{font-style:normal}
.checks{list-style:none;padding:0;margin:16px 0}.checks li{position:relative;padding-left:30px;margin:0 0 10px}
.checks li::before{content:"";position:absolute;left:0;top:.3em;width:18px;height:18px;border-radius:50%;background:var(--accent-soft)}
.checks li::after{content:"";position:absolute;left:6.5px;top:calc(.3em + 4px);width:4px;height:8px;border:solid var(--accent);border-width:0 2px 2px 0;transform:rotate(45deg)}
.prose .changes{grid-template-columns:1fr;margin-top:16px}.prose .changes li:nth-child(even){padding-left:0;border-left:0}
@media (max-width:900px){
.hero{padding:40px 0 56px}.hero-grid,.duo{grid-template-columns:1fr;gap:40px}
.pillars{grid-template-columns:1fr;gap:28px}.also,.changes,.apps,.plans,.faq,.prompts{grid-template-columns:1fr}
.changes li:nth-child(even){padding-left:0;border-left:0}.changes li{padding-right:0}
.sec{padding:64px 0}.band{padding:44px 0}
}
@media (max-width:600px){
.hero{padding:28px 0 44px}.hero h1{margin:14px 0 14px}.hero .lede{font-size:17px;margin-bottom:22px}
.ctas .btn{flex:1 1 auto;text-align:center}.btn-lg{padding:12px 16px;font-size:15px}
.window-body{padding:16px;font-size:14px}.defs{grid-template-columns:1fr;gap:2px}.defs dd{margin-bottom:10px}
.url-lg code{font-size:13px}.nav-hide{display:none}
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
  ["Switch bid strategy: manual CPC, maximize clicks, maximize conversions, target impression share (e.g. top of page)", "Restores the previous strategy"],
  ["Set a campaign's tracking URL suffix", "Restores the previous suffix"],
  ["Create a conversion action, or set how many conversions a click can count, or its value, window and attribution", "Removes it / restores the previous setting"],
  ["Remove a conversion action", "None: Google can't restore it, so it warns you first (a GA4 import can be imported again)"],
  ["Edit a responsive search ad in place: it keeps its stats", "Restores the previous text and link"],
  ["Negative keywords on an ad group, and shared negative lists", "Removes them, or restores the list"],
  ["Ad schedules and device bids", "Restores the previous settings"],
  ["Add callouts, structured snippets, a business name, logos and images", "Takes them off again"],
  ["Turn AI Max and Google-written text on or off", "Restores the previous settings"],
  ["Create a remarketing list of site visitors and add it to a campaign in observation (no customer data)", "Removes the list / takes it off"],
  ["Delete keywords, negatives or sitelinks", "Adds them back; a sitelink comes back as a new one, so its history restarts"],
  ["Delete an ad, ad group, campaign or shared negative list", "None: these can't be restored, so each warns you first"],
  ["Apply or dismiss one of Google's recommendations", "None: applying warns you first, and Google picks the details"],
];

/** Two-part rows: the thing, then a labelled line under it ("Undo: …", "Reads: …"). */
const pairList = (rows: [string, string][], label: string) =>
  `<ul class="changes">${rows.map(([c, u]) => `<li><span>${c}</span><span class="undo"><b>${label}:</b> ${u}</span></li>`).join("")}</ul>`;

/** The demo account's negative-keyword exchange as an app window: the hero visual. `at` prefixes the user's messages (ChatGPT's @-mention). */
const demoWindow = (at = "") => `<figure class="window" aria-label="What a change looks like, from the demo account">
<div class="window-bar"><i></i><i></i><i></i><span>Demo account · sample plumbing business</span></div>
<div class="window-body">
<p class="said you">${at}Which search terms are wasting money in Emergency Plumbing?</p>
<p class="ai"><em>"plumber jobs near me"</em> cost $84.60 and <em>"plumber salary"</em> $41.20, with no conversions: people looking for work, not a plumber. I can add "jobs" and "salary" as negative keywords.</p>
<div class="change"><div class="change-top"><strong>Proposal</strong><span class="pill proposed">proposed</span></div>
<ul><li>Add 2 negative keyword(s) to campaign "Emergency Plumbing – Search": "jobs", "salary"</li></ul>
<div class="change-foot">Checked with Google, nothing changed yet</div></div>
<p class="said you">${at}Apply it.</p>
<p class="ai"><span class="pill applied">applied</span>&nbsp; Done. If it blocks searches you wanted, ask me to undo it: that removes exactly these two negatives.</p>
</div>
</figure>`;

/** A guide's first screen: copy and buttons on the left, `aside` (a window) on the right. */
const guideHero = (o: { kicker: string; title: string; lede: string; ctas: string; note?: string; aside?: string }) =>
  `<section class="hero"><div class="wrap${o.aside ? " hero-grid" : ""}">
<div class="hero-copy">
<p class="eyebrow"><span class="dot ok"></span>${o.kicker}</p>
<h1>${o.title}</h1>
<p class="lede">${o.lede}</p>
<div class="ctas">${o.ctas}</div>${o.note ?? ""}
</div>${o.aside ?? ""}
</div></section>`;

/** A guide's body: the readable column under the hero. */
const guideBody = (html: string) => `<section class="sec guide"><div class="wrap prose">${html}</div></section>`;

const closer = (title: string, sub: string, ctas: string) =>
  `<section class="closer"><div class="wrap"><h2>${title}</h2><p class="muted">${sub}</p><div class="ctas">${ctas}</div></div></section>`;

/** The homepage's "What does Free cover?" while the change cap is on; nothing otherwise. */
const freeFaq = () => (capOn() ? `<div><h3>What does Free cover?</h3>
<p>Every tool on 1 Google Ads account, with Search Console, Google Analytics, Merchant Center (1 account) and Tag Manager included, and
${freeChanges()}. A change counts when you approve and apply a proposal, however many edits it holds; undo, the demo account
and publishing Tag Manager changes on their own don't count. Reading, asking and proposing are never limited.${plusLine()}</p></div>` : "");

export function homePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/", wide: true,
    title: "Camberstack: hosted Google Ads MCP for Claude and ChatGPT",
    description: `A hosted Google Ads MCP server for Claude, ChatGPT and Cursor. Your AI proposes changes, you approve each one, and undo takes one step; the few changes Google can't reverse are flagged first. Free for 1 account with ${freeChangesShort()}; ${PRO_PRICE_LABEL} for ${PRO_ACCOUNTS}.`,
    jsonLd: {
      "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Camberstack",
      applicationCategory: "BusinessApplication", operatingSystem: "Web", url: baseUrl,
      description: "Hosted Google Ads MCP server for Claude, ChatGPT and other MCP apps: read-only queries, optional Search Console, Google Analytics 4, Merchant Center and Tag Manager, and approved changes with undo.",
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD",
          description: `Every tool, with ${freeChanges()}, on 1 Google Ads account.` },
        ...(capOn() ? [{ "@type": "Offer", name: "Plus", price: "7", priceCurrency: "USD", description: `Unlimited applied changes, on 1 Google Ads account.`,
          priceSpecification: { "@type": "UnitPriceSpecification", price: "7", priceCurrency: "USD", billingDuration: "P1M", unitCode: "MON" } }] : []),
        { "@type": "Offer", name: "Pro", price: "15", priceCurrency: "USD", description: `Every tool${capOn() ? ", with unlimited applied changes," : ""} on up to ${PRO_ACCOUNTS} Google Ads accounts.`,
          priceSpecification: { "@type": "UnitPriceSpecification", price: "15", priceCurrency: "USD", billingDuration: "P1M", unitCode: "MON" } },
        { "@type": "Offer", name: "Agency", price: "49", priceCurrency: "USD", description: `Every tool${capOn() ? ", with unlimited applied changes," : ""} on up to ${AGENCY_ACCOUNTS} Google Ads accounts.`,
          priceSpecification: { "@type": "UnitPriceSpecification", price: "49", priceCurrency: "USD", billingDuration: "P1M", unitCode: "MON" } },
      ],
    },
    body: `
<section class="hero"><div class="wrap hero-grid">
<div class="hero-copy">
<p class="eyebrow"><span class="dot ok"></span>Free for 1 Google Ads account. No card.</p>
<h1>A hosted Google Ads MCP server</h1>
<p class="lede">Your AI reads your Google Ads account and proposes changes. Nothing changes until you approve, and undo takes one message; the few changes Google can't reverse are flagged first.</p>
<div class="ctas"><a class="btn btn-lg" href="#setup">Connect for free</a><a class="btn btn-lg btn-ghost" href="#demo">Try the demo account</a></div>
<p class="works">Works with <span>Claude</span><span>ChatGPT</span><span>Cursor</span><span>Claude Code</span><span>any MCP app</span></p>
</div>
<div id="example">${demoWindow()}</div>
</div></section>

<section class="band"><div class="wrap">
<div class="pillars">
<div><h3>Undo on every plan</h3><p>Ask your AI to undo a change, and it reverses exactly that change. Every applied change is listed on your <a href="/account">account page</a>, with its undo if it has one. The few Google can't reverse warn you before you approve.</p></div>
<div><h3>Warnings before you approve</h3><p>Turning a campaign on, more than doubling a budget or bid, or switching bid strategy is flagged in the proposal.</p></div>
<div><h3>A demo account to try first</h3><p>Every tool works on a <a href="#demo">sample account</a> before you use your own. Changes there never reach Google.</p></div>
</div>
<ul class="also">
<li>Negative keywords and budgets up to whole new Search, Performance Max, Display and YouTube campaigns</li>
<li>One URL and a Google sign-in for Claude, ChatGPT, Cursor or any MCP app. Works with manager (MCC) accounts</li>
<li>Optional <a href="#search-console">Search Console</a>: where you already rank, which searches you may be paying for twice, and sitemaps you approve</li>
<li>Optional <a href="/google-analytics-mcp">Google Analytics 4</a>: which landing pages turn ad clicks into conversions</li>
<li>Optional <a href="/google-merchant-center-mcp">Merchant Center</a>: why products are disapproved or limited, what they were earning in Shopping ads, and fixes you approve</li>
<li>Optional <a href="/google-tag-manager-mcp">Tag Manager</a>: conversion tracking mistakes in your container, and the tags and publishes you approve to fix them</li>
</ul>
</div></section>

<section class="sec" id="changes"><div class="wrap">
<div class="sec-head"><p class="kicker">Google Ads</p><h2>What it can change</h2>
<p class="muted">Every change is a proposal you approve, and all but a few have an undo: the ones Google can't reverse warn you first. A new campaign is always created paused, so building it and letting it spend are two separate approvals.</p></div>
${pairList(CHANGES, "Undo")}
<p class="muted small">Besides the warnings above, a proposal also warns before removing a campaign's last location.
It deletes only what you approve, and it cannot touch billing or edit anything outside Google Ads, the <a href="#analytics">Google Analytics setup changes</a> and the <a href="#search-console">Search Console sitemaps and properties</a> below,
and the <a href="/google-merchant-center-mcp">Merchant Center</a> and <a href="/google-tag-manager-mcp">Tag Manager</a> changes on their pages.
Any question beyond these tools is answered with read-only queries. <a href="/tools">Every tool and what it can do</a>;
the code is <a href="${SOURCE_URL}">open source</a>.</p>
</div></section>

<section class="sec sec-tint"><div class="wrap duo">
<div id="search-console"><p class="kicker">Optional</p><h2>Search Console</h2>
<p>Leave the Search Console box ticked when you connect, and your AI can read your site's Google Search clicks, impressions,
queries and positions, and line them up against your ads:</p>
<dl class="defs">
<dt>Paid and already ranking</dt><dd>Searches you pay for where your site is already in the top few organic results, with the ad spend on each.</dd>
<dt>Organic gaps</dt><dd>Searches your site shows up for on page 2 or lower, with no ad covering them.</dd>
<dt>Site totals</dt><dd>Clicks, impressions, CTR and position against the previous period.</dd>
<dt>Trends</dt><dd>Which searches and pages are rising, falling, new or gone since the period before.</dd>
<dt>Opportunities</dt><dd>Searches just off page 1, and top results with a click-through rate low enough to point at the title.</dd>
<dt>Indexing</dt><dd>Whether Google has indexed a page and why not, when it last crawled it, and when it last read your sitemap.</dd>
<dt>Sitemaps and properties</dt><dd>Submit, resubmit or remove a sitemap, and add or remove a property, once you approve the proposal.</dd>
</dl>
<p class="muted small">Nothing changes in Search Console until you approve a proposal. The Search Console tools work without a Google Ads account too: <a href="/google-search-console-mcp">Search Console MCP</a>.</p>
</div>
<div id="analytics"><p class="kicker">Optional</p><h2>Google Analytics 4</h2>
<p>Leave the Google Analytics box ticked when you connect, and your AI can read your GA4 properties next to your ads:</p>
<dl class="defs">
<dt>Landing pages</dt><dd>Sessions, engagement and key events (GA4's conversions) per landing page, for all traffic or one channel, such as Paid Search.</dd>
<dt>Reports</dt><dd>Any GA4 report by dimension and metric, for example paid against organic traffic last month.</dd>
<dt>Setup check</dt><dd>Each property's web streams and measurement IDs, which events count as key events, and which Google Ads accounts it's linked to.</dd>
</dl>
<p>It can also change that setup, with the same proposal, approval and undo as a Google Ads change:</p>
${pairList([
  ["Create a GA4 property with a web stream (the result gives the measurement ID and the tag your site needs)", "Moves the property it created to Google Analytics' trash (restorable there for 35 days)"],
  ["Mark or unmark an event as a key event", "Restores the previous setting"],
  ["Link or unlink a Google Ads account", "Restores the previous link"],
], "Undo")}
<p class="muted small">Google Ads, Search Console, Google Analytics, Merchant Center and Tag Manager are each optional: untick any of them, and when you later ask about it Camberstack gives you a one-click link that adds it. The <a href="#demo">demo</a> includes a sample GA4 property. <a href="/google-analytics-mcp">More on the Google Analytics tools</a>.</p>
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
<div class="app"><h3>ChatGPT <span class="muted">web and phone app</span></h3>
<p>Camberstack is in ChatGPT's plugin directory: <a href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866">open it there and click Install plugin</a>, sign in with Google, then type <strong>@Camberstack</strong> in a chat.</p>
<p><a href="/google-ads-chatgpt">Step-by-step setup guide →</a></p></div>
<div class="app"><h3>Claude Code</h3>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}</div>
<div class="app"><h3>Cursor, VS Code, others</h3>
${cmd(`{ "mcpServers": { "camberstack": { "url": "${mcpUrl}" } } }`)}</div>
</div>
<p class="muted small">Your AI app handles sign-in. Google shows exactly what Camberstack asks for before anything is shared: your Google Ads, and (optional) Search Console and Google Analytics. Camberstack changes nothing without your approval.</p>
<div class="demo" id="demo"><h3>Want to look first?</h3>
<p>Connect, then ask <em>"Show me Camberstack's demo account"</em>. It's a sample plumbing business with six months of
campaigns and search terms, so you can try questions, proposals, applying and undo without touching a real account.
Changes there never reach Google, and the demo doesn't count as one of your plan's accounts. A Google login with no Google Ads access gets the demo automatically.</p></div>
</div></section>

<section class="sec sec-tint" id="pricing"><div class="wrap">
<div class="sec-head"><p class="kicker">Pricing</p><h2>${capOn() ? `Free for one account. ${PLUS_PRICE_LABEL} for unlimited changes, ${PRO_PRICE_LABEL} for ${PRO_ACCOUNTS} accounts, ${AGENCY_PRICE_LABEL} for ${AGENCY_ACCOUNTS}.`
  : `Free for one account. ${PRO_PRICE_LABEL} for ${PRO_ACCOUNTS}, ${AGENCY_PRICE_LABEL} for ${AGENCY_ACCOUNTS}.`}</h2></div>
<div class="plans">
<div class="plan"><h3>Free</h3><p class="price">$0</p><p>Every tool, with ${freeChanges()} and undo, on <strong>1 Google Ads account</strong>. No card.</p>
<p class="plan-cta"><a class="btn btn-ghost" href="#setup">Connect for free</a></p></div>${!capOn() ? "" : `
<div class="plan plan-pro"><h3>Plus</h3><p class="price">${PLUS_PRICE_LABEL}</p><p>Unlimited applied changes, on <strong>1 Google Ads account</strong>, for anyone who makes more than a few changes a month. Cancel any time.</p>
<p class="plan-cta"><a class="btn" href="/account?upgrade=plus">Get Plus</a></p><p class="muted small">Connect Camberstack to your AI app first; you'll sign in with the same Google account.</p></div>`}
<div class="plan${capOn() ? "" : " plan-pro"}"><h3>Pro</h3><p class="price">${PRO_PRICE_LABEL}</p><p>${paidCovers()} <strong>up to ${PRO_ACCOUNTS} Google Ads accounts</strong>, for owners with a few brands and freelancers with a few clients. Cancel any time; you keep Pro until the end of the month you paid for.</p>
<p class="plan-cta"><a class="btn${capOn() ? " btn-ghost" : ""}" href="/account?upgrade=1">Upgrade to Pro</a></p>${capOn() ? "" : `<p class="muted small">Connect Camberstack to your AI app first; you'll sign in with the same Google account.</p>`}</div>
<div class="plan"><h3>Agency</h3><p class="price">${AGENCY_PRICE_LABEL}</p><p>${paidCovers()} <strong>up to ${AGENCY_ACCOUNTS} Google Ads accounts</strong>, for agencies and anyone managing clients through a manager (MCC) account. Already on Pro? Switch from your account page; the difference is prorated.</p>
<p class="plan-cta"><a class="btn btn-ghost" href="/account?upgrade=agency">Upgrade to Agency</a></p></div>
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
${freeFaq()}<div><h3>What counts as an account?</h3>
<p>Each Google Ads account you actually use Camberstack on in the last ${ACCOUNT_WINDOW_DAYS} days, not every account your login can see.
A manager (MCC) account and the demo account don't count. Free covers one account at a time: your AI asks which one first, and
another opens once it has gone ${ACCOUNT_WINDOW_DAYS} days unused. Before that, your AI says when it opens
and how to upgrade. Undo and change history always work.</p></div>
</div>
</div></section>

${closer("Ask your Google Ads account a question.", `Free for one account, with ${freeChangesShort()} and undo.`,
  `<a class="btn btn-lg" href="#setup">Connect for free</a><a class="btn btn-lg btn-ghost" href="#demo">Try the demo account</a>`)}
`,
  });
}

// ---------------------------------------------------------------- shared by the setup guides

const ASK_FIRST = `<h2>What to ask first</h2>
<ul class="prompts">
<li><em>"How did each campaign do last month: spend, clicks, conversions?"</em></li>
<li><em>"Which search terms cost the most in the last 30 days?"</em></li>
<li><em>"Add 'jobs' as a negative keyword to my Search campaign. Show me the change first."</em></li>
<li><em>"Build a paused Performance Max campaign for my homepage, using the images already in my account."</em></li>
<li><em>"What did you change this week? Undo the last change."</em></li>
<li><em>"Which searches am I paying for that my site already ranks for organically?"</em></li>
<li>Not ready to use your real account? <em>"Show me Camberstack's demo account."</em></li>
</ul>`;

/** The other Google services, for the Ads guides: each has its own page, which the guides otherwise never linked. */
const OTHER_SERVICES = `<p>The same connection can also read <a href="/google-search-console-mcp">Search Console</a>, <a href="/google-analytics-mcp">Google Analytics 4</a>,
<a href="/google-merchant-center-mcp">Merchant Center</a> and <a href="/google-tag-manager-mcp">Tag Manager</a>, if you leave their boxes ticked when you sign in.</p>`;

const CAN_CHANGE = `<h2>What it can change</h2>
<p>Negative keywords, budgets and end dates, pausing and re-enabling, bids, targeting and bid strategy, conversion goals, and whole new
Search, Performance Max, Display and YouTube campaigns (always created paused). You approve each change, and each one can be undone, apart from the few Google can't reverse, which are flagged first. <a href="/#changes">The full list</a>, and <a href="/tools">every tool</a>.</p>`;

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
<p>The Free plan covers one Google Ads account at a time; another opens once it has gone ${ACCOUNT_WINDOW_DAYS} days unused. On a second account, it says when another account opens
and how to upgrade. Undo and change history always work. <a href="/#pricing">Plans</a>.</p>${capOn() ? `
<h3>"Change limit"</h3>
<p>The Free plan includes ${freeChanges()}. Past that, applying a proposal stops: nothing is applied, the proposal stays open, and
the answer says when the next change opens. Asking, reading, proposing, undo and change history keep working. Plus has unlimited changes on
one account, Pro and Agency on more. <a href="/#pricing">Plans</a>.</p>` : ""}
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
<p>No. It gets Google Ads access, your email address and, if you leave them ticked, Search Console, Google Analytics, Merchant Center and Tag Manager (changed only when you approve a proposal). Nothing else: no Gmail, Drive or calendar. Details in the <a href="/privacy">privacy policy</a>.</p>
<h3>What does it cost?</h3>
<p>${capOn() ? `Free on one Google Ads account, with every tool and ${freeChangesShort()}. <a href="/#pricing">Plus</a> has unlimited changes on one account for ${PLUS_PRICE_LABEL}, Pro on up to ${PRO_ACCOUNTS} accounts for ${PRO_PRICE_LABEL}, Agency up to ${AGENCY_ACCOUNTS} for ${AGENCY_PRICE_LABEL}.`
  : `Free on one Google Ads account, with every tool and ${freeChangesShort()}. <a href="/#pricing">Pro</a> covers up to ${PRO_ACCOUNTS} accounts for ${PRO_PRICE_LABEL}, Agency up to ${AGENCY_ACCOUNTS} for ${AGENCY_PRICE_LABEL}.`}</p>`;

/**
 * Use-case page for "claude google ads" / "google ads claude" / "google ads mcp server" (keyword data:
 * project-research/keywords-ads-mcp.json).
 */
export function claudeGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-claude", wide: true,
    title: "Connect Google Ads to Claude: MCP setup in 2 minutes | Camberstack",
    description: "Connect your Google Ads account to Claude with an MCP server. No developer token or Google Cloud project: sign in with Google, then ask Claude about your account.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to Claude", url: `${baseUrl}/google-ads-claude`, dateModified: "2026-10-17",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "In Claude's connector directory",
  title: "Connect Google Ads to Claude",
  lede: `Claude can read your Google Ads account, answer questions about it,
and make the changes you approve. Camberstack is in Claude's connector directory, so it takes a few clicks and a Google sign-in. No developer token, no Google Cloud project.`,
  ctas: `<a class="btn btn-lg" href="https://claude.ai/directory/connectors/camberstack">Open in Claude's directory</a><a class="btn btn-lg btn-ghost" href="#setup">See the steps</a>`,
  note: `<p class="demo-note" id="demo"><strong>Try it on a demo account first.</strong> Once connected, ask <em>"Show me Camberstack's demo account"</em>: a sample
plumbing business where you can try questions, proposals and undo. Changes there never reach Google.</p>`,
  aside: demoWindow(),
})}
${guideBody(`
<h2 id="setup">Set it up</h2>
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
${OTHER_SERVICES}

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
`)}
${closer("Ask Claude about your Google Ads.", `Free for one account, with ${freeChangesShort()} and undo.`,
  `<a class="btn btn-lg" href="https://claude.ai/directory/connectors/camberstack">Open in Claude's directory</a><a class="btn btn-lg btn-ghost" href="/#setup">Other AI apps</a>`)}
`,
  });
}

/**
 * Use-case page for "chatgpt google ads". Camberstack is published in ChatGPT's plugin directory (2026-10-21), so setup is
 * the plugin page and a Google sign-in; developer mode and the custom-MCP-server path are no longer needed.
 */
export function chatgptGuidePage(baseUrl: string): string {
  return layout({
    baseUrl, path: "/google-ads-chatgpt", wide: true,
    title: "Connect Google Ads to ChatGPT: MCP setup, step by step | Camberstack",
    description: "Connect your Google Ads account to ChatGPT with a plugin. No developer token or Google Cloud project: add Camberstack from ChatGPT's plugin directory, sign in with Google, then ask about your account.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to ChatGPT", url: `${baseUrl}/google-ads-chatgpt`, dateModified: "2026-10-21",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "In ChatGPT's plugin directory",
  title: "Connect Google Ads to ChatGPT",
  lede: `ChatGPT can read your Google Ads account, answer questions about it,
and make the changes you approve. Setup is one click in ChatGPT's plugin directory and a Google sign-in. No developer token,
no Google Cloud project.`,
  ctas: `<a class="btn btn-lg" href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866">Open in ChatGPT's directory</a><a class="btn btn-lg btn-ghost" href="#setup">See the steps</a>`,
  aside: demoWindow("@Camberstack "),
})}
${guideBody(`
<h2 id="setup">Set it up</h2>
<ol class="steps">
<li>Open <a href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866">Camberstack in ChatGPT's plugin directory</a>, and click <strong>Install plugin</strong>. It's listed as
<strong>Camberstack: Google Ads</strong>.
On Business or Enterprise, a workspace admin may need to allow it first.
${shot("chatgpt-plugin.webp", 540, 842, "Camberstack: Google Ads in ChatGPT's plugin directory, with the Install plugin button")}</li>
<li>Sign in with the Google account that has access to your Google Ads. Google shows exactly what's being shared before you agree.</li>
<li>In a chat, type <strong>@Camberstack</strong> and pick <strong>Camberstack: Google Ads</strong>, then your question:
<em>"@Camberstack how did my campaigns do last month?"</em> Once it's added, it works in the ChatGPT phone app too.</li>
</ol>

<h2>What protects your account</h2>
<ul>
<li>Changes are stored as a proposal and checked with Google first; applying is a separate tool call. ChatGPT asks you to
confirm tool calls that change things unless you've turned that off.</li>
<li>Applied changes can be undone with one more message. The few Google can't reverse, such as deleting a campaign, are flagged before you approve.</li>
<li>New campaigns are created paused, and risky changes (turning a campaign on, a big budget or bid jump) carry a warning before you approve. Nothing you built can be deleted.</li>
</ul>

<h2>Using it in ChatGPT</h2>
<p>Start each message with <strong>@Camberstack</strong>. Without the mention, ChatGPT answers from what it already knows
and never looks at your account. Some first questions:</p>
<ul class="prompts">
<li><em>"@Camberstack which campaign had the highest cost per conversion in the last 30 days?"</em></li>
<li><em>"@Camberstack list the search terms that spent money without a conversion this month."</em></li>
<li><em>"@Camberstack find keyword ideas for my landing page and tell me their monthly searches."</em></li>
<li><em>"@Camberstack show me the demo account"</em>, to try it before using your real account.</li>
</ul>
<p>When you ask for a change, ChatGPT first shows what Camberstack proposes, then asks before it calls the tool that applies it.
Approve in the chat and the change is made in Google Ads; ask <em>"@Camberstack undo that"</em> to reverse it.
It can change negatives, budgets, bids, targeting and conversion goals, and build paused campaigns: <a href="/#changes">the full list</a>
and <a href="/tools">every tool</a>. In the phone app, the same @-mention works once you've set it up on the web.</p>
${OTHER_SERVICES}

${guideTroubleshooting("ChatGPT",
  "ChatGPT uses a plugin only when you mention it. Start the message with <strong>@</strong> and its name: <em>\"@Camberstack how did my campaigns do last month?\"</em>",
  "remove Camberstack under <strong>Plugins</strong> and add it again from <a href=\"https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866\">the directory</a>.")}

<h2>Questions</h2>
<h3>How do I disconnect?</h3>
<p>ChatGPT blocks disconnect requests from chat, so sign in at <a href="/account">camberstack.io/account</a> and choose
<strong>Disconnect Google Ads</strong>, or remove Camberstack at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<h3>Does ChatGPT see my whole Google account?</h3>
<p>No. The Google sign-in is Camberstack's, not ChatGPT's, and it shares only Google Ads, your email address and, if you leave them
ticked, Search Console, Google Analytics, Merchant Center and Tag Manager (changed only when you approve a proposal). ChatGPT sees the answers Camberstack returns to the questions you ask, nothing else.</p>
<h3>Does it need a paid Camberstack plan?</h3>
<p>${capOn() ? `No. One Google Ads account is free with every tool and ${freeChanges()}; <a href="/#pricing">Plus</a> has unlimited changes on one account, Pro on up to ${PRO_ACCOUNTS} accounts, and Agency up to ${AGENCY_ACCOUNTS}.`
  : `No. One Google Ads account is free with every tool; <a href="/#pricing">Pro</a> is for managing up to ${PRO_ACCOUNTS}, and Agency up to ${AGENCY_ACCOUNTS}.`}</p>
<h3>Using Claude too?</h3>
<p>Camberstack is in Claude's connector directory as well: see <a href="/google-ads-claude">the Claude guide</a>.</p>
`)}
${closer("Ask ChatGPT about your Google Ads.", `Free for one account, with ${freeChangesShort()} and undo.`,
  `<a class="btn btn-lg" href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866">Open in ChatGPT's directory</a><a class="btn btn-lg btn-ghost" href="/google-ads-claude">Using Claude instead?</a>`)}
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
    baseUrl, path: "/google-search-console-mcp", wide: true,
    title: "Google Search Console MCP server, hosted | Camberstack",
    description: "A hosted Google Search Console MCP server for Claude, ChatGPT and Cursor. Sign in with Google: no Cloud project, service account or API key. Queries, trends, indexing, and sitemaps you can submit with your approval.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Google Search Console MCP server", url: `${baseUrl}/google-search-console-mcp`, dateModified: "2026-10-13",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "Free, no Google Ads account needed",
  title: "Google Search Console MCP server",
  lede: `Ask your AI assistant how your site is doing in Google Search, and it reads your Search Console data to answer:
clicks, queries, pages, what's rising or falling, and why a page isn't indexed. Camberstack is hosted, so setup is a Google
sign-in. It reads by default, and submits sitemaps or changes properties only when you approve a proposal.`,
  ctas: `<a class="btn btn-lg" href="#setup">Connect Search Console</a><a class="btn btn-lg btn-ghost" href="/tools#search_console_sites">See the tools</a>`,
  aside: `<figure class="window" aria-label="An example answer, from the demo website">
<div class="window-bar"><i></i><i></i><i></i><span>Demo website · northwind-plumbing.example</span></div>
<div class="window-body">
<p class="said you">Which searches am I on page 2 for?</p>
<p class="ai">Four searches with real demand where you sit on page 2, over the last 180 days:</p>
<table class="mini"><tr><th>Search</th><th>Position</th><th>Impressions</th></tr>
<tr><td>tankless water heater</td><td>14.2</td><td>8,800</td></tr>
<tr><td>water heater replacement</td><td>11.8</td><td>5,200</td></tr>
<tr><td>slab leak repair</td><td>18.3</td><td>4,200</td></tr>
<tr><td>hydro jetting</td><td>12.5</td><td>3,100</td></tr></table>
<p class="ai">"Water heater replacement" is closest to page 1. Want me to check whether that page is indexed?</p>
</div>
</figure>`,
})}
${guideBody(`
<h2>Questions it answers</h2>
${pairList([
  [`<em>"How did my site do in Google Search last month, against the month before?"</em>`, "Site totals for both periods: clicks, impressions, CTR, average position"],
  [`<em>"Which pages lost the most clicks in the last 28 days?"</em>`, "Every query and page compared with the period before: rising, falling, new and lost"],
  [`<em>"Which searches am I on page 2 for?"</em>`, "Queries in positions 4 to 20, with the clicks a realistic climb would add, and top results whose CTR is low enough to point at the title"],
  [`<em>"Is /pricing indexed? If not, why?"</em>`, "Google's index record for the page: the coverage reason, last crawl, robots.txt, and the canonical Google chose"],
  [`<em>"When did Google last read my sitemap?"</em>`, "Each submitted sitemap's last download, URL count, errors and warnings"],
  [`<em>"Which searches do I pay for that I already rank for?"</em>`, "Your Google Ads search terms joined with your organic queries over the same days (needs a Google Ads account)"],
], "Reads")}
<p>Answers come from the Search Console API, so they match what Search Console shows, with its limits: data goes back 16 months,
the last two or three days are still filling in, and Google leaves rare queries out of per-query rows for privacy. Site totals
are the complete numbers, so your AI leads with those.</p>

<h2 id="setup">Set it up</h2>
<p>Connect Camberstack in your AI app (<a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, or any MCP
client with <code>${mcpUrl}</code>). On Google's sign-in screen, leave the <strong>Search Console</strong> box ticked: it grants
access to your sites' Search Console (<code>webmasters</code>), nothing else. Then ask <em>"List my Search Console sites"</em> and use a site
from that list.</p>
<p>Google's screen also asks for Google Ads access, because Camberstack is a Google Ads tool too. You don't need a Google Ads account
to use the Search Console tools. Without one, Camberstack offers its demo Ads account and every Search Console tool works on your real sites.</p>

<h2>Domain and URL-prefix properties</h2>
<p>Search Console treats <code>sc-domain:example.com</code> (a Domain property, verified by DNS, covering every subdomain and
protocol) and <code>https://www.example.com/</code> (a URL-prefix property) as different sites, with different data. If your AI
says it has no access to a site you can see in Search Console, it's usually using the other form. The site list shows the exact
names your login can read.</p>

<h2>Changing sitemaps and properties</h2>
<p>Ask your AI to submit a sitemap, and it shows you a proposal first. Nothing changes until you approve it, and undo reverses it, except removing a verified
property, which warns you first. If you connected before Camberstack could make changes, your first one gives you a link that adds them, with no reconnecting.</p>

<h2>What it can't do</h2>
<ul>
<li>Request indexing. Google offers no API for requesting indexing of ordinary pages, so you still do that in Search Console. Submitting or resubmitting a sitemap is the closest thing Camberstack can do.</li>
<li>Verify ownership of a property. It can add a property, but unless you already own its domain in Search Console, you prove ownership there.</li>
<li>Read the Enhancements reports (rich results, Core Web Vitals) as Search Console's UI shows them. URL inspection includes each page's
structured-data items and their errors, which covers the same ground one page at a time.</li>
</ul>

<h2>Compared with running your own</h2>
<p>Open-source Search Console MCP servers run on your machine and need a Google Cloud project with the Search Console API enabled,
plus an OAuth client or a service account added as a user on each property. That suits a developer on one laptop. Camberstack
runs that part for you: one Google sign-in, and it works the same in Claude on the web, on your phone, and in ChatGPT.
The same connection reads <a href="/google-analytics-mcp">Google Analytics 4</a> and <a href="/google-merchant-center-mcp">Merchant Center</a> too.</p>

<h2>Questions</h2>
<h3>What does it cost?</h3>
<p>${serviceCost("Search Console", ", and it doesn't use up a plan's Google Ads accounts")}</p>
<h3>Which Search Console permission do I need?</h3>
<p>Any user of the property can read its performance data. Only the sites your Google login can see in Search Console are listed.</p>
<h3>Do you store my search data?</h3>
<p>No. Camberstack fetches it when your AI asks and passes it on; reports and query results aren't kept. Details in the <a href="/privacy">privacy policy</a>.</p>
`)}
${closer("Ask your AI how your site is doing in Google Search.", "Included on every plan, Free too. No Google Ads account needed.",
  `<a class="btn btn-lg" href="/#setup">Connect Search Console</a><a class="btn btn-lg btn-ghost" href="/tools#search_console_sites">See the tools</a>`)}
`,
  });
}

/**
 * Use-case page for "google merchant center mcp" (20/mo avg, 0 → 40 over the year to 2026-09; the per-issue searches such
 * as "price mismatch" or "missing gtin" have no Keyword Planner volume, so they're sections here, not pages of their own.
 * Keyword Planner via the dev connector, 2026-11-04). The hero's numbers are the demo store's (merchant.ts DEMO_PRODUCTS,
 * merchant_ad_spend on 000-000-0001 + 000000001, 30 days to 2026-11-03).
 */
export function merchantCenterPage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-merchant-center-mcp", wide: true,
    title: "Google Merchant Center MCP server, hosted | Camberstack",
    description: "A hosted Google Merchant Center MCP server for Claude, ChatGPT and Cursor. See why products are disapproved or limited, what they were earning in Shopping ads, and fix price, GTIN and title issues with your approval.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Google Merchant Center MCP server", url: `${baseUrl}/google-merchant-center-mcp`, dateModified: "2026-11-04",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "No Google Ads account needed",
  title: "Google Merchant Center MCP server",
  lede: `Ask your AI assistant why products aren't showing on Google, and it reads your Merchant Center to answer: which products are
disapproved or limited, why, and what they were earning in Shopping ads before they stopped. It can fix a price, GTIN or title for
you, only when you approve. Camberstack is hosted, so setup is a Google sign-in.`,
  ctas: `<a class="btn btn-lg" href="#setup">Connect Merchant Center</a><a class="btn btn-lg btn-ghost" href="/tools#merchant_accounts">See the tools</a>`,
  aside: `<figure class="window" aria-label="An example answer, from the demo store">
<div class="window-bar"><i></i><i></i><i></i><span>Demo store · Northwind Plumbing Supply</span></div>
<div class="window-body">
<p class="said you">Why did my Shopping sales drop?</p>
<p class="ai">Two of your best sellers were disapproved for a price mismatch and stopped serving:</p>
<table class="mini"><tr><th>Product</th><th>Issue</th><th>Ad value, 30 days</th></tr>
<tr><td>Tankless Water Heater 5.0 GPM</td><td>Price mismatch</td><td>$33,321</td></tr>
<tr><td>Tankless Water Heater 3.8 GPM</td><td>Price mismatch</td><td>$12,432</td></tr>
<tr><td>Garbage Disposal 3/4 HP</td><td>Missing GTIN</td><td>$1,909</td></tr></table>
<p class="ai">The feed price doesn't match your product page. Want me to propose setting it to the page's price?</p>
</div>
</figure>`,
})}
${guideBody(`
<h2>Questions it answers</h2>
${pairList([
  [`<em>"Why aren't my products showing on Google?"</em>`, "Account issues, how many products are eligible, limited, pending or disapproved, and each issue with the products it hits, worst first"],
  [`<em>"Which disapproved products were making me money?"</em>`, "Problem products joined with what they earned in Shopping and Performance Max ads, most value first, and which stopped spending in the last week (needs a Google Ads account)"],
  [`<em>"Why is this product disapproved?"</em>`, "One product's issues in full, with the attribute each one names"],
  [`<em>"Which products got the most Shopping clicks last month?"</em>`, "Any Merchant Center report: clicks and impressions per product, ads or free listings, price competitiveness, best sellers"],
], "Reads")}

<h2>Fixes it can make</h2>
<p>Ask for a fix and your AI shows you a proposal first. Nothing changes until you approve it, and every change can be undone.</p>
${pairList([
  ["Override a product's price, sale price, GTIN, brand, title, availability or other attributes, for example to clear a price mismatch or a missing GTIN", "Your feed's own values apply again"],
  ["Take products out of Shopping ads or free listings, or put them back", "Restores the previous setting"],
  ["Add, change or delete products of Camberstack's own, in a data source named \"Camberstack products\"", "Removes or re-creates the product"],
  ["Link or unlink your Merchant Center and Google Ads accounts", "Restores the previous link"],
], "Undo")}
<p>Your feed itself is never edited. An override goes into Camberstack's own supplemental data source in your account, which Google
applies on top of your feed. The first time, that source has to be added to your feed's rules; the proposal says so before you
approve. A fix in your store or feed lasts longer, and your AI will suggest that too.</p>

<h2>Common issues</h2>
<h3>Price mismatch</h3>
<p>The price in your feed differs from the price on your product page, so Google disapproves the product. Ask your AI to check
the product and propose the right price as an override. The override shows within a few minutes, and Google then rechecks the
product. Fix the price at the source too, in your store or feed.</p>
<h3>Missing GTIN</h3>
<p>Products without a GTIN (the barcode number) are limited rather than disapproved, so they still show, but less. Give your AI
the GTINs and it proposes them as overrides. For a product that has no GTIN, such as a custom item, set brand and MPN instead, or mark it as having no identifier.</p>
<h3>Image too small, misrepresentation and account issues</h3>
<p>Your AI can find these and tell you which products they hit, but the fix happens elsewhere: a larger image on your site, or
Merchant Center's own settings for return policy, shipping and business details.</p>

<h2>Shopify and other stores</h2>
<p>Products from Shopify's Google &amp; YouTube app take overrides, and the overrides survive the app's syncs; so do products from
other apps and from file feeds. Products added by hand in Merchant Center, or found by its automatic feed, can't take them, and
the proposal tells you if a product is one of those.</p>

<h2 id="setup">Set it up</h2>
<p>Connect Camberstack in your AI app (<a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, or any MCP
client with <code>${mcpUrl}</code>). On Google's sign-in screen, leave the <strong>Merchant Center</strong> box ticked, then ask <em>"List my Merchant Center accounts"</em>.
Already connected without it? The first time you ask, Camberstack gives you a link that adds it to the same Google account, with no reconnecting.</p>
<p>You don't need a Google Ads account. Without one, every Merchant Center tool works on your real store; only the one that joins
products with ad spend needs Ads.</p>

<h2>Compared with running your own</h2>
<p>Google's Merchant API needs a Google Cloud project with the API enabled, registered with a Merchant Center account before any call
works, plus an OAuth client of your own. That suits a developer on one laptop. Camberstack runs that part for you: one Google sign-in,
and it works the same in Claude on the web, on your phone, and in ChatGPT. The same connection reads <a href="/google-search-console-mcp">Search Console</a>
and <a href="/google-analytics-mcp">Google Analytics 4</a> too.</p>

<h2>Questions</h2>
<h3>What does it cost?</h3>
<p>${serviceCost("Merchant Center", `: 1 Merchant Center account on Free${capOn() ? " and Plus" : ""}, ${PRO_ACCOUNTS} on Pro and ${AGENCY_ACCOUNTS} on Agency`)}</p>
<h3>Can I try it first?</h3>
<p>Yes. Ask for the demo store (Merchant Center account 000000001), a sample plumbing supply shop with disapproved and limited products. Fixes there change only the demo.</p>
<h3>Do you store my product data?</h3>
<p>Only the changes you approve, so they can be shown and undone; Google can't return them. Product statuses and reports are fetched
when your AI asks and aren't kept. Details in the <a href="/privacy">privacy policy</a>.</p>
`)}
${closer("Ask your AI why products aren't showing on Google.", "Free on one Merchant Center account.",
  `<a class="btn btn-lg" href="/#setup">Connect Merchant Center</a><a class="btn btn-lg btn-ghost" href="/tools#merchant_accounts">See the tools</a>`)}
`,
  });
}

/**
 * Use-case page for Google Tag Manager (public 2026-11-11, when Google verified the four tagmanager scopes). The hero is
 * tag_manager_setup on the demo container (gtm.ts freshGtm): an Ads conversion tag on All Pages, no Conversion Linker,
 * a Universal Analytics tag. Only web (GTM-) containers are listed; custom HTML tags, variables and editing an existing
 * tag's settings aren't supported, and GTM accounts can't be created through the API.
 */
export function tagManagerPage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-tag-manager-mcp", wide: true,
    title: "Google Tag Manager MCP server, hosted | Camberstack",
    description: "A hosted Google Tag Manager MCP server for Claude, ChatGPT and Cursor. Find conversion tracking problems in your container, and add, pause or remove tags and publish, only with your approval.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Google Tag Manager MCP server", url: `${baseUrl}/google-tag-manager-mcp`, dateModified: "2026-11-11",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "No Google Ads account needed",
  title: "Google Tag Manager MCP server",
  lede: `Ask your AI assistant why your conversions look wrong, and it reads your Tag Manager container to answer: which tags fire
where and when, what isn't published yet, and the tracking mistakes that skew Google Ads and GA4. It can add the tag that's missing,
pause or remove a broken one, and publish, only when you approve. Camberstack is hosted, so setup is a Google sign-in.`,
  ctas: `<a class="btn btn-lg" href="#setup">Connect Tag Manager</a><a class="btn btn-lg btn-ghost" href="/tools#tag_manager_containers">See the tools</a>`,
  aside: `<figure class="window" aria-label="An example answer, from the demo container">
<div class="window-bar"><i></i><i></i><i></i><span>Demo container · northwind-plumbing.example</span></div>
<div class="window-body">
<p class="said you">Why does Google Ads count so many conversions?</p>
<p class="ai">Three problems in your container:</p>
<table class="mini"><tr><th>Tag</th><th>Problem</th></tr>
<tr><td>Ads - Call clicks</td><td>Fires on every page, so each page view counts as a conversion</td></tr>
<tr><td>(none)</td><td>No Conversion Linker: Safari and Firefox conversions go uncounted</td></tr>
<tr><td>UA - pageviews (old)</td><td>Universal Analytics, which Google stopped processing in 2024</td></tr></table>
<p class="ai">Want me to propose adding a Conversion Linker, pausing the call-click tag and deleting the old one, then publishing?</p>
</div>
</figure>`,
})}
${guideBody(`
<h2>Questions it answers</h2>
${pairList([
  [`<em>"Is my conversion tracking set up right?"</em>`, "Every tag in the container, what it sends where and when it fires, and the problems worth fixing: a Google Ads conversion tag with no Conversion Linker or firing on every page, a tag that never fires, retired Universal Analytics, no Google tag"],
  [`<em>"What's waiting to be published?"</em>`, "The live version, and the changes in the workspace that aren't on the site yet"],
  [`<em>"Which containers do I have?"</em>`, "Every web container your Google login can read, across your Tag Manager accounts"],
  [`<em>"Does my Google Ads conversion fire on the thank-you page?"</em>`, "Each tag's triggers, and the conversion ID and label it sends"],
], "Reads")}

<h2>Changes it can make</h2>
<p>Ask for a change and your AI shows you a proposal first. Nothing changes until you approve it, and changes stay in the container's
workspace until a publish puts them on your site, which is a change you approve too.</p>
${pairList([
  ["Add a Google tag (GA4 or Google Ads), a Google Ads conversion tag, a GA4 event tag or a Conversion Linker, on all pages, on pages whose URL contains some text, on a custom event, or on an existing trigger", "Removes the tag, and the trigger it added"],
  ["Pause, unpause or delete a tag", "Restores the previous state, or the deleted tag"],
  ["Publish the workspace, so the changes go live on the site", "Publishes the version that was live before"],
  ["Create a web container", "Deletes the container"],
  ["Delete a container: Google can't undo this, and the proposal warns you first", "None"],
], "Undo")}

<h2>Common problems</h2>
<h3>Conversions counted on every page</h3>
<p>A Google Ads conversion tag on the All Pages trigger counts each page view as a conversion, so the numbers run high and Smart
Bidding chases visits instead of leads. Ask your AI to check the tag's triggers, then pause it and add one that fires on the
thank-you page or the form's event.</p>
<h3>No Conversion Linker</h3>
<p>Without a Conversion Linker, Google Ads loses conversions from browsers that block third-party cookies, such as Safari and Firefox.
Adding one is a single approved change and a publish.</p>
<h3>Universal Analytics tags</h3>
<p>Google stopped processing Universal Analytics in 2024, so those tags send data nowhere. They can be deleted; GA4 uses a Google tag.</p>

<h2 id="setup">Set it up</h2>
<p>Connect Camberstack in your AI app (<a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, or any MCP
client with <code>${mcpUrl}</code>). On Google's sign-in screen, leave <strong>Tag Manager</strong> ticked, then ask <em>"List my Tag Manager containers"</em>.
Already connected without it? The first time you ask, Camberstack gives you a link that adds it to the same Google account, with no reconnecting.</p>
<p>You need a Tag Manager account, which you create at <a href="https://tagmanager.google.com">tagmanager.google.com</a>: Google doesn't let
any app create one. A container inside it Camberstack can create for you. You don't need a Google Ads account.</p>

<h2>What it can't do</h2>
<p>Camberstack works on web containers (<code>GTM-</code> IDs), not server-side, app or AMP containers. It doesn't write custom HTML tags,
edit variables, or change the settings of a tag it didn't add: for those, it tells you what to change in Tag Manager. A container
managed by another app, such as Shopify's Google channel, can be read but not changed.</p>

<h2>Compared with running your own</h2>
<p>Google's Tag Manager API needs a Google Cloud project with the API enabled and an OAuth client of your own. That suits a developer
on one laptop. Camberstack runs that part for you: one Google sign-in, and it works the same in Claude on the web, on your phone, and
in ChatGPT. The same connection reads <a href="/google-analytics-mcp">Google Analytics 4</a> and your Google Ads conversions, the
other two ends of the same tracking.</p>

<h2>Questions</h2>
<h3>What does it cost?</h3>
<p>${serviceCost("Tag Manager")}</p>
<h3>Which Tag Manager permission do I need?</h3>
<p>Read access to a container is enough to check it. Adding, pausing or deleting tags needs Edit, and publishing needs Publish.
Creating or deleting a container needs administrator access to the Tag Manager account.</p>
<h3>Can I try it first?</h3>
<p>Yes. Ask for the demo container, a sample plumbing business's tags with the three problems above. Changes there change only the demo.</p>
<h3>Do you store my container?</h3>
<p>Only what's needed to show and undo the changes you approve, such as a tag you deleted, so it can be put back. Your container's
tags and triggers are read when your AI asks and aren't kept. Details in the <a href="/privacy">privacy policy</a>.</p>
`)}
${closer("Ask your AI whether your conversion tracking is right.", "Free.",
  `<a class="btn btn-lg" href="/#setup">Connect Tag Manager</a><a class="btn btn-lg btn-ghost" href="/tools#tag_manager_containers">See the tools</a>`)}
`,
  });
}

/**
 * Use-case page for "google analytics mcp" (720/mo, 320 → 1,000 over the year to 2026-09), "ga4 mcp" (170) and "google
 * analytics mcp server" (170): low competition, $5–41 top-of-page bid (Keyword Planner via the dev connector, 2026-11-06;
 * scripts/seo/audits/camberstack.md). The GA4 tools need no Google Ads account (tools.ts gates them on Analytics only).
 * The hero's numbers are the demo property's (ga4.ts DemoAnalytics, analytics_landing_pages, Paid Search, 30 days).
 * Google's own server: github.com/googleanalytics/google-analytics-mcp, read 2026-11-06 (local pipx/ADC, or self-hosted on
 * Cloud Run; writes only annotations, custom dimensions and key events, behind --allow-write).
 */
export function analyticsPage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-analytics-mcp", wide: true,
    title: "Google Analytics MCP server (GA4), hosted | Camberstack",
    description: "A hosted Google Analytics 4 MCP server for Claude, ChatGPT and Cursor. Sign in with Google: no Cloud project, credentials file or pipx. Landing pages, any GA4 report, key events and Google Ads links, changed only with your approval.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Google Analytics MCP server", url: `${baseUrl}/google-analytics-mcp`, dateModified: "2026-11-06",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "GA4, no Google Ads account needed",
  title: "Google Analytics MCP server",
  lede: `Ask your AI assistant which pages turn visitors into leads, and it reads your Google Analytics 4 property to answer:
sessions, engagement and key events by landing page, channel, campaign or device. It can also fix the setup behind those numbers,
such as marking a key event or linking Google Ads, only when you approve. Camberstack is hosted, so setup is a Google sign-in.`,
  ctas: `<a class="btn btn-lg" href="#setup">Connect Google Analytics</a><a class="btn btn-lg btn-ghost" href="/tools#analytics_properties">See the tools</a>`,
  aside: `<figure class="window" aria-label="An example answer, from the demo property">
<div class="window-bar"><i></i><i></i><i></i><span>Demo property · Northwind Plumbing</span></div>
<div class="window-body">
<p class="said you">Which landing pages convert my Google Ads clicks?</p>
<p class="ai">Paid Search over the last 30 days, by landing page:</p>
<table class="mini"><tr><th>Landing page</th><th>Sessions</th><th>Key event rate</th></tr>
<tr><td>/</td><td>538</td><td>3.9%</td></tr>
<tr><td>/emergency-plumber</td><td>348</td><td>8.1%</td></tr>
<tr><td>/water-heater-repair</td><td>237</td><td>8.0%</td></tr>
<tr><td>/contact</td><td>127</td><td>11.0%</td></tr></table>
<p class="ai">Your home page gets the most ad clicks but converts at half the rate of the service pages. Want me to check which campaigns send traffic there?</p>
</div>
</figure>`,
})}
${guideBody(`
<h2>Questions it answers</h2>
${pairList([
  [`<em>"Which landing pages turn ad clicks into leads?"</em>`, "Sessions, users, engagement rate, key events and key event rate per landing page, for all traffic or one channel such as Paid Search or Organic Search"],
  [`<em>"How did paid traffic compare with organic last month?"</em>`, "Any GA4 report by dimension and metric: channel, source and medium, campaign, page, device, country, event, revenue"],
  [`<em>"Is my GA4 set up right for Google Ads?"</em>`, "Each property's web streams and measurement IDs, which events count as key events, and which Google Ads accounts it's linked to"],
  [`<em>"Which of my campaigns bring visitors who never convert?"</em>`, "GA4 sessions by Google Ads campaign next to the campaign's spend in Google Ads (needs a Google Ads account)"],
], "Reads")}
<p>Answers come from the Google Analytics Data API, so they match GA4's own reports, with its limits: today's data is still
processing, and very large reports can be sampled or group rare values into <code>(other)</code>.</p>

<h2>Setup changes it can make</h2>
<p>Ask for a change and your AI shows you a proposal first. Nothing changes until you approve it, and every change can be undone.</p>
${pairList([
  ["Create a GA4 property with a web stream for your site (the result gives the measurement ID and the tag to add)", "Moves the property to Google Analytics' trash, restorable there for 35 days"],
  ["Mark or unmark an event as a key event, such as <code>generate_lead</code> or <code>purchase</code>", "Restores the previous setting"],
  ["Count a key event once per event or once per session; a Google Ads conversion imported from it follows", "Restores the previous counting"],
  ["Link or unlink a Google Ads account, so Ads can import key events and GA4 shows ad clicks and cost", "Restores the previous link"],
], "Undo")}
<p>With Google Ads connected too, your AI can then import a key event into Google Ads as a conversion action, in the same kind of
proposal. That is the usual fix when Google Ads reports no conversions while GA4 shows leads.</p>

<h2>Key events and Google Ads</h2>
<p>A key event is what GA4 now calls a conversion. Google Ads can only bid on a GA4 key event if three things hold: the event is
marked as a key event, the property is linked to the Google Ads account, and the event is imported there as a conversion action.
Ask <em>"Why doesn't Google Ads see my GA4 conversions?"</em> and your AI checks each step and proposes the missing one. Linking needs
you to be an admin of both the property and the Google Ads account.</p>

<h2 id="setup">Set it up</h2>
<p>Connect Camberstack in your AI app (<a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, or any MCP
client with <code>${mcpUrl}</code>). On Google's sign-in screen, leave the <strong>Google Analytics</strong> box ticked, then ask
<em>"List my Google Analytics properties"</em> and use a property from that list. Already connected without it? The first time you
ask, Camberstack gives you a link that adds it to the same Google account, with no reconnecting.</p>
<p>Google's screen also asks for Google Ads access, because Camberstack is a Google Ads tool too. You don't need a Google Ads account
to use the Google Analytics tools: every one of them works on your real properties without it.</p>

<h2>Compared with Google's own</h2>
<p>Google publishes an open-source Google Analytics MCP server. You run it yourself, on your machine with Python and
<code>pipx</code>, or deployed to your own Cloud Run: it needs a Google Cloud project with the Analytics Admin and Data APIs
enabled, and your own OAuth client or credentials. It reads reports, and can create key events, custom dimensions and annotations once
you turn writes on. That suits a developer on one laptop. Camberstack is hosted, so you only sign in with Google, it works the
same in Claude on the web, on your phone and in ChatGPT, and every change is a proposal you approve, with undo. It also reads
your Google Ads, <a href="/google-search-console-mcp">Search Console</a>, <a href="/google-merchant-center-mcp">Merchant Center</a> and <a href="/google-tag-manager-mcp">Tag Manager</a>
through the same connection.</p>

<h2>Questions</h2>
<h3>What does it cost?</h3>
<p>${serviceCost("Google Analytics")}</p>
<h3>Which Google Analytics permission do I need?</h3>
<p>Viewer access to a property is enough to read it. Marking key events needs Marketer or Editor; linking Google Ads needs admin
access to both. Only the properties your Google login can see are listed.</p>
<h3>Can I try it first?</h3>
<p>Yes. Ask for the demo property, a sample plumbing business with six landing pages and five channels. Changes there change only the demo.</p>
<h3>Do you store my analytics data?</h3>
<p>No. Camberstack fetches reports when your AI asks and passes them on; they aren't kept. Only the setup changes you approve are
stored, so they can be shown and undone. Details in the <a href="/privacy">privacy policy</a>.</p>
`)}
${closer("Ask your AI which pages turn visitors into customers.", "Free.",
  `<a class="btn btn-lg" href="/#setup">Connect Google Analytics</a><a class="btn btn-lg btn-ghost" href="/tools#analytics_properties">See the tools</a>`)}
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
    baseUrl, path: "/google-ads-gemini", noindex: true, wide: true,
    title: "Connect Google Ads to Gemini: custom app (MCP) setup | Camberstack",
    description: "Connect your Google Ads account to Google Gemini as a custom app. No developer token or Google Cloud project: add one URL, sign in with Google, then ask Gemini about your account.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to Gemini", url: `${baseUrl}/google-ads-gemini`, dateModified: "2026-10-02",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
${guideHero({
  kicker: "Google AI Pro or Ultra, in the US",
  title: "Connect Google Ads to Gemini",
  lede: `Gemini can read your Google Ads account, answer questions about it,
and make the changes you approve. You add Camberstack as a custom app with one URL, then sign in with Google.
No developer token, no Google Cloud project.`,
  ctas: `<a class="btn btn-lg" href="/google-ads-claude">Use Claude instead</a><a class="btn btn-lg btn-ghost" href="/google-ads-chatgpt">Or ChatGPT</a>`,
  note: `<div class="warn"><p><strong>Not working yet.</strong> Gemini accepts Camberstack and you can sign in, but Gemini then stops
before finishing the connection, with "Cannot Complete Request". We've reported it to Google. Until it's fixed, use
<a href="/google-ads-claude">Claude</a> or <a href="/google-ads-chatgpt">ChatGPT</a>. The steps below are kept for when it works.</p></div>`,
})}
${guideBody(`
<h2>Before you start</h2>
<p>Google only offers custom apps in Gemini when all of these are true. If the <strong>Custom apps</strong> option is missing, one of them is why.</p>
<ul class="checks">
<li><strong>A personal Google account.</strong> Work and school (Google Workspace) accounts don't get custom apps.</li>
<li><strong>Google AI Pro or Ultra</strong>, the plans that include Gemini Spark.</li>
<li><strong>18 or over, in the US,</strong> with Gemini set to English.</li>
<li><strong>Keep Activity turned on</strong> in Gemini's activity settings. Custom apps are switched off without it.</li>
</ul>

<h2>Set it up</h2>
<ol class="steps">
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
a specific proposal, every applied change can be undone apart from deletions Google can't reverse, which are flagged before you approve.</p>
<h3>Isn't Gemini already connected to my Google account?</h3>
<p>Gemini's built-in Google apps don't include Google Ads. Camberstack adds it, with its own Google sign-in limited to Google Ads and your email address.</p>
${commonQuestions("Gemini")}

<p class="muted">Also works in <a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, Cursor and other MCP apps: see <a href="/#setup">all setup options</a>.</p>
`)}
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
Search Console, Google Analytics 4, Merchant Center and Tag Manager. The AI reads the account and proposes changes. Nothing changes until you approve a specific proposal, and applied changes can be undone, apart from deletions Google can't reverse, which are flagged first.</p>
<ul>
<li><a href="#connect">Connect</a></li>
<li><a href="#how-it-works">How it works: read, propose, approve, apply, undo</a></li>
<li><a href="#building">Building campaigns: Search, Performance Max, Display, YouTube</a></li>
<li><a href="#search-console">Search Console</a></li>
<li><a href="#analytics">Google Analytics 4</a></li>
<li><a href="#merchant-center">Merchant Center</a></li>
<li><a href="#tag-manager">Tag Manager</a></li>
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
<p>Add it from <a href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866">Camberstack's page in ChatGPT's plugin directory</a>, then type <strong>@Camberstack</strong> in a chat.
You don't need the URL above. <a href="/google-ads-chatgpt">Setup guide</a>.</p>
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
<li><strong>See what it did.</strong> From 7 days after a change, <code>change_results</code> compares equal windows before and after it, from Google's own numbers:
what the searches your negatives block cost, what a paused keyword or campaign spent and how the rest of its campaign did, a campaign before and after a budget
or bid strategy change, and what new campaigns, ad groups and keywords have done since. If the campaign was paused or its budget or bidding changed in the meantime, the result says so. Before vs after, not proof of cause.</li>
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
<p>If you leave the Search Console box ticked when you sign in, your AI can read your sites' search data: totals against the previous
period, queries and pages, rising and falling queries, near-page-1 opportunities, index status for given URLs, sitemap status, and
searches you pay for that already rank organically. It can also submit, resubmit or remove sitemaps and add or remove properties, through
proposals you approve (<code>propose_search_console_changes</code>). If you connected before this existed, your first change gives you a link that adds it.
Camberstack can't request indexing or verify a property; you do those in Search Console.
<a href="/google-search-console-mcp">More on the Search Console tools</a>.</p>

<h2 id="analytics">Google Analytics 4</h2>
<p>With the Google Analytics box ticked, your AI can read your GA4 properties: landing pages with engagement and key events, for all
traffic or one channel, any report by dimension and metric, and each property's streams, key events and Google Ads links. Through
proposals you approve (<code>propose_analytics_changes</code>) it can create a property, mark or unmark key events and link Google Ads.
None of it needs a Google Ads account. <a href="/google-analytics-mcp">More on the Google Analytics tools</a>.</p>

<h2 id="merchant-center">Merchant Center</h2>
<p>With the Merchant Center box ticked, your AI can see why products are disapproved or limited, what they earned in Shopping ads, and
fix prices, GTINs and titles through overrides you approve. <a href="/google-merchant-center-mcp">More on the Merchant Center tools</a>.</p>

<h2 id="tag-manager">Tag Manager</h2>
<p>With Tag Manager ticked, your AI can list your web containers and check one: every tag, what it sends and when it fires, what isn't
published yet, and conversion tracking problems such as a Google Ads conversion tag firing on every page or no Conversion Linker.
Through proposals you approve (<code>propose_tag_manager_changes</code>) it can add a Google tag, Google Ads conversion tag, GA4 event tag or
Conversion Linker, pause, unpause or delete tags, create or delete a container, and publish. Tag changes reach the site only when a publish
you approve runs. <a href="/google-tag-manager-mcp">More on the Tag Manager tools</a>.</p>

<h2 id="demo">Demo account</h2>
<p>Account <code>000-000-0001</code> is a sample plumbing business with six months of campaigns and search terms. Every tool works on it,
changes there never reach Google, and it doesn't count toward your plan. Ask <em>"Show me Camberstack's demo account"</em>.</p>

<h2 id="plans">Plans and limits</h2>
<table><tr><th>Plan</th><th>Covers</th></tr>
<tr><td>Free</td><td>Every tool, ${freeChanges()}, on 1 Google Ads account. No card.</td></tr>
${!capOn() ? "" : `<tr><td>Plus, ${PLUS_PRICE_LABEL}</td><td>Unlimited applied changes, on 1 Google Ads account. Cancel any time.</td></tr>
`}<tr><td>Pro, ${PRO_PRICE_LABEL}</td><td>${(capOn() ? "Unlimited applied changes" : "The same")}, on up to ${PRO_ACCOUNTS} Google Ads accounts. Cancel any time.</td></tr>
<tr><td>Agency, ${AGENCY_PRICE_LABEL}</td><td>${(capOn() ? "Unlimited applied changes" : "The same")}, on up to ${AGENCY_ACCOUNTS} Google Ads accounts. Cancel any time; switching from Pro is prorated.</td></tr></table>
<p>An account counts when you use Camberstack on it; it stops counting ${ACCOUNT_WINDOW_DAYS} days after its last use. Manager (MCC) accounts and the demo don't count.
Using one more account than your plan covers returns a <code>plan_limit</code> error listing the accounts in use, when one frees up, and, on Free,
a personal upgrade link valid for 7 days.${changeCap() ? ` On Free, applying a proposal once ${changeCap()} have been applied in the last ${ACCOUNT_WINDOW_DAYS} days
returns a <code>change_limit</code> result with the date the next one opens; nothing is applied and the proposal stays open. A proposal counts once
however many edits it holds, and undo, the demo and a Tag Manager publish on its own don't count.` : ""} Undo, change history and billing are never limited. Ask <em>"What plan am I on?"</em> to see your usage.</p>

<h2 id="access">Google API access and your data</h2>
<p>Camberstack accesses the Google Ads API under its own approved API access, with the user's Google OAuth consent. Search Console, Google Analytics,
Merchant Center and Tag Manager are reached through their own Google APIs under the same consent, each with its own scope (listed in the <a href="/privacy">privacy policy</a>). Camberstack is independent and not affiliated with Google.</p>
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
<li><strong>Your Google Ads data, optional</strong> (the <code>https://www.googleapis.com/auth/adwords</code> scope): account and campaign structure, performance metrics, search terms, keywords and conversion settings, read when your AI assistant calls a Camberstack tool.</li>
<li><strong>Your Search Console data and sitemaps, optional</strong> (the <code>https://www.googleapis.com/auth/webmasters</code> scope; a connection made before 2026-10-31 may hold <code>https://www.googleapis.com/auth/webmasters.readonly</code> instead): the websites you have verified, their Google Search clicks, impressions, queries and positions, Google's index status for pages you ask about, and the sitemaps you have submitted, read when your AI assistant calls a Search Console tool, for example to compare what you pay for with where you already rank. Google Ads and Search Console are each optional: you can untick either on Google's consent screen and add it later through a link Camberstack gives you. With the same scope, Camberstack submits, resubmits and removes sitemaps and adds and removes properties, each only when you approve a specific proposal. We keep what we need to show and reverse each change (the sitemap or property, and the proposal), as for any other change.</li>
<li><strong>Your Google Analytics data and setup, optional</strong> (the <code>https://www.googleapis.com/auth/analytics.readonly</code> and <code>https://www.googleapis.com/auth/analytics.edit</code> scopes): the names of the Google Analytics accounts and properties you can access; reports on your properties' traffic, such as sessions, users, engagement, key events (conversions), landing pages and traffic sources; and each property's setup (web streams and their measurement IDs, key events, Google Ads links), read when your AI assistant calls a Google Analytics tool, for example to see whether visitors from your ads convert. With edit access Camberstack can set up tracking for you, <strong>only</strong> when you approve a specific proposal: create a property with a web stream, mark or unmark an event as a key event, and link or unlink a Google Ads account. Every such change is logged and can be undone. Google Analytics is optional: both scopes come as one box on Google's consent screen, which you can untick and add later through a link Camberstack gives you.</li>
<li><strong>Your Google Merchant Center data and products, optional</strong> (the <code>https://www.googleapis.com/auth/content</code> scope): the names of the Merchant Center accounts you can access; account-level issues; your products' status (eligible, limited, pending or disapproved) and the issues Google reports for each, with product IDs, titles, brands and prices; and reports on your products' Google Shopping and free-listing clicks and impressions, read when your AI assistant calls a Merchant Center tool, for example to find why products stopped showing. Camberstack can also change products for you, <strong>only</strong> when you approve a specific proposal: override a product's attributes (such as its price, GTIN or title), exclude it from Shopping ads or free listings, or create, change and delete products of its own. Overrides go through Camberstack's own supplemental data source in your account, which it creates and, the first time, places ahead of the product's feed in that feed's rules; products it creates live in its own data source, "Camberstack products". Your feed and its products are never edited, added or deleted. Every change is logged and can be undone: undoing an override lets your feed's values apply again, and undoing a deletion re-creates the product. Merchant Center is optional: it is a box on Google's consent screen, which you can untick and add later through a link Camberstack gives you.</li>
<li><strong>Your Google Tag Manager containers, optional</strong> (the <code>https://www.googleapis.com/auth/tagmanager.edit.containers</code>, <code>https://www.googleapis.com/auth/tagmanager.edit.containerversions</code>, <code>https://www.googleapis.com/auth/tagmanager.publish</code> and <code>https://www.googleapis.com/auth/tagmanager.delete.containers</code> scopes): the names of the Tag Manager accounts and web containers you can access, and a container's tags, triggers, workspace and versions (which tags exist, what each sends where, such as a Google Ads conversion ID or a GA4 measurement ID, and when each fires), read when your AI assistant calls a Tag Manager tool, for example to check your conversion tracking. Camberstack can also change a container for you, <strong>only</strong> when you approve a specific proposal: add a Google tag, a Google Ads conversion tag, a GA4 event tag or a Conversion Linker with the trigger it needs; pause, unpause or delete a tag; create a version of the workspace and publish it to your site; and create or delete a container. Every change is logged and can be undone, except deleting a container, which Google can't reverse and which the proposal warns about first. Tag Manager is optional: it is on Google's consent screen, which you can untick and add later through a link Camberstack gives you.</li>
</ul>
<p>We request nothing else from your Google account: no Gmail, Drive, contacts or calendar.</p>

<h2>How we use it</h2>
<ul>
<li>To answer the requests your AI assistant makes on your behalf (reports and read-only queries).</li>
<li>To apply changes to your Google Ads account, your Search Console sitemaps and properties, your Google Analytics setup, your Merchant Center products or your Tag Manager containers, <strong>only</strong> when you approve a specific proposal, and to reverse them if you ask.</li>
</ul>
<p>We do not sell your data, use it for advertising, share it with data brokers, or use it to train AI or machine-learning models.
Humans at Camberstack do not read your Google data unless you ask us to for support, it is needed for security or abuse investigation, or the law requires it.</p>

<h2>Google API Services: Limited Use</h2>
<p>Camberstack's use and transfer of information received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>What we store</h2>
<table>
<tr><th>Data</th><th>Why</th><th>Kept until</th></tr>
<tr><td>Google email and account ID</td><td>Identify you across connections</td><td>You ask us to delete it, or two years without use (not while on a paid plan)</td></tr>
<tr><td>How many Google Ads accounts your login can reach, how many of them had ad spend in the last 30 days, and which manager accounts they sit under (counts and IDs only, never names, amounts or other account data)</td><td>Show which accounts are active when you pick one, and size plans to how many accounts people use</td><td>The same as your email and account ID</td></tr>
<tr><td>Google refresh token, encrypted (AES-256-GCM)</td><td>Call Google's APIs (Google Ads, and Search Console, Google Analytics, Merchant Center or Tag Manager if you granted them) when you use a tool</td><td>You disconnect or revoke access, or six months without use</td></tr>
<tr><td>A sign-in session for the account page (a cookie; we store only its hash)</td><td>Keep you signed in to camberstack.io/account</td><td>7 days, or until you sign out</td></tr>
<tr><td>A random value in a cookie while you connect an AI app</td><td>Check that the browser finishing the Google sign-in is the one that approved the connection</td><td>The sign-in finishes, or 1 hour</td></tr>
<tr><td>A random value in a cookie while you add a Google service (Google Ads, Search Console, Google Analytics, Merchant Center or Tag Manager) to your connection</td><td>Check that the browser finishing Google's consent is the one that opened your link</td><td>The consent finishes, or 10 minutes</td></tr>
<tr><td>Tokens we issue to your AI app (stored as hashes)</td><td>Authenticate your AI app</td><td>Expiry (1 hour access, 90 days refresh) or disconnect</td></tr>
<tr><td>Proposals: the changes requested, their summary and results, and for a Tag Manager tag you delete, a copy of that tag's settings</td><td>Show what changed and let you undo it</td><td>You ask us to delete them, or two years without use (not while on a paid plan)</td></tr>
<tr><td>Merchant Center product changes you approve: the values you set for a product, and for products you create through Camberstack, their details (such as title, price and link)</td><td>Google can't return these, so we keep them to show what's in place and to undo a change</td><td>You remove the change or the product, ask us to delete them, or two years without use (not while on a paid plan)</td></tr>
<tr><td>Feedback you send from camberstack.io/feedback, or through your AI app with <code>send_feedback</code>: your message, what it's about, and your Google email. Your AI app sends only the message you approve, not your conversation</td><td>Read it and reply to you</td><td>You ask us to delete it</td></tr>
<tr><td>A sign-in session for the feedback page (a cookie; we store only its hash)</td><td>Know who a message is from, so we can reply and keep spam out</td><td>1 day, or until you sign out</td></tr>
<tr><td>A usage log: which tool ran, for which Google Ads account ID, when, how long it took and any error message. For a custom Google Ads query, which fields and resources it asked for, with every value in it (names, keywords, IDs, dates) removed. Never the tool's other inputs, or any results</td><td>Find and fix failures, see which features are used, and count how many Google Ads accounts you use for your plan</td><td>You ask us to delete it, or two years without use (not while on a paid plan)</td></tr>
</table>
<p>Reports, search-term lists, query results, Google Analytics reports, Merchant Center product statuses and reports, and Tag Manager containers' tags and triggers are computed on request and returned to your AI assistant. We do not store them.
When a proposed ad uses an image URL, we download that image only to upload it to your Google Ads account as an image asset; we do not keep the file.
Web server and application logs (IP address, time, path, errors) are kept for up to 90 days for security and then deleted.
When the server hits a bug, the error and where in the code it happened go to an error tracker we host ourselves; no request contents, cookies or tokens are sent with it.</p>

<h2 id="retention">Data retention and deletion</h2>
<p>We keep Google user data only as long as we need it to run Camberstack for you. The table above gives the period for each item we store; Google data we read for you and don't list there is not retained.</p>
<ul>
<li><strong>When you stop using Camberstack:</strong> "without use" means no tool call from your AI app and no new connection. After six months of it we revoke and delete your Google token (Google stops honoring an unused one after six months anyway); connect again to carry on. After two years we delete your account, proposals and usage log.</li>
<li><strong>When you disconnect:</strong> the <code>disconnect</code> tool revokes our access at Google and immediately deletes your Google token and every token we issued to your AI app. If you remove Camberstack at Google instead, the token stops working at once and we delete it the next time it is tried, or after six months at the latest. Your account and change history stay until you ask us to delete them.</li>
<li><strong>When you ask us to delete your data:</strong> email <a href="mailto:${CONTACT}">${CONTACT}</a> from your Google account's address and within 30 days we delete your Google token, account, proposals, Merchant Center product changes, usage log and feedback.</li>
<li><strong>Backups:</strong> daily backups of our database hold the stored items above. They are used only to recover from a failure and expire after 35 days at most, so data you delete leaves them within 35 days of its deletion. A Google token in a backup stays encrypted, and stops working once revoked.</li>
</ul>

<h2>Who else handles your data</h2>
<ul>
<li><strong>Your AI app.</strong> Tool results go to the AI app you connected (for example Claude or ChatGPT). How that provider handles the conversation is governed by its own privacy policy.</li>
<li><strong>Service providers.</strong> Resend delivers our emails, so it receives your email address. Stripe handles payments if you upgrade, so it receives your email address and keeps payment records under its own policy. Cloudflare R2 stores an encrypted-at-rest copy of our backups. They receive this only to provide these services to us.</li>
</ul>
<p>We do not transfer your Google data to anyone else unless you ask us to or the law requires it.</p>

<h2>Where it runs</h2>
<p>Camberstack runs on infrastructure we operate in the United States, with the off-site backup copy on Cloudflare R2. We use no third-party analytics on your Google data.</p>

<h2>Emails</h2>
<p>We may send you a few short emails about using Camberstack: a welcome when you connect, a note if you connect but don't try it within a
couple of days, a note asking how it went after your first applied change, one if you try Camberstack on more Google Ads accounts or more
Google services than the Free plan covers, and a confirmation if you upgrade. Each is sent once. We may also send occasional one-time announcements
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
None of your Google Ads, Search Console, Google Analytics, Merchant Center or Tag Manager data that Camberstack reads for you is ever sent to either analytics tool.</p>

<h2>Your choices</h2>
<ul>
<li><strong>Disconnect:</strong> ask your AI to run the <code>disconnect</code> tool, or remove Camberstack at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Either stops all access; the tool also deletes the stored token.</li>
<li><strong>Delete everything:</strong> email <a href="mailto:${CONTACT}">${CONTACT}</a> from your Google account's address and within 30 days we delete your Google token, account, proposals, Merchant Center product changes, usage log and feedback (see <a href="#retention">Data retention and deletion</a>).</li>
</ul>

<h2>Data protection</h2>
<p>We protect your Google user data and other sensitive data, including Google tokens, account details and your change history, with these measures:</p>
<ul>
<li><strong>Encryption in transit:</strong> all traffic between your AI app or browser, Camberstack and Google uses HTTPS (TLS 1.2 or newer). Plain HTTP requests are redirected to HTTPS.</li>
<li><strong>Encryption of credentials at rest:</strong> Google refresh tokens are encrypted with AES-256-GCM, using a key kept outside the database. Tokens we issue and sign-in sessions are stored only as SHA-256 hashes, so a copy of the database alone can't be used to reach Google or to sign in.</li>
<li><strong>Keeping as little as possible:</strong> reports and query results pass through and are not stored, and the usage log leaves out tool results and the values in your queries.</li>
<li><strong>Access control:</strong> only Camberstack's operator can sign in to the server, the database and the backups. Each person's data is tied to their own Google account, and the service acts only on the accounts that Google account can reach.</li>
<li><strong>Isolation:</strong> the application runs as an unprivileged user in its own container, and is not exposed to the internet directly: requests reach it only through a rate-limited HTTPS proxy.</li>
<li><strong>Protected backups:</strong> backups are checked for integrity after every run. The encryption key is backed up separately, itself encrypted to a private key that is not on the server, and the off-site copy sits in a locked bucket that the server can't alter or delete.</li>
<li><strong>Safeguards on changes:</strong> changes are validated with Google before you approve them, are limited to the operations listed on the homepage, and are logged so they can be undone, apart from the few Google can't reverse, which warn you first.</li>
</ul>

<h2>Children</h2>
<p>Camberstack is a business tool and not directed at anyone under 18.</p>

<h2>Changes and contact</h2>
<p>We will post changes here and update the date above. Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
</div>`,
  });
}

/**
 * What each plan includes, as facts only: no upgrade buttons and no checkout links. The one plans page a ChatGPT connection
 * may link to (its guidelines allow "an informational page describing available plans", not a page that "explicitly
 * initiates the process to upgrade"; the homepage #pricing has upgrade buttons). Follows the change cap (FREE_CHANGE_CAP).
 */
export function plansPage(baseUrl: string): string {
  const free = `<p>Every tool, with ${freeChanges()} and undo, on <strong>1 Google Ads account</strong> at a time; another opens
once it has gone ${ACCOUNT_WINDOW_DAYS} days unused. Search Console, Google Analytics and Tag Manager are included and don't use up the Google Ads account${capOn() ? "; their applied changes count toward the same allowance" : ""}. Merchant Center is included too, on 1 Merchant Center account.</p>`;
  const all = paidCovers();
  return layout({
    baseUrl, path: "/plans",
    title: "Plans | Camberstack",
    description: "What each of Camberstack's plans includes.",
    body: `<div class="legal">
<h1>Plans</h1>
<h2>Free · $0</h2>
${free}
${!capOn() ? "" : `<h2>Plus · ${PLUS_PRICE_LABEL}</h2>
<p>Unlimited applied changes, on <strong>1 Google Ads account</strong>. Cancel any time.</p>
`}<h2>Pro · ${PRO_PRICE_LABEL}</h2>
<p>${all} <strong>up to ${PRO_ACCOUNTS} Google Ads accounts</strong>. Cancel any time.</p>
<h2>Agency · ${AGENCY_PRICE_LABEL}</h2>
<p>${all} <strong>up to ${AGENCY_ACCOUNTS} Google Ads accounts</strong>. Cancel any time.</p>
<h2>On every plan</h2>
<p>Nothing changes until you approve the proposal, applied changes can be undone apart from the few Google can't reverse, which warn you first, and undo and change history always
work. Plans count Google Ads accounts used in the last ${ACCOUNT_WINDOW_DAYS} days; manager (MCC) accounts and the demo account never count.</p>
<p class="muted">Your current plan is on your account page at camberstack.io/account.</p>
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
${listedServices().includes("merchant")
    ? `If you add them to your connection, it can also read your Search Console data, your Merchant Center data,
your Google Analytics data and your Tag Manager containers, and change your Search Console sitemaps and properties, your Google Analytics setup,
your Merchant Center products and your Tag Manager containers (including publishing them to your website) when you approve a specific proposal.`
    : `If you add them to your connection, it can also read your Search Console data and your Google Analytics data, and change your Search Console sitemaps and properties and your Google Analytics setup when you approve a specific proposal.`}
There is a free plan and paid plans, described at <a href="/#pricing">camberstack.io/#pricing</a>.</p>
<h2>Paid subscriptions</h2>
<p>Paid plans are billed monthly in advance through Stripe until you cancel. You can cancel any time from the billing link the <code>billing</code> tool gives you; your plan continues until the end of the period you paid for, and we don't refund partial months. Switching between Pro and Agency takes effect right away, and Stripe prorates the difference. If we change the price we will email you at least 30 days before it applies to you.</p>
<h2>You stay in control, and responsible</h2>
<p>Recommendations are generated from your account data and may be wrong. You decide what to approve, and you are responsible
for changes you approve, for your Google Ads spend, and for the tracking and consent on any website you measure with Google Analytics or tag through Tag Manager. Review proposals before approving them.</p>
<h2>Acceptable use</h2>
<p>Use Camberstack only on Google Ads accounts, Search Console sites${listedServices().includes("merchant") ? ", Google Analytics properties, Merchant Center accounts and Tag Manager containers" : " and Google Analytics properties"} you are authorized to manage, and in line with Google's policies. Don't attempt to access other users' data or overload the service.</p>
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
<p>Camberstack connects your Google Ads account, and optionally Search Console, Google Analytics 4, Merchant Center and Tag Manager, to an AI assistant such as Claude or ChatGPT. It reads your data, and it changes your account only when you approve a specific proposal. <a href="/tools">The tools page</a> lists everything it can do.</p>
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
export function consentPage(o: { id: string; clientName: string; redirectHost: string; known: boolean }): string {
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
.consent .services{font-size:15px;text-align:left}
.consent .btn{width:100%;border:0;cursor:pointer;font-size:16px}.consent .linkish{margin-top:14px;color:var(--muted)}
</style></head><body>
<main class="card consent">
<img src="/favicon.svg" alt="Camberstack" width="40" height="40">
<h1>Connect ${esc(o.clientName || "this app")} to Camberstack?</h1>
<p class="muted">You'll return to <strong>${host}</strong> after signing in with Google.</p>
<p class="services">Google then asks which services to share: <strong>${servicesAnd()}</strong>.
Every one is optional. Untick any you don't use; if you ask about it later, Camberstack gives you a link that adds it.</p>
${o.known ? "" : `<p class="warn"><strong>Unrecognized address.</strong> If someone sent you this link, cancel: ${host} would get access to the Google services you share.</p>\n`}<form method="post" action="/oauth/consent">
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
  return { cls: "prep", label: "Changes nothing in Google" };
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
<p><span class="pill ro">Read-only</span> tools never change anything. <span class="pill prep">Changes nothing in Google</span>
tools prepare or manage proposals. Only <code>apply_changes</code> changes anything in ${esc(servicesOr())}, and only after you approve a specific proposal.
<code>disconnect</code> asks you to confirm before it revokes access.</p>
${cards}
<p class="muted">You don't call these yourself: ask your AI in plain English and it picks the tools. <a href="/#setup">Connect Camberstack</a>.</p>`,
  });
}

export function robotsTxt(baseUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /oauth/\nDisallow: /authorize\nDisallow: /token\nDisallow: /register\nDisallow: /account\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

/** The indexable pages, in sitemap order. */
export const SITEMAP_PATHS = ["/", "/docs", "/google-ads-claude", "/google-ads-chatgpt", "/google-search-console-mcp", "/google-analytics-mcp", "/google-merchant-center-mcp", "/google-tag-manager-mcp", "/tools", "/changelog", "/about", "/privacy", "/terms"];

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
- Writes (each one proposed, approved, then applied; almost all can be undone, and the few Google can't reverse warn first): negative keywords on campaigns and ad groups, and shared negative lists; pause/enable campaign, ad group, keyword or ad; daily budget; end date; build a Search, Display, Demand Gen (YouTube video) or Performance Max campaign (created paused); add ad groups, keywords, ads; edit a responsive search ad in place; delete keywords, ads, ad groups, campaigns, negatives and sitelinks; sitelinks, callouts, structured snippets, business name, logos and images; bids; bid strategy; ad schedules and device bids; location/language targeting; URL suffix; AI Max and Google-written text; conversion actions, goals, value, window and attribution; remarketing lists; apply or dismiss Google's recommendations.
- Search Console (optional): site totals, query/page performance, period-over-period trends, ranking opportunities, URL Inspection (index status), sitemap status, and paid vs organic overlap with the Ads account; approved changes submit or remove sitemaps and add or remove properties.
- Google Analytics 4 (optional): landing pages with engagement and key events by channel, any GA4 report, each property's streams, key events and Google Ads links; approved changes create a property, mark or unmark key events, and link or unlink Google Ads.
- Merchant Center (optional): account and product issues, Shopping and free-listing reports, disapproved products joined with their ad spend; approved changes override product attributes (price, GTIN, title, …) through Camberstack's own supplemental source, exclude or include products, add Camberstack's own products, and link Merchant Center to Google Ads. The feed itself is never edited.
- Tag Manager (optional): web containers, each container's tags and triggers with tracking problems (Ads conversion tag on every page, no Conversion Linker, tags that never fire, Universal Analytics), and what's unpublished; approved changes add a Google tag, Google Ads conversion tag, GA4 event tag or Conversion Linker, pause, unpause or delete tags, create or delete a container, and publish.
- Demo: account 000-000-0001 is a sample business (sample data) anyone can try every tool on; changes there never touch Google. Logins with no Google Ads access get it automatically.
- Pricing: ${`Free plan covers 1 Google Ads account (every tool, ${freeChanges()}).${capOn() ? ` Plus ${PLUS_PRICE_LABEL} has unlimited applied changes on 1 Google Ads account.` : ""}`} Pro ${PRO_PRICE_LABEL} covers up to ${PRO_ACCOUNTS}; Agency ${AGENCY_PRICE_LABEL} up to ${AGENCY_ACCOUNTS}. Accounts are counted as those used in the last ${ACCOUNT_WINDOW_DAYS} days, with no switching in between; manager (MCC) and demo accounts don't count. Undo is always free.
- [Documentation](${baseUrl}/docs)
- [Setup](${baseUrl}/#setup)
- [Pricing](${baseUrl}/#pricing)
- [Connect Google Ads to Claude (guide with a worked example)](${baseUrl}/google-ads-claude)
- [Connect Google Ads to ChatGPT (step-by-step guide)](${baseUrl}/google-ads-chatgpt)
- [Google Search Console MCP (works without a Google Ads account)](${baseUrl}/google-search-console-mcp)
- [Google Analytics MCP, GA4 (works without a Google Ads account)](${baseUrl}/google-analytics-mcp)
- [Google Merchant Center MCP (works without a Google Ads account)](${baseUrl}/google-merchant-center-mcp)
- [Google Tag Manager MCP (works without a Google Ads account)](${baseUrl}/google-tag-manager-mcp)
- [Every tool, with its parameters](${baseUrl}/tools)
- [Source (MIT)](${SOURCE_URL})
- [Privacy](${baseUrl}/privacy)
- [Terms](${baseUrl}/terms)
`;
}

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
