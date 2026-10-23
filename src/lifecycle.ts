/**
 * Lifecycle emails, each sent at most once per user, through Resend:
 *   first_steps    connected 2–14 days ago and never asked anything real → the first question to ask, and the demo
 *   limit_reached  a tool refused a second Google Ads account (the Free plan's limit), still free the next morning (6+ hours later) → one note:
 *                  when their next switch opens, what Pro covers, the upgrade link
 *   switch_wanted  a Free user's AI was stopped before spending the switch (asked about another account) and they didn't
 *                  spend it, still free the next morning (6+ hours later) → the plan that covers all their accounts
 *                  (Pro, or Agency past Pro's limit), its upgrade link. One upgrade email per user: never both this and limit_reached
 *   check_in       first applied a change to a real account 2–14 days ago → a personal note from Adam asking how it went (replies go to him)
 *   welcome        signed up (still Free) and their AI app finished connecting → the first question to ask, the demo, the plans
 *   pro_welcome    on Pro with a Stripe subscription → what Pro adds, where billing lives
 * Those two are transactional: sent within a minute (transactional(), every minute), not held for the morning.
 * The first three go out in the user's morning (SEND_HOURS in the time zone of their Google Ads account, or FALLBACK_TZ),
 * so being due only holds it until the next hourly run inside that window.
 * Never sent to internal accounts (ADMIN_EMAILS, PRO_EMAILS) or anyone who unsubscribed; first_steps and limit_reached
 * switch_wanted and limit_reached also skip Pro users and the disconnected.
 *
 * Content stays generic on purpose: counts and links, never campaign names or other Google Ads data
 * (the email address comes from Google sign-in; the account page is where the details live).
 * Unsubscribe: a signed link per user. GET shows a confirm button (mail scanners follow links);
 * POST unsubscribes, which is also what List-Unsubscribe-Post one-click sends (RFC 8058).
 */
import express, { type Express } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { deriveKey, safeEqual, sign } from "./crypto.js";
import { ACCOUNT_WINDOW_DAYS, AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL, PLAN_LIMIT_PREFIX, PRO_ACCOUNTS, PRO_PRICE_LABEL, SWITCH_NOTICE_PREFIX } from "./plans.js";
import { DEMO_CID } from "./demo.js";
import { GA_TARGET } from "./ga4-changes.js";

export interface MailConfig {
  apiKey: string; from: string; replyTo: string;
  /** MAIL_POSTAL_ADDRESS: a mailing address for the footer of announcements (marketing mail; US CAN-SPAM wants one). */
  postalAddress?: string;
}

export interface LifecycleDeps {
  db: DB;
  baseUrl: string;
  mail?: MailConfig;
  signingKey: Buffer;
  /** Never emailed: the operator and testers. */
  internalEmails: Set<string>;
  upgradeLink: (userId: string) => string | null;
  /** The upgrade link for Agency (billing.ts link "agency"); null or unset when Agency isn't sold. */
  agencyLink?: (userId: string) => string | null;
  fetch?: typeof fetch;
  /** Tests pin the time of day. */
  clock?: () => Date;
}

/** Key for unsubscribe links; server.ts and email-preview.ts must sign alike. */
export const lifecycleSigningKey = (encryptionKey: Buffer) => deriveKey(encryptionKey, "email-links");

const DAY = 86400;
/** Local hours an email may go out in: three hourly runs, so one always lands. */
const SEND_HOURS = { from: 9, to: 12 };
/** For users whose Google Ads time zone we never saw: 9am Central is 10 Eastern, 7 Pacific. */
const FALLBACK_TZ = "America/Chicago";

/** Hour of day (0–23) at `at` in `tz`; an unknown zone counts as FALLBACK_TZ. */
function localHour(at: Date, tz: string | null | undefined): number {
  const fmt = (zone: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(at));
  try { return fmt(tz || FALLBACK_TZ); } catch { return fmt(FALLBACK_TZ); }
}
type Kind = "first_steps" | "limit_reached" | "switch_wanted" | "check_in" | "welcome" | "pro_welcome";
/** welcome shipped at this time (2026-10-14); everyone who signed up before it never gets one. */
const WELCOME_SINCE = 1792001873;
/** A welcome that hasn't gone out a day after signup (mail down that long) is dropped, not sent late. */
const WELCOME_WITHIN = DAY;
/** Tools that mean someone has asked Camberstack something real (not just listed accounts or sites). */
const USED_TOOLS = "('account_overview','run_gaql','keyword_ideas','keyword_metrics','propose_changes','paid_organic_overlap',"
  + "'search_console_summary','search_console_performance','search_console_trend','search_console_opportunities',"
  + "'search_console_inspect_urls','search_console_sitemaps')";

