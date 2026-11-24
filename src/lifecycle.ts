/**
 * Lifecycle emails, each sent at most once per user, through Resend:
 *   first_steps    connected 2–14 days ago and never asked anything real → the first question to ask, and the demo.
 *                  If their login has no Google Ads account (ads_accounts = 0, no manager), the same slot says so instead:
 *                  reconnect with the login that has one, or create one; Camberstack can't. Added 2026-11-16: a user with
 *                  no account got "ask about your campaigns" and replied he'd try it
 *   limit_reached  a tool refused a second Google Ads account (the Free plan's limit), still free the next morning (6+ hours later) → one note:
 *                  when another account opens, what Pro covers, the upgrade link
 *   (switch_wanted, sent when a Free user was stopped before spending the account switch, went with the switch on 2026-11-06;
 *                  its email_log rows still count as an upgrade email already sent)
 *   (service_limit, for the one-service gate, was removed with it on 2026-11-11 before it ever sent)
 *   change_limit   the change cap (FREE_CHANGE_CAP) stopped a Free user's apply, still free and still at the cap the next
 *                  morning (6+ hours later) →
 *                  when the next change opens, Plus's unlimited changes, the upgrade link. Once per user, but sent even after
 *                  another upgrade email: the cap is the main paywall, and this email is how ChatGPT users see the offer (2026-11-11)
 *                  limit_reached isn't sent after any upgrade email (limit_reached, switch_wanted or change_limit), nor
 *                  in the same run as change_limit
 *   paid_limit     a paying Plus or Pro user (Stripe, not complimentary) was refused another Google Ads account on that plan,
 *                  the next morning (6+ hours later) → one note: when another account opens, and the plan above (Plus → Pro,
 *                  Pro → Agency) with a personal link to switch. Once per user. Added 2026-11-12: a Pro user with 16 accounts was
 *                  refused, clicked Agency twice and got no email, since every other upgrade email is for Free only
 *   check_in       first applied a change to a real account 2–14 days ago → a personal note from Adam asking how it went (replies go to him)
 *   welcome        signed up (still Free) and their AI app finished connecting → the first question to ask, the demo, the plans
 *   pro_welcome    on a paid plan (Plus, Pro, Agency) with a Stripe subscription → what it adds, where billing lives
 *   plan_switch:<plan>  moved between paid plans in Stripe's billing portal (billing.ts sweep, a plan_events 'switch') after
 *                  pro_welcome → what the new plan covers, where billing lives. Once per plan switched to. Added 2026-11-24: a
 *                  Pro user moved to Agency and got no email, since pro_welcome goes once per user
 * Those three are transactional: sent within a minute (transactional(), every minute), not held for the morning.
 * The first five go out in the user's morning (SEND_HOURS in the time zone of their Google Ads account, or FALLBACK_TZ),
 * so being due only holds it until the next hourly run inside that window.
 * Never sent to internal accounts (ADMIN_EMAILS, PRO_EMAILS) or anyone who unsubscribed.
 * Spacing across kinds (2026-11-13: a Free user got limit_reached, then change_limit and check_in in the same minute, two
 * days later): at most one of these five per user per run, none within GAP_DAYS of any other email but the two transactional
 * ones (announcements, follow-ups and outreach count), and check_in not within CHECK_IN_AFTER_SALES_DAYS of an upgrade
 * email, so the personal note never reads as part of a sales sequence. When several are due, the upgrade email goes first
 * (the user is stuck now), then first_steps, then check_in; the windows run long enough that a held email still goes.
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
import { ACCOUNT_WINDOW_DAYS, AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL, CHANGE_LIMIT_PREFIX, FREE_TOOLS, PLAN_LIMIT_PREFIX, PLUS_PRICE_LABEL, changeCap, freeChanges, freeChangesShort, PRO_ACCOUNTS, PRO_PRICE_LABEL, PLUS_ACCOUNTS, dateLabel, payingSql, planLabel } from "./plans.js";
import { DEMO_CID } from "./demo.js";
import { capCounted } from "./session.js";
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
/** No lifecycle email within this many days of another email (transactional ones aside). */
const GAP_DAYS = 3;
/** check_in waits this long after an upgrade email. */
const CHECK_IN_AFTER_SALES_DAYS = 7;
/** Kinds that pitch a plan: the four upgrade emails, and the operator's personal notes about a limit (gaql-reliability outreach). */
const SALES_SQL = "(kind IN ('limit_reached','switch_wanted','change_limit','paid_limit') OR kind LIKE 'outreach:%')";
const PRIORITY: Record<string, number> = { limit_reached: 0, paid_limit: 0, change_limit: 0, first_steps: 1, check_in: 2 };
/** For users whose Google Ads time zone we never saw: 9am Central is 10 Eastern, 7 Pacific. */
const FALLBACK_TZ = "America/Chicago";

