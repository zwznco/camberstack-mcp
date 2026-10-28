/**
 * Paid plans (Pro, Agency) billing: a Stripe Checkout subscription, no webhook. Which plan someone is on follows their
 * subscription's price, so switching between Pro and Agency in Stripe's billing portal moves the plan too (the sweep).
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
import { AGENCY_ACCOUNTS, PRO_ACCOUNTS, isPaid, type Plan } from "./plans.js";

const LINK_TTL = 7 * 86400;
/** Subscription statuses that keep Pro (past_due: Stripe is still retrying the card). */
const LIVE = new Set(["active", "trialing", "past_due"]);
const APP = "camberstack-mcp";
/** Where a personal upgrade link was handed out (plan_events.src): an AI tool result, a lifecycle email, the account page. */
export type LinkSrc = "tool" | "email" | "account";
const SRCS = new Set<string>(["tool", "email", "account"]);

export interface BillingDeps {
  db: DB;
  baseUrl: string;
  /** Signs billing links; derived from ENCRYPTION_KEY so no new secret is needed. */
  signingKey: Buffer;
  stripe?: { secretKey: string; proPriceId: string; agencyPriceId?: string };
  fetch?: typeof fetch;
}

export class Billing {
  constructor(private d: BillingDeps) {}

  get enabled(): boolean { return Boolean(this.d.stripe?.secretKey && this.d.stripe.proPriceId); }

  private sign(payload: string): string {
    return sign(this.d.signingKey, `billing:${payload}`);
  }

  get agencyEnabled(): boolean { return this.enabled && Boolean(this.d.stripe?.agencyPriceId); }

  /**
   * A link for one user, valid for a week. Null when billing (or, for "agency", the Agency plan) isn't configured.
   * "agency" is the upgrade link with plan=agency: which plan to buy is the user's choice, so it isn't signed.
   */
  link(kind: "upgrade" | "billing" | "agency", userId: string, src?: LinkSrc): string | null {
    if (!this.enabled || (kind === "agency" && !this.agencyEnabled)) return null;
    const k = kind === "agency" ? "upgrade" : kind;
    const payload = `${userId}.${now() + LINK_TTL}`;
    // src isn't signed: it only labels the click for the funnel.
    return `${this.d.baseUrl}/${k}?t=${payload}.${this.sign(`${k}:${payload}`)}${kind === "agency" ? "&plan=agency" : ""}${src && k === "upgrade" ? `&src=${src}` : ""}`;
  }

  /**
   * The /plans page through a personal link, so a view counts in the paywall funnel (ChatGPT connections get this instead
   * of an upgrade link). Works without Stripe: the page is facts only.
   */
  plansLink(userId: string): string {
    const payload = `${userId}.${now() + LINK_TTL}`;
    return `${this.d.baseUrl}/plans?t=${payload}.${this.sign(`plans:${payload}`)}`;
  }

  /** One paywall funnel step (db.ts plan_events). Never throws: tracking must not break a page. */
  track(userId: string, kind: "upgrade_click" | "plans_view" | "paid", src: string | null = null): void {
    try {
      this.d.db.prepare("INSERT INTO plan_events (user_id, kind, src, at) VALUES (?, ?, ?, ?)").run(userId, kind, src, now());
    } catch { /* best effort */ }
  }

  /** The plan a live subscription pays for: Agency by its price, anything else Pro (the old $49 Pro price included). */
  private planOf(sub: any): Plan {
    const prices = (sub?.items?.data ?? []).map((i: any) => i.price?.id);
    return this.d.stripe?.agencyPriceId && prices.includes(this.d.stripe.agencyPriceId) ? "agency" : "pro";
  }

