/**
 * The operator's live view of usage (report.ts), served ONLY on its own host (ADMIN_URL, e.g.
 * https://admin.camberstack.io), at its root. Google sign-in (signin.ts) allowed for ADMIN_EMAILS;
 * with ADMIN_URL or that list unset, the admin site does not exist. The main site has no /admin.
 */
import express, { type Express, type Request } from "express";
import type { DB } from "./db.js";
import type { GoogleCreds } from "./google.js";
import { SignIn } from "./signin.js";
import { startLoginAs } from "./account.js";
import { buildReport, permissionLabels, SCOPE_LABELS, userDetail, windowStart, type Report, type UserDetail } from "./report.js";
import { now } from "./db.js";
import { esc } from "./pages.js";
import { PRO_PRICE_LABEL } from "./plans.js";
import { SERVER_VERSION } from "./tools.js";
import { FEEDBACK_KINDS, feedbackCount, recentFeedback, type FeedbackRow } from "./feedback.js";
import { AUDIENCES, PRESETS, render as renderAnnouncement, type Announcements, type Preset, type SendState } from "./announce.js";

export interface AdminDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  /** The admin site's origin. */
  adminUrl?: string;
  adminEmails: Set<string>;
  /** PRO_EMAILS: Pro without a plan row (session.ts isPro), so the users table alone reads them as free. */
  proEmails?: Set<string>;
  /** Hidden from the numbers by default (operator + testers); the page can include them. */
  internalEmails: Set<string>;
  /** Announcement emails (announce.ts); unset = no Announcements page. */
  announcements?: Announcements;
  fetch?: typeof fetch;
}

/** Mount first: requests for the admin host never reach the public site's routes. */
export function mountAdmin(app: Express, d: AdminDeps): SignIn | null {
  if (!d.adminUrl || !d.adminEmails.size) return null;
  const host = new URL(d.adminUrl).host;
  const auth = new SignIn(d, "adm_", "cs_admin", "/", 12 * 3600, d.adminUrl);
  const email = (req: Request) => {
    const e = auth.subject(req);
    return e && d.adminEmails.has(e) ? e : null;
  };

  const site = express.Router();
  site.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  site.get("/robots.txt", (_q, r) => { r.type("text/plain").send("User-agent: *\nDisallow: /\n"); });
  site.get("/login", (_req, res) => {
    if (!d.google.clientId) { res.status(503).send("Google sign-in is not configured."); return; }
    auth.start(res);
  });
  site.get("/callback", async (req, res) => {
    const who = await auth.finish(req);
    if (!who) { res.status(400).send('Sign-in expired or was cancelled. <a href="/login">Try again</a>.'); return; }
    if (!d.adminEmails.has(who.email)) { res.status(403).send("Not an admin account."); return; }
    auth.open(res, who.email);
    res.redirect(302, "/");
  });
  site.post("/logout", (req, res) => { auth.close(req, res); res.redirect(303, d.baseUrl); });
  // Every page takes the same filters: ?days=1|7|30|90 (whole UTC days; 1 is today) and ?internal=1 (include the operator's and testers' accounts).
  const view = (req: Request) => {
    const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const all = req.query.internal === "1";
    const report = buildReport(d.db, { days, exclude: all ? [] : [...d.internalEmails] });
    for (const u of report.users) if (u.plan === "free" && d.proEmails?.has(u.email.toLowerCase())) u.plan = "pro";
    return { days, all, internal: d.internalEmails.size, report,
      feedback: feedbackCount(d.db, windowStart(days)) };
  };
  const pages: Record<string, (v: ReturnType<typeof view>) => string> = {
    "/": overviewPage, "/users": usersPage, "/activity": activityPage, "/revenue": revenuePage,
    "/feedback": (v) => feedbackPage(recentFeedback(d.db), v),
  };
  for (const [path, render] of Object.entries(pages)) {
    site.get(path, (req, res) => {
      const who = email(req);
      if (!who) { res.redirect(302, "/login"); return; }
      const v = view(req);
      if (req.query.format === "json") { res.json(v.report); return; }
      res.type("html").send(shell(path, who, v, render(v)));
    });
  }
  site.get("/users/:id", (req, res) => {
    const who = email(req);
    if (!who) { res.redirect(302, "/login"); return; }
    const u = userDetail(d.db, req.params.id);
    if (!u) { res.status(404).send("No such user."); return; }
    if (req.query.format === "json") { res.json(u); return; }
    const v = view(req);
    const heading = `<a class="muted" href="/users${qs(v)}">Users</a> <span class="dim">/</span> ${esc(u.user.email)} ${planBadge(u.user.plan, Boolean(u.user.stripe_sub))}${
      d.internalEmails.has(u.user.email.toLowerCase()) ? ` <span class="chip">internal</span>` : ""}`;
    res.type("html").send(shell("/users", who, v, userPage(u, v), heading));
  });
  const form = express.urlencoded({ extended: false, limit: "4kb" });
  // POSTs must come from this site's own pages: the cookie is SameSite=Lax, and this checks the Origin as well.
  const post = (path: string, h: (req: Request, res: express.Response, who: string) => unknown) =>
    site.post(path, form, async (req, res) => {
      const who = email(req);
      if (!who) { res.redirect(303, "/login"); return; }
      if (req.get("origin") !== new URL(d.adminUrl!).origin) { res.status(403).send("Cross-site request refused."); return; }
      try { await h(req, res, who); } catch (e) { res.status(400).send(esc((e as Error).message)); }
    });
  // "Log in as user": the user's /account page, opened as them in this browser (account.ts startLoginAs).
  post("/users/:id/login-as", (req, res, who) => {
    const id = String(req.params.id);
    if (!d.db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) { res.status(404).send("No such user."); return; }
    res.redirect(303, startLoginAs(d.db, d.baseUrl, id, who));
  });
  const ann = d.announcements;
  if (ann) {
    site.get("/announcements", (req, res) => {
      const who = email(req);
      if (!who) { res.redirect(302, "/login"); return; }
      res.type("html").send(shell("/announcements", who, view(req), announcementsPage(ann)));
    });
    site.get("/announcements/:id", (req, res) => {
      const who = email(req);
      if (!who) { res.redirect(302, "/login"); return; }
      const p = ann.preset(req.params.id);
      if (!p) { res.status(404).send("No such announcement."); return; }
      const heading = `<a class="muted" href="/announcements">Announcements</a> <span class="dim">/</span> ${esc(p.subject)}`;
      res.type("html").send(shell("/announcements", who, view(req), announcementPage(ann, p, who, String(req.query.note ?? "")), heading));
    });
    post("/announcements/:id/test", async (req, res, who) => {
      await ann.sendTest(String(req.params.id), who);
      res.redirect(303, `/announcements/${req.params.id}?note=test`);
    });
    post("/announcements/:id/send", (req, res) => {
      const p = ann.preset(String(req.params.id));
      // The count the page showed must still hold: a stale tab can't send to a different list than the one confirmed.
      if (!p || String(ann.recipients(p).length) !== (req.body as Record<string, string>).count) {
        throw new Error("The recipient list changed since the page loaded; go back, reload and check it again.");
      }
      void ann.start(p.id).catch((e) => console.error(`announcement ${p.id}: ${(e as Error).message}`));
      res.redirect(303, `/announcements/${p.id}?note=sending`);
    });
  }
  site.use((_req, res) => { res.status(404).send("Not found."); });

  app.use((req, res, next) => (req.get("host") === host ? site(req, res, next) : next()));
  return auth;
}