/** Hour of day (0–23) at `at` in `tz`; an unknown zone counts as FALLBACK_TZ. */
function localHour(at: Date, tz: string | null | undefined): number {
  const fmt = (zone: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(at));
  try { return fmt(tz || FALLBACK_TZ); } catch { return fmt(FALLBACK_TZ); }
}
type Kind = "first_steps" | "limit_reached" | "paid_limit" | "change_limit" | "check_in" | "welcome" | "pro_welcome" | `plan_switch:${string}`;
/** welcome shipped at this time (2026-10-14); everyone who signed up before it never gets one. */
const WELCOME_SINCE = 1792001873;
/** A welcome that hasn't gone out a day after signup (mail down that long) is dropped, not sent late. */
const WELCOME_WITHIN = DAY;
/**
 * Tools that don't mean someone has asked Camberstack something real: listing accounts, sites or properties, and account
 * housekeeping. Every other tool does. A list of the ones that count fell behind new tools (Tag Manager, analytics_setup,
 * landing_page_speed and ChatGPT's per-operation propose tools weren't on it, 2026-11-18).
 */
const NOT_USE = "('list_accounts','switch_account','choose_account','search_console_sites','analytics_properties','tag_manager_containers',"
  + "'merchant_accounts','billing','send_feedback','disconnect','change_history','discard_proposal')";

type Due = { kind: Kind; id: string; email: string; days: number; opens?: string; accounts?: number; error?: string; plan?: string; afterAccountEmail?: boolean; noAds?: boolean; stopped?: Stopped | null };