  verify(kind: "upgrade" | "billing" | "plans", t: unknown): string | null {
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

  /** Apply a completed Checkout Session, on the plan its live subscription pays for. Idempotent; returns the user it upgraded. */
  private settle(session: any, sub: any): string | null {
    if (session?.status !== "complete" || session?.metadata?.app !== APP || !session.client_reference_id) return null;
    const r = this.d.db.prepare("UPDATE users SET plan = ?, stripe_customer = ?, stripe_sub = ? WHERE id = ?")
      .run(this.planOf(sub), String(session.customer ?? ""), String(session.subscription ?? ""), session.client_reference_id);
    // Settling repeats (the sweep, a reload of /upgraded): one paid event per subscription, its id in src.
    if (r.changes && session.subscription && !this.d.db.prepare("SELECT 1 FROM plan_events WHERE user_id = ? AND kind = 'paid' AND src = ?")
      .get(session.client_reference_id, String(session.subscription))) this.track(session.client_reference_id, "paid", String(session.subscription));
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
      if (LIVE.has(sub.status) && this.settle(s, sub)) upgraded.push(u.id);
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

  /** Hourly backstop: settle missed checkouts; follow a switch between Pro and Agency; drop a plan whose subscription has ended. */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    // One bad answer from Stripe must not stop the rest: each step and each user fails on its own.
    try { await this.settleCompleted(); } catch (e) { console.error(`billing sweep: settle: ${(e as Error).message}`); }
    const paying = this.d.db.prepare("SELECT id, plan, stripe_sub FROM users WHERE plan IN ('pro', 'agency') AND stripe_sub IS NOT NULL AND stripe_sub != ''").all() as
      { id: string; plan: Plan; stripe_sub: string }[];
    for (const p of paying) {
      let sub: any;
      try {
        sub = await this.stripe(`subscriptions/${p.stripe_sub}`);
      } catch (e) {
        // A subscription Stripe no longer has (deleted, or from test mode) has ended; anything else, retry next hour.
        if ((e as { status?: number }).status !== 404) { console.error(`billing sweep: ${p.id}: ${(e as Error).message}`); continue; }
        sub = { status: "missing" };
      }
      const plan = LIVE.has(sub.status) ? this.planOf(sub) : "free";
      if (plan !== p.plan) this.d.db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, p.id);
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
      this.track(u.id, "upgrade_click", SRCS.has(String(req.query.src)) ? String(req.query.src) : null);
      const want: Plan = req.query.plan === "agency" && this.agencyEnabled ? "agency" : "pro";
      const name = want === "agency" ? "Agency" : "Pro";
      if (u.plan === want) return send(res, 200, `Already on ${name}`, `<p>${esc(u.email)} is already on Camberstack ${name}. Go back to your AI assistant and carry on.</p>`);
      // Already paying for the other plan: a second subscription would bill twice, so switch in Stripe's billing portal.
      if (isPaid(u.plan) && u.stripe_customer) {
        try {
          const p = await this.stripe("billing_portal/sessions", {
            customer: u.stripe_customer, return_url: `${this.d.baseUrl}/account`, ...(await this.portalConfig()),
          });
          return res.redirect(303, p.url);
        } catch (e) {
          return send(res, 502, "Billing unavailable", `<p>Stripe's billing page is not available (${esc((e as Error).message)}). Email us to change your plan.</p>`);
        }
      }
      try {
        const s = await this.stripe("checkout/sessions", {
          mode: "subscription",
          "line_items[0][price]": want === "agency" ? this.d.stripe!.agencyPriceId! : this.d.stripe!.proPriceId,
          "metadata[plan]": want,
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
        // The link stays valid after a cancellation, so reloading it must not bring a plan back.
        const sub = session?.subscription ? await this.stripe(`subscriptions/${session.subscription}`) : null;
        const ok = sub && LIVE.has(sub.status) && this.settle(session, sub);
        if (!ok) return send(res, 400, "Payment not complete", `<p>We could not confirm this payment. If you were charged, email us and we will sort it out.</p>`);
        const agency = this.planOf(sub) === "agency", name = agency ? "Agency" : "Pro";
        send(res, 200, `You're on ${name}`, `<p><strong>Thanks, you're on Camberstack ${name}.</strong></p>
<p>Go back to your AI assistant and ask it to try again. ${name} covers up to ${agency ? AGENCY_ACCOUNTS : PRO_ACCOUNTS} Google Ads accounts.</p>
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
