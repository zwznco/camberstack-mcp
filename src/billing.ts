/**
 * Pro billing: a Stripe Checkout subscription, no webhook.
 *
 * The user is in a chat, not on our site, so every billing link we hand out is a signed, expiring,
 * per-user URL (the AI shows it; the user clicks it). Paying lands on /upgraded, which verifies the
 * Checkout Session server-side and flips the plan. Two things that page can't see are covered by an
 * hourly sweep against Stripe: a buyer who pays
 * and closes the tab, and a subscription that later ends (cancelled at period end, unpaid).
 * past_due stays Pro while Stripe retries the card.
 */
import type { Express, Request, Response } from "express";
import type { DB, UserRow } from "./db.js";
import { now } from "./db.js";
import { safeEqual, sign } from "./crypto.js";
import { esc } from "./pages.js";
import { PRO_ACCOUNTS } from "./plans.js";

const LINK_TTL = 7 * 86400;
/** Subscription statuses that keep Pro (past_due: Stripe is still retrying the card). */
const LIVE = new Set(["active", "trialing", "past_due"]);
const APP = "camberstack-mcp";

export interface BillingDeps {
  db: DB;
  baseUrl: string;
  /** Signs billing links; derived from ENCRYPTION_KEY so no new secret is needed. */
  signingKey: Buffer;
  stripe?: { secretKey: string; proPriceId: string };
  fetch?: typeof fetch;
}

export class Billing {
  constructor(private d: BillingDeps) {}

  get enabled(): boolean { return Boolean(this.d.stripe?.secretKey && this.d.stripe.proPriceId); }

  private sign(payload: string): string {
    return sign(this.d.signingKey, `billing:${payload}`);
  }

  /** A link for one user, valid for a week. Null when billing isn't configured. */
  link(kind: "upgrade" | "billing", userId: string): string | null {
    if (!this.enabled) return null;
    const payload = `${userId}.${now() + LINK_TTL}`;
    return `${this.d.baseUrl}/${kind}?t=${payload}.${this.sign(`${kind}:${payload}`)}`;
  }

  verify(kind: "upgrade" | "billing", t: unknown): string | null {
    const [userId, exp, sig] = String(t ?? "").split(".");
    if (!userId || !exp || !sig) return null;
    return safeEqual(this.sign(`${kind}:${userId}.${exp}`), sig) && Number(exp) >= now() ? userId : null;
  }