/** At most one email per user, by PRIORITY, and none too soon after the user's last email (see the header). */
function spaced(due: Due[], lastEmail: Map<string, number>, lastSales: Map<string, number>, t: number): Due[] {
  const out = new Map<string, Due>();
  for (const u of [...due].sort((a, b) => PRIORITY[a.kind]! - PRIORITY[b.kind]!)) {
    if (out.has(u.id)) continue;
    // change_limit answers something the user just did, so another email doesn't hold it: an announcement sent 5 hours
    // after a stop held one 3 days, and a "your change wasn't applied" email days late reads as out of sync (2026-11-24).
    if (u.kind !== "change_limit" && (lastEmail.get(u.id) ?? 0) > t - GAP_DAYS * DAY) continue;
    if (u.kind === "check_in" && (lastSales.get(u.id) ?? 0) > t - CHECK_IN_AFTER_SALES_DAYS * DAY) continue;
    out.set(u.id, u);
  }
  return [...out.values()];
}

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

  /**
   * Who is due each email right now. `only`: one user, sent by hand (sendNow): their morning and the 6 hours after a stop
   * don't apply; every other rule does.
   */
  private due(only?: string): Due[] {
    const t = now();
    const settle = only ? 0 : 6 * 3600;
    const eligible = `u.enc_refresh IS NOT NULL AND u.email_opt_out = 0 AND u.plan = 'free'`;
    const notSent = (k: string) => `NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = '${k}')`;
    const first = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, u.created_at,
      (u.ads_accounts = 0 AND coalesce(u.ads_managers, 0) = 0) no_ads FROM users u WHERE ${eligible}
      AND u.created_at BETWEEN ? AND ? AND ${notSent("first_steps")}
      AND NOT EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.error IS NULL AND c.tool NOT IN ${NOT_USE}
        AND NOT (c.tool = 'run_gaql' AND c.customer_id IS NULL))`)  // a run_gaql field lookup reads no account; error set = a notice or grant link, not use
      .all(t - (15 + GAP_DAYS) * DAY, t - 2 * DAY) as { id: string; email: string; time_zone: string | null; created_at: number; no_ads: number | null }[];
    // Refused a second account by the plan gate (session.ts checkAccount), the last refusal 6 hours to 30 days ago. A refusal
    // logs as ok since it became a notice (it was ok = 0 before), so it's matched on the text; Merchant ones by their wording.
    // A refusal means they're working on more than one account now (there is no switch since 2026-11-06): the next
    // morning, not days later. The 6 hours keep it from landing minutes after a refusal inside the
    // send window. `error` is the latest refusal's (SQLite takes bare columns from the max() row). A reset by hand cancels
    // the refusals before it: this email would say the account is still locked (sent minutes after one, 2026-10-16).
    /**
     * Each user's latest stop whose message starts with `prefix`, 6 hours to 31 days ago and since any reset of their plan.
     * `cols` adds user columns, `on` narrows the stops, `where` the users. `error` is the latest stop's (SQLite takes bare
     * columns from the max() row).
     */
    const lastStops = <R>(prefix: string, o: { cols?: string; on?: string; where: string }) => this.d.db.prepare(`SELECT u.id, u.email, u.time_zone${o.cols ?? ""}, max(c.at) last, c.error
      FROM users u JOIN tool_calls c ON c.user_id = u.id AND c.error LIKE ? AND c.at >= coalesce(u.plan_reset_at, 0)${o.on ?? ""}
      WHERE ${o.where}
      GROUP BY u.id HAVING last BETWEEN ? AND ?`)
      .all(`${prefix}%`, t - 31 * DAY, t - settle) as ({ id: string; email: string; time_zone: string | null; last: number; error: string } & R)[];
    const notMerchant = `
        AND coalesce(c.customer_id, '') NOT LIKE 'mc:%' AND c.error NOT LIKE '%Merchant Center account%'`;
    const limit = lastStops<object>(PLAN_LIMIT_PREFIX, { on: notMerchant,
      where: `${eligible} AND ${notSent("limit_reached")} AND ${notSent("switch_wanted")} AND ${notSent("change_limit")}` });
    // Stopped by the change cap (session.ts checkChangeCap), the last stop 6 hours to 30 days ago. Always on request: the
    // user approved the change that was stopped. `error` is the latest stop's, which names the date the next change opens.
    // Not held back by an earlier upgrade email (limit_reached etc.): only by its own.
    const changes = lastStops<{ plan_reset_at: number | null }>(CHANGE_LIMIT_PREFIX, { cols: ", u.plan_reset_at",
      where: `${eligible} AND ${notSent("change_limit")}` });
    // Only while they're still at the cap, with the date the next change opens as of now: the stop can be up to a month
    // old, its window may have rolled, and the cap may be off. Not at it: nothing now; a later stop sends it then.
    const cap = changeCap();
    const atCap = changes.flatMap((u) => {
      const used = cap ? capCounted(this.d.db, u.id, u.plan_reset_at, t) : [];
      if (!cap || used.length < cap) return [];
      return [{ ...u, opens: new Date((used[used.length - cap]! + ACCOUNT_WINDOW_DAYS * DAY) * 1000).toISOString().slice(0, 10) }];
    });
    // A paying Plus or Pro user refused another Ads account on that plan (the refusal names it: "; Pro covers 5 at a time"),
    // so a refusal from before they upgraded doesn't count. Comps have no stripe_sub; Agency has no plan above it.
    const paid = lastStops<{ plan: string }>(PLAN_LIMIT_PREFIX, { cols: ", u.plan",
      on: `
        AND instr(c.error, '; ' || CASE u.plan WHEN 'pro' THEN 'Pro' ELSE 'Plus' END || ' covers ') > 0${notMerchant}`,
      where: `u.enc_refresh IS NOT NULL AND u.email_opt_out = 0 AND u.plan IN ('plus', 'pro') AND coalesce(u.stripe_sub, '') != ''
        AND ${notSent("paid_limit")}` });
    // First applied change to a real account (not the demo, not an undo) 2–14 days ago; any plan, connected or not.
    const checkIn = this.d.db.prepare(`SELECT u.id, u.email, u.time_zone, min(p.applied_at) first FROM users u
      JOIN proposals p ON p.user_id = u.id AND p.status = 'applied' AND p.undo_of IS NULL AND p.customer_id <> ? AND p.customer_id <> 'mc:${DEMO_MERCHANT}'
      WHERE u.email_opt_out = 0 AND ${notSent("check_in")}
      GROUP BY u.id HAVING first BETWEEN ? AND ?`)
      .all(DEMO_CID, t - (15 + CHECK_IN_AFTER_SALES_DAYS) * DAY, t - 2 * DAY) as { id: string; email: string; time_zone: string | null; first: number }[];
    // Upper bounds carry a day past the nominal window (waiting for their morning can take up to ~21h), plus the longest
    // spacing hold below, so a held email still goes.
    const at = this.d.clock?.() ?? new Date();
    const morning = (u: { time_zone: string | null }) => { const h = localHour(at, u.time_zone); return h >= SEND_HOURS.from && h < SEND_HOURS.to; };
    const ok = (u: { id: string; email: string; time_zone: string | null }) => !this.d.internalEmails.has(u.email.toLowerCase())
      && (only ? u.id === only : morning(u));
    const latest = (where: string) => new Map((this.d.db.prepare(`SELECT user_id, max(sent_at) at FROM email_log WHERE ${where} GROUP BY user_id`)
      .all() as { user_id: string; at: number }[]).map((r) => [r.user_id, r.at]));
    const lastEmail = latest("kind NOT IN ('welcome','pro_welcome') AND kind NOT LIKE 'plan_switch:%'");
    const lastSales = latest(SALES_SQL);
    const accountEmailed = new Set(latest("kind IN ('limit_reached','switch_wanted')").keys());
    const due = [
      ...first.filter(ok).map((u) => ({ kind: "first_steps" as const, id: u.id, email: u.email, days: Math.floor((t - u.created_at) / DAY), noAds: u.no_ads === 1 })),
      // Every refusal's text names when another account opens (session.ts refuse: "opens on YYYY-MM-DD"; before 0.29.0 "the next opens YYYY-MM-DD").
      // Both stops by the same morning: change_limit only, so one upgrade email, not two.
      ...limit.filter((u) => ok(u) && !atCap.some((c) => c.id === u.id)).map((u) => ({ kind: "limit_reached" as const, id: u.id, email: u.email, days: 0,
        opens: /opens (?:again )?(?:on )?(\d{4}-\d{2}-\d{2})/.exec(u.error)?.[1] })),
      ...paid.filter(ok).filter((u) => u.plan === "plus" || this.d.agencyLink?.(u.id)).map((u) => ({ kind: "paid_limit" as const, id: u.id, email: u.email, days: 0, plan: u.plan,
        opens: /opens (?:on )?(\d{4}-\d{2}-\d{2})/.exec(u.error)?.[1] })),
      ...atCap.filter(ok).map((u) => ({ kind: "change_limit" as const, id: u.id, email: u.email, days: 0, opens: u.opens,
        afterAccountEmail: accountEmailed.has(u.id), stopped: this.stoppedProposal(u.id, u.error) })),
      ...checkIn.filter(ok).map((u) => ({ kind: "check_in" as const, id: u.id, email: u.email, days: 0 })),
    ];
    return spaced(due, lastEmail, lastSales, t);
  }

  /** Hourly. */
  async run(): Promise<number> {
    if (!this.d.mail) return 0;
    return this.deliver(this.due(), (u) => this.render(u));
  }

  /** What sendNow would send this user: kind and email, nothing logged or sent (lifecycle-send.ts's dry run). */
  pending(userId: string): { kind: Kind; email: { subject: string; text: string; html: string } }[] {
    return this.due(userId).map((u) => ({ kind: u.kind, email: this.render(u) }));
  }

  /** Send the one email this user is due now, outside their morning and the 6 hours after a stop (lifecycle-send.ts). */
  async sendNow(userId: string): Promise<number> {
    if (!this.d.mail) return 0;
    return this.deliver(this.due(userId), (u) => this.render(u));
  }

  private render(u: Due): { subject: string; text: string; html: string } {
    return u.kind === "first_steps" ? (u.noAds ? noAdsAccount(u.days) : firstSteps(u.days))
      : u.kind === "limit_reached" ? limitReached(this.d.baseUrl, this.d.upgradeLink(u.id), u.opens)
      : u.kind === "paid_limit" ? paidLimit(this.d.baseUrl, u.plan === "pro" ? "pro" : "plus",
        u.plan === "pro" ? this.d.agencyLink?.(u.id) ?? null : this.d.upgradeLink(u.id), u.opens)
      : u.kind === "change_limit" ? changeLimit(this.d.baseUrl, this.d.plusLink?.(u.id) ?? null, this.d.upgradeLink(u.id), u.opens, u.afterAccountEmail, u.stopped) : checkInEmail();
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
    // A switch made after their pro_welcome went (one in the same minute as the first purchase is covered by it), to the plan
    // they're on now, at most a day ago (mail down that long: dropped, not sent late). Latest switch first, so it's the one claimed.
    const switched = (this.d.db.prepare(`SELECT u.id, u.email, u.plan, e.src FROM users u
      JOIN plan_events e ON e.user_id = u.id AND e.kind = 'switch' AND e.at >= ? AND e.src LIKE '%>' || u.plan
      WHERE ${payingSql("u.")} AND u.email_opt_out = 0
        AND EXISTS (SELECT 1 FROM email_log w WHERE w.user_id = u.id AND w.kind = 'pro_welcome' AND w.sent_at <= e.at)
        AND NOT EXISTS (SELECT 1 FROM email_log s WHERE s.user_id = u.id AND s.kind = 'plan_switch:' || u.plan)
      ORDER BY e.at DESC`)
      .all(now() - DAY) as { id: string; email: string; plan: string; src: string }[])
      .filter((u) => !this.d.internalEmails.has(u.email.toLowerCase()));
    return await this.deliver(fresh.map((u) => ({ ...u, kind: "welcome" as const, days: 0 })), () => welcome(this.d.baseUrl))
      + await this.deliver(pros.map((u) => ({ ...u, kind: "pro_welcome" as const, days: 0 })), (u) => proWelcome(this.d.baseUrl, u.plan))
      + await this.deliver(switched.map((u) => ({ ...u, kind: `plan_switch:${u.plan}` as const, days: 0 })),
        (u) => planSwitch(this.d.baseUrl, u.src.split(">")[0]!, u.plan));
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
  /**
   * The proposals the change cap stopped (named in the stop: "Proposal p_… stays open", or "Proposals p_…, p_… stay open" when
   * merged), as a count and change types only: never their summaries, which hold Google Ads data the privacy policy keeps out of
   * other services (email goes through Resend).
   */
  private stoppedProposal(userId: string, error?: string): Stopped | null {
    const ids = /Proposals? ((?:p_[\w-]+(?:, )?)+) stays? open/.exec(error ?? "")?.[1]?.split(", ") ?? [];
    const get = this.d.db.prepare("SELECT changes, status FROM proposals WHERE id = ? AND user_id = ?");
    const types: string[] = [];
    let open = false;
    for (const id of ids) {
      const row = get.get(id, userId) as { changes: string; status: string } | undefined;
      if (!row) continue;
      try { types.push(...(JSON.parse(row.changes) as { type?: string }[]).map((c) => c.type ?? "")); } catch { continue; }
      if (row.status === "proposed") open = true;
    }
    if (!types.length) return null;
    return { changes: types.length, kinds: [...new Set(types.filter(Boolean).map((t) => t.replaceAll("_", " ")))].slice(0, 3), open };
  }

  async preview(to: string): Promise<void> {
    await this.send(to, firstSteps(3), "preview");
    await this.send(to, limitReached(this.d.baseUrl, `${this.d.baseUrl}/account?upgrade=1`, "2026-11-13"), "preview");
    await this.send(to, changeLimit(this.d.baseUrl, `${this.d.baseUrl}/account?upgrade=plus`, `${this.d.baseUrl}/account?upgrade=1`, "2026-12-02"), "preview");
    await this.send(to, checkInEmail(), "preview");
    await this.send(to, welcome(this.d.baseUrl), "preview");
    await this.send(to, proWelcome(this.d.baseUrl, "pro"), "preview");
    await this.send(to, proWelcome(this.d.baseUrl, "plus"), "preview");
    await this.send(to, planSwitch(this.d.baseUrl, "pro", "agency"), "preview");
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

/** first_steps for a login with no Google Ads account: the campaign question would only get "no accounts". No demo pitch (nobody uses it). */
function noAdsAccount(days: number) {
  const ago = `${days} days ago`;
  return {
    subject: "Camberstack can't find a Google Ads account",
    text: `Hi,