// ---------------------------------------------------------------- views

type View = { days: number; all: boolean; internal: number; report: Report; feedback: number };

/** Pro's monthly price in dollars, from the label the site shows, so the two can't drift. */
const MRR_PER_PRO = Number(PRO_PRICE_LABEL.match(/\d+/)?.[0] ?? 0);
const ago = (t: number | null) => {
  if (!t) return "—";
  const s = now() - t;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
/** Relative time, with the exact UTC time on hover. */
const when = (t: number | null) => (t ? `<span title="${date(t)} UTC">${ago(t)}</span>` : `<span class="dim">—</span>`);
const num = (n: number | null | undefined) => `<span class="n">${(n ?? 0).toLocaleString("en-US")}</span>`;
const bad = (n: number) => (n ? `<span class="n bad">${n}</span>` : `<span class="n dim">0</span>`);
const qs = (v: Pick<View, "days" | "all">, p: Partial<{ days: number; all: boolean }> = {}) => {
  const days = p.days ?? v.days, all = p.all ?? v.all;
  return `?days=${days}${all ? "&internal=1" : ""}`;
};
/** The window in words: "today", or "7d" counting today. `lastW` and `inW` read as a phrase ("last 7d", "in 7d"). */
const range = (days: number) => (days === 1 ? "today" : `${days}d`);
const lastW = (days: number) => (days === 1 ? "today" : `last ${days}d`);
const inW = (days: number) => (days === 1 ? "today" : `in ${days}d`);
/** A tool error: Google's code as a chip and its message as text (all red was a wall), the whole of it on hover. */
function errorText(e: string | null): string {
  const m = /^(Google [\w ]+? API \d{3}): ([A-Z][A-Z0-9_]{3,}) ([\s\S]*)$/.exec(e ?? "");
  return m ? `<span title="${esc(e)}"><span class="chip badc">${esc(m[2]!)}</span> ${esc(m[3]!)}</span>` : `<span title="${esc(e)}">${esc(e)}</span>`;
}
const userLink = (v: View, id: string, email: string) => `<a href="/users/${encodeURIComponent(id)}${qs(v)}">${esc(email)}</a>`;
const cid = (c: string | null) => (c ? `<code>${esc(c.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3"))}</code>` : `<span class="dim">—</span>`);

const SHORT: Record<string, string> = { "Google Ads": "Ads", "Search Console": "GSC", "GA4 read": "GA4", "GA4 edit": "GA4 edit" };
/** Permission chips: granted ones solid; with `missing`, the rest outlined. */
function perms(scopes: string | null, connected: number | boolean, o: { short?: boolean; missing?: boolean } = {}): string {
  if (!connected) return `<span class="dim">disconnected</span>`;
  const have = permissionLabels(scopes);
  if (!have) return `<span class="dim" title="Not reported by Google yet: filled in on their next call">unknown</span>`;
  const label = (l: string) => (o.short ? SHORT[l] ?? l : l);
  const on = have.map((l) => `<span class="chip on">${label(l)}</span>`);
  const off = o.missing ? Object.values(SCOPE_LABELS).filter((l) => !have.includes(l)).map((l) => `<span class="chip">${label(l)}</span>`) : [];
  return [...on, ...off].join(" ") || `<span class="dim">none</span>`;
}
const planBadge = (plan: string, paying: number | boolean) =>
  plan === "free" ? `<span class="chip">free</span>` : `<span class="chip pro">${esc(plan)}${paying ? "" : " · comp"}</span>`;

function table(cols: (string | [string, "r"])[], rows: unknown[][], empty = "Nothing yet.", cls = ""): string {
  if (!rows.length) return `<p class="empty">${empty}</p>`;
  const right = cols.map((c) => Array.isArray(c));
  return `<div class="tbl"><table${cls ? ` class="${cls}"` : ""}><thead><tr>${cols.map((c) => `<th${Array.isArray(c) ? ' class="r"' : ""}>${Array.isArray(c) ? c[0] : c}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((v, i) => `<td${right[i] ? ' class="r"' : ""}>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const card = (title: string, body: string, extra = "") => `<section class="card"><header><h2>${title}</h2>${extra}</header>${body}</section>`;
const stat = (label: string, value: string, sub = "") => `<div class="stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

/** Outside dashboards the operator checks alongside this one. */
const EXTERNAL: [string, string][] = [
  ["Claude directory", "https://claude.ai/directory/manage/camberstack"],  // submission + Observability; public listing: /directory/connectors/camberstack
  ["Stripe", "https://dashboard.stripe.com/subscriptions"],
  ["Glama", "https://glama.ai/mcp/servers/zwznco/camberstack-mcp"],
  ["MCP registry", "https://registry.modelcontextprotocol.io/?q=io.camberstack"],
  ["Matomo", "https://matomo.zwznco.com/index.php?module=CoreHome&action=index&idSite=7&period=day&date=today"],
  ["GitHub", "https://github.com/zwznco/camberstack-mcp"],
];

function shell(path: string, who: string, v: View, body: string, heading?: string): string {
  // Counts as of page load (no live polling): users all time, tool errors in the window (red), Pro users.
  const errs = v.report.errorsInWindow;
  const nav: [string, string, string][] = [
    ["/", "Overview", ""],
    ["/users", "Users", String(v.report.funnel.all.connected)],
    ["/activity", "Activity", errs ? `<b class="bad" title="${errs} tool errors in this range">${errs}</b>` : ""],
    ["/revenue", "Revenue", String(v.report.funnel.all.paid || "")],
    ["/announcements", "Announcements", ""],
    ["/feedback", "Feedback", String(v.feedback || "")],
  ];
  const title = nav.find(([p]) => p === path)?.[1] ?? "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${heading ? "User" : title} · Camberstack admin</title><style>
:root{--bg:#fafafa;--panel:#fff;--fg:#0a0a0a;--muted:#6b6b6b;--dim:#a3a3a3;--line:#e8e8e8;--hover:#f4f4f5;--accent:#2563eb;--ok:#16a34a;--bad:#dc2626;--chip:#f4f4f5;--pro:#7c3aed;--bar:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--panel:#111;--fg:#ededed;--muted:#8f8f8f;--dim:#5c5c5c;--line:#222;--hover:#181818;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171;--chip:#1c1c1c;--pro:#a78bfa;--bar:#3b82f6}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
code,.n,.mono{font-family:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,monospace;font-size:12px;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}a:hover{color:var(--accent)}td a{border-bottom:1px dotted var(--dim)}
.app{display:grid;grid-template-columns:216px 1fr;min-height:100vh}
aside{border-right:1px solid var(--line);padding:16px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}
.brand{font:600 13px/1 ui-monospace,Menlo,monospace;padding:4px 8px 18px;letter-spacing:-.2px;white-space:nowrap}.brand span{color:var(--dim);font-weight:400}
aside nav a{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:6px;color:var(--muted)}
aside nav a:hover{background:var(--hover);color:var(--fg)}aside nav a.on{background:var(--hover);color:var(--fg);font-weight:500}
aside nav a em{font:normal 11px ui-monospace,Menlo,monospace;color:var(--dim)}aside nav a em b{font-weight:400}
.ext{margin-top:20px;padding-top:12px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:1px}.ext span{display:none}
.ext a{padding:4px 8px;border-radius:6px;color:var(--muted);font-size:12px}.ext a:hover{background:var(--hover);color:var(--fg)}.ext i{font-style:normal;color:var(--dim)}
.who{margin-top:auto;padding:8px;color:var(--dim);font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.who span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.who form{margin:0}.who button{border:0;padding:0;color:var(--dim)}
main{min-width:0;padding:20px 28px 48px;max-width:1240px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:18px;font-weight:600;margin:0;letter-spacing:-.2px}h2{font-size:13px;font-weight:600;margin:0}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel)}
.seg a{padding:4px 10px;color:var(--muted);font:12px ui-monospace,Menlo,monospace;border-left:1px solid var(--line)}.seg a:first-child{border-left:0}
.seg a.on{background:var(--fg);color:var(--bg)}.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toggle{font-size:12px;color:var(--dim)}.toggle:hover{color:var(--fg)}.toggle.on{color:var(--fg)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border:1px solid var(--line);border-radius:8px;background:var(--panel);margin-bottom:16px;overflow:hidden}
.stat{padding:14px 16px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);margin:0 -1px -1px 0}
.stat span{display:block;color:var(--muted);font-size:12px}.stat b{display:block;font:500 22px/1.3 ui-monospace,Menlo,monospace;letter-spacing:-.5px;margin-top:4px}
.stat b .n{font-size:inherit}.stat b span.chip{display:inline-block;font-size:13px;margin-top:6px}.stat small{color:var(--dim);font-size:11px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;margin-bottom:16px}.grid2>.card{margin-bottom:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:16px;min-width:0}
.card>header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.card>header small{color:var(--dim);font-size:12px}.card>.pad{padding:14px}
.mfoot{display:none}.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%}
th{font-weight:500;color:var(--muted);font-size:12px;text-align:left;padding:7px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 14px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--hover)}
.r{text-align:right}td.wrap{white-space:normal;min-width:280px}.empty{color:var(--dim);padding:14px;margin:0}
.chip{display:inline-block;font:11px/1.6 ui-monospace,Menlo,monospace;padding:0 6px;border-radius:4px;border:1px solid var(--line);color:var(--dim)}
.chip.on{background:var(--chip);color:var(--fg);border-color:var(--chip)}.chip.pro{color:var(--pro);border-color:var(--pro)}
.chip.okc{color:var(--ok);border-color:var(--ok)}.chip.badc{color:var(--bad);border-color:var(--bad)}
.dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--ok)}.muted{color:var(--muted)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dim)}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.chart{display:flex;align-items:flex-end;gap:2px;height:120px;padding:14px 14px 0}.chart div{flex:1;background:var(--bar);opacity:.85;min-height:2px;border-radius:2px 2px 0 0}
.chart div:hover{opacity:1}.chart div{position:relative;overflow:hidden}.chart div.future{background:none;border:1px dashed var(--line);border-bottom:0;opacity:1}
.chart i{position:absolute;left:0;right:0;bottom:0;background:var(--bad)}.axis b{font-weight:400}
.err{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:90ch}.err .chip{vertical-align:1px}.axis{display:flex;justify-content:space-between;padding:6px 14px 10px;color:var(--dim);font:11px ui-monospace,Menlo,monospace}
.bar{height:6px;background:var(--chip);border-radius:3px;min-width:80px}.bar i{display:block;height:100%;background:var(--bar);border-radius:3px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0;padding:14px}dt{color:var(--muted)}dd{margin:0;min-width:0;overflow-wrap:anywhere}
button{font:inherit;font-size:12px;background:none;border:1px solid var(--line);color:var(--muted);border-radius:6px;padding:3px 10px;cursor:pointer}button:hover{color:var(--fg)}
@media (max-width:760px){.app{display:block}aside{position:sticky;top:0;z-index:2;height:auto;flex-direction:row;align-items:center;gap:8px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 12px;background:var(--bg)}
.brand{padding:4px 4px}.brand span{display:none}aside nav{display:flex;gap:2px}aside nav a{white-space:nowrap;gap:6px}.who,.ext{display:none}main{padding:16px}
.mfoot{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:24px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.mfoot span{flex-basis:100%;color:var(--dim);font-size:12px}.mfoot button{border:0;padding:0;color:var(--dim)}.grid2{grid-template-columns:1fr}
.top{margin-bottom:14px}h1{font-size:16px}
table.users thead{display:none}table.users tr{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:10px 14px;border-bottom:1px solid var(--line)}
table.users tr:last-child{border-bottom:0}table.users td{padding:0;border:0}table.users td:first-child{flex-basis:100%}
table.users td:nth-child(4),table.users td:nth-child(6),table.users td:nth-child(7),table.users td:nth-child(8),table.users td:nth-child(9){display:none}
table.users td:nth-child(5){margin-left:auto;color:var(--dim);font-size:12px}}
</style></head><body><div class="app">
<aside><div class="brand">camberstack<span>/admin</span></div><nav>${nav.map(([p, l, c]) =>
  `<a class="${p === path ? "on" : ""}" href="${p}${qs(v)}">${l}<em>${c}</em></a>`).join("")}</nav>
<div class="ext"><span>Links</span>${EXTERNAL.map(([l, href]) => `<a href="${href}" target="_blank" rel="noopener">${l} <i>↗</i></a>`).join("")}</div>
<div class="who"><span title="${esc(who)}">${esc(who)}</span><form method="post" action="/logout"><button>Sign out</button></form></div></aside>
<main><div class="top"><h1>${heading ?? title}</h1><div class="tools"${path === "/announcements" ? ' style="display:none"' : ""}>
<span class="seg" title="Whole days in UTC, counting today">${[1, 7, 30, 90].map((d) => `<a class="${d === v.days ? "on" : ""}" href="?${qs(v, { days: d }).slice(1)}">${d === 1 ? "Today" : `${d}d`}</a>`).join("")}</span>
<a class="toggle ${v.all ? "on" : ""}" href="${qs(v, { all: !v.all })}" title="Include the operator's and testers' accounts (ADMIN_EMAILS, PRO_EMAILS)">${v.all ? "showing" : "hiding"} internal</a></div></div>
${body}
<footer class="mfoot">${EXTERNAL.map(([l, href]) => `<a href="${href}" target="_blank" rel="noopener">${l} ↗</a>`).join("")}
<span>${esc(who)} · <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></span></footer>
</main></div></body></html>`;
}

function overviewPage(v: View): string {
  const r = v.report, w = range(v.days);
  const stages = Object.keys(r.funnel.all) as (keyof Report["funnel"]["all"])[];
  const top = Math.max(1, r.funnel.all.connected);
  const errs = r.errorsInWindow;
  const paying = r.paying;
  const callsInWindow = r.daily.reduce((a, x) => a + x.calls, 0);
  return `<div class="stats">
${stat("Users", num(r.funnel.all.connected), `+${r.funnel.window.connected} ${inW(v.days)}`)}
${stat(`Active · ${w}`, num(r.activeInWindow), `${callsInWindow.toLocaleString("en-US")} calls`)}
${stat("Applied a change", num(r.funnel.all.applied), `${Math.round((100 * r.funnel.all.applied) / top)}% of users`)}
${stat("Paying", num(paying), `$${paying * MRR_PER_PRO} MRR`)}
${stat(`Tool errors · ${w}`, errs ? `<span class="n bad">${errs}</span>` : num(0), callsInWindow ? `${((100 * errs) / callsInWindow).toFixed(1)}% of calls` : "")}
</div>
${callsChart(v)}
<div class="grid2">
${card("Funnel", table(["stage", ["all time", "r"], "", [`new · ${w}`, "r"]], stages.map((k) => [k.replace(/_/g, " "), num(r.funnel.all[k]),
    `<div class="bar"><i style="width:${Math.round((100 * r.funnel.all[k]) / top)}%"></i></div>`, num(r.funnel.window[k])])))}
${card("Google permissions", table(["service", ["connected users", "r"], ""], [
    ...Object.entries(r.permissions).map(([l, n]) => [l, num(n), `<div class="bar"><i style="width:${Math.round((100 * n) / Math.max(1, r.funnel.all.connected - r.funnel.all.disconnected))}%"></i></div>`]),
    ...(r.permissionsUnknown ? [[`<span class="dim">not reported yet</span>`, num(r.permissionsUnknown), ""]] : []),
  ]), `<small>connected users only</small>`)}
</div>
${card("Connects by source", table(["source", "campaign", "content", ["users", "r"], [`new · ${w}`, "r"], ["used real", "r"], ["applied", "r"]],
    r.sources.map((x) => [x.source === "(untagged)" ? `<span class="dim">untagged</span>` : esc(x.source), esc(x.campaign ?? "—"), esc(x.content ?? "—"),
      num(x.connected), num(x.in_window), num(x.used_real), num(x.applied)]), "No users yet."), `<small>first touch</small>`)}
<div class="grid2">
${card("Latest signups", table(["user", "plan", "permissions", ["signed up", "r"]], [...r.users].sort((a, b) => b.created_at - a.created_at).slice(0, 6)
    .map((u) => [userLink(v, u.id, u.email), planBadge(u.plan, u.paying), perms(u.google_scopes, u.connected, { short: true }), `<span class="r">${when(u.created_at)}</span>`])),
    `<a class="muted" href="/users${qs(v)}">all users →</a>`)}
${card("Top tools", table(["tool", ["calls", "r"], ["errors", "r"]], r.tools.slice(0, 6).map((t) => [`<code>${esc(t.tool)}</code>`, num(t.calls), bad(t.errors)]), "No calls in this window."),
    `<a class="muted" href="/activity${qs(v)}">activity →</a>`)}
</div>`;
}

/**
 * Calls over the window, errors stacked in red: one bar per UTC day, zeros included so the bars are a real time axis,
 * or for today one per UTC hour (hours still to come drawn empty).
 */
function callsChart(v: View): string {
  const r = v.report, start = windowStart(v.days), hourNow = new Date(now() * 1000).getUTCHours();
  type Bar = { label: string; calls: number; users: number; errors: number; future?: boolean };
  let bars: Bar[];
  if (v.days === 1) {
    const byHour = new Map(r.hourly.map((x) => [x.hour, x]));
    bars = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, "0")}:00`, calls: 0, users: 0, errors: 0, ...byHour.get(h), future: h > hourNow }));
  } else {
    const byDay = new Map(r.daily.map((x) => [x.day, x]));
    bars = Array.from({ length: v.days }, (_, i) => {
      const day = new Date((start + i * 86400) * 1000).toISOString().slice(0, 10);
      return { label: day, calls: 0, users: 0, errors: 0, ...byDay.get(day) };
    });
  }
  const per = v.days === 1 ? "hour" : "day", max = Math.max(1, ...bars.map((b) => b.calls));
  const body = r.daily.length
    ? `<div class="chart">${bars.map((b) => `<div class="${b.future ? "future" : ""}" style="height:${b.future ? 100 : Math.max(1, Math.round((100 * b.calls) / max))}%" title="${b.label}${
        v.days === 1 ? " UTC" : ""}: ${b.calls} calls · ${b.users} users · ${b.errors} errors">${b.errors ? `<i style="height:${Math.round((100 * b.errors) / b.calls)}%"></i>` : ""}</div>`).join("")}</div>
