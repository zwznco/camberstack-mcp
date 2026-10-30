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
 */
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
}

const COOKIE = "cs_click";
const MAX_AGE = 90 * 86400;
const KINDS = ["gclid", "gbraid", "wbraid"] as const;
type Kind = typeof KINDS[number];
const MAX_ATTEMPTS = 8;

export class AdConversions {
  constructor(private db: DB, private cfg: ConversionConfig | undefined, private secure: boolean, private f: typeof fetch = fetch) {}

  /** On any page view: keep an ad click id if the URL carries one. */
  captureClick(req: Request, res: Response): void {
    for (const kind of KINDS) {
      const v = req.query[kind];
      if (typeof v === "string" && /^[A-Za-z0-9_\-.~]{10,300}$/.test(v)) {
        res.append("Set-Cookie", `${COOKIE}=${kind}:${v}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`);
        res.setHeader("Cache-Control", "private, no-store");  // a page that sets a per-visitor cookie must not be shared-cached
        return;
      }
    }
  }

  /** After a successful Google Ads connection: record the conversion for a first-time user, then try to upload it. */
  record(req: Request, res: Response, userId: string, firstConnection: boolean): void {
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

  private flushing = false;

  /** Upload every pending conversion (new ones, and failures under the retry cap). One flush at a time, or a
   *  record() during the hourly flush would upload the same click twice and log Google's rejection as an error. */
  async flush(): Promise<void> {
    if (!this.cfg || this.flushing) return;
    this.flushing = true;
    try { await this.flushPending(this.cfg); } finally { this.flushing = false; }
  }

  private async flushPending(cfg: ConversionConfig): Promise<void> {
    const pending = this.db.prepare(`SELECT * FROM ad_conversions WHERE uploaded_at IS NULL AND attempts < ? ORDER BY at`).all(MAX_ATTEMPTS) as
      { user_id: string; kind: Kind; click_id: string; at: number }[];
    for (const p of pending) {
      try {
        const res = await this.f(cfg.opsUrl, { method: "POST",
          headers: { Authorization: `Bearer ${cfg.opsKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ conversion_action_id: cfg.actionId, [p.kind]: p.click_id, conversion_time: new Date(p.at * 1000).toISOString() }) });
        if (res.status !== 202) throw new Error(`operations ${res.status}: ${(await res.text()).slice(0, 300)}`);
        // Handed over: operations uploads it, retries it, and mails the operator if Google rejects it.
        this.db.prepare("UPDATE ad_conversions SET uploaded_at = ?, error = NULL, attempts = attempts + 1 WHERE user_id = ?").run(now(), p.user_id);
      } catch (e) {
        this.db.prepare("UPDATE ad_conversions SET error = ?, attempts = attempts + 1 WHERE user_id = ?").run((e as Error).message.slice(0, 500), p.user_id);
      }
    }
  }
}