You connected Camberstack ${ago}, but the Google login you used doesn't have access to any Google Ads account, so there's nothing for it to work with yet.

If your Google Ads account is under a different Google login (a work one, say): disconnect Camberstack in Claude or ChatGPT, connect again, and choose that login when Google asks. In Google Ads, Admin > Access and security shows which logins have access.

If you don't have a Google Ads account yet, you'd create one at ads.google.com first. Camberstack works with an existing account and can't set one up for you.

If it's neither, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`You connected Camberstack ${ago}, but the Google login you used doesn't have access to any Google Ads account, so there's nothing for it to work with yet.`)
      + p("If your Google Ads account is under a different Google login (a work one, say): disconnect Camberstack in Claude or ChatGPT, connect again, and choose that login when Google asks. In Google Ads, <strong>Admin</strong> &gt; <strong>Access and security</strong> shows which logins have access.")
      + p(`If you don't have a Google Ads account yet, you'd create one at <a href="https://ads.google.com">ads.google.com</a> first. Camberstack works with an existing account and can't set one up for you.`)
      + p("If it's neither, just reply. I read every email.") + p("Adam<br>Camberstack")),
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

I won't email you about this limit again. Questions? Just reply.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(stopped) + p(pitch)
      + `<p style="margin:0 0 18px"><a href="${link ?? `${base}/account?upgrade=1`}" style="display:inline-block;background:#1f5f4a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${o.cta}</a></p>`
      + p(`${free} Your plan is on <a href="${base}/account">your account page</a>.`)
      + p("I won't email you about this limit again. Questions? Just reply.") + p("Adam<br>Camberstack")),
  };
}