export class Lifecycle {
  constructor(private d: LifecycleDeps) {}

  private sig(userId: string): string {
    return sign(this.d.signingKey, `unsubscribe:${userId}`);
  }
  unsubscribeUrl(userId: string): string { return `${this.d.baseUrl}/unsubscribe?u=${userId}&s=${this.sig(userId)}`; }
  private verify(userId: unknown, s: unknown): string | null {
    const u = String(userId ?? "");
    return u && safeEqual(this.sig(u), String(s ?? "")) ? u : null;
  }

  /** Who is due each email right now. */
  private due(): { kind: Kind; id: string; email: string; days: number; opens?: string; accounts?: number }[] {
    const t = now();
    const eligible = `u.enc_refresh IS NOT NULL AND u.email_opt_out = 0 AND u.plan = 'free'`;
    const notSent = (k: string) => `NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = '${k}')`;
    const first = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, u.created_at FROM users u WHERE ${eligible}
      AND u.created_at BETWEEN ? AND ? AND ${notSent("first_steps")}
      AND NOT EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.tool IN ${USED_TOOLS}
        AND NOT (c.tool = 'run_gaql' AND c.customer_id IS NULL))`)  // a run_gaql field lookup reads no account
      .all(t - 15 * DAY, t - 2 * DAY) as { id: string; email: string; time_zone: string | null; created_at: number }[];
    // Refused a second account by the plan gate (session.ts checkAccount), the last refusal 6 hours to 30 days ago.
    // Since 0.12.0 a refusal only follows a switch the user confirmed, so they're working on more than one account
    // now: the next morning, not days later. The 6 hours keep it from landing minutes after a refusal inside the
    // send window. `error` is the latest refusal's (SQLite takes bare columns from the max() row).
    const limit = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, max(c.at) last, c.error
      FROM users u JOIN tool_calls c ON c.user_id = u.id AND c.ok = 0 AND c.error LIKE ?
      WHERE ${eligible} AND ${notSent("limit_reached")} AND ${notSent("switch_wanted")}
      GROUP BY u.id HAVING last BETWEEN ? AND ?`)
      .all(`${PLAN_LIMIT_PREFIX}%`, t - 31 * DAY, t - 6 * 3600) as { id: string; email: string; time_zone: string | null; last: number; error: string }[];
    // Stopped by the switch notice (session.ts noticeSwitch), the last one 6 hours to 30 days ago, with no switch spent
    // since: they wanted another account and stayed on one (2026-10-23: 5 accounts, asked about 3). Matched on the text,
    // since 0.19.0 logs a notice as ok (it was ok = 0 before).
    const wanted = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, u.ads_accounts, max(c.at) last
      FROM users u JOIN tool_calls c ON c.user_id = u.id AND c.error LIKE ?
      WHERE ${eligible} AND ${notSent("switch_wanted")} AND ${notSent("limit_reached")}
        AND NOT EXISTS (SELECT 1 FROM tool_calls s WHERE s.user_id = u.id AND s.tool = 'switch_account' AND s.ok = 1 AND s.at >= c.at)
      GROUP BY u.id HAVING last BETWEEN ? AND ?`)
      .all(`${SWITCH_NOTICE_PREFIX}%`, t - 31 * DAY, t - 6 * 3600) as { id: string; email: string; time_zone: string | null; ads_accounts: number | null; last: number }[];
    // First applied change to a real account (not the demo, not an undo) 2–14 days ago; any plan, connected or not.
    const checkIn = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, min(p.applied_at) first FROM users u
      JOIN proposals p ON p.user_id = u.id AND p.status = 'applied' AND p.undo_of IS NULL AND p.customer_id <> ?
      WHERE u.email_opt_out = 0 AND ${notSent("check_in")}
      GROUP BY u.id HAVING first BETWEEN ? AND ?`)
      .all(DEMO_CID, t - 15 * DAY, t - 2 * DAY) as { id: string; email: string; time_zone: string | null; first: number }[];
    // Upper bounds carry a day past the nominal window: waiting for their morning can take up to ~21h.
    const at = this.d.clock?.() ?? new Date();
    const morning = (u: { time_zone: string | null }) => { const h = localHour(at, u.time_zone); return h >= SEND_HOURS.from && h < SEND_HOURS.to; };
    const ok = (u: { email: string; time_zone: string | null }) => !this.d.internalEmails.has(u.email.toLowerCase()) && morning(u);
    return [
      ...first.filter(ok).map((u) => ({ kind: "first_steps" as const, id: u.id, email: u.email, days: Math.floor((t - u.created_at) / DAY) })),
      // Every refusal's text names when the next switch opens (session.ts refuse: "the next opens YYYY-MM-DD").
      ...limit.filter(ok).map((u) => ({ kind: "limit_reached" as const, id: u.id, email: u.email, days: 0,
        opens: /the next opens (\d{4}-\d{2}-\d{2})/.exec(u.error)?.[1] })),
      ...wanted.filter(ok).map((u) => ({ kind: "switch_wanted" as const, id: u.id, email: u.email, days: 0,         // All their accounts: what list_accounts last saw (managers aren't counted), or more if they asked about more since.
        accounts: Math.max(2, u.ads_accounts ?? 0, this.askedAccounts(u.id)) })),
      ...checkIn.filter(ok).map((u) => ({ kind: "check_in" as const, id: u.id, email: u.email, days: 0 })),
    ];
  }

  /** Google Ads accounts a user has used or asked about in the window: the active ones plus every switch notice's account. */
  private askedAccounts(userId: string): number {
    const since = now() - ACCOUNT_WINDOW_DAYS * DAY;
    const rows = this.d.db.prepare(`SELECT customer_id c, error FROM tool_calls WHERE user_id = ? AND at >= ?
      AND ((ok = 1 AND customer_id IS NOT NULL AND customer_id NOT IN (?, ?)) OR error LIKE ?)`)
      .all(userId, since, DEMO_CID, GA_TARGET, `${SWITCH_NOTICE_PREFIX}%`) as { c: string | null; error: string | null }[];
    // A notice names its account in the text ("using 1234567890 spends"); before 0.19.0 it was also in customer_id.
    return new Set(rows.map((r) => r.error?.startsWith(SWITCH_NOTICE_PREFIX) ? /using (\d+) spends/.exec(r.error)?.[1] : r.c).filter(Boolean)).size;
  }

  /** Hourly. */
  async run(): Promise<number> {
    if (!this.d.mail) return 0;
    return this.deliver(this.due(), (u) => u.kind === "first_steps" ? firstSteps(u.days)
      : u.kind === "limit_reached" ? limitReached(this.d.baseUrl, this.d.upgradeLink(u.id), u.opens)
      : u.kind === "switch_wanted" ? this.switchWantedFor(u.id, u.accounts ?? 2) : checkInEmail());
  }

  /** Agency only when they have more accounts than Pro covers and Agency is sold; otherwise Pro. */
  private switchWantedFor(userId: string, accounts: number) {
    const agency = accounts > PRO_ACCOUNTS ? this.d.agencyLink?.(userId) ?? null : null;
    return switchWanted(this.d.baseUrl, accounts, agency ? "agency" : "pro", agency ?? this.d.upgradeLink(userId));
  }

  /**
   * Every minute. welcome: a Free user who connected in the last day (Pro gets pro_welcome instead), once their app holds a
   * token or has called a tool. The account exists from the Google callback, before the app swaps its code for a token: a
   * Codex that never did got "You're connected" while it couldn't connect (2026-10-23). Finishing later, within the day, still sends it.
   * pro_welcome: anyone on Pro through Stripe who hasn't had it. Polling the plan, not hooking the
   * upgrade, covers every way someone becomes Pro (/upgraded, the paywall's refreshPlan, the hourly sweep).
   * PRO_EMAILS users have no stripe_sub, so they never get it.
   */
  async transactional(): Promise<number> {
    if (!this.d.mail) return 0;
    const pros = (this.d.db.prepare(`SELECT u.id, u.email, u.plan FROM users u WHERE u.plan IN ('pro', 'agency') AND u.stripe_sub IS NOT NULL AND u.stripe_sub != ''
      AND u.email_opt_out = 0 AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = 'pro_welcome')`)
      .all() as { id: string; email: string; plan: string }[])
      .filter((u) => !this.d.internalEmails.has(u.email.toLowerCase()));
    const fresh = (this.d.db.prepare(`SELECT u.id, u.email FROM users u WHERE u.plan = 'free' AND u.enc_refresh IS NOT NULL
      AND u.created_at >= ? AND u.email_opt_out = 0 AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = 'welcome')
      AND (EXISTS (SELECT 1 FROM tokens t WHERE t.user_id = u.id) OR EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id))`)
      .all(Math.max(WELCOME_SINCE, now() - WELCOME_WITHIN)) as { id: string; email: string }[])
      .filter((u) => !this.d.internalEmails.has(u.email.toLowerCase()));
    return await this.deliver(fresh.map((u) => ({ ...u, kind: "welcome" as const, days: 0 })), () => welcome(this.d.baseUrl))
      + await this.deliver(pros.map((u) => ({ ...u, kind: "pro_welcome" as const, days: 0 })), (u) => proWelcome(this.d.baseUrl, u.plan));
  }

  /** Logs before sending (at most once, even if a send is retried by a crash); a failed send is unlogged to retry. */
  private async deliver<U extends { kind: Kind; id: string; email: string; days: number }>(
    due: U[], render: (u: U) => { subject: string; text: string; html: string }): Promise<number> {
    let sent = 0;
    for (const u of due) {
      const claim = this.d.db.prepare("INSERT OR IGNORE INTO email_log (user_id, kind, sent_at) VALUES (?, ?, ?)").run(u.id, u.kind, now());
      if (!claim.changes) continue;
      try {
        await this.send(u.email, render(u), u.id, `${u.id}:${u.kind}`);
        sent++;
      } catch (e) {
        this.d.db.prepare("DELETE FROM email_log WHERE user_id = ? AND kind = ?").run(u.id, u.kind);
        console.error(`lifecycle ${u.kind}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  /** `once`: Resend's idempotency key (kept 24h), so a send that timed out after Resend took it isn't sent again an hour later. */
  /** An announcement (announce.ts): the same footer and unsubscribe link, plus the postal address. */
  sendAnnouncement(to: string, m: { subject: string; text: string; html: string }, userId: string, once?: string): Promise<void> {
    return this.send(to, m, userId, once, this.d.mail?.postalAddress);
  }

  private async send(to: string, m: { subject: string; text: string; html: string }, userId: string, once?: string, address?: string): Promise<void> {
    const unsub = this.unsubscribeUrl(userId);
    const footer = `You're getting this because you connected Camberstack (camberstack.io) to Google Ads.${address ? ` Camberstack, ${address}.` : ""}`;
    const res = await (this.d.fetch ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.d.mail!.apiKey}`, "Content-Type": "application/json", ...(once ? { "Idempotency-Key": once } : {}) },
      body: JSON.stringify({
        from: this.d.mail!.from, to: [to], reply_to: this.d.mail!.replyTo, subject: m.subject,
        text: `${m.text}\n\n--\n${footer}\nUnsubscribe: ${unsub}`,
        html: `${m.html}<hr style="border:0;border-top:1px solid #ddd;margin:28px 0 12px">
<p style="color:#777;font-size:13px">${footer} <a href="${unsub}" style="color:#777">Unsubscribe</a></p>`,
        headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  /** Operator check: send one sample of each email to `to`, with placeholder links. */
  async preview(to: string): Promise<void> {
    await this.send(to, firstSteps(3), "preview");
    await this.send(to, limitReached(this.d.baseUrl, `${this.d.baseUrl}/account?upgrade=1`, "2026-11-13"), "preview");
    await this.send(to, switchWanted(this.d.baseUrl, 5, "pro", `${this.d.baseUrl}/account?upgrade=1`), "preview");
    await this.send(to, checkInEmail(), "preview");
    await this.send(to, welcome(this.d.baseUrl), "preview");
    await this.send(to, proWelcome(this.d.baseUrl, "pro"), "preview");
  }

  mount(app: Express, page: (title: string, body: string) => string): void {
    const optOut = (u: string) => this.d.db.prepare("UPDATE users SET email_opt_out = 1 WHERE id = ?").run(u);
    app.get("/unsubscribe", (req, res) => {
      const u = this.verify(req.query.u, req.query.s);
      res.setHeader("Cache-Control", "no-store");
      if (!u) { res.status(400).type("html").send(page("Link not valid", "<p>This unsubscribe link isn't valid. Reply to any of our emails and we'll take you off.</p>")); return; }
      res.type("html").send(page("Unsubscribe", `<p>Stop getting Camberstack emails? You'll still be able to use Camberstack as normal.</p>
<form method="post" action="/unsubscribe?u=${u}&s=${this.sig(u)}"><button class="btn" style="border:0;cursor:pointer">Unsubscribe</button></form>`));
    });
    app.post("/unsubscribe", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
      const u = this.verify(req.query.u, req.query.s);
      if (!u) { res.status(400).end(); return; }
      optOut(u);
      res.type("html").send(page("Unsubscribed", "<p>Done. You won't get any more emails from Camberstack.</p>"));
    });
  }
}

// ---------------------------------------------------------------- the emails

const p = (s: string) => `<p style="margin:0 0 14px">${s}</p>`;
const wrap = (body: string) => `<div style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19;max-width:560px">${body}</div>`;

function firstSteps(days: number) {
  const ask = "How did each of my Google Ads campaigns do last month?";
  return {
    subject: "The first thing to ask Camberstack",
    text: `Hi,

You connected Camberstack to Google Ads ${days} days ago but haven't asked it anything yet. A good first question, in Claude or ChatGPT:

  "${ask}"

From there, ask whatever you'd ask about your account: search terms, keywords, budgets. Nothing changes until you approve it.

Rather try it on sample data first? Ask: "Show me Camberstack's demo account."

If something didn't work when you tried, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`You connected Camberstack to Google Ads ${days} days ago but haven't asked it anything yet. A good first question, in Claude or ChatGPT:`)
      + `<p style="margin:0 0 14px;padding:12px 14px;background:#f1eee7;border-radius:8px"><strong>“${ask}”</strong></p>`
      + p("From there, ask whatever you'd ask about your account: search terms, keywords, budgets. Nothing changes until you approve it.")
      + p(`Rather try it on sample data first? Ask: <em>“Show me Camberstack's demo account.”</em>`)
      + p("If something didn't work when you tried, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}

function limitReached(base: string, upgrade: string | null, opens?: string) {
  // "November 13": the date the refusal named, in words. UTC so it's the same day the tool said.
  const when = opens && new Date(`${opens}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const stopped = `Camberstack stopped when you tried it on another Google Ads account. The Free plan covers one account at a time, `
    + `with one switch every ${ACCOUNT_WINDOW_DAYS} days, and yours was already used${when ? `; the next one opens on ${when}` : ""}.`;
  const pro = `If you're working on more than one account, Camberstack Pro covers up to ${PRO_ACCOUNTS} accounts, for ${PRO_PRICE_LABEL}, `
    + `and Agency up to ${AGENCY_ACCOUNTS}, for ${AGENCY_PRICE_LABEL}; cancel any time.`;
  const free = "On Free, every tool and unlimited changes keep working on your active account, and undo and history always work";
  return {
    subject: "Using Camberstack on more than one Google Ads account",
    text: `Hi,

${stopped}

${pro}${upgrade ? `\n${upgrade}\n(personal link, valid for 7 days)` : ` Upgrade from ${base}/account`}

${free}: ${base}/account

This is the only email about it. Questions? Just reply.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(stopped) + p(pro)
      + `<p style="margin:0 0 18px"><a href="${upgrade ?? `${base}/account?upgrade=1`}" style="display:inline-block;background:#1f5f4a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">Upgrade to Pro</a></p>`
      + p(`${free}, on <a href="${base}/account">your account page</a>.`)
      + p("This is the only email about it. Questions? Just reply.") + p("Adam<br>Camberstack")),
  };
}

/** No account ids or names, only the count (see the header). `plan` is the one that covers all `accounts`. */
function switchWanted(base: string, accounts: number, plan: "pro" | "agency", upgrade: string | null) {
  const [name, covers, price] = plan === "agency" ? ["Agency", AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL] : ["Pro", PRO_ACCOUNTS, PRO_PRICE_LABEL];
  const asked = "Camberstack recently stopped to check before switching you to another Google Ads account. The Free plan "
    + "covers one at a time, and nothing was locked.";
  const fits = `You have ${accounts} Google Ads accounts. If you want to manage all of them, try Camberstack ${name}: `
    + `up to ${covers} accounts at once, for ${price}. Cancel any time.`;
  const free = `Staying on Free is fine too: your active account keeps every tool and unlimited changes, with one switch every ${ACCOUNT_WINDOW_DAYS} days`;
  return {
    subject: "Working on more than one Google Ads account?",
    text: `Hi,

${asked}

${fits}${upgrade ? `\n${upgrade}\n(personal link, valid for 7 days)` : ` Upgrade from ${base}/account`}

${free}: ${base}/account

This is the only email about it. Questions? Just reply.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(asked) + p(fits)
      + `<p style="margin:0 0 18px"><a href="${upgrade ?? `${base}/account?upgrade=1`}" style="display:inline-block;background:#1f5f4a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">Upgrade to ${name}</a></p>`
      + p(`${free}, on <a href="${base}/account">your account page</a>.`)
      + p("This is the only email about it. Questions? Just reply.") + p("Adam<br>Camberstack")),
  };
}

/** Plain on purpose: it should read like Adam wrote it, and replies go straight to him. Never says how many users there are. */
function checkInEmail() {
  const qs = ["How did you find Camberstack?", "Was there anything that got in your way, or that you wished it could do?"];
  return {
    subject: "Camberstack: how did it go?",
    text: `Hi,

I'm Adam, I built Camberstack. I like to check in with people after their first few days, so: how's it going?

Two quick questions, if you have a minute:
${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}

I read every reply and fix things quickly, so even one line helps.

Thanks,
Adam
camberstack.io`,
    html: wrap(p("Hi,") + p("I'm Adam, I built Camberstack. I like to check in with people after their first few days, so: how's it going?")
      + p("Two quick questions, if you have a minute:")
      + `<ol style="margin:0 0 14px;padding-left:22px">${qs.map((q) => `<li>${q}</li>`).join("")}</ol>`
      + p("I read every reply and fix things quickly, so even one line helps.") + p("Thanks,<br>Adam<br>camberstack.io")),
  };
}

/** Transactional: right after signup. Doesn't name Google Ads as connected: someone can sign up with only Search Console. */
function welcome(base: string) {
  const ask = "How did each of my Google Ads campaigns do last month?";
  return {
    subject: "Welcome to Camberstack",
    text: `Hi,

You're connected. You can now use Camberstack in Claude or ChatGPT.

A good first question: "${ask}" From there, ask about search terms, keywords and budgets. Nothing changes until you approve it, and every change can be undone from ${base}/account

Want to try it on sample data first? Ask: "Show me Camberstack's demo account."

Free covers one Google Ads account; Pro (${PRO_PRICE_LABEL}) covers up to ${PRO_ACCOUNTS}, and Agency (${AGENCY_PRICE_LABEL}) up to ${AGENCY_ACCOUNTS}.

If anything doesn't work, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p("You're connected. You can now use Camberstack in Claude or ChatGPT.")
      + p(`A good first question: <em>“${ask}”</em> From there, ask about search terms, keywords and budgets. Nothing changes until you approve it, and every change can be undone from <a href="${base}/account">your account page</a>.`)
      + p(`Want to try it on sample data first? Ask: <em>“Show me Camberstack's demo account.”</em>`)
      + p(`Free covers one Google Ads account; Pro (${PRO_PRICE_LABEL}) covers up to ${PRO_ACCOUNTS}, and Agency (${AGENCY_PRICE_LABEL}) up to ${AGENCY_ACCOUNTS}.`)
      + p("If anything doesn't work, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}

/** Transactional: confirms the upgrade. Billing changes and cancelling live on /account (Stripe's portal), receipts come from Stripe. */
/** The welcome for a new subscriber, on the plan they bought (Pro or Agency; the kind stays pro_welcome for both). */
function proWelcome(base: string, plan: string) {
  const ask = "List my Google Ads accounts";
  const [name, accounts, price] = plan === "agency" ? ["Agency", AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL] : ["Pro", PRO_ACCOUNTS, PRO_PRICE_LABEL];
  return {
    subject: `You're on Camberstack ${name}`,
    text: `Hi,

Thanks for subscribing to Camberstack ${name}. It's active now.

What ${name} adds: up to ${accounts} Google Ads accounts instead of 1. To use another one, ask in Claude or ChatGPT, e.g. "${ask}", then name the one you want.

What stays the same: every tool, unlimited changes, nothing applied until you approve it, and every change can be undone.

Billing: ${price}, renewing monthly. You can see invoices, change your card or cancel any time from your account page:
${base}/account

If anything doesn't work the way you expected, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`Thanks for subscribing to Camberstack ${name}. It's active now.`)
      + p(`<strong>What ${name} adds:</strong> up to ${accounts} Google Ads accounts instead of 1. To use another one, ask in Claude or ChatGPT, e.g. <em>“${ask}”</em>, then name the one you want.`)
      + p("<strong>What stays the same:</strong> every tool, unlimited changes, nothing applied until you approve it, and every change can be undone.")
      + p(`<strong>Billing:</strong> ${price}, renewing monthly. You can see invoices, change your card or cancel any time from <a href="${base}/account">your account page</a>.`)
      + p("If anything doesn't work the way you expected, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}
