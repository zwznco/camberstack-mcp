/**
 * Lifecycle emails, each sent at most once per user, through Resend:
 *   first_steps    connected 2–14 days ago and never asked anything real → the first question to ask, and the demo
 *   limit_reached  a tool refused a second Google Ads account (the Free plan's limit), still free the next morning (6+ hours later) → one note:
 *                  when another account opens, what Pro covers, the upgrade link
 *   (switch_wanted, sent when a Free user was stopped before spending the account switch, went with the switch on 2026-11-06;
 *                  its email_log rows still count as an upgrade email already sent)
 *   (service_limit, for the one-service gate, was removed with it on 2026-11-11 before it ever sent)
 *   change_limit   the change cap (FREE_CHANGE_CAP) stopped a Free user's apply, still free the next morning (6+ hours later) →
 *                  when the next change opens, Plus's unlimited changes, the upgrade link. Once per user, but sent even after
 *                  another upgrade email: the cap is the main paywall, and this email is how ChatGPT users see the offer (2026-11-11)
 *                  limit_reached isn't sent after any upgrade email (limit_reached, switch_wanted or change_limit)
 *   check_in       first applied a change to a real account 2–14 days ago → a personal note from Adam asking how it went (replies go to him)
 *   welcome        signed up (still Free) and their AI app finished connecting → the first question to ask, the demo, the plans
 *   pro_welcome    on a paid plan (Plus, Pro, Agency) with a Stripe subscription → what it adds, where billing lives
 * Those two are transactional: sent within a minute (transactional(), every minute), not held for the morning.
 * The first five go out in the user's morning (SEND_HOURS in the time zone of their Google Ads account, or FALLBACK_TZ),
 * so being due only holds it until the next hourly run inside that window.
 * Never sent to internal accounts (ADMIN_EMAILS, PRO_EMAILS) or anyone who unsubscribed.
 * limit_reached also skips Pro users and the disconnected.
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
import { ACCOUNT_WINDOW_DAYS, AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL, CHANGE_LIMIT_PREFIX, PLAN_LIMIT_PREFIX, PLUS_PRICE_LABEL, changeCap, freeChanges, freeChangesShort, PRO_ACCOUNTS, PRO_PRICE_LABEL, dateLabel, payingSql } from "./plans.js";
import { DEMO_CID } from "./demo.js";
import { DEMO_MERCHANT } from "./merchant.js";

/** Send one email through Resend; throws if it refuses. */
export async function sendMail(apiKey: string, email: object, f: typeof fetch = fetch, idempotencyKey?: string): Promise<void> {
  const res = await f("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify(email),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

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
  /** The upgrade link for Plus (billing.ts link "plus"); null or unset when Plus isn't sold. change_limit pitches it. */
  plusLink?: (userId: string) => string | null;
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
type Kind = "first_steps" | "limit_reached" | "switch_wanted" | "change_limit" | "check_in" | "welcome" | "pro_welcome";
/** welcome shipped at this time (2026-10-14); everyone who signed up before it never gets one. */
const WELCOME_SINCE = 1792001873;
/** A welcome that hasn't gone out a day after signup (mail down that long) is dropped, not sent late. */
const WELCOME_WITHIN = DAY;
/** Tools that mean someone has asked Camberstack something real (not just listed accounts or sites). */
const USED_TOOLS = "('account_overview','run_gaql','keyword_ideas','keyword_metrics','propose_changes','paid_organic_overlap',"
  + "'search_console_summary','search_console_performance','search_console_trend','search_console_opportunities',"
  + "'search_console_inspect_urls','search_console_sitemaps','analytics_report','analytics_landing_pages','propose_analytics_changes','propose_search_console_changes',"
  + "'merchant_product_issues','merchant_report','merchant_ad_spend','propose_merchant_changes')";

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
  private due(): { kind: Kind; id: string; email: string; days: number; opens?: string; accounts?: number; error?: string }[] {
    const t = now();
    const eligible = `u.enc_refresh IS NOT NULL AND u.email_opt_out = 0 AND u.plan = 'free'`;
    const notSent = (k: string) => `NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = '${k}')`;
    const first = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, u.created_at FROM users u WHERE ${eligible}
      AND u.created_at BETWEEN ? AND ? AND ${notSent("first_steps")}
      AND NOT EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.tool IN ${USED_TOOLS}
        AND NOT (c.tool = 'run_gaql' AND c.customer_id IS NULL))`)  // a run_gaql field lookup reads no account
      .all(t - 15 * DAY, t - 2 * DAY) as { id: string; email: string; time_zone: string | null; created_at: number }[];
    // Refused a second account by the plan gate (session.ts checkAccount), the last refusal 6 hours to 30 days ago. A refusal
    // logs as ok since it became a notice (it was ok = 0 before), so it's matched on the text; Merchant ones by their wording.
    // A refusal means they're working on more than one account now (there is no switch since 2026-11-06): the next
    // morning, not days later. The 6 hours keep it from landing minutes after a refusal inside the
    // send window. `error` is the latest refusal's (SQLite takes bare columns from the max() row). A reset by hand cancels
    // the refusals before it: this email would say the account is still locked (sent minutes after one, 2026-10-16).
    const limit = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, max(c.at) last, c.error
      FROM users u JOIN tool_calls c ON c.user_id = u.id AND c.error LIKE ? AND c.at >= coalesce(u.plan_reset_at, 0)
        AND coalesce(c.customer_id, '') NOT LIKE 'mc:%' AND c.error NOT LIKE '%Merchant Center account%'
      WHERE ${eligible} AND ${notSent("limit_reached")} AND ${notSent("switch_wanted")} AND ${notSent("change_limit")}
      GROUP BY u.id HAVING last BETWEEN ? AND ?`)
      .all(`${PLAN_LIMIT_PREFIX}%`, t - 31 * DAY, t - 6 * 3600) as { id: string; email: string; time_zone: string | null; last: number; error: string }[];
    // Stopped by the change cap (session.ts checkChangeCap), the last stop 6 hours to 30 days ago. Always on request: the
    // user approved the change that was stopped. `error` is the latest stop's, which names the date the next change opens.
    // Not held back by an earlier upgrade email (limit_reached etc.): only by its own.
    const changes = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, max(c.at) last, c.error
      FROM users u JOIN tool_calls c ON c.user_id = u.id AND c.error LIKE ? AND c.at >= coalesce(u.plan_reset_at, 0)
      WHERE ${eligible} AND ${notSent("change_limit")}
      GROUP BY u.id HAVING last BETWEEN ? AND ?`)
      .all(`${CHANGE_LIMIT_PREFIX}%`, t - 31 * DAY, t - 6 * 3600) as { id: string; email: string; time_zone: string | null; last: number; error: string }[];
    // First applied change to a real account (not the demo, not an undo) 2–14 days ago; any plan, connected or not.
    const checkIn = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, min(p.applied_at) first FROM users u
      JOIN proposals p ON p.user_id = u.id AND p.status = 'applied' AND p.undo_of IS NULL AND p.customer_id <> ? AND p.customer_id <> 'mc:${DEMO_MERCHANT}'
      WHERE u.email_opt_out = 0 AND ${notSent("check_in")}
      GROUP BY u.id HAVING first BETWEEN ? AND ?`)
      .all(DEMO_CID, t - 15 * DAY, t - 2 * DAY) as { id: string; email: string; time_zone: string | null; first: number }[];
    // Upper bounds carry a day past the nominal window: waiting for their morning can take up to ~21h.
    const at = this.d.clock?.() ?? new Date();
    const morning = (u: { time_zone: string | null }) => { const h = localHour(at, u.time_zone); return h >= SEND_HOURS.from && h < SEND_HOURS.to; };
    const ok = (u: { email: string; time_zone: string | null }) => !this.d.internalEmails.has(u.email.toLowerCase()) && morning(u);
    return [
      ...first.filter(ok).map((u) => ({ kind: "first_steps" as const, id: u.id, email: u.email, days: Math.floor((t - u.created_at) / DAY) })),
      // Every refusal's text names when another account opens (session.ts refuse: "opens on YYYY-MM-DD"; before 0.29.0 "the next opens YYYY-MM-DD").
      ...limit.filter(ok).map((u) => ({ kind: "limit_reached" as const, id: u.id, email: u.email, days: 0,
        opens: /opens (?:again )?(?:on )?(\d{4}-\d{2}-\d{2})/.exec(u.error)?.[1] })),
      ...changes.filter(ok).map((u) => ({ kind: "change_limit" as const, id: u.id, email: u.email, days: 0,
        opens: /next opens on (\d{4}-\d{2}-\d{2})/.exec(u.error)?.[1] })),
      ...checkIn.filter(ok).map((u) => ({ kind: "check_in" as const, id: u.id, email: u.email, days: 0 })),
    ];
  }

  /** Hourly. */
  async run(): Promise<number> {
    if (!this.d.mail) return 0;
    return this.deliver(this.due(), (u) => u.kind === "first_steps" ? firstSteps(u.days)
      : u.kind === "limit_reached" ? limitReached(this.d.baseUrl, this.d.upgradeLink(u.id), u.opens)
      : u.kind === "change_limit" ? changeLimit(this.d.baseUrl, this.d.plusLink?.(u.id) ?? null, this.d.upgradeLink(u.id), u.opens) : checkInEmail());
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
    const pros = (this.d.db.prepare(`SELECT u.id, u.email, u.plan FROM users u WHERE ${payingSql("u.")}
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

  /** An announcement (announce.ts): the same footer and unsubscribe link, plus the postal address. */
  sendAnnouncement(to: string, m: { subject: string; text: string; html: string }, userId: string, once?: string): Promise<void> {
    return this.send(to, m, userId, once, this.d.mail?.postalAddress);
  }

  /** `once`: Resend's idempotency key (kept 24h), so a send that timed out after Resend took it isn't sent again an hour later. */
  private async send(to: string, m: { subject: string; text: string; html: string }, userId: string, once?: string, address?: string): Promise<void> {
    const unsub = this.unsubscribeUrl(userId);
    const footer = `You're getting this because you connected Camberstack (camberstack.io) to Google Ads.${address ? ` Camberstack, ${address}.` : ""}`;
    await sendMail(this.d.mail!.apiKey, {
      from: this.d.mail!.from, to: [to], reply_to: this.d.mail!.replyTo, subject: m.subject,
      text: `${m.text}\n\n--\n${footer}\nUnsubscribe: ${unsub}`,
      html: `${m.html}<hr style="border:0;border-top:1px solid #ddd;margin:28px 0 12px">
<p style="color:#777;font-size:13px">${footer} <a href="${unsub}" style="color:#777">Unsubscribe</a></p>`,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }, this.d.fetch, once);
  }

  /** Operator check: send one sample of each email to `to`, with placeholder links. */
  async preview(to: string): Promise<void> {
    await this.send(to, firstSteps(3), "preview");
    await this.send(to, limitReached(this.d.baseUrl, `${this.d.baseUrl}/account?upgrade=1`, "2026-11-13"), "preview");
    await this.send(to, changeLimit(this.d.baseUrl, `${this.d.baseUrl}/account?upgrade=plus`, `${this.d.baseUrl}/account?upgrade=1`, "2026-12-02"), "preview");
    await this.send(to, checkInEmail(), "preview");
    await this.send(to, welcome(this.d.baseUrl), "preview");
    await this.send(to, proWelcome(this.d.baseUrl, "pro"), "preview");
    await this.send(to, proWelcome(this.d.baseUrl, "plus"), "preview");
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

/** A stop at a plan limit: what happened, what would cover it, and that Free still works. Sent once per stop. */
function upgradeEmail(o: { subject: string; stopped: string; pitch: string; link: string | null; cta: string; free: string; base: string }) {
  const { stopped, pitch, link, free, base } = o;
  return {
    subject: o.subject,
    text: `Hi,

${stopped}

${pitch}${link ? `\n${link}\n(personal link, valid for 7 days)` : ` Upgrade from ${base}/account`}

${free} Your plan: ${base}/account

This is the only email about it. Questions? Just reply.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(stopped) + p(pitch)
      + `<p style="margin:0 0 18px"><a href="${link ?? `${base}/account?upgrade=1`}" style="display:inline-block;background:#1f5f4a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${o.cta}</a></p>`
      + p(`${free} Your plan is on <a href="${base}/account">your account page</a>.`)
      + p("This is the only email about it. Questions? Just reply.") + p("Adam<br>Camberstack")),
  };
}

function limitReached(base: string, upgrade: string | null, opens?: string) {
  // "November 13": the date the refusal named, in words. UTC so it's the same day the tool said.
  const when = opens && dateLabel(Date.parse(`${opens}T12:00:00Z`) / 1000);
  const stopped = `Camberstack stopped when you tried it on another Google Ads account. The Free plan covers one account at a time, `
    + `and another opens once your current one has gone ${ACCOUNT_WINDOW_DAYS} days unused${when ? `: on ${when}, if you don't use it before then` : ""}.`;
  const pro = `If you're working on more than one account, Camberstack Pro covers up to ${PRO_ACCOUNTS} accounts, for ${PRO_PRICE_LABEL}, `
    + `and Agency up to ${AGENCY_ACCOUNTS}, for ${AGENCY_PRICE_LABEL}; cancel any time.`;
  const free = `On Free, every tool and ${freeChangesShort()} keep working on your active account, and undo and history always work.`;
  return upgradeEmail({ subject: "Using Camberstack on more than one Google Ads account", stopped, pitch: pro, link: upgrade, cta: "Upgrade to Pro", free, base });
}

/** The change cap stopped an apply: when the next one opens (the date the stop named), and Plus's unlimited changes. */
function changeLimit(base: string, plus: string | null, upgrade: string | null, opens?: string) {
  const when = opens && dateLabel(Date.parse(`${opens}T12:00:00Z`) / 1000);
  const stopped = `Camberstack stopped a change you approved: the Free plan includes ${freeChanges()}, and you've used them`
    + `${when ? `. The next one opens on ${when}` : ""}. The proposal is still open, so nothing is lost.`;
  const pitch = plus
    ? `Camberstack Plus has unlimited changes on one Google Ads account, for ${PLUS_PRICE_LABEL}; cancel any time. Pro (${PRO_PRICE_LABEL}) does the same on up to ${PRO_ACCOUNTS} accounts.`
    : `Camberstack Pro has unlimited changes on up to ${PRO_ACCOUNTS} Google Ads accounts, for ${PRO_PRICE_LABEL}; cancel any time.`;
  const free = "On Free, every tool keeps working: asking, reading and proposing are never limited, and undo and history always work.";
  return upgradeEmail({ subject: "Your free Camberstack changes for this month", stopped, pitch, link: plus ?? upgrade, cta: plus ? "Get Plus" : "Upgrade to Pro", free, base });
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
  const plans = changeCap()
    ? `Free covers one Google Ads account, with ${freeChanges()}; Plus (${PLUS_PRICE_LABEL}) has unlimited changes on it, Pro (${PRO_PRICE_LABEL}) on up to ${PRO_ACCOUNTS} accounts, and Agency (${AGENCY_PRICE_LABEL}) up to ${AGENCY_ACCOUNTS}.`
    : `Free covers one Google Ads account; Pro (${PRO_PRICE_LABEL}) covers up to ${PRO_ACCOUNTS}, and Agency (${AGENCY_PRICE_LABEL}) up to ${AGENCY_ACCOUNTS}.`;
  return {
    subject: "Welcome to Camberstack",
    text: `Hi,

You're connected. You can now use Camberstack in Claude or ChatGPT.

A good first question: "${ask}" From there, ask about search terms, keywords and budgets. Nothing changes until you approve it, and almost every change can be undone from ${base}/account

Want to try it on sample data first? Ask: "Show me Camberstack's demo account."

${plans}

If anything doesn't work, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p("You're connected. You can now use Camberstack in Claude or ChatGPT.")
      + p(`A good first question: <em>“${ask}”</em> From there, ask about search terms, keywords and budgets. Nothing changes until you approve it, and almost every change can be undone from <a href="${base}/account">your account page</a>.`)
      + p(`Want to try it on sample data first? Ask: <em>“Show me Camberstack's demo account.”</em>`)
      + p(plans)
      + p("If anything doesn't work, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}

/** What a new subscription adds, what stays, and how billing works. */
function paidWelcome(o: { base: string; name: string; adds: string; addsHtml: string; billing: string; billingHtml: string }) {
  const { base, name } = o;
  const same = "every tool, unlimited changes, nothing applied until you approve it, and almost every change can be undone.";
  return {
    subject: `You're on Camberstack ${name}`,
    text: `Hi,

Thanks for subscribing to Camberstack ${name}. It's active now.

What ${name} adds: ${o.adds}

What stays the same: ${same}

Billing: ${o.billing}:
${base}/account

If anything doesn't work the way you expected, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`Thanks for subscribing to Camberstack ${name}. It's active now.`)
      + p(`<strong>What ${name} adds:</strong> ${o.addsHtml}`)
      + p(`<strong>What stays the same:</strong> ${same}`)
      + p(`<strong>Billing:</strong> ${o.billingHtml}`)
      + p("If anything doesn't work the way you expected, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}

/** Plus adds changes, not accounts: unlimited applied changes on the one account. */
function plusWelcome(base: string) {
  const adds = `unlimited applied changes on one Google Ads account${changeCap() ? `, where Free stops at ${changeCap()} every 30 days` : ""}. `
    + "Nothing else changes: every proposal still waits for your approval.";
  const billing = `${PLUS_PRICE_LABEL}, renewing monthly. You can see invoices, change your card, move to Pro for more accounts or cancel any time from`;
  return paidWelcome({ base, name: "Plus", adds, addsHtml: adds,
    billing: `${billing} your account page`, billingHtml: `${billing} <a href="${base}/account">your account page</a>.` });
}

/**
 * The welcome for a new subscriber, on the plan they bought (Pro or Agency; the kind stays pro_welcome for both).
 * Transactional: confirms the upgrade. Billing changes and cancelling live on /account (Stripe's portal), receipts come from Stripe.
 */
function proWelcome(base: string, plan: string) {
  if (plan === "plus") return plusWelcome(base);
  const ask = "List my Google Ads accounts";
  const [name, accounts, price] = plan === "agency" ? ["Agency", AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL] : ["Pro", PRO_ACCOUNTS, PRO_PRICE_LABEL];
  const billing = `${price}, renewing monthly. You can see invoices, change your card or cancel any time from`;
  return paidWelcome({ base, name,
    adds: `up to ${accounts} Google Ads accounts instead of 1. To use another one, ask in Claude or ChatGPT, e.g. "${ask}", then name the one you want.`,
    addsHtml: `up to ${accounts} Google Ads accounts instead of 1. To use another one, ask in Claude or ChatGPT, e.g. <em>“${ask}”</em>, then name the one you want.`,
    billing: `${billing} your account page`, billingHtml: `${billing} <a href="${base}/account">your account page</a>.` });
}
