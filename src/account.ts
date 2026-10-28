/**
 * /account: a connected user's own page, for what they'd otherwise have to ask their AI for: plan and
 * free applies left, upgrade or manage billing, every change Camberstack made, and disconnect.
 * Google sign-in (signin.ts, identity only) matched to the user who connected through an AI app.
 */
import express, { type Express, type Request } from "express";
import type { DB, UserRow } from "./db.js";
import { now } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import type { GoogleCreds } from "./google.js";
import type { UserSession } from "./session.js";
import { SignIn } from "./signin.js";
import { appPage, cmd, COPY_JS, esc, infoPage } from "./pages.js";
import { DEMO_CID } from "./demo.js";
import { GA_TARGET } from "./ga4-changes.js";
import { ACCOUNT_WINDOW_DAYS, AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL, PRO_ACCOUNTS, PRO_PRICE_LABEL } from "./plans.js";

export interface AccountDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  fetch?: typeof fetch;
  session: (userId: string, o?: { seen?: boolean }) => UserSession;
  billingLink: (kind: "upgrade" | "billing" | "agency", userId: string) => string | null;
  /** The admin site's origin: where ending a "Log in as user" session returns to. */
  adminUrl?: string;
}

/** A "Log in as user" handoff link works once, within this many seconds. */
const LOGIN_AS_TTL = 60;
/** How long the admin's session as that user lasts. */
const LOGIN_AS_SESSION = 3600;

/**
 * "Log in as user" from the admin site (admin.ts), which is on another host and so can't set the /account cookie
 * itself: it stores a one-use token here (hash only, in pending_auth) and sends the browser to /account/lau with it.
 */
export function startLoginAs(db: DB, baseUrl: string, userId: string, admin: string): string {
  const t = randomToken();
  db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, '__lau', ?, ?)")
    .run(sha256(t), JSON.stringify({ userId, admin }), now());
  console.log(`login-as: ${admin} -> ${userId}`);
  return `${baseUrl}/account/lau?t=${t}`;
}

/** "Oct 1, 19:44 UTC" */
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC";
/** "19:44 UTC", for an entry already under its day's heading */
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC";
const DAY = 86400000;
/** "Today", "Yesterday", "Oct 1" (UTC, like every time on the page) */
const dayLabel = (ms: number, now: number) => {
  const ago = Math.floor(now / DAY) - Math.floor(ms / DAY);
  return ago === 0 ? "Today" : ago === 1 ? "Yesterday"
    : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: ago > 300 ? "numeric" : undefined, timeZone: "UTC" });
};
/** The change list's time filter, in days (0 = all). 30 matches the plan's account window. */
const RANGES = [1, 7, 14, 30, 0] as const;
const DEFAULT_RANGE = 30;
/** A change longer than this (items, or characters) folds behind a preview. */
const FOLD_LINES = 3;
const FOLD_CHARS = 280;
/** Google's dashed form: 386-283-8095 */
const fmtCid = (c: string) => c === DEMO_CID ? "000-000-0001 (demo, sample data)" : c === GA_TARGET ? "Google Analytics" : /^\d{10}$/.test(c) ? `${c.slice(0, 3)}-${c.slice(3, 6)}-${c.slice(6)}` : c;