<div class="axis"><span>${bars[0]!.label}</span><span>peak ${max}/${per} · <b class="bad">■</b> errors</span><span>${bars.at(-1)!.label}${v.days === 1 ? " UTC" : ""}</span></div>`
    : `<p class="empty">No calls in this window.</p>`;
  return card(`Calls per ${per}`, body, `<small>${lastW(v.days)} · UTC</small>`);
}

function usersPage(v: View): string {
  const r = v.report;
  const shown = r.users.length < r.funnel.all.connected ? `${r.users.length} of ${r.funnel.all.connected} users` : `${r.users.length} users`;
  return card(shown, table(["user", "plan", "Google permissions", "signed up", "last seen", ["calls", "r"], ["errors", "r"], ["applied", "r"], "app"],
    r.users.map((u) => [userLink(v, u.id, u.email), planBadge(u.plan, u.paying), perms(u.google_scopes, u.connected, { short: true }),
      when(u.created_at), when(u.last_seen_at), num(u.calls), bad(u.errors), num(u.applied), `<span class="muted">${esc(u.client ?? "—")}</span>`]), "No users.", "users"),
    `<small>all time, by last seen</small>`);
}

function userPage(x: UserDetail, v: View): string {
  const u = x.user;
  const stripe = u.stripe_customer ? `<a href="https://dashboard.stripe.com/customers/${encodeURIComponent(u.stripe_customer)}" target="_blank" rel="noopener"><code>${esc(u.stripe_customer)}</code> ↗</a>` : `<span class="dim">—</span>`;
  return `<div class="stats">
