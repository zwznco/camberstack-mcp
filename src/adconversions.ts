/**
 * Our own Google Ads campaign's conversions, measured without a Google tag (the site promises no
 * third-party scripts). Same pattern as theqrcode and redbudway: keep the ad click id, upload it when
 * the thing we pay for happens.
 *
 *  1. A visitor lands from one of our ads: Google appends gclid (or gbraid/wbraid on iOS) to the URL.
 *     captureClick() keeps it in a first-party, HttpOnly cookie for 90 days (the conversion window).
 *  2. The same browser finishes "Connect Google Ads" (the OAuth callback): record() ties the click to
 *     that user, once, on their FIRST connection only.
 *  3. flush() hands it to operations (~/operations, http://operations:3000), the operator's service that
 *     uploads the fleet's conversions through Google's Data Manager API, with this app's own key, exactly
 *     as theqrcode and redbudway do. Nothing about the user travels
 *     with it. Until 2026-10-16 this uploaded with its own refresh token (CONV_ADS_*), which died unnoticed,
 *     and Google now refuses UploadClickConversions from new projects anyway.
 *     Failures stay in the table and the hourly sweep retries them, so nothing is lost while the relay is down.
 *
 * ChatGPT Ads (2026-11-15) work the same way with OpenAI's click reference. Our campaigns' tracking template adds
 * `utm_source=openai&click_id={oppref}`; the reference is kept as kind "oppref" and handed to operations' second
 * endpoint, which sends it to OpenAI's Conversions API. Two events go out for such a user: the first connection, and
 * the first paid plan if it starts within OpenAI's 30-day window (paid()). Still nothing about the user travels.
 * The connection goes out only once list_accounts has read at least one real Google Ads account for that login
 * (users.ads_accounts > 0), so the hourly sweep sends it, not the OAuth callback. Before 2026-11-22 every connect was
 * sent: 9 of 10 ad-attributed connects had no Ads account (ChatGPT users curious about "Google Ads", not advertisers),
 * and the LatAm ES campaign's oCPC bidding was learning to find more of them. Google's kinds are unchanged.
 */
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { readCookie } from "./http.js";

export interface ConversionConfig {
  /** http://operations:3000/v1/conversions */
  opsUrl: string;
  /** This app's crk_ key on operations, limited to actionId. */
  opsKey: string;
  /** Our "Google Ads connected" conversion action in 386-283-8095. */
  actionId: string;
  /** http://operations:3000/v1/openai-conversions, same key. Unset = ChatGPT Ads clicks are kept but not sent. */
  openaiUrl?: string;
  /** This site, for the page URL OpenAI requires on a web event. */
  siteUrl?: string;
}

const COOKIE = "cs_click";
/**
 * `?ref=<slug>` on any link we place for free (a YouTube description, a post): kept 90 days and written to
 * users.signup_ref at the first connection from that browser (2026-11-24, for the YouTube test in
 * ~/scripts/seo/audits/camberstack.md). Nothing is uploaded anywhere; it only answers "where did they come from".
 */
const REF_COOKIE = "cs_ref";
const MAX_AGE = 90 * 86400;
const GOOGLE_KINDS = ["gclid", "gbraid", "wbraid"] as const;
const KINDS = [...GOOGLE_KINDS, "oppref"] as const;
type Kind = typeof KINDS[number];
const MAX_ATTEMPTS = 8;
/** OpenAI credits a conversion to a click for 30 days (our event settings' attribution window). */
const OPENAI_WINDOW = 30 * 86400;
const PLAN_CENTS: Record<string, number> = { plus: 700, pro: 1500, agency: 4900 };
/** An id for OpenAI to dedupe on that isn't our user id. */
const eventId = (what: string, userId: string) => `${what}_${createHash("sha256").update(`${what}:${userId}`).digest("hex").slice(0, 40)}`;

export class AdConversions {
  constructor(private db: DB, private cfg: ConversionConfig | undefined, private secure: boolean, private f: typeof fetch = fetch) {}

  /** On any page view: keep an ad click id if the URL carries one, and a `ref` (where an unpaid link came from). */
  captureClick(req: Request, res: Response): void {
    const ref = req.query.ref;
    if (typeof ref === "string" && /^[a-z0-9][a-z0-9_-]{1,39}$/i.test(ref)) {
      res.append("Set-Cookie", `${REF_COOKIE}=${ref.toLowerCase()}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`);
      res.setHeader("Cache-Control", "private, no-store");
    }
    const keep = (kind: Kind, v: string) => {
      res.append("Set-Cookie", `${COOKIE}=${kind}:${encodeURIComponent(v)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`);
      res.setHeader("Cache-Control", "private, no-store");  // a page that sets a per-visitor cookie must not be shared-cached
    };
    for (const kind of GOOGLE_KINDS) {
      const v = req.query[kind];
      if (typeof v === "string" && /^[A-Za-z0-9_\-.~]{10,300}$/.test(v)) return keep(kind, v);
    }
    // ChatGPT Ads: OpenAI's reference is opaque, so any printable value is kept as it came (the cookie value is encoded).
    const o = req.query.click_id;
    if (req.query.utm_source === "openai" && typeof o === "string" && /^[\x21-\x7E]{6,1000}$/.test(o)) keep("oppref", o);
  }