/** "November 13" for a YYYY-MM-DD the tool named, read in UTC so it's the same day; nothing without one. */
const whenLabel = (opens?: string) => opens && dateLabel(Date.parse(`${opens}T12:00:00Z`) / 1000);

function limitReached(base: string, upgrade: string | null, opens?: string) {
  // "November 13": the date the refusal named, in words. UTC so it's the same day the tool said.
  const when = whenLabel(opens);
  const stopped = `Camberstack stopped when you tried it on another Google Ads account. The Free plan covers one account at a time, `
    + `and another opens once your current one has gone ${ACCOUNT_WINDOW_DAYS} days unused${when ? `: on ${when}, if you don't use it before then` : ""}.`;
  const pro = `If you're working on more than one account, Camberstack Pro covers up to ${PRO_ACCOUNTS} accounts, for ${PRO_PRICE_LABEL}, `
    + `and Agency up to ${AGENCY_ACCOUNTS}, for ${AGENCY_PRICE_LABEL}; cancel any time.`;
  const free = `On Free, ${FREE_TOOLS} and ${freeChangesShort()} keep working on your active account, and undo and history always work.`;
  return upgradeEmail({ subject: "Using Camberstack on more than one Google Ads account", stopped, pitch: pro, link: upgrade, cta: "Upgrade to Pro", free, base });
}