${stat("Calls · all time", num(x.totals.calls), `avg ${x.totals.avg_ms} ms`)}
${stat("Errors · all time", x.totals.errors ? `<span class="n bad">${x.totals.errors}</span>` : num(0), x.totals.calls ? `${((100 * x.totals.errors) / x.totals.calls).toFixed(1)}%` : "")}
${stat("Proposals", num(x.proposals.length), `${x.proposals.filter((p) => p.status === "applied").length} applied`)}
${stat("Ads accounts", num(x.accounts.length), "")}
</div>
<div class="grid2">
${card("Account", `<dl>
<dt>Status</dt><dd>${u.connected ? `<i class="dot ok"></i> connected` : `<i class="dot"></i> disconnected`}</dd>
<dt>Google permissions</dt><dd>${perms(u.google_scopes, u.connected, { missing: true })}</dd>
<dt>Signed up</dt><dd>${date(u.created_at)} UTC <span class="dim">(${ago(u.created_at)})</span></dd>
<dt>Last seen</dt><dd>${when(u.last_seen_at)}</dd>
<dt>Came from</dt><dd>${u.src_source ? esc([u.src_source, u.src_campaign, u.src_content].filter(Boolean).join(" · ")) : `<span class="dim">untagged</span>`}</dd>
<dt>Time zone</dt><dd>${esc(u.time_zone ?? "—")}</dd>
<dt>Stripe</dt><dd>${stripe}${u.stripe_sub ? ` <code class="dim">${esc(u.stripe_sub)}</code>` : ""}</dd>
<dt>Emails</dt><dd>${u.email_opt_out ? `<span class="bad">unsubscribed</span>` : "subscribed"}</dd>
<dt>User id</dt><dd><code>${esc(u.id)}</code></dd>
</dl>
<form method="post" action="/users/${encodeURIComponent(u.id)}/login-as" target="_blank"><button>Log in as user ↗</button></form>`)}
${card("Ads accounts used", table(["account", ["calls", "r"], "first", "last"], x.accounts.map((a) => [cid(a.customer_id) + (a.customer_id === "0000000001" ? ` <span class="chip">demo</span>` : ""), num(a.calls), when(a.first), when(a.last)])))}
</div>
<div class="grid2">
${card("AI apps", table(["app", ["calls", "r"], "last", "tool list"], x.clients.map((c) => [esc(c.client), num(c.calls), when(c.last), toolList(x, c.client)])),
    `<small>tool list: our version when the app last fetched it</small>`)}