  /** After a successful Google Ads connection: record the conversion for a first-time user, then try to upload it. */
  record(req: Request, res: Response, userId: string, firstConnection: boolean): void {
    const ref = readCookie(req, REF_COOKIE);
    if (ref) {
      res.append("Set-Cookie", `${REF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${this.secure ? "; Secure" : ""}`);
      if (firstConnection && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(ref)) {
        this.db.prepare("UPDATE users SET signup_ref = ? WHERE id = ? AND signup_ref IS NULL").run(ref, userId);
      }
    }
    const raw = readCookie(req, COOKIE);
    if (!raw) return;
    res.append("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${this.secure ? "; Secure" : ""}`);
    if (!firstConnection) return;
    const [kind, ...rest] = raw.split(":");
    const clickId = rest.join(":");
    if (!KINDS.includes(kind as Kind) || !clickId) return;
    this.db.prepare(`INSERT OR IGNORE INTO ad_conversions (user_id, kind, click_id, at) VALUES (?, ?, ?, ?)`)
      .run(userId, kind, clickId, now());
    void this.flush().catch(() => { /* retried by the sweep */ });
  }

  /**
   * A user's first paid plan (billing.ts, once per subscription): if they came from a ChatGPT ad within OpenAI's
   * window, report it as that click's second conversion. Google gets no paid event: its action counts connections.
   */
  paid(userId: string, plan: string): void {
    const c = this.db.prepare("SELECT at FROM ad_conversions WHERE user_id = ? AND kind = 'oppref'").get(userId) as { at: number } | undefined;
    if (!c || now() - c.at > OPENAI_WINDOW) return;
    this.db.prepare("INSERT OR IGNORE INTO ad_paid (user_id, plan, at) VALUES (?, ?, ?)").run(userId, plan, now());
    void this.flush().catch(() => { /* retried by the sweep */ });
  }

  private flushing = false;

  /** Upload every pending conversion (new ones, and failures under the retry cap). One flush at a time, or a
   *  record() during the hourly flush would upload the same click twice and log Google's rejection as an error. */
  async flush(): Promise<void> {
    if (!this.cfg || this.flushing) return;
    this.flushing = true;
    try { await this.flushPending(this.cfg); } finally { this.flushing = false; }
  }

  private async flushPending(cfg: ConversionConfig): Promise<void> {
    // A ChatGPT Ads connect waits until the login is known to hold a real Ads account, and inside OpenAI's window.
    const pending = this.db.prepare(`SELECT c.* FROM ad_conversions c JOIN users u ON u.id = c.user_id
      WHERE c.uploaded_at IS NULL AND c.attempts < ?
        AND (c.kind <> 'oppref' OR (coalesce(u.ads_accounts, 0) > 0 AND c.at > ?)) ORDER BY c.at`).all(MAX_ATTEMPTS, now() - OPENAI_WINDOW) as
      { user_id: string; kind: Kind; click_id: string; at: number }[];
    for (const p of pending) {
      if (p.kind === "oppref" && !cfg.openaiUrl) continue;  // kept; goes out once the endpoint is configured
      try {
        const res = p.kind === "oppref"
          ? await this.openai(cfg, { event: "registration_completed", event_id: eventId("connect", p.user_id), oppref: p.click_id, at: p.at, path: "/google-ads-chatgpt" })
          : await this.f(cfg.opsUrl, { method: "POST",
            headers: { Authorization: `Bearer ${cfg.opsKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ conversion_action_id: cfg.actionId, [p.kind]: p.click_id, conversion_time: new Date(p.at * 1000).toISOString() }) });
        if (res.status !== 202) throw new Error(`operations ${res.status}: ${(await res.text()).slice(0, 300)}`);
        // Handed over: operations uploads it, retries it, and mails the operator if Google rejects it.
        this.db.prepare("UPDATE ad_conversions SET uploaded_at = ?, error = NULL, attempts = attempts + 1 WHERE user_id = ?").run(now(), p.user_id);
      } catch (e) {
        this.db.prepare("UPDATE ad_conversions SET error = ?, attempts = attempts + 1 WHERE user_id = ?").run((e as Error).message.slice(0, 500), p.user_id);
      }
    }
    if (!cfg.openaiUrl) return;
    const paid = this.db.prepare(`SELECT a.user_id, a.plan, a.at, c.click_id FROM ad_paid a JOIN ad_conversions c ON c.user_id = a.user_id AND c.kind = 'oppref'
      WHERE a.uploaded_at IS NULL AND a.attempts < ? ORDER BY a.at`).all(MAX_ATTEMPTS) as { user_id: string; plan: string; at: number; click_id: string }[];
    for (const p of paid) {
      try {
        const cents = PLAN_CENTS[p.plan];
        const res = await this.openai(cfg, { event: "subscription_created", event_id: eventId("paid", p.user_id), oppref: p.click_id, at: p.at, path: "/plans",
          plan_id: p.plan, ...(cents ? { amount: cents, currency: "USD" } : {}) });
        if (res.status !== 202) throw new Error(`operations ${res.status}: ${(await res.text()).slice(0, 300)}`);
        this.db.prepare("UPDATE ad_paid SET uploaded_at = ?, error = NULL, attempts = attempts + 1 WHERE user_id = ?").run(now(), p.user_id);
      } catch (e) {
        this.db.prepare("UPDATE ad_paid SET error = ?, attempts = attempts + 1 WHERE user_id = ?").run((e as Error).message.slice(0, 500), p.user_id);
      }
    }
  }

  /** One ChatGPT Ads event to operations, which sends it to OpenAI. */
  private openai(cfg: ConversionConfig, e: { event: string; event_id: string; oppref: string; at: number; path: string; plan_id?: string; amount?: number; currency?: string }): Promise<globalThis.Response> {
    const { at, path, ...rest } = e;
    return this.f(cfg.openaiUrl!, { method: "POST",
      headers: { Authorization: `Bearer ${cfg.opsKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, time: new Date(at * 1000).toISOString(), source_url: `${(cfg.siteUrl ?? "https://camberstack.io").replace(/\/$/, "")}${path}` }) });
  }
}