/** A paying Plus or Pro user was refused another account: when one opens, and the plan above with its link (Stripe's billing portal switches the subscription). */
function paidLimit(base: string, plan: "plus" | "pro", link: string | null, opens?: string) {
  const when = whenLabel(opens);
  const [name, covers] = plan === "pro" ? ["Pro", PRO_ACCOUNTS] : ["Plus", 1];
  const [next, nextCovers, price] = plan === "pro" ? ["Agency", AGENCY_ACCOUNTS, AGENCY_PRICE_LABEL] : ["Pro", PRO_ACCOUNTS, PRO_PRICE_LABEL];
  const stopped = `Camberstack stopped when you tried it on another Google Ads account. Your ${name} plan covers ${covers === 1 ? "one account" : `${covers} accounts`} at a time, `
    + `and another opens once one of them has gone ${ACCOUNT_WINDOW_DAYS} days unused${when ? `: on ${when}, if it isn't used before then` : ""}.`;
  const pitch = `If you're working on more accounts than that, ${next} covers up to ${nextCovers}, for ${price}. You can switch with the link below; cancel any time.`;
  const keep = `On ${name}, everything keeps working on your active account${covers === 1 ? "" : "s"} as it does now.`;
  return upgradeEmail({ subject: "Using Camberstack on more Google Ads accounts", stopped, pitch: pitch, link, cta: `Switch to ${next}`, free: keep, base });
}