${card("Tools", table(["tool", ["calls", "r"], ["errors", "r"]], x.tools.map((t) => [`<code>${esc(t.tool)}</code>`, num(t.calls), bad(t.errors)])))}
</div>
${card("Proposals", table(["id", "account", "status", "summary", "created"], x.proposals.map((p) => [`<code>${esc(p.id)}</code>`, cid(p.customer_id),
    `<span class="chip ${p.status === "applied" ? "okc" : p.status === "failed" ? "badc" : ""}">${esc(p.status)}${p.undo_of ? " · undo" : ""}</span>`,
    `<span class="muted">${esc(p.summary).replace(/\n/g, "<br>")}</span>`, when(p.created_at)]), "No proposals.").replaceAll("<td><span class=\"muted\">", "<td class=\"wrap\"><span class=\"muted\">"))}
${card("Emails sent", table(["email", "sent"], x.emails.map((e) => [`<code>${esc(e.kind)}</code>`, `${date(e.sent_at)} UTC`]), "None sent."))}
${card("Recent calls", callsTable(x.recent.map((c) => ({ ...c, email: null }))), `<small>last ${x.recent.length}</small>`)}`;
}

/** The tool set an app holds: our version when it last fetched the list. Apps keep it until they fetch again. */
function toolList(x: UserDetail, client: string): string {
  const t = x.toolLists.find((l) => l.client === client);  // newest first
  if (!t) return `<span class="dim" title="Hasn't fetched the tool list since 2026-10-15, when this started being recorded">unknown</span>`;
  const stale = t.version !== SERVER_VERSION;
  return `<span class="${stale ? "bad" : "ok"}" title="Fetched ${date(t.fetched_at)} UTC${stale ? `; current is ${SERVER_VERSION}` : ""}">${esc(t.version)}</span> <span class="dim">${ago(t.fetched_at)}</span>`;
}

function callsTable(rows: { at: number; email: string | null; id?: string; tool: string; customer_id: string | null; ok: number; error: string | null; ms: number; client: string }[], v?: View): string {
  const withUser = rows.some((c) => c.email);
  return table(["when", ...(withUser ? ["user"] : []), "tool", "account", ["ms", "r"], "result", "app"], rows.map((c) => [
    `<span class="mono" title="${date(c.at)} UTC">${date(c.at).slice(5)}</span>`, ...(withUser ? [v && c.id ? userLink(v, c.id, c.email!) : esc(c.email ?? "")] : []),
    `<code>${esc(c.tool)}</code>`, cid(c.customer_id), num(c.ms),
    c.ok ? `<span class="ok">ok</span>` : `<span class="err">${errorText(c.error)}</span>`, `<span class="muted">${esc(c.client)}</span>`]))
    .replaceAll('<td><span class="err">', '<td class="wrap"><span class="err">');
}

function activityPage(v: View): string {
  const r = v.report, w = lastW(v.days);
  return `<div class="grid2">