  private async stripe(path: string, form?: Record<string, string>, method = form ? "POST" : "GET"): Promise<any> {
    const res = await (this.d.fetch ?? fetch)(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.d.stripe!.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Stripe ${path}: ${data?.error?.message ?? res.status}`), { status: res.status });
    return data;
  }

  private user(id: string): UserRow | undefined {
    return this.d.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  /** Apply a completed Checkout Session. Idempotent; returns the user it upgraded. */
  private settle(session: any): string | null {
    if (session?.status !== "complete" || session?.metadata?.app !== APP || !session.client_reference_id) return null;
    const r = this.d.db.prepare("UPDATE users SET plan = 'pro', stripe_customer = ?, stripe_sub = ? WHERE id = ?")
      .run(String(session.customer ?? ""), String(session.subscription ?? ""), session.client_reference_id);
    return r.changes ? session.client_reference_id : null;
  }

  /**
   * Link completed checkouts whose subscription is still live (payers who closed the tab before /upgraded).
   * With `onlyUser`, just that user's, over the last day: run at the moment it matters (see refreshPlan).
   * Returns the users it upgraded.
   */
  private async settleCompleted(onlyUser?: string): Promise<string[]> {
    const since = now() - (onlyUser ? 86400 : 3 * 86400);
    const recent = await this.stripe(`checkout/sessions?limit=100&status=complete&created[gte]=${since}`);
    const upgraded: string[] = [];
    for (const s of recent.data ?? []) {
      if (onlyUser && s.client_reference_id !== onlyUser) continue;
      const u = s.metadata?.app === APP && s.client_reference_id ? this.user(s.client_reference_id) : undefined;
      if (!u || u.stripe_sub === s.subscription || !s.subscription) continue;
      // Only a subscription that is still live makes someone Pro. Without this, a checkout completed and then
      // cancelled within the 3-day window was re-linked (Pro) on every sweep and only undone by the next loop.
      const sub = await this.stripe(`subscriptions/${s.subscription}`);
      if (LIVE.has(sub.status) && this.settle(s)) upgraded.push(u.id);
    }
    return upgraded;
  }

  /**
   * Called when a free user hits the paywall: did they just pay (and close the tab before /upgraded)?
   * Without this they'd stay blocked until the hourly sweep, right after paying. Never throws: if Stripe is
   * unreachable the paywall shows as usual and the sweep catches up.
   */
  async refreshPlan(userId: string): Promise<boolean> {
    if (!this.enabled) return false;
    try { return (await this.settleCompleted(userId)).includes(userId); } catch { return false; }
  }

  /** Hourly backstop: settle missed checkouts; drop Pro whose subscription has ended. */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    // One bad answer from Stripe must not stop the rest: each step and each user fails on its own.
    try { await this.settleCompleted(); } catch (e) { console.error(`billing sweep: settle: ${(e as Error).message}`); }
    const pros = this.d.db.prepare("SELECT id, stripe_sub FROM users WHERE plan = 'pro' AND stripe_sub IS NOT NULL AND stripe_sub != ''").all() as
      { id: string; stripe_sub: string }[];
    for (const p of pros) {
      let status: string;
      try {
        status = (await this.stripe(`subscriptions/${p.stripe_sub}`)).status;
      } catch (e) {
        // A subscription Stripe no longer has (deleted, or from test mode) has ended; anything else, retry next hour.
        if ((e as { status?: number }).status !== 404) { console.error(`billing sweep: ${p.id}: ${(e as Error).message}`); continue; }
        status = "missing";
      }
      if (!LIVE.has(status)) this.d.db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(p.id);
    }
  }

  private portal?: string;
  /** A portal configuration made through the API is not Stripe's default, so name it explicitly. */
  private async portalConfig(): Promise<Record<string, string>> {
    if (!this.portal) {
      const list = await this.stripe("billing_portal/configurations?limit=10&active=true");
      const c = (list.data ?? []).find((x: any) => x.is_default) ?? list.data?.[0];
      if (!c) return {};
      this.portal = c.id as string;
    }
    return { configuration: this.portal };
  }

  mount(app: Express, page: (title: string, body: string) => string): void {
    const send = (res: Response, status: number, title: string, body: string) =>
      res.status(status).setHeader("Cache-Control", "no-store").type("html").send(page(title, body));
    const expired = (res: Response) => send(res, 400, "Link expired",
      `<p>This billing link has expired or is not valid. Ask your AI assistant to run Camberstack's <code>billing</code> tool for a fresh one.</p>`);

    app.get("/upgrade", async (req: Request, res: Response) => {
      const userId = this.verify("upgrade", req.query.t);
      const u = userId ? this.user(userId) : undefined;
      if (!u || !this.enabled) return expired(res);
      if (u.plan === "pro") return send(res, 200, "Already on Pro", `<p>${esc(u.email)} is already on Camberstack Pro. Go back to your AI assistant and carry on.</p>`);
      try {
        const s = await this.stripe("checkout/sessions", {
          mode: "subscription",
          "line_items[0][price]": this.d.stripe!.proPriceId,
          "line_items[0][quantity]": "1",
          client_reference_id: u.id,
          customer_email: u.email,
          allow_promotion_codes: "true",
          "metadata[app]": APP,
          "subscription_data[metadata][user_id]": u.id,
          success_url: `${this.d.baseUrl}/upgraded?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.d.baseUrl}/#pricing`,
        });
        res.redirect(303, s.url);
      } catch (e) {
        send(res, 502, "Checkout unavailable", `<p>Stripe could not start checkout (${esc((e as Error).message)}). Try again in a minute.</p>`);
      }
    });

    app.get("/upgraded", async (req: Request, res: Response) => {
      const id = String(req.query.session_id ?? "");
      if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !this.enabled) return expired(res);
      try {
        const session = await this.stripe(`checkout/sessions/${id}`);
        // The link stays valid after a cancellation, so reloading it must not bring Pro back.
        const live = session?.subscription && LIVE.has((await this.stripe(`subscriptions/${session.subscription}`)).status);
        const ok = live && this.settle(session);
        if (!ok) return send(res, 400, "Payment not complete", `<p>We could not confirm this payment. If you were charged, email us and we will sort it out.</p>`);
        send(res, 200, "You're on Pro", `<p><strong>Thanks, you're on Camberstack Pro.</strong></p>
<p>Go back to your AI assistant and ask it to try again. Pro covers up to ${PRO_ACCOUNTS} Google Ads accounts.</p>
<p><a class="btn" href="/account">Go to your account</a></p>
<p class="muted">Change your card or cancel any time from your account page.</p>`);
      } catch (e) {
        send(res, 502, "Could not confirm", `<p>Stripe did not answer (${esc((e as Error).message)}). Your payment is safe; your plan updates within the hour.</p>`);
      }
    });

    app.get("/billing", async (req: Request, res: Response) => {
      const userId = this.verify("billing", req.query.t);
      const u = userId ? this.user(userId) : undefined;
      if (!u || !this.enabled) return expired(res);
      if (!u.stripe_customer) return send(res, 200, "No subscription", `<p>${esc(u.email)} has no Camberstack subscription.</p>`);
      try {
        const s = await this.stripe("billing_portal/sessions", {
          customer: u.stripe_customer, return_url: `${this.d.baseUrl}/account`, ...(await this.portalConfig()),
        });
        res.redirect(303, s.url);
      } catch (e) {
        send(res, 502, "Billing unavailable", `<p>Stripe's billing page is not available (${esc((e as Error).message)}). Email us to change or cancel your plan.</p>`);
      }
    });
  }
}