/** What the cap stopped, without its Ads data: how many changes and of which types, and whether it's still waiting. */
type Stopped = { changes: number; kinds: string[]; open: boolean };

/**
 * The change cap stopped an apply (copy: operator, 2026-11-23). Leads with what they approved and that it's waiting; waiting for
 * the next free change is one line at the end. The old copy ("nothing is lost", "reading and proposing are never limited")
 * argued against paying, and its 2 recipients didn't click. `afterAccountEmail`: limit_reached (or switch_wanted) went earlier.
 */
function changeLimit(base: string, plus: string | null, upgrade: string | null, opens?: string, afterAccountEmail = false, stopped: Stopped | null = null) {
  const when = whenLabel(opens);
  const many = (stopped?.changes ?? 1) > 1;
  const what = stopped ? `${many ? `${stopped.changes} changes` : "a change"}${stopped.kinds.length ? ` (${stopped.kinds.join(", ")})` : ""}` : "a change";
  const waiting = !stopped || stopped.open;
  const head = `${afterAccountEmail ? "This is a different limit from the one-account one I wrote about before. " : ""}You approved ${what} in Camberstack, `
    + `but ${many ? "they weren't" : "it wasn't"} applied: Free includes ${freeChanges()} and you've used them.${waiting ? ` ${many ? "They're" : "It's"} still waiting, ready to go.` : ""}`;
  const now = waiting ? `applies ${many ? "them" : "it"} now` : "has";
  const pitch = plus
    ? `Plus ${now}${waiting ? ", with" : ""} unlimited changes on one Google Ads account, for ${PLUS_PRICE_LABEL}. Cancel any time.`
    : `Pro ${now}${waiting ? ", with" : ""} unlimited changes on up to ${PRO_ACCOUNTS} Google Ads accounts, for ${PRO_PRICE_LABEL}. Cancel any time.`;
  const cta = plus ? (waiting ? `Apply ${many ? "them" : "it"} with Plus` : "Get Plus") : (waiting ? `Apply ${many ? "them" : "it"} with Pro` : "Upgrade to Pro");
  const link = plus ?? upgrade;
  const wait = `${when ? `If you'd rather wait, your next free change opens on ${when}. ` : ""}Questions? Just reply.`;
  return {
    subject: "Your Google Ads change wasn't applied",
    text: `Hi,

${head}

${pitch}
${link ? `${link}\n(personal link, valid for 7 days)` : `${base}/account?upgrade=1`}

${wait}

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(head) + p(pitch)
      + `<p style="margin:0 0 18px"><a href="${link ?? `${base}/account?upgrade=1`}" style="display:inline-block;background:#1f5f4a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${cta}</a></p>`
      + p(wait) + p("Adam<br>Camberstack")),
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
  const same = `every tool and Google service, ${changeCap() ? "" : "unlimited changes, "}nothing applied until you approve it, and almost every change can be undone.`;
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
  const adds = `unlimited applied changes on one Google Ads account${changeCap() ? ` (Free stops at ${changeCap()} every 30 days)` : ""}, and the trend report: ask what changed lately, and it shows which campaigns moved, on what day, and what was changed around then. `
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
    adds: `${changeCap() ? "unlimited applied changes, on " : ""}up to ${accounts} Google Ads accounts instead of 1. To use another one, ask in Claude or ChatGPT, e.g. "${ask}", then name the one you want.`,
    addsHtml: `${changeCap() ? "unlimited applied changes, on " : ""}up to ${accounts} Google Ads accounts instead of 1. To use another one, ask in Claude or ChatGPT, e.g. <em>“${ask}”</em>, then name the one you want.`,
    billing: `${billing} your account page`, billingHtml: `${billing} <a href="${base}/account">your account page</a>.` });
}