${card("Tools", table(["tool", ["calls", "r"], ["users", "r"], ["errors", "r"], ["avg ms", "r"], ["max ms", "r"]], r.tools.map((t) => [`<code>${esc(t.tool)}</code>`,
    num(t.calls), num(t.users), bad(t.errors), num(t.avg_ms), num(t.max_ms)]), "No calls in this window."), `<small>${w}</small>`)}
${card("AI apps", table(["app", ["calls", "r"], ["users", "r"]], r.clients.map((c) => [esc(c.client), num(c.calls), num(c.users)]), "No calls in this window."), `<small>${w}</small>`)}
</div>
${card("Errors", table(["tool", "error", ["count", "r"], ["users", "r"], "last"], r.errors.map((e) => [`<code>${esc(e.tool)}</code>`, `<span class="err">${errorText(e.error)}</span>`, num(e.n), num(e.users), when(e.last)]), "No errors in this window.")
    .replaceAll('<td><span class="err">', '<td class="wrap"><span class="err">'), `<small>${w}, grouped, newest first</small>`)}
${card("Recent calls", callsTable(r.recent.map((c) => ({ ...c, id: r.users.find((u) => u.email === c.email)?.id })), v), "<small>last 50, any window</small>")}`;
}

function revenuePage(v: View): string {
  const r = v.report;
  const pros = r.users.filter((u) => u.plan !== "free");
  const paying = r.paying;
  return `<div class="stats">