export function mountAccount(app: Express, d: AccountDeps): SignIn {
  const auth = new SignIn(d, "acc_", "cs_account", "/account", 7 * 86400);
  /** The signed-in user; `by` is the admin's email when an admin is logged in as them. */
  const signedIn = (req: Request): { u: UserRow; by: string | null } | undefined => {
    const s = auth.session(req);
    const u = s && d.db.prepare("SELECT * FROM users WHERE id = ?").get(s.subject) as UserRow | undefined;
    return u ? { u, by: s.impersonator } : undefined;
  };
  const page = (title: string, body: string) => infoPage(d.baseUrl, title, body);
  const shell = (title: string, body: string) => appPage(d.baseUrl, title, "/account", body);

  app.use("/account", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/account/login", (req, res) => {
    if (!d.google.clientId) { res.status(503).type("html").send(page("Sign-in unavailable", "<p>Google sign-in is not configured.</p>")); return; }
    // Only a sign-in started from the upgrade screen continues to checkout.
    auth.start(res, req.query.next === "upgrade" ? "/account?upgrade=1" : req.query.next === "agency" ? "/account?upgrade=agency" : undefined);
  });

  app.get("/account/callback", async (req, res) => {
    const who = await auth.finish(req);
    if (!who) { res.status(400).type("html").send(page("Sign-in didn't finish", `<p>The sign-in expired or was cancelled. <a href="/account/login">Try again</a>.</p>`)); return; }
    const u = d.db.prepare("SELECT * FROM users WHERE google_sub = ?").get(who.sub) as UserRow | undefined;
    if (!u) {
      // Signed in before connecting: the account is made by connecting from an AI app, so this is the
      // next step, not an error. (2026-10-14: a new Pro user's first visit ended on a bare 404 here.)
      const mcpUrl = `${d.baseUrl}/mcp`;
      res.type("html").send(page("Connect Camberstack first", `<p>${esc(who.email)} hasn't connected Camberstack yet.
Your account is created when you connect it to your AI app. It takes about a minute:</p>
<p>1. Add this server URL to your AI app:</p>
<div class="url"><code>${mcpUrl}</code><button class="copy" type="button" data-copy="${mcpUrl}">Copy</button></div>
<p><strong>Claude:</strong> <a href="https://claude.ai/directory/connectors/camberstack">open Camberstack in the connector directory</a> and click Connect
(<a href="/google-ads-claude">guide</a>).<br>
<strong>ChatGPT:</strong> <a href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866">open Camberstack in the plugin directory</a> and click Install plugin
(<a href="/google-ads-chatgpt">guide</a>).<br>
<strong>Claude Code:</strong></p>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}
<p>2. Sign in with Google when your AI app asks, using ${esc(who.email)}.</p>
<p>3. Come back and <a href="/account/login${who.next === "/account?upgrade=1" ? "?next=upgrade" : who.next === "/account?upgrade=agency" ? "?next=agency" : ""}">sign in here again</a>${who.next === "/account?upgrade=1" ? " to finish upgrading to Pro" : who.next === "/account?upgrade=agency" ? " to finish upgrading to Agency" : ""}.</p>
${COPY_JS}`));
      return;
    }
    auth.open(res, u.id);
    res.redirect(302, who.next === "/account?upgrade=1" || who.next === "/account?upgrade=agency" ? who.next : "/account");
  });

  app.post("/account/logout", (req, res) => {
    const s = signedIn(req);
    auth.close(req, res);
    // Ending a "Log in as user" session goes back to that user on the admin site.
    res.redirect(303, s?.by && d.adminUrl ? `${d.adminUrl}/users/${encodeURIComponent(s.u.id)}` : "/");
  });

  // The admin site's "Log in as user" handoff (startLoginAs): one use, LOGIN_AS_TTL seconds.
  app.get("/account/lau", (req, res) => {
    const id = sha256(String(req.query.t ?? ""));
    const row = d.db.prepare("SELECT params, created_at FROM pending_auth WHERE id = ? AND client_id = '__lau'").get(id) as
      { params: string; created_at: number } | undefined;
    d.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(id);
    const p = row && row.created_at >= now() - LOGIN_AS_TTL ? JSON.parse(row.params) as { userId: string; admin: string } : null;
    if (!p || !d.db.prepare("SELECT 1 FROM users WHERE id = ?").get(p.userId)) {
      res.status(400).type("html").send(page("Link expired", "<p>That link was already used or has expired. Start again from the admin site.</p>"));
      return;
    }
    auth.open(res, p.userId, { impersonator: p.admin, ttl: LOGIN_AS_SESSION });
    res.redirect(302, "/account");
  });

  app.post("/account/disconnect", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const s = signedIn(req);
    if (!s) { res.redirect(303, "/account"); return; }
    // Revoking someone's Google grant is theirs to do, never an admin's from their account page.
    if (s.by) { res.status(403).type("html").send(page("Not while logged in as this user", "<p>Only the user can disconnect their account.</p>")); return; }
    const u = s.u;
    if (req.body?.confirm !== "yes") { res.redirect(303, "/account#disconnect"); return; }
    await d.session(u.id).disconnect();
    auth.close(req, res);
    res.type("html").send(page("Disconnected", `<p>Camberstack's access to your Google Ads account is revoked and the stored Google credentials are deleted.
Your AI app can no longer use Camberstack until you connect again.</p>
<p>Your change history is kept so you can see what was changed. To have it deleted, email <a href="mailto:adam@camberstack.io">adam@camberstack.io</a>.</p>`));
  });

  app.get("/account", (req, res) => {
    const me = signedIn(req);
    const u = me?.u, by = me?.by ?? null;
    // "Upgrade to Pro" on the pricing section lands on /account?upgrade=1 (Agency: ?upgrade=agency). Signed in: a free user goes
    // straight to Stripe Checkout. Signed out: the sign-in link carries the intent through Google (in
    // the sign-in's own state, so an abandoned click can't hijack a later, ordinary sign-in).
    const agency = req.query.upgrade === "agency", wantsUpgrade = req.query.upgrade === "1" || agency;
    if (u && wantsUpgrade && !by) {
      const p = d.session(u.id).plan();
      const to = agency ? ("agency_upgrade_url" in p ? p.agency_upgrade_url : null) : ("upgrade_url" in p ? p.upgrade_url : null);
      if (to) { res.redirect(303, to); return; }
    }
    if (!u) {
      res.type("html").send(shell("Your account", `<div class="signin"><div class="card">
<h1 style="font-size:26px;margin:0">Your Camberstack account</h1>
<p class="muted">${wantsUpgrade ? `Sign in to upgrade to ${agency ? "Agency" : "Pro"}. You'll go straight to checkout.` : "See your plan, every change Camberstack made to your Google Ads, and manage billing or disconnect."}</p>
<a class="btn" href="/account/login${wantsUpgrade ? `?next=${agency ? "agency" : "upgrade"}` : ""}">Sign in with Google</a>
<p class="muted" style="font-size:14px">Use the Google account you connected to your AI app. We only ask for your email address here.</p>
<p class="muted" style="font-size:14px">New to Camberstack? <a href="/#setup">Connect it to your AI app first</a>: that creates your account.</p>
</div></div>`));
      return;
    }
    // An admin looking at the page is not the user being active.
    const s = d.session(u.id, { seen: !by });
    const plan = s.plan();
    const history = s.history(undefined, 500);
    const apps = d.db.prepare(`SELECT coalesce(json_extract(cl.info, '$.client_name'), 'AI app') name, max(c.at) last FROM tool_calls c
      LEFT JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = ? GROUP BY 1 ORDER BY last DESC`).all(u.id) as { name: string }[];
    const lastUsed = (d.db.prepare("SELECT max(at) t FROM tool_calls WHERE user_id = ?").get(u.id) as { t: number | null }).t;

    // An applied undo folds into the change it reversed; everything else is its own entry.
    const undoneBy = new Map(history.filter((h) => h.undo_of && h.status === "applied").map((h) => [h.undo_of!, h]));
    const all = history.filter((h) => !(h.undo_of && h.status === "applied"));
    const at = (h: { applied_at: string | null; proposed_at: string }) => Date.parse(h.applied_at ?? h.proposed_at);
    const asked = Number(req.query.days);
    const days: number = (RANGES as readonly number[]).includes(asked) && req.query.days !== "" ? asked : DEFAULT_RANGE;
    const now = Date.now();
    const entries = days ? all.filter((h) => at(h) >= now - days * DAY) : all;

    const planCard = plan.plan !== "free"
      ? `<div class="card"><p class="label">Plan</p><p class="big">${plan.plan === "agency" ? "Agency" : "Pro"}${"complimentary" in plan ? ` <span class="chip">complimentary</span>` : ""}</p>
<p class="muted">${plan.accounts_in_use.length} of ${plan.accounts_included} Google Ads accounts in use (last ${ACCOUNT_WINDOW_DAYS} days).${"complimentary" in plan ? " No subscription on this account, so nothing to manage or cancel." : ""}</p>
${!by && "manage_billing" in plan && plan.manage_billing ? `<a class="btn" href="${esc(plan.manage_billing)}">Manage billing</a>` : ""}
${!by && "agency_upgrade_url" in plan && plan.agency_upgrade_url ? `<a class="btn" href="${esc(plan.agency_upgrade_url)}">Switch to Agency · ${AGENCY_PRICE_LABEL}</a>` : ""}</div>`
      : (() => {
        const used = plan.accounts_in_use;
        return `<div class="card"><p class="label">Plan</p><p class="big">Free</p>
<p class="muted">${"services_included" in plan
  ? `Every tool, with unlimited applied changes, on one Google service at a time (Google Ads on ${plan.accounts_included} account, Search Console or Google Analytics). In use: <strong style="color:var(--fg)">${esc(plan.service_in_use ?? "none yet; your AI asks which before the first")}</strong>.`
  : `Every tool, with unlimited applied changes, on ${plan.accounts_included} Google Ads account.`}
${used.length ? `Google Ads accounts in use (last ${ACCOUNT_WINDOW_DAYS} days): <strong style="color:var(--fg)">${used.map((c) => esc(fmtCid(c))).join(", ")}</strong>.` : "Not used on a Google Ads account yet."}
Pro covers ${"services_included" in plan ? `all three together, on ` : ""}up to ${PRO_ACCOUNTS}${"agency_upgrade_url" in plan && plan.agency_upgrade_url ? `, Agency up to ${AGENCY_ACCOUNTS}` : ""}.</p>
${"free_plan_change" in plan && plan.free_plan_change ? `<p class="muted"><strong style="color:var(--fg)">${esc(plan.free_plan_change)}</strong></p>` : ""}
<p class="muted">To move to a different account, ask your AI to switch to it: Free allows one switch every ${ACCOUNT_WINDOW_DAYS} days.</p>
${!by && "upgrade_url" in plan && plan.upgrade_url ? `<a class="btn" href="${esc(plan.upgrade_url)}">Upgrade to Pro · ${PRO_PRICE_LABEL}</a>` : ""}
${!by && "agency_upgrade_url" in plan && plan.agency_upgrade_url ? `<a class="btn" href="${esc(plan.agency_upgrade_url)}">Agency · ${AGENCY_PRICE_LABEL}</a>` : ""}</div>`;
      })();

    const connCard = `<div class="card"><p class="label">Connection</p>
<p class="big" style="font-size:20px"><span class="dot${u.enc_refresh ? " ok" : ""}"></span>${u.enc_refresh ? "Connected to Google Ads" : "Disconnected"}</p>
${apps.length ? `<div class="chips">${apps.map((a) => `<span class="chip">${esc(a.name)}</span>`).join("")}</div>` : ""}
<p class="muted">${u.enc_refresh ? (lastUsed ? `Last used ${when(lastUsed * 1000)}.` : "Not used yet.") : "Connect again from your AI app to use Camberstack."}</p></div>`;

    const change = (h: typeof entries[number]) => {
      const undo = undoneBy.get(h.proposal_id);
      const state = undo ? "undone" : h.undo_of ? "proposed" : h.status;
      const label = undo ? "Undone"
        : h.undo_of ? "Undo waiting for approval" : ({ applied: "Applied", proposed: "Waiting for approval", failed: "Failed", discarded: "Discarded" } as Record<string, string>)[h.status] ?? h.status;
      const lines = h.summary.split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
      const li = (ls: string[]) => ls.map((l) => `<li>${esc(l)}</li>`).join("");
      // A long change shows a clamped preview of its first line; the full list opens on tap.
      const fold = lines.length > FOLD_LINES || lines.join(" ").length > FOLD_CHARS;
      const canUndo = h.status === "applied" && !undo && !h.undo_of;
      // Status and time share a row that never wraps; the account, which can be long, gets its own line.
      return `<div class="change"><div class="change-head"><span class="pill ${state}">${esc(label)}</span><span class="change-time">${clock(at(h))}</span></div>
<p class="change-acct">Account ${esc(fmtCid(h.customer_id))}</p>
${fold ? `<details class="fold"><summary><span class="preview">${esc(lines[0])}</span><span class="toggle"><span class="closed">Show full change${lines.length > 1 ? ` (${lines.length} items)` : ""}</span><span class="opened">Show less</span></span></summary><ul>${li(lines)}</ul></details>`
  : `<ul>${li(lines)}</ul>`}
${canUndo ? `<div class="change-foot"><span>To reverse it, paste this into your AI:</span>
<button class="copy" type="button" data-copy="Undo Camberstack proposal ${esc(h.proposal_id)}">Copy undo request</button></div>` : ""}</div>`;
    };
    // Grouped under one heading per (UTC) day, so each entry needs only its time.
    let lastDay = "";
    const changes = entries.map((h) => {
      const d = dayLabel(at(h), now);
      const head = d === lastDay ? "" : `<h3 class="day">${d}</h3>`;
      lastDay = d;
      return head + change(h);
    }).join("");
    const rangeName = (n: number) => n === 1 ? "24 hours" : n ? `${n} days` : "All";
    const rangeBar = `<nav class="range" aria-label="Show changes from">${RANGES.map((n) =>
      `<a href="/account?days=${n}#changes"${n === days ? ` aria-current="page"` : ""}>${n === 1 ? "24h" : rangeName(n)}</a>`).join("")}</nav>`;
    const countLine = `<p class="muted range-note">${entries.length} change${entries.length === 1 ? "" : "s"}${days ? ` in the last ${rangeName(days)}` : ""}${days && all.length > entries.length ? ` · ${all.length} in total` : ""}</p>`;

    // An admin logged in as this user: say so on every view, and leave out what only the user may do (checkout, the
    // billing portal, disconnect), whose links are bearer links to the user's own Stripe and Google.
    const banner = by ? `<form method="post" action="/account/logout" class="card impersonating"><strong>Logged in as ${esc(u.email)}</strong>
<span class="muted">as admin ${esc(by)}. Billing and disconnect are hidden.</span> <button class="linkish">End</button></form>` : "";
    res.type("html").send(shell("Your account", `<div class="acct">
${banner}
<div class="acct-head"><h1>Your account</h1><form method="post" action="/account/logout" class="who muted">${esc(u.email)} · <button class="linkish">Sign out</button></form></div>
<div class="grid">${planCard}${connCard}</div>
<h2 id="changes">Changes</h2>
${all.length ? rangeBar : ""}
${!all.length ? `<div class="card"><p class="muted">No changes yet. Ask your AI about your Google Ads account to start.</p></div>`
  : entries.length ? countLine + changes
  : `<div class="card"><p class="muted">No changes in the last ${rangeName(days)}. <a href="/account?days=0#changes">See all ${all.length}</a>.</p></div>`}
<p class="muted">Something wrong, missing or confusing? <a href="/feedback">Send feedback</a>.</p>
<h2 id="disconnect">Disconnect</h2>
${by ? `<p class="muted">Only the user can disconnect.</p>` : u.enc_refresh ? `<form method="post" action="/account/disconnect" class="danger"><p>Revokes Camberstack's Google access and deletes the stored credentials. Your AI app stops working with Camberstack until you connect again. Your change history stays here.</p>
<label><input type="checkbox" name="confirm" value="yes" required> I want to disconnect</label><button class="btn-danger">Disconnect Google Ads</button></form>`
  : `<p class="muted">Already disconnected.</p>`}
</div>
${COPY_JS}`));
  });

  return auth;
}