/**
 * A move between paid plans in Stripe's billing portal (plan_switch:<plan>): what the plan now covers, and where billing lives.
 * Transactional, like pro_welcome. Says nothing about proration or charges: those follow the portal's settings, and Stripe sends the invoice.
 */
function planSwitch(base: string, from: string, to: string) {
  const name = planLabel(to), was = planLabel(from);
  const [price, covers] = to === "plus" ? [PLUS_PRICE_LABEL, `unlimited applied changes on ${PLUS_ACCOUNTS} Google Ads account`]
    : [to === "agency" ? AGENCY_PRICE_LABEL : PRO_PRICE_LABEL,
      `${changeCap() ? "unlimited applied changes, on " : ""}up to ${to === "agency" ? AGENCY_ACCOUNTS : PRO_ACCOUNTS} Google Ads accounts`];
  const ask = "List my Google Ads accounts";
  const use = to === "plus" ? "" : ` To use another account, ask in Claude or ChatGPT, e.g. "${ask}", then name the one you want.`;
  const useHtml = to === "plus" ? "" : ` To use another account, ask in Claude or ChatGPT, e.g. <em>“${ask}”</em>, then name the one you want.`;
  const billing = `${price}, renewing monthly. You can see invoices, change your card or plan, or cancel any time from`;
  return {
    subject: `You're now on Camberstack ${name}`,
    text: `Hi,

Your Camberstack plan changed from ${was} to ${name}. It's active now.

${name} covers: ${covers}.${use}

Billing: ${billing} your account page:
${base}/account

If anything doesn't work the way you expected, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`Your Camberstack plan changed from ${was} to ${name}. It's active now.`)
      + p(`<strong>${name} covers:</strong> ${covers}.${useHtml}`)
      + p(`<strong>Billing:</strong> ${billing} <a href="${base}/account">your account page</a>.`)
      + p("If anything doesn't work the way you expected, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}