${stat("Paying", num(paying), "live Stripe subscriptions")}
${stat("MRR", `$${paying * MRR_PER_PRO}`, `$${MRR_PER_PRO}/mo each`)}
${stat("Comped Pro", num(pros.filter((u) => !u.paying).length), v.all ? "PRO_EMAILS" : "PRO_EMAILS are internal: show internal")}
${stat("Ad connects uploaded", num(r.adConversions?.uploaded), `${r.adConversions?.recorded ?? 0} recorded`)}
</div>
${card("Pro users", table(["user", "plan", "permissions", "signed up", "last seen", ["calls", "r"]], pros.map((u) => [userLink(v, u.id, u.email), planBadge(u.plan, u.paying),
    perms(u.google_scopes, u.connected, { short: true }), when(u.created_at), when(u.last_seen_at), num(u.calls)]), "No Pro users yet."))}
<div class="grid2">
${card("Emails", table(["email", ["all time", "r"], [lastW(v.days), "r"]], r.emails.map((e) => [`<code>${esc(e.kind)}</code>`, num(e.sent), num(e.in_window)]), "No emails sent yet."))}
${card("Ad conversions", `<dl><dt>Recorded</dt><dd>${num(r.adConversions?.recorded)}</dd><dt>Uploaded to Google Ads</dt><dd>${num(r.adConversions?.uploaded)}</dd>
<dt>Failing</dt><dd>${bad(r.adConversions?.failing ?? 0)}</dd><dt>Last error</dt><dd class="${r.adConversions?.last_error ? "bad" : "dim"}">${esc(r.adConversions?.last_error ?? "—")}</dd></dl>`)}
</div>
<p class="dim">Usage comes from our own database; page visits are in Matomo (site 7).</p>`;
}

// ---------------------------------------------------------------- announcements

function sendStatus(st: SendState & { running: boolean }, left: number): string {
  if (st.sent_at) return `<span class="chip okc">sent</span>`;
  if (st.running) return `<span class="chip pro">sending</span>`;
  if (st.started_at) return `<span class="chip badc">interrupted · ${left} left</span>`;
  return `<span class="chip">not sent</span>`;
}

function announcementsPage(ann: Announcements): string {
  return `${ann.canSend ? "" : `<p class="warn">Email isn't configured (RESEND_API_KEY): nothing can be sent.</p>`}
<p class="dim" style="margin:0 0 16px">Preset emails, written in <code>src/announce.ts</code>. Each goes out once, when you press Send on its page.</p>
<div class="cards">${PRESETS.map((p) => {
    const st = ann.state(p.id), left = ann.recipients(p).length;
    return `<a class="pcard" href="/announcements/${p.id}"><div class="row">${sendStatus(st, left)}<span class="dim">${AUDIENCES[p.audience]}</span></div>
<h3>${esc(p.subject)}</h3><p class="dim">${st.sent_at ? `Sent ${date(st.sent_at)} UTC to ${st.sent}` : esc(p.plan)}</p></a>`;
  }).join("")}</div>
${STYLE}`;
}

function announcementPage(ann: Announcements, p: Preset, who: string, note: string): string {
  const st = ann.state(p.id), to = ann.recipients(p), m = renderAnnouncement(p, false);
  const notes: Record<string, string> = { test: `Test sent to ${esc(who)}.`, sending: "Sending, about one email a second. Reload to follow along." };
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const label = st.sent_at ? `Sent ${date(st.sent_at)} UTC to ${people(st.sent)}` : st.running ? "Sending…"
    : st.started_at ? `Finish sending (${people(to.length)} left)` : `Send to ${people(to.length)}`;
  const off = !!st.sent_at || st.running || !ann.canSend || !to.length;
  return `${note && notes[note] ? `<p class="okmsg">${notes[note]}</p>` : ""}
<div class="stats">
${stat("Status", sendStatus(st, to.length))}
${stat("Audience", esc(AUDIENCES[p.audience]))}
${stat(st.sent_at ? "Sent to" : st.started_at ? "Still to send" : "Would go to", `<span class="n">${st.sent_at ? st.sent : to.length}</span>`)}
${stat("Planned", `<span style="font:13px/1.4 inherit;font-family:inherit">${esc(p.plan)}</span>`)}
</div>
<div class="actions">
<form method="post" action="/announcements/${p.id}/send" data-confirm="${esc(`Send “${p.subject}” to ${people(to.length)}? It goes out once and can't be undone.`)}" onsubmit="return confirm(this.dataset.confirm)">
<input type="hidden" name="count" value="${to.length}"><button class="primary"${off ? " disabled" : ""}>${label}</button></form>
<form method="post" action="/announcements/${p.id}/test"><button${ann.canSend ? "" : " disabled"}>Send a test to ${esc(who)}</button></form>
</div>
${ann.canSend ? "" : `<p class="warn">Email isn't configured (RESEND_API_KEY): nothing can be sent.</p>`}
<div class="grid2">
${card("Preview", `<div class="pad"><p class="dim" style="margin:0 0 4px">Subject</p><p style="margin:0 0 16px;font-weight:600">${esc(m.subject)}</p>
<div class="mail">${m.html}<hr><p class="dim" style="font-size:12px">You're getting this because you connected Camberstack (camberstack.io) to Google Ads. … Unsubscribe</p></div></div>`)}
${card(st.sent_at ? "Recipients" : `Recipients (${to.length})`, st.sent_at ? `<p class="empty">Sent to ${people(st.sent)}. It can't send again.</p>`
    : table(["email", "plan"], to.map((u) => [esc(u.email), esc(u.plan)]), "Nobody matches this audience."))}
</div>
${STYLE}`;
}

const STYLE = `<style>
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.pcard{display:block;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;color:var(--fg)}
.pcard:hover{border-color:var(--muted);color:var(--fg)}.pcard h3{font-size:14px;font-weight:600;margin:10px 0 6px}.pcard p{margin:0;font-size:12px}
.pcard .row{display:flex;justify-content:space-between;align-items:center;font-size:12px}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg);padding:6px 14px}button[disabled]{opacity:.45;cursor:not-allowed}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}.actions form{margin:0}
.warn{border:1px solid var(--bad);color:var(--bad);border-radius:6px;padding:8px 12px}.okmsg{border:1px solid var(--ok);color:var(--ok);border-radius:6px;padding:8px 12px}
.mail{background:#fff;color:#1c1b19;border-radius:6px;padding:16px;font-size:14px}.mail a{color:#1f5f4a;text-decoration:underline}.mail hr{border:0;border-top:1px solid #ddd}
</style>`;

/** Every message from /feedback, newest first; not filtered by the range (there are few, and old ones still matter). */
function feedbackPage(rows: FeedbackRow[], v: View): string {
  const reply = (r: FeedbackRow) => `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(`Re: your Camberstack feedback`)}`;
  return card("Feedback", table(["when", "from", "about", "message"], rows.map((r) => [
    when(r.at),
    `${r.user_id ? userLink(v, r.user_id, r.email) : esc(r.email)}${r.user_id ? "" : ` <span class="chip">not connected</span>`}<br><a class="dim" href="${reply(r)}">reply</a>`,
    esc(FEEDBACK_KINDS[r.kind] ?? r.kind),
    `<div style="white-space:pre-wrap;max-width:60ch">${esc(r.message)}</div>`,
  ]), "No feedback yet. It arrives from camberstack.io/feedback."), `<small>${rows.length} shown · emailed as they arrive</small>`);
}
