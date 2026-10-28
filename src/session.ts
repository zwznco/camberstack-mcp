/**
 * Everything one connected user can do, independent of MCP. The MCP tools in tools.ts are thin
 * wrappers over these methods, which keeps them testable with a fake Ads client.
 */
import { randomUUID } from "node:crypto";
import type { DB, ProposalRow, UserRow } from "./db.js";
import { now } from "./db.js";
import { decrypt } from "./crypto.js";
import {
  AdsApiError, AdsClient, NotGrantedError, SearchConsoleClient, micros, refreshGoogleToken, revokeGoogleToken,
  type GoogleCreds, type GrantKind, type SearchAnalyticsRequest, type SearchAnalyticsRow, type UrlInspection,
} from "./google.js";
import { ACCOUNT_CHOICE_PREFIX, ACCOUNT_WINDOW_DAYS, AGENCY_PRICE_LABEL, PLAN_LIMIT_PREFIX, PRO_PRICE_LABEL, PlanLimitError, SERVICE_CHOICE_PREFIX, SERVICE_CHOICE_SECONDS, SERVICE_LABELS, SERVICE_LIMIT_PREFIX, SWITCH_NOTICE_PREFIX, SwitchNotice, accountsLabel, isPaid, type Plan, type Service } from "./plans.js";
import { AnalyticsClient, DemoAnalytics, routedAnalytics, type Analytics } from "./ga4.js";
import { GA_TARGET, GaChangeSchema, gaInverseAfterApply, gaNoteAfterApply, resolveGaChange, writeGa, type GaChange, type GaOp, type GaResolved } from "./ga4-changes.js";
import { DEMO_CID, DEMO_NAME, DEMO_NOTE, DEMO_SITE, DemoAds, DemoSearchConsole } from "./demo.js";
import { CATALOG_QUERY, FIELD_COLUMNS, catalog, checkGaql, fieldQuery, lookupFields, queryShape } from "./gaql.js";
import { reportBug } from "./sentry.js";
import {
  ChangeSchema, MAX_CHANGES, inverseAfterApply, sameSummary, pendingOf, resolveChange, summarize,
  type Change, type ResolvedChange,
} from "./changes.js";

export interface Account {
  customerId: string;
  name: string;
  currency: string;
  manager: boolean;
  /** Header Google needs when the account is reached through a manager (MCC). */
  loginCustomerId: string | null;
  /** The account's IANA time zone, e.g. "America/New_York". */
  timeZone?: string;
  /** Whether it spent anything in the last 30 days (spendActivity); absent when not checked or Google didn't answer. */
  spentLast30Days?: boolean;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
/**
 * Each user's account list, shared across requests. A UserSession lives for one MCP request, so a cache on the
 * instance never hit and every account-scoped tool paid ~1s re-listing accounts before doing its own work.
 */
/** An account (or the whole login) Google refused to read, and why; `grant_url` when Google Ads isn't granted yet. */
type Unreadable = { customerId: string; error: string; grant_url?: string };
const accountsCache = new Map<string, { at: number; list: Account[]; unreadable: Unreadable[] }>();
const ACCOUNTS_TTL_MS = 10 * 60_000;
/** Which accounts spent in the last 30 days, per user: shown when the user picks an account (2026-10-26). */
const activityCache = new Map<string, { at: number; spent: boolean }>();  // keyed user|customer
const ACTIVITY_TTL_MS = 6 * 3600_000;
/** Accounts checked per listing, and how long a listing waits for Google before showing what it has. */
const ACTIVITY_MAX = 25;
const ACTIVITY_WAIT_MS = 4000;
/** Drop a user's cached Google token and account list: on disconnect, and on reconnect (the old token may be revoked). */
export function clearGoogleCache(userId: string): void {
  tokenCache.delete(userId);
  accountsCache.delete(userId);
}
/** An apply claim older than this was left by a server that died mid-apply (a real apply takes seconds). */
const STALE_CLAIM = 10 * 60;
/** Changes that re-running could duplicate: nothing identifies what an earlier, interrupted run created. */
const NOT_REPEATABLE = new Set<string>(["add_ad_group", "add_responsive_search_ad", "add_sitelinks"]);
/** Per user: the tail of their plan-gate checks (run one at a time), and the accounts with a call running. */
const gateQueue = new Map<string, Promise<void>>();
const inFlight = new Map<string, Map<string, number>>();
/** Services a user's running calls use, so parallel calls can't take two services at once (checkService). */
const servicesInFlight = new Map<string, Map<Service, number>>();
/** When each user was last asked to pick Free's service (checkService). In memory: a restart just asks again. */
const serviceAsked = new Map<string, number>();

/**
 * `fn` over `items`, at most `limit` at a time, results in input order. If any fail, throws the error of the
 * earliest item that failed, the same error a one-by-one loop would have thrown.
 */
async function mapLimited<T, R>(items: T[], fn: (x: T) => Promise<R>, limit = 6): Promise<R[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!).then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  const failed = out.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return out.map((r) => (r as PromiseFulfilledResult<R>).value);
}

export interface SessionDeps {
  db: DB;
  baseUrl: string;
  google: GoogleCreds;
  encryptionKey: Buffer;
  /** Google Ads accounts each plan covers, over ACCOUNT_WINDOW_DAYS (config.ts). */
  freeAccounts: number;
  proAccounts: number;
  /** Option C (plans.ts Service): Free covers one Google service at a time. Off unless FREE_ONE_SERVICE=1. */
  freeOneService?: boolean;
  /** Agency's accounts at a time; unset = no Agency plan (tests, and billing without STRIPE_AGENCY_PRICE_ID). */
  agencyAccounts?: number;
  proEmails: Set<string>;
  /** Asks Stripe whether this user just paid; true when that made them Pro (billing.ts refreshPlan). */
  refreshPlan?: (userId: string) => Promise<boolean>;
  /** Signed per-user billing links (billing.ts); null when billing isn't configured. */
  billingLink?: (kind: "upgrade" | "billing" | "agency", userId: string) => string | null;
  /** Tests inject a fake. */
  adsFactory?: (user: UserRow) => AdsClient;
  scFactory?: (user: UserRow) => SearchConsole;
  gaFactory?: (user: UserRow) => Analytics;
  /** The personal link that adds one Google service to this user's connection (grant.ts). */
  grantLink?: (kind: GrantKind, userId: string) => string | null;
}

export class NotConnectedError extends Error {}

/** The Google Ads calls the tools make; the demo account answers the same ones. */
type Ads = Pick<AdsClient, "listAccessibleCustomers" | "search" | "mutate" | "keywordPlan"> & Partial<Pick<AdsClient, "searchFields">>;

/** Sends the demo account's calls to the demo and everything else to Google. */
function routed(google: Ads, demo: DemoAds): Ads {
  return {
    listAccessibleCustomers: () => google.listAccessibleCustomers(),
    search: (cid, query, login) => (cid === DEMO_CID ? demo.search(cid, query) : google.search(cid, query, login)),
    mutate: (cid, service, ops, opts) => (cid === DEMO_CID ? demo.mutate(cid, service, ops, opts) : google.mutate(cid, service, ops, opts)),
    keywordPlan: (cid, method, req, login) => (cid === DEMO_CID ? demo.keywordPlan(cid, method, req) : google.keywordPlan(cid, method, req, login)),
    ...(google.searchFields ? { searchFields: (q: string) => google.searchFields!(q) } : {}),
  };
}

/** The Search Console calls the tools make; the demo site answers the same ones. */
type SearchConsole = Pick<SearchConsoleClient, "sites" | "searchAnalytics" | "sitemaps" | "inspect">;

function routedSc(google: SearchConsole, demo: DemoSearchConsole): SearchConsole {
  return {
    sites: () => google.sites(),
    searchAnalytics: (site, req) => (site === DEMO_SITE ? demo.searchAnalytics(site, req) : google.searchAnalytics(site, req)),
    sitemaps: (site) => (site === DEMO_SITE ? demo.sitemaps() : google.sitemaps(site)),
    inspect: (site, url) => (site === DEMO_SITE ? demo.inspect(site, url) : google.inspect(site, url)),
  };
}
const DEMO_SITE_NOTE = "Sample data from Camberstack's demo website (a fictional plumbing business), not a real Search Console property.";
const siteNote = (site: string) => (site === DEMO_SITE ? { note: DEMO_SITE_NOTE } : {});
/** Search terms and queries compared case- and spacing-insensitively. */
const norm = (q: string) => q.toLowerCase().trim().replace(/\s+/g, " ");

const DEMO_ACCOUNT: Account = { customerId: DEMO_CID, name: DEMO_NAME, currency: "USD", manager: false, loginCustomerId: null };
/** Customer ids arrive with or without dashes; stored and compared without. */
const bareCid = (customerId: string) => customerId.replace(/-/g, "");
export const isDemo = (customerId: string | null | undefined) => bareCid(customerId ?? "") === DEMO_CID;
/** Spread into any result about an account, so the AI can't mistake demo data for the user's. */
const demoNote = (customerId: string) => (isDemo(customerId) ? { note: DEMO_NOTE } : {});

type AnyChange = Change | GaChange;
type AnyResolved = ResolvedChange | GaResolved;
/** `note`: something the user must do next, e.g. a new GA4 property's tag. */
type Outcome = { describe: string; ok: boolean; error?: string; note?: string; inverse?: AnyChange };
type Proposed = { proposal_id: string; summary: string; changes: number; skipped: string[] };
type AlreadyInPlace = { status: "already in place"; changes: 0; skipped: string[]; note: string };
/** What the AI (and the account page) sees of an applied proposal's outcomes. */
const publicResults = (outcomes: Outcome[]) => outcomes.map(({ describe, ok, error, note }) =>
  ({ change: describe, ok, ...(error ? { error } : {}), ...(note ? { note } : {}) }));

export class UserSession {
  readonly ads: Ads;
  readonly sc: SearchConsole;
  readonly ga: Analytics;
  /** Accounts the login can see but Google refused to read, from the last accounts() call. */
  lastUnreadable: Unreadable[] = [];

  /**
   * A ChatGPT connection, held to its plugin guidelines: no upgrade links or plan pitches (no promoting upgrades or
   * linking to checkout), and one propose_<operation> tool per change instead of propose_changes (tools.ts).
   */
  readonly chatgpt: boolean;

  constructor(private deps: SessionDeps, readonly user: UserRow, o: { chatgpt?: boolean } = {}) {
    this.chatgpt = o.chatgpt ?? false;
    const link = (kind: GrantKind) => () => deps.grantLink?.(kind, user.id) ?? null;
    const google = deps.adsFactory?.(user) ?? new AdsClient(() => this.googleAccessToken(), deps.google.developerToken, fetch, link("google-ads"));
    this.ads = routed(google, new DemoAds(deps.db, user.id));
    this.sc = routedSc(deps.scFactory?.(user) ?? new SearchConsoleClient(() => this.googleAccessToken(), link("search-console")), new DemoSearchConsole());
    this.ga = routedAnalytics(deps.gaFactory?.(user)
      ?? new AnalyticsClient(() => this.googleAccessToken(), link("analytics")), new DemoAnalytics(deps.db, user.id));
  }

  /** `seen: false` leaves last_seen_at alone: an admin viewing the user's /account through "Log in as user". */
  /** The name a result should give a write tool: ChatGPT connections have per-operation tools instead (tools.ts). */
  tool(name: "propose_changes" | "undo_changes"): string {
    if (!this.chatgpt) return name;
    return name === "undo_changes" ? "propose_undo" : "the matching propose_<operation> tool";
  }

  static load(deps: SessionDeps, userId: string, o: { seen?: boolean; chatgpt?: boolean } = {}): UserSession {
    const user = deps.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!user) throw new NotConnectedError("Unknown user; connect Camberstack again.");
    if (o.seen !== false) deps.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), userId);
    return new UserSession(deps, user, o);
  }

  /** An access token for this user's Google connection (cached; refreshed from the stored refresh token). */
  async googleAccessToken(): Promise<string> {
    const hit = tokenCache.get(this.user.id);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    if (!this.user.enc_refresh) throw new NotConnectedError("Google Ads is disconnected. Reconnect Camberstack in your AI app.");
    try {
      const t = await refreshGoogleToken(this.deps.google, decrypt(this.deps.encryptionKey, this.user.enc_refresh));
      tokenCache.set(this.user.id, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
      // Keeps the admin's view of their permissions current, e.g. one service revoked at myaccount.google.com.
      if (t.scope && t.scope !== this.user.google_scopes) {
        this.deps.db.prepare("UPDATE users SET google_scopes = ? WHERE id = ?").run(t.scope, this.user.id);
        this.user.google_scopes = t.scope;
      }
      return t.access_token;
    } catch (e) {
      if ((e as { revoked?: boolean }).revoked) {
        this.forgetGoogle();
        throw new NotConnectedError("Google access was revoked. Reconnect Camberstack in your AI app.");
      }
      throw e;
    }
  }

  /** On a paid plan (Pro or Agency), or complimentary Pro (PRO_EMAILS). */
  get isPro(): boolean {
    return isPaid(this.user.plan) || this.deps.proEmails.has(this.user.email.toLowerCase());
  }

  get planName(): Plan {
    return this.user.plan === "agency" ? "agency" : this.isPro ? "pro" : "free";
  }

  get accountLimit(): number {
    const p = this.planName;
    return p === "agency" ? this.deps.agencyAccounts ?? this.deps.proAccounts : p === "pro" ? this.deps.proAccounts : this.deps.freeAccounts;
  }

  /** The plan above this one, if it's offered: Pro from Free, Agency from Pro. Never on ChatGPT (no upgrade pitches there). */
  private nextPlan(): { plan: Plan; price: string; accounts_included: number; upgrade_url: string | null } | null {
    if (this.chatgpt) return null;
    const p = this.planName;
    if (p === "free") return { plan: "pro", price: PRO_PRICE_LABEL, accounts_included: this.deps.proAccounts, upgrade_url: this.deps.billingLink?.("upgrade", this.user.id) ?? null };
    // Paid Pro switches in Stripe's billing portal (the agency link sends a paying user there); complimentary Pro checks out.
    if (p === "pro" && this.deps.agencyAccounts) {
      const url = this.deps.billingLink?.("agency", this.user.id) ?? null;
      return url ? { plan: "agency", price: AGENCY_PRICE_LABEL, accounts_included: this.deps.agencyAccounts, upgrade_url: url } : null;
    }
    return null;
  }

  /** After Stripe said this user just paid: their plan as billing.ts recorded it. */
  private reloadPlan(): void {
    this.user.plan = (this.deps.db.prepare("SELECT plan FROM users WHERE id = ?").get(this.user.id) as { plan: string } | undefined)?.plan ?? this.user.plan;
  }

  /**
   * Google Ads accounts this user has run tools on in the window: what a plan is sized by. Accounts used,
   * not accounts reachable, so a manager login that can see 50 clients isn't charged for 50. The demo never
   * counts, nor does Google Analytics (change_history for "ga4"), nor failed calls (a call the gate refused is logged as failed),
   * nor calls before the user's plan_reset_at (a reset by hand: UPDATE users SET plan_reset_at = unixepoch()).
   */
  accountsInUse(): string[] {
    return this.usage().map((u) => u.c);
  }

  /**
   * Google services this user ran real calls on in the window, most recently used first (tool_calls.service; the demo,
   * refused calls and calls before plan_reset_at don't count). With FREE_ONE_SERVICE, Free covers the first of these.
   */
  servicesInUse(): { s: Service; last: number }[] {
    const rows = this.deps.db.prepare(`SELECT service, max(at) last, max(id) id FROM tool_calls WHERE user_id = ? AND ok = 1 AND service IS NOT NULL AND at >= ?
        GROUP BY service ORDER BY last DESC, id DESC`)
      .all(this.user.id, Math.max(now() - ACCOUNT_WINDOW_DAYS * 86400, this.user.plan_reset_at ?? 0)) as { service: string; last: number }[];
    const out: { s: Service; last: number }[] = [];
    for (const r of rows) for (const s of r.service.split(",") as Service[]) if (!out.some((o) => o.s === s)) out.push({ s, last: r.last });
    return out;
  }

  /**
   * The one-service gate (FREE_ONE_SERVICE, Free only): a call may use only the service the plan covers, which is the
   * most recently used one (a call needing two, paid_organic_overlap, needs a paid plan). Another service opens 30 days
   * after the covered one was last used, or with plan_reset_at. With none used yet, the first real call stops with a
   * Service choice notice so the AI asks the user which service to keep for 30 days; the next real call within
   * SERVICE_CHOICE_SECONDS is the answer and takes the plan. Both stops are SwitchNotices, normal results rather than
   * errors (errors count against the directories' reliability metrics).
   * Returns a release to call once the call is logged: until then its service counts as in use.
   */
  checkService(services: Service[]): () => void {
    if (!this.deps.freeOneService || this.isPro) return () => {};
    const running = [...(servicesInFlight.get(this.user.id)?.keys() ?? [])];
    const used = this.servicesInUse();
    if (!running.length && !used.length && services.length === 1) {
      const asked = serviceAsked.get(this.user.id);
      if (!asked || now() - asked > SERVICE_CHOICE_SECONDS) {
        serviceAsked.set(this.user.id, now());
        const plan = this.chatgpt ? "The current plan" : "The Free plan";
        throw new SwitchNotice(`${SERVICE_CHOICE_PREFIX} ${plan} covers one Google service at a time: Google Ads, Search Console or Google Analytics. `
          + `Nothing has run yet. Ask the user which one they want to use for the next ${ACCOUNT_WINDOW_DAYS} days, then make the call for that service: `
          + `the first one made in the next ${SERVICE_CHOICE_SECONDS / 60} minutes becomes the plan's service, and the others wait until ${ACCOUNT_WINDOW_DAYS} days after it was last used.`
          + (this.chatgpt ? "" : ` Pro (${PRO_PRICE_LABEL}) covers all three together.`),
          { stop: "service_choice", this_call_uses: SERVICE_LABELS[services[0]!], services: Object.values(SERVICE_LABELS), window_days: ACCOUNT_WINDOW_DAYS,
            ...(this.chatgpt ? { plans_page: this.plansPage } : {}) });
      }
      serviceAsked.delete(this.user.id);
    }
    const covered = running[0] ?? used[0]?.s ?? (services.length === 1 ? services[0]! : undefined);
    const extra = services.filter((s) => s !== covered);
    if (!covered || extra.length) {
      const have = covered ? SERVICE_LABELS[covered] : null;
      const want = extra.map((s) => SERVICE_LABELS[s]).join(" and ") || services.map((s) => SERVICE_LABELS[s]).join(" and ");
      // A covered service still in flight (parallel calls) has no logged use yet: it's being used now.
      const last = used.find((u) => u.s === covered)?.last ?? (covered ? now() : undefined);
      const opens = last ? new Date((last + ACCOUNT_WINDOW_DAYS * 86400) * 1000).toISOString().slice(0, 10) : null;
      const why = have ? `this login uses it for ${have}` : `${want} together need more than one`;
      const head = `${SERVICE_LIMIT_PREFIX} the Free plan covers one Google service at a time (Google Ads, Search Console or Google Analytics), and ${why}.`
        + (have && opens ? ` ${want} opens on Free on ${opens}, ${ACCOUNT_WINDOW_DAYS} days after ${have} was last used.` : "");
      const common = { stop: "service_limit", service_in_use: have, service_requested: want, opens_on_free: opens };
      if (this.chatgpt) throw new SwitchNotice(`${head} Using several together needs a different plan.`, { ...common, plans_page: this.plansPage });
      const url = this.deps.billingLink?.("upgrade", this.user.id) ?? null;
      throw new SwitchNotice(`${head} Pro (${PRO_PRICE_LABEL}) covers all three together, so ${want} works right away.`,
        { ...common, upgrade: { plan: "pro", price: PRO_PRICE_LABEL, covers: "Google Ads, Search Console and Google Analytics together", cancel: "any time",
          upgrade_url: url, upgrade_url_expires: url ? "7 days; personal to this user" : null, pricing_page: url ? null : `${this.deps.baseUrl}/#pricing` } });
    }
    const mine = servicesInFlight.get(this.user.id) ?? new Map<Service, number>();
    servicesInFlight.set(this.user.id, mine);
    mine.set(covered, (mine.get(covered) ?? 0) + 1);
    return () => {
      const n = (mine.get(covered) ?? 1) - 1;
      if (n > 0) mine.set(covered, n); else mine.delete(covered);
      if (!mine.size) servicesInFlight.delete(this.user.id);
    };
  }

  /** accountsInUse, most recently used first, with when each was last used. */
  private usage(): { c: string; last: number }[] {
    // max(id): a same-second tie goes to the later call, so switch_account's account is the active one.
    return this.deps.db.prepare(`SELECT customer_id c, max(at) last FROM tool_calls
        WHERE user_id = ? AND ok = 1 AND customer_id IS NOT NULL AND customer_id NOT IN (?, ?) AND at >= ?
        GROUP BY customer_id ORDER BY last DESC, max(id) DESC, c`)
      .all(this.user.id, DEMO_CID, GA_TARGET, Math.max(now() - ACCOUNT_WINDOW_DAYS * 86400, this.user.plan_reset_at ?? 0)) as { c: string; last: number }[];
  }

  /**
   * Which accounts the plan covers right now: the most recently used, up to the plan's limit. Calls still
   * running count as used now. On top of the limit, a plan gets ONE switch per window: a new account is let
   * in, becomes active, and the least recent active one locks. So someone who connected the wrong account,
   * or moved on, isn't stuck, while rotating through clients still needs Pro. Switching back counts as
   * another switch. Over limit + 1 (a Pro who cancelled), the rest stay locked until they age out;
   * `switchOpens` is when the next switch (or a locked account) opens up.
   */
  planState(managers: Set<string>) {
    const running = [...(inFlight.get(this.user.id)?.keys() ?? [])];
    const seen = new Set<string>();
    const ranked = [...running.map((c) => ({ c, last: now() })), ...this.usage()]
      .filter((u) => !managers.has(u.c) && !seen.has(u.c) && seen.add(u.c));
    const limit = this.accountLimit;
    const used = ranked.map((u) => u.c), active = used.slice(0, limit);
    const canSwitch = ranked.length < limit + 1;
    const oldest = ranked[limit];  // aging out of the window is what frees the switch again
    return {
      used, active, canSwitch,
      /** At the limit: a new account now is (or would need) the switch. */
      full: ranked.length >= limit,
      allows: (cid: string) => active.includes(cid) || (canSwitch && !used.includes(cid)),
      switchOpens: oldest ? new Date((oldest.last + ACCOUNT_WINDOW_DAYS * 86400) * 1000).toISOString().slice(0, 10) : null,
    };
  }

  /**
   * The plan gate, run before every tool that reads or proposes on a Google Ads account. An active account
   * always passes, so the gate only ever stops a NEW (or locked) account. Manager accounts don't count: they are
   * how a login reaches its clients, not an account anyone advertises from. Undo, history and billing take
   * no account and are never gated: nothing may stand between a user and reversing a change.
   *
   * One user's checks run one at a time, and a passed account counts as in use until its call ends (call the
   * returned release): AI clients call tools in parallel, which otherwise let several new accounts through at once.
   *
   * Spending the switch takes `confirmSwitch`, which only switch_account passes: any other tool stops with a notice
   * naming what will lock and until when. Users found out only on the way back, after days of work on both (2026-10-16).
   */
  checkAccount(customerId: string, confirmSwitch = false): Promise<() => void> {
    const prev = gateQueue.get(this.user.id) ?? Promise.resolve();
    const run = prev.then(() => this.admit(bareCid(customerId), confirmSwitch));
    const tail = run.then(() => {}, () => {});
    gateQueue.set(this.user.id, tail);
    void tail.then(() => { if (gateQueue.get(this.user.id) === tail) gateQueue.delete(this.user.id); });
    return run;
  }

  private async admit(cid: string, confirmSwitch: boolean): Promise<() => void> {
    if (isDemo(cid)) return () => {};
    let st = this.planState(new Set());
    // Nothing used yet and the login has more accounts than the plan covers: the user picks, not whichever call lands
    // first (2026-10-23: a Free user's AI overviewed 3 of 5 accounts at once and the first took the plan).
    if (!st.used.length && !confirmSwitch) {
      const counted = (await this.accounts().catch(() => [] as Account[])).filter((a) => !a.manager && !isDemo(a.customerId));
      if (counted.length > this.accountLimit && counted.some((a) => a.customerId === cid)) this.noticeChoice(await this.withActivity(counted));
    }
    // A new account on a full plan is the switch: it passes only once the user has said yes to spending it.
    const isSwitch = () => st.full && !st.active.includes(cid) && st.allows(cid);
    if (isSwitch() && !confirmSwitch) {
      const managers = new Set((await this.accounts().catch(() => [] as Account[])).filter((a) => a.manager).map((a) => a.customerId));
      if (!managers.has(cid)) {
        st = this.planState(managers);
        if (isSwitch() && !this.isPro && await this.deps.refreshPlan?.(this.user.id)) {
          this.reloadPlan();
          st = this.planState(managers);
        }
        if (isSwitch()) this.noticeSwitch(cid, st);
      }
    }
    if (!st.allows(cid)) {
      const managers = new Set((await this.accounts().catch(() => [] as Account[])).filter((a) => a.manager).map((a) => a.customerId));
      if (!managers.has(cid)) {
        st = this.planState(managers);
        // Someone who paid and closed the tab before /upgraded must not be blocked for an hour: ask Stripe first.
        if (!st.allows(cid) && !this.isPro && await this.deps.refreshPlan?.(this.user.id)) {
          this.reloadPlan();
          st = this.planState(managers);
        }
        if (!st.allows(cid)) this.refuse(cid, st);
      }
    }
    const mine = inFlight.get(this.user.id) ?? new Map<string, number>();
    inFlight.set(this.user.id, mine);
    mine.set(cid, (mine.get(cid) ?? 0) + 1);
    return () => {
      const n = (mine.get(cid) ?? 1) - 1;
      if (n > 0) mine.set(cid, n); else mine.delete(cid);
      if (!mine.size && inFlight.get(this.user.id) === mine) inFlight.delete(this.user.id);
    };
  }

  /** Stop before the plan's first account is taken: the user says which, then switch_account takes it. */
  private noticeChoice(accounts: Account[]): never {
    const n = this.accountLimit, one = n === 1;
    throw new SwitchNotice(`${ACCOUNT_CHOICE_PREFIX} this plan covers ${n} Google Ads account${one ? "" : "s"} at a time and this login has `
      + `${accounts.length}. The first ${one ? "account" : "accounts"} used become${one ? "s" : ""} the plan's, so nothing has been used yet. `
      + `Ask the user which to work on; then call switch_account with that customer_id, then this tool again.`,
      { status: "account_choice_needed", plan: this.planName, accounts_included: n,
        accounts: accounts.map((a) => ({ customer_id: a.customerId, name: a.name,
          ...(a.spentLast30Days === undefined ? {} : { spent_last_30_days: a.spentLast30Days }) })),
        ...(accounts.some((a) => a.spentLast30Days === false) ? { note: "spent_last_30_days false: the account had no ad spend in the last 30 days, so it may be dormant. Show this to the user when they pick." } : {}),
        to_go_ahead: "once the user picks, call switch_account with that customer_id, then this tool again" });
  }

  /** Stop before the switch is spent: what it locks, until when, and how to go ahead. */
  private noticeSwitch(cid: string, st: ReturnType<UserSession["planState"]>): never {
    const locks = st.active.at(-1)!;
    // Once spent, the switch comes back when the account it locks ages out of the window.
    const last = this.usage().find((u) => u.c === locks)?.last ?? now();
    const reopens = new Date((last + ACCOUNT_WINDOW_DAYS * 86400) * 1000).toISOString().slice(0, 10);
    const next = this.nextPlan();
    throw new SwitchNotice(`${SWITCH_NOTICE_PREFIX} using ${cid} spends this plan's one switch per ${ACCOUNT_WINDOW_DAYS} days. `
      + `${locks} would lock until ${reopens}, including switching back to it. Nothing has been used yet. `
      + `Ask the user; if they want to go ahead, call switch_account with customer_id ${cid}, then this tool again.`,
      { status: "switch_confirmation_needed", plan: this.planName, switch_to: cid, locks_account: locks,
        locked_until: reopens, accounts_included: this.accountLimit, window_days: ACCOUNT_WINDOW_DAYS,
        to_go_ahead: `once the user agrees, call switch_account with customer_id ${cid}, then this tool again`,
        ...(next ? { keep_both: { ...next, pricing_page: next.upgrade_url ? null : `${this.deps.baseUrl}/#pricing` } } : {}),
        ...(this.chatgpt ? { plans_page: this.plansPage } : {}) });
  }

  private refuse(cid: string, st: ReturnType<UserSession["planState"]>): never {
    const used = `${PLAN_LIMIT_PREFIX} Camberstack has been used on ${accountsLabel(st.used.length)} in the last ${ACCOUNT_WINDOW_DAYS} days`;
    const rule = `covers ${this.accountLimit} at a time (active: ${st.active.join(", ")}), with one switch per ${ACCOUNT_WINDOW_DAYS} days, `
      + `already used; the next opens ${st.switchOpens}.`;
    const common = { plan: this.planName, accounts_in_use: st.used, active_accounts: st.active,
      accounts_included: this.accountLimit, window_days: ACCOUNT_WINDOW_DAYS, refused_account: cid,
      switching: `one switch per ${ACCOUNT_WINDOW_DAYS} days, already used; the next opens ${st.switchOpens}`,
      still_available: ["the active accounts", this.tool("undo_changes"), "change_history", "billing"] };
    if (this.isPro) {
      const next = this.nextPlan(), name = this.planName === "agency" ? "Agency" : "Pro";
      throw new PlanLimitError(`${used}; ${name} ${rule}`
        + (next ? ` Agency (${AGENCY_PRICE_LABEL}) covers up to ${next.accounts_included}, switched to from the billing page (upgrade_url).` : ""),
        { error: "plan_limit", ...common, ...(next ? { upgrade: { ...next, cancel: "any time", upgrade_url_expires: next.upgrade_url ? "7 days; personal to this user" : null } } : {}),
          contact: "adam@camberstack.io" });
    }
    // Lead with what gets them working again: someone refused here is working on more than one account.
    const wait = st.used.includes(cid) ? `${cid} opens again on ${st.switchOpens}` : `the next switch opens on ${st.switchOpens}`;
    if (this.chatgpt) {
      throw new PlanLimitError(`${used} (${st.used.join(", ")}). ${wait[0].toUpperCase()}${wait.slice(1)}: the current plan ${rule} `
        + `More accounts at a time need a different plan.`, { error: "plan_limit", ...common, plans_page: this.plansPage });
    }
    const url = this.deps.billingLink?.("upgrade", this.user.id) ?? null;
    const agency = this.deps.agencyAccounts ? this.deps.billingLink?.("agency", this.user.id) ?? null : null;
    throw new PlanLimitError(`${used} (${st.used.join(", ")}). Pro (${PRO_PRICE_LABEL}) covers up to ${this.deps.proAccounts}, `
      + `so ${cid} works right away${agency ? `; Agency (${AGENCY_PRICE_LABEL}) up to ${this.deps.agencyAccounts}` : ""}. On Free, ${wait}: the Free plan ${rule}`,
      { error: "plan_limit", ...common,
        upgrade: { plan: "pro", price: PRO_PRICE_LABEL, accounts_included: this.deps.proAccounts, cancel: "any time",
          upgrade_url: url, upgrade_url_expires: url ? "7 days; personal to this user" : null,
          pricing_page: url ? null : `${this.deps.baseUrl}/#pricing` },
        ...(agency ? { or_agency: { plan: "agency", price: AGENCY_PRICE_LABEL, accounts_included: this.deps.agencyAccounts, upgrade_url: agency } } : {}) });
  }

  /**
   * What ChatGPT connections link to about plans: facts only, no upgrade buttons (pages.ts plansPage). Its guidelines allow
   * explaining that a feature needs a different plan and linking "an informational page describing available plans".
   */
  private get plansPage(): string { return `${this.deps.baseUrl}/plans`; }

  private freeIncluded(): string {
    return this.deps.freeOneService
      ? "every tool on 1 Google service at a time (Google Ads, Search Console or Google Analytics) and 1 Google Ads account, with unlimited applied changes; undo and history always work"
      : "every tool on 1 Google Ads account, with unlimited applied changes; undo and history always work";
  }

  /** With FREE_ONE_SERVICE: which service Free covers now. Nothing otherwise, so plan() reads as before. */
  private serviceUsage(): { service_in_use?: string | null; services_included?: number } {
    if (!this.deps.freeOneService) return {};
    const s = this.servicesInUse()[0]?.s;
    return { service_in_use: s ? SERVICE_LABELS[s] : null, services_included: 1 };
  }

  plan() {
    if (this.chatgpt) {
      const usage = { accounts_in_use: this.accountsInUse(), accounts_included: this.accountLimit, window_days: ACCOUNT_WINDOW_DAYS };
      return this.isPro ? { plan: this.planName, ...usage, plans_page: this.plansPage }
        : { plan: "free", ...usage, ...this.serviceUsage(), included: this.freeIncluded(),
            note: "More accounts at a time need a different plan.", plans_page: this.plansPage };
    }
    const upgrade = this.deps.billingLink?.("upgrade", this.user.id) ?? null;
    const agencyUrl = this.deps.agencyAccounts ? this.deps.billingLink?.("agency", this.user.id) ?? null : null;
    const agency = agencyUrl ? { agency: `up to ${accountsLabel(this.deps.agencyAccounts!)}, ${AGENCY_PRICE_LABEL}, cancel any time`, agency_upgrade_url: agencyUrl } : {};
    const account_page = `${this.deps.baseUrl}/account`;
    const usage = { accounts_in_use: this.accountsInUse(), accounts_included: this.accountLimit, window_days: ACCOUNT_WINDOW_DAYS };
    return this.isPro
      ? { plan: this.planName, account_page, ...usage,
          // Paid is plan = 'pro' or 'agency' (a live subscription). Pro any other way is complimentary (PRO_EMAILS):
          // nothing to manage or cancel, even if an old Stripe customer is still on record.
          ...(isPaid(this.user.plan) && this.user.stripe_customer
            ? { manage_billing: this.deps.billingLink?.("billing", this.user.id) ?? null }
            : { complimentary: true, manage_billing: null }),
          // Pro → Agency switches on the billing page (Stripe's portal), with the difference prorated.
          ...(this.planName === "pro" ? agency : {}) }
      : { plan: "free", account_page, ...usage, ...this.serviceUsage(),
          included: this.freeIncluded(),
          pro: `${this.deps.freeOneService ? "Google Ads, Search Console and Google Analytics together, on " : ""}up to ${accountsLabel(this.deps.proAccounts)}, ${PRO_PRICE_LABEL}, cancel any time`,
          upgrade_url: upgrade, ...agency,
          note: upgrade ? "upgrade_url is personal to this user and expires in 7 days." : "Upgrades are not open yet." };
  }

  // ---------------------------------------------------------------- read

  /** `fresh` skips the cache: list_accounts, and an account id the cached list doesn't have (it may be new). */
  async accounts(opts: { fresh?: boolean } = {}): Promise<Account[]> {
    const hit = accountsCache.get(this.user.id);
    if (!opts.fresh && hit && Date.now() - hit.at < ACCOUNTS_TTL_MS) {
      this.lastUnreadable = hit.unreadable;
      return hit.list;
    }
    const out = new Map<string, Account>();
    const unreadable: Unreadable[] = [];
    let roots: string[] = [];
    try {
      roots = await this.ads.listAccessibleCustomers();
    } catch (e) {
      // A login with no Google Ads at all (NOT_ADS_USER), or that didn't grant Google Ads, gets the demo account instead of a dead end.
      if (e instanceof NotConnectedError) throw e;
      unreadable.push({ customerId: "this Google login", error: (e as Error).message, ...(e instanceof NotGrantedError && e.link ? { grant_url: e.link } : {}) });
    }
    // All roots at once; merged below in Google's order, so the result is the same as reading them one by one.
    // Every level, not just direct clients: a manager under a manager has its own clients, which a level <= 1 read never
    // listed (2026-10-23). The root works as login-customer-id at any depth below it.
    const perRoot = await Promise.all(roots.map((root) => this.ads.search(root, `SELECT customer_client.id, customer_client.descriptive_name,
        customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level, customer_client.status
      FROM customer_client WHERE customer_client.status = 'ENABLED'`, root)
      .then((rows) => ({ rows }), (e: Error) => ({ error: e.message }))));
    for (const [i, root] of roots.entries()) {
      const got = perRoot[i]!;
      if ("error" in got) {
        // One cancelled account shouldn't hide the rest, but the reason must never be swallowed:
        // an empty list that is really an API refusal reads as "you have no accounts".
        unreadable.push({ customerId: root, error: got.error });
        continue;
      }
      for (const r of got.rows) {
        const c = r.customerClient;
        const cid = String(c.id);
        const viaSelf = cid === root;
        if (out.has(cid) && !viaSelf) continue;
        out.set(cid, {
          customerId: cid,
          name: c.descriptiveName ?? "(unnamed)",
          currency: c.currencyCode ?? "",
          manager: !!c.manager,
          loginCustomerId: viaSelf ? null : root,
          ...(c.timeZone ? { timeZone: c.timeZone } : {}),
        });
      }
    }
    const list = [...out.values()].sort((a, b) => Number(a.manager) - Number(b.manager) || a.name.localeCompare(b.name));
    // Only when something was readable or nothing failed: a refusal would otherwise overwrite a real count with 0.
    if (out.size || !unreadable.length) {
      const managers = list.filter((a) => a.manager).map((a) => a.customerId);
      this.deps.db.prepare("UPDATE users SET ads_accounts = ?, ads_managers = ?, ads_manager_ids = ?, ads_accounts_at = ? WHERE id = ?")
        .run(list.length - managers.length, managers.length, JSON.stringify(managers), now(), this.user.id);
    }
    // Nothing readable (no Ads access, or blocked e.g. by 2-Step Verification): offer the demo account,
    // and keep the reason in lastUnreadable so list_accounts still says why the real ones are missing.
    if (!list.some((a) => !a.manager)) list.push(DEMO_ACCOUNT);
    // A first guess at their time zone, until they work on a specific account (account() below).
    const tz = list.find((a) => !a.manager && a.timeZone)?.timeZone;
    if (tz) this.deps.db.prepare("UPDATE users SET time_zone = ? WHERE id = ? AND time_zone IS NULL").run(tz, this.user.id);
    this.lastUnreadable = unreadable;
    accountsCache.set(this.user.id, { at: Date.now(), list, unreadable });
    return list;
  }

  /**
   * Whether each ad account spent anything in the last 30 days, so the user picks a live account rather than a dormant
   * one by name (on Free that pick holds for 30 days). Only when the user is listing or choosing accounts, one small
   * query per account (up to ACTIVITY_MAX), never more than ACTIVITY_WAIT_MS. An account Google doesn't answer for is
   * left out, never guessed. Stores only the count (users.ads_active), for the admin site's opportunities.
   */
  async spendActivity(list: Account[]): Promise<Map<string, boolean>> {
    const all = list.filter((a) => !a.manager && !isDemo(a.customerId));
    const ads = all.slice(0, ACTIVITY_MAX);
    const key = (c: string) => `${this.user.id}|${c}`;
    const fresh = (c: string) => { const h = activityCache.get(key(c)); return h && Date.now() - h.at < ACTIVITY_TTL_MS ? h : undefined; };
    const checks = mapLimited(ads.filter((a) => !fresh(a.customerId)), (a) => this.ads.search(a.customerId,
      "SELECT metrics.cost_micros FROM customer WHERE segments.date DURING LAST_30_DAYS", a.loginCustomerId)
      .then((rows) => { activityCache.set(key(a.customerId), { at: Date.now(), spent: rows.some((r) => Number(r.metrics?.costMicros ?? 0) > 0) }); }, () => {}));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([checks, new Promise((r) => { timer = setTimeout(r, ACTIVITY_WAIT_MS); })]);
    clearTimeout(timer);
    const done = new Map<string, boolean>();
    for (const a of ads) { const h = fresh(a.customerId); if (h) done.set(a.customerId, h.spent); }
    // The count only when every account answered: a partial one would read as fewer live accounts than there are.
    if (all.length && done.size === all.length) {
      this.deps.db.prepare("UPDATE users SET ads_active = ?, ads_active_at = ? WHERE id = ?")
        .run([...done.values()].filter(Boolean).length, now(), this.user.id);
    }
    return done;
  }

  /** `list` with spentLast30Days set where it's known. */
  async withActivity(list: Account[]): Promise<Account[]> {
    const spent = await this.spendActivity(list);
    return list.map((a) => (spent.has(a.customerId) ? { ...a, spentLast30Days: spent.get(a.customerId) } : a));
  }

  async account(customerId: string): Promise<Account> {
    const cid = bareCid(customerId);
    if (cid === DEMO_CID) return DEMO_ACCOUNT;  // anyone can try the demo by its id
    const a = (await this.accounts()).find((x) => x.customerId === cid)
      ?? (await this.accounts({ fresh: true })).find((x) => x.customerId === cid);
    // "Call list_accounts" alone sent a model that had already called it back in a loop, and the user gave up (2026-10-27).
    // A user-typed id usually belongs to another Google login, so say which login this is and how to get access.
    if (!a) throw new Error(`Account ${customerId} isn't one that ${this.user.email}, the Google login connected to Camberstack, can open. `
      + `If the user gave this id, it most likely belongs to a different Google login: give ${this.user.email} access to it in Google Ads `
      + "(Admin, then Access and security), or disconnect and connect again with the Google login that has it. "
      + `list_accounts lists the accounts ${this.user.email} can open.`);
    if (a.manager) throw new Error(`${a.name} (${cid}) is a manager account; pick one of the client accounts under it.`);
    // The account they actually work on sets their time zone (lifecycle emails go out in their morning).
    if (a.timeZone) this.deps.db.prepare("UPDATE users SET time_zone = ? WHERE id = ? AND time_zone IS NOT ?").run(a.timeZone, this.user.id, a.timeZone);
    return a;
  }

  async overview(customerId: string, days: number) {
    const a = await this.account(customerId);
    const rows = await this.ads.search(a.customerId, `SELECT campaign.id, campaign.name, campaign.status,
        campaign.advertising_channel_type, campaign_budget.amount_micros, campaign.bidding_strategy_type,
        metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
      FROM campaign WHERE ${dateRange(days)} AND campaign.status != 'REMOVED'`, a.loginCustomerId);
    const summed = aggregate(rows, (r) => String(r.campaign.id), (r) => ({
      campaign_id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status, type: r.campaign.advertisingChannelType,
      bidding: r.campaign.biddingStrategyType, daily_budget: micros(r.campaignBudget?.amountMicros),
      cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0,
    }), (e, r) => {
      e.impressions += Number(r.metrics?.impressions ?? 0);
      e.conversion_value += Number(r.metrics?.conversionsValue ?? 0);
    });
    const campaigns = summed.map((c) => ({
      ...c, cost: round(c.cost), conversions: round(c.conversions),
      cost_per_conversion: c.conversions > 0 ? round(c.cost / c.conversions) : null,
    })).sort((x, y) => y.cost - x.cost);
    const cost = campaigns.reduce((s, c) => s + c.cost, 0);
    const conv = campaigns.reduce((s, c) => s + c.conversions, 0);
    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      ...demoNote(a.customerId),
      window: `last ${days} days`,
      totals: { cost: round(cost), conversions: round(conv), cost_per_conversion: conv > 0 ? round(cost / conv) : null },
      campaigns,
    };
  }

  async runQuery(customerId: string, query: string) {
    if (!/^\s*select\b/i.test(query)) throw new Error(`Only SELECT (read-only GAQL) queries are allowed. Use ${this.tool("propose_changes")} to change anything.`);
    const lookup = fieldQuery(query);
    if (lookup !== null) return this.fieldLookup(lookup);
    const a = await this.account(customerId);
    const { query: current, renamed } = renameFields(query);
    const { query: expanded, rewrote } = expandDuring(current);
    let q = expanded;
    // Models filter or sort on a field they didn't select despite the rule in run_gaql's description. Google names the
    // field, so select it and rerun rather than spend the model's turn on the retry.
    const added: string[] = [];
    let rows: any[];
    for (;;) {
      try {
        rows = await this.ads.search(a.customerId, q, a.loginCustomerId);
        break;
      } catch (e) {
        const missing = e instanceof AdsApiError ? missingSelectFields(e.body).filter((f) => !added.includes(f)) : [];
        if (!missing.length || added.length >= 5) {
          // Google's own message is often vague ("Unrecognized field"); add what its field catalog says, by name.
          const found = e instanceof AdsApiError ? await this.gaqlCheck(q) : [];
          if (found.length) (e as Error).message += `\nGoogle's field catalog: ${found.join(" ")}`;
          throw e;
        }
        added.push(...missing);
        q = q.replace(/^\s*select\s+/i, `SELECT ${missing.join(", ")}, `);
      }
    }
    // A finding on a query Google ran is a bug in the check, not in the query: report it, never show it. To Bugsink as well
    // as the log, which every deploy replaces: none had survived to say whether the check was ever wrong (2026-10-22).
    // The shape, not the query: the event leaves the box, and the query carries the user's values.
    void this.gaqlCheck(q).then((found) => {
      if (!found.length) return;
      const msg = `gaql check false positive: ${found.join(" ")} | ${queryShape(q).slice(0, 300)}`;
      console.error(msg);
      reportBug(msg, "run_gaql");
    });
    return { ...demoNote(a.customerId), ...(rewrote.length ? { rewritten: `Google only accepts LAST_7/14/30_DAYS, so ran ${rewrote.join(", ")} (dates in UTC)` } : {}),
      ...(renamed.length ? { renamed: `These fields were renamed in the API, so ran ${renamed.join(", ")} (a date and time, e.g. 2026-01-31 23:59:59)` } : {}),
      ...(added.length ? { added_to_select: `Google requires fields used in WHERE or ORDER BY to be selected too, so added ${added.join(", ")} to SELECT` } : {}),
      rows: rows.slice(0, 500), truncated: rows.length > 500, total_rows: rows.length };
  }

  /**
   * run_gaql's field lookup: the query goes to Google's field catalog as written (its own filters, LIKE included), not
   * to an account, so it needs none and counts toward no plan (tools.ts skips the gate for it).
   */
  private async fieldLookup(query: string) {
    const fetch = this.ads.searchFields;
    if (!fetch) throw new Error("Google's field catalog isn't reachable right now. Try again in a few minutes.");
    let rows: any[];
    try {
      rows = await fetch(query);
    } catch (e) {
      // A rejected lookup (400) would draw run_gaql's account-query fixes (UNRECOGNIZED_FIELD…), which don't apply: swap them
      // for the lookup's own, and say how to read an account, since a query that forgot its FROM lands here too.
      if (e instanceof AdsApiError && e.status === 400) (e as Error).message = (e as Error).message.replace(/ → .*?(?=; [A-Z_]{3,} |\n|$)/g, "")
        + `\nA query with no FROM is a field lookup, which selects from: ${FIELD_COLUMNS}. `
        + "E.g. SELECT name, category, selectable WHERE name LIKE '%search_term%', or SELECT attribute_resources, metrics, segments WHERE name = 'campaign'. "
        + "To read the account instead, add FROM and a resource (FROM campaign).";
      throw e;
    }
    // A field's selectable_with can run to hundreds of names; WHERE filters rows, not a row's lists, so cap only well past the
    // longest a resource needs (campaign: ~200 metrics, 2026-10-16).
    const LIST = 500;
    const out = rows.slice(0, 500).map(({ resourceName: _, ...r }) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, Array.isArray(v) && v.length > LIST ? [...v.slice(0, LIST), `… ${v.length - LIST} more not shown`] : v])));
    return { field_lookup: "Google's field catalog (no account involved)", rows: out, truncated: rows.length > 500, total_rows: rows.length };
  }

  /** What Google's field catalog finds wrong with a query; empty when nothing, or when the catalog can't be had. */
  private async gaqlCheck(query: string): Promise<string[]> {
    const cat = await this.fieldCatalog();
    return cat ? checkGaql(query, cat) : [];
  }

  private fieldCatalog() {
    const fetch = this.ads.searchFields;
    return fetch ? catalog(() => fetch(CATALOG_QUERY)) : Promise.resolve(null);
  }

  async gaqlFields(o: { resource?: string; search?: string }) {
    const cat = await this.fieldCatalog();
    if (!cat) throw new Error("Google's field catalog isn't reachable right now. Try again in a few minutes.");
    return lookupFields(cat, o);
  }

  /** Keyword Planner ideas from seed keywords and/or a URL, biggest first, flagged where the account already has them. */
  async keywordIdeas(customerId: string, o: KeywordPlanOpts & { keywords?: string[]; url?: string; min_searches: number; limit: number }) {
    const a = await this.account(customerId);
    const keywords = [...new Set((o.keywords ?? []).map((k) => k.trim()).filter(Boolean))];
    if (!keywords.length && !o.url) throw new Error("Give at least one seed keyword or a URL.");
    const seed = keywords.length && o.url ? { keywordAndUrlSeed: { keywords, url: o.url } }
      : keywords.length ? { keywordSeed: { keywords } } : { urlSeed: { url: o.url } };
    const [res, have] = await Promise.all([
      this.ads.keywordPlan(a.customerId, "generateKeywordIdeas", { ...planTarget(o), includeAdultKeywords: false, ...seed }, a.loginCustomerId),
      this.keywordsInAccount(a),
    ]);
    const ideas = (res.results ?? [])
      .map((r) => keywordRow(r.text, r.keywordIdeaMetrics, have))
      .filter((k) => k.avg_monthly_searches !== null && k.avg_monthly_searches >= o.min_searches)
      .sort((x, y) => y.avg_monthly_searches! - x.avg_monthly_searches!);
    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      ...demoNote(a.customerId),
      target: { location_ids: o.location_ids, language_id: o.language_id },
      ideas: ideas.slice(0, o.limit), total_ideas: ideas.length,
    };
  }

  /** Keyword Planner volume, competition and bids for an exact list, with the last 12 months of searches. */
  async keywordMetrics(customerId: string, o: KeywordPlanOpts & { keywords: string[] }) {
    const a = await this.account(customerId);
    const keywords = [...new Set(o.keywords.map((k) => k.trim()).filter(Boolean))];
    const [res, have] = await Promise.all([
      this.ads.keywordPlan(a.customerId, "generateKeywordHistoricalMetrics", { ...planTarget(o), includeAdultKeywords: false, keywords }, a.loginCustomerId),
      this.keywordsInAccount(a),
    ]);
    const rows = (res.results ?? []).map((r) => ({
      ...keywordRow(r.text, r.keywordMetrics, have),
      ...(r.closeVariants?.length ? { close_variants: r.closeVariants } : {}),
      monthly: monthly(r.keywordMetrics?.monthlySearchVolumes),
    }));
    // Google omits keywords it has no data for; say so rather than dropping them silently.
    const covered = new Set(rows.flatMap((r) => [r.keyword, ...(r.close_variants ?? [])].map((k: string) => k.toLowerCase())));
    const head = {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      ...demoNote(a.customerId),
      target: { location_ids: o.location_ids, language_id: o.language_id },
    };
    const noData = keywords.filter((k) => !covered.has(k.toLowerCase()));
    if (rows.length <= COMPACT_OVER) return { ...head, keywords: rows, no_data: noData };
    // A big list as objects repeats every field name per row and floods the AI's context: one header, then arrays.
    const months = [...new Set(rows.flatMap((r) => Object.keys(r.monthly)))].sort();
    return {
      ...head,
      columns: ["keyword", "avg_monthly_searches", "competition", "bid_low", "bid_high", "in_account", "monthly"],
      months,
      rows: rows.map((r) => [r.keyword, r.avg_monthly_searches, r.competition, r.top_of_page_bid.low, r.top_of_page_bid.high,
        (r as { in_account?: string }).in_account ?? null, months.map((m) => (r.monthly as Record<string, number>)[m] ?? null)]),
      no_data: noData,
    };
  }

  /** Lowercased keyword text → "keyword" or "negative", across the whole account. */
  private async keywordsInAccount(a: Account): Promise<Map<string, "keyword" | "negative">> {
    const [kw, neg] = await Promise.all([
      this.ads.search(a.customerId, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.negative
        FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`, a.loginCustomerId),
      this.ads.search(a.customerId, `SELECT campaign_criterion.keyword.text
        FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = true`, a.loginCustomerId),
    ]);
    const m = new Map<string, "keyword" | "negative">();
    for (const r of kw) {
      const t = r.adGroupCriterion?.keyword?.text?.toLowerCase();
      if (t) m.set(t, r.adGroupCriterion.negative ? "negative" : "keyword");
    }
    for (const r of neg) {
      const t = r.campaignCriterion?.keyword?.text?.toLowerCase();
      if (t && !m.has(t)) m.set(t, "negative");
    }
    return m;
  }

  // ---------------------------------------------------------------- Search Console (read-only)

  /** Search Console properties this login can read; the demo site only when there are none. */
  async searchConsoleSites() {
    let sites: { siteUrl: string; permissionLevel: string }[];
    try {
      sites = (await this.sc.sites()).filter((x) => x.permissionLevel !== "siteUnverifiedUser");
    } catch (e) {
      if (!(e instanceof NotGrantedError)) throw e;
      return { sites: [{ site_url: DEMO_SITE, permission: "demo" }], not_granted: e.message, ...(e.link ? { grant_url: e.link } : {}),
        note: "Only the demo site is available until the user adds Search Console. Say so plainly and give them grant_url." };
    }
    if (sites.length) return { sites: sites.map((x) => ({ site_url: x.siteUrl, permission: x.permissionLevel })) };
    return { sites: [{ site_url: DEMO_SITE, permission: "demo" }],
      note: "This Google login has no verified Search Console property, so the demo site (sample data) is offered. Tell the user it is a demo." };
  }

  /**
   * Site-wide totals for the window and for the same number of days before it. With no dimension Google returns the
   * site's true totals, including the rare queries it leaves out of per-query rows.
   */
  async searchConsoleSummary(site: string, o: ScWindowOpts) {
    const cur = scWindow(o);
    const prev = priorWindow(cur);
    const [now_, before] = await Promise.all([this.scTotals(site, cur, o.fresh), this.scTotals(site, prev, o.fresh)]);
    const pct = (a: number, b: number) => (b > 0 ? round(((a - b) / b) * 100) : null);
    return {
      site, ...siteNote(site),
      current: { window: cur, ...now_ }, previous: { window: prev, ...before },
      change: {
        clicks_pct: pct(now_.clicks, before.clicks), impressions_pct: pct(now_.impressions, before.impressions),
        ctr_points: round(now_.ctr_pct - before.ctr_pct),
        position: now_.position != null && before.position != null ? Math.round((now_.position - before.position) * 10) / 10 : null,
      },
      note: "A lower position is better: a negative position change means the site moved up."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /** Undimensioned site totals: the only figure that includes the rare queries Google withholds from per-query rows. */
  private async scTotals(site: string, w: { start: string; end: string }, fresh?: boolean) {
    const [r] = await this.sc.searchAnalytics(site, { startDate: w.start, endDate: w.end, dimensions: [], rowLimit: 1, ...dataState(fresh) });
    return r ? organicMetrics(r) : { clicks: 0, impressions: 0, ctr_pct: 0, position: null };
  }

  /** Every row for one dimension, paging past Google's 25,000-row cap (up to SC_MAX_ROWS) so "lost" means lost, not truncated. */
  private async scAllRows(site: string, req: Omit<SearchAnalyticsRequest, "rowLimit" | "startRow">) {
    const out: SearchAnalyticsRow[] = [];
    for (let startRow = 0; startRow < SC_MAX_ROWS; startRow += 25_000) {
      const rows = await this.sc.searchAnalytics(site, { ...req, rowLimit: 25_000, startRow });
      out.push(...rows);
      if (rows.length < 25_000) return { rows: out, truncated: false };
    }
    return { rows: out, truncated: true };
  }

  /** Search performance (clicks, impressions, CTR, position) grouped by the given dimensions, most clicks first. */
  async searchConsolePerformance(site: string, o: ScWindowOpts & ScFilterOpts & { dimensions: string[]; limit: number }) {
    const w = scWindow(o);
    const filters = scFilters(o);
    const rows = await this.sc.searchAnalytics(site, { startDate: w.start, endDate: w.end, dimensions: o.dimensions, rowLimit: o.limit,
      ...dataState(o.fresh), ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}) });
    return {
      site, ...siteNote(site), window: w,
      rows: rows.map((r) => ({ ...Object.fromEntries(o.dimensions.map((d, i) => [d, r.keys[i]])), ...organicMetrics(r) })),
      note: "Search Console leaves out rare queries for privacy, so query rows don't add up to the site's total clicks."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /**
   * Two adjacent equal windows, compared query by query and page by page: what is rising, falling, new and gone,
   * and rising searches the site is sliding down on. Totals come from undimensioned requests, not row sums.
   */
  async searchConsoleTrend(site: string, o: ScWindowOpts & { exclude_query_regex?: string; min_impressions: number; limit: number }) {
    const cur = scWindow(o);
    const prev = priorWindow(cur);
    const exclude = o.exclude_query_regex ? { dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "excludingRegex", expression: o.exclude_query_regex }] }] } : {};
    const pull = (w: { start: string; end: string }, dim: string) =>
      this.scAllRows(site, { startDate: w.start, endDate: w.end, dimensions: [dim], ...dataState(o.fresh), ...(dim === "query" ? exclude : {}) });
    const [qCur, qPrev, pCur, pPrev, tCur, tPrev] = await Promise.all([
      pull(cur, "query"), pull(prev, "query"), pull(cur, "page"), pull(prev, "page"),
      this.scTotals(site, cur, o.fresh), this.scTotals(site, prev, o.fresh),
    ]);
    const queries = diffWindows(qCur.rows, qPrev.rows, o.min_impressions);
    const pages = diffWindows(pCur.rows, pPrev.rows, o.min_impressions);
    const moving = queries.filter((r) => !r.state);
    const up = (a: TrendRow, b: TrendRow) => b.impressions_change - a.impressions_change;
    const down = (a: TrendRow, b: TrendRow) => a.impressions_change - b.impressions_change;
    const pct = (a: number, b: number) => (b > 0 ? round(((a - b) / b) * 100) : null);
    return {
      site, ...siteNote(site), current_window: cur, prior_window: prev,
      totals: { current: tCur, prior: tPrev, impressions_pct: pct(tCur.impressions, tPrev.impressions), clicks_pct: pct(tCur.clicks, tPrev.clicks) },
      counts: { queries_current: qCur.rows.length, queries_prior: qPrev.rows.length, compared: queries.length,
        new: queries.filter((r) => r.state === "new").length, lost: queries.filter((r) => r.state === "lost").length },
      ...(qCur.truncated || qPrev.truncated ? { truncated: `More than ${SC_MAX_ROWS} queries in a window; the rest weren't compared.` } : {}),
      rising_queries: moving.filter((r) => r.impressions_change > 0).sort(up).slice(0, o.limit),
      falling_queries: moving.filter((r) => r.impressions_change < 0).sort(down).slice(0, o.limit),
      new_queries: queries.filter((r) => r.state === "new").sort(up).slice(0, o.limit),
      lost_queries: queries.filter((r) => r.state === "lost").sort(down).slice(0, o.limit),
      losing_ground: moving.filter((r) => r.impressions_change > 0 && (r.position_change ?? 0) > 0.5).sort(up).slice(0, o.limit),
      rising_pages: pages.filter((r) => r.impressions_change > 0).sort(up).slice(0, o.limit),
      falling_pages: pages.filter((r) => r.impressions_change < 0).sort(down).slice(0, o.limit),
      how_to_read: `Rows need at least ${o.min_impressions} impressions in one of the windows. A negative position_change means the site moved up. `
        + "losing_ground: searches growing while the site's position gets worse. Adjacent windows mix trend with seasonality, so check "
        + "anything seasonal against the same dates a year earlier. A page that falls while a near-identical URL (trailing slash, www, "
        + "http) rises is Google consolidating duplicates, not lost demand: check it with search_console_inspect_urls before acting."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /**
   * Where more clicks are within reach: queries on positions 4-20 with real impressions (projected to a realistic climb),
   * top-5 queries whose CTR is under half of what that position usually gets (a title/description problem), and
   * question-shaped queries. Projections use a typical CTR-by-position curve, not the site's own.
   */
  async searchConsoleOpportunities(site: string, o: ScWindowOpts & { exclude_query_regex?: string; limit: number }) {
    const w = scWindow(o);
    const { rows } = await this.scAllRows(site, { startDate: w.start, endDate: w.end, dimensions: ["query"], ...dataState(o.fresh),
      ...(o.exclude_query_regex ? { dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "excludingRegex", expression: o.exclude_query_regex }] }] } : {}) });
    const q = (r: SearchAnalyticsRow) => ({ query: r.keys[0], ...organicMetrics(r) });
    const striking = rows.filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 15).map((r) => {
      const target = Math.max(3, Math.floor(r.position) - 3);
      const projected = r.impressions * ctrAt(target);
      return { ...q(r), target_position: target, projected_clicks: round(projected), click_gain: round(projected - r.clicks) };
    }).sort((a, b) => b.click_gain - a.click_gain);
    const snippet = rows.filter((r) => r.position <= 5 && r.impressions >= 30 && r.ctr < ctrAt(r.position) * 0.5)
      .map((r) => ({ ...q(r), typical_ctr_pct: round(ctrAt(r.position) * 100), click_gain: round(r.impressions * ctrAt(r.position) - r.clicks) }))
      .sort((a, b) => b.click_gain - a.click_gain);
    const questions = rows.filter((r) => QUESTION.test(r.keys[0] ?? "") && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions).map(q);
    return {
      site, ...siteNote(site), window: w,
      striking_distance: striking.slice(0, o.limit), striking_distance_total: striking.length,
      snippet_gaps: snippet.slice(0, o.limit), snippet_gaps_total: snippet.length,
      question_queries: questions.slice(0, o.limit), question_queries_total: questions.length,
      how_to_read: "striking_distance: positions 4-20 with 15+ impressions; click_gain assumes a climb of about 3 places (not to #1). "
        + "snippet_gaps: top-5 positions with 30+ impressions but under half the usual CTR there: rewrite the title and meta description, "
        + "or check for a missing rich result. question_queries: question- and comparison-shaped searches, the kind answer boxes and AI "
        + "answers draw on. Expected CTRs are industry averages, so treat click_gain as a ranking of opportunities, not a forecast. "
        + "Empty lists are a finding: nothing is close enough for a quick win. Exclude the brand name with exclude_query_regex."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /**
   * Google's index record for each URL: indexed or not and why, last crawl, canonical chosen vs declared, and
   * structured-data items. One call per URL, 10 at a time: each takes seconds at Google, and a call carries at most
   * 20 URLs, so that is two rounds at most (Google allows 600 a minute, 2,000 a day per property).
   */
  async searchConsoleInspectUrls(site: string, urls: string[]) {
    const results: Record<string, unknown>[] = await mapLimited(urls, (url) => this.sc.inspect(site, url).then(
      (r) => inspectionRow(url, r),
      (e: Error) => {
        if (e instanceof NotGrantedError) throw e;
        return { url, error: e.message };
      }), 10);
    const tally: Record<string, number> = {};
    for (const r of results) { const k = String(r.coverage_state ?? (r.error ? "error" : "unknown")); tally[k] = (tally[k] ?? 0) + 1; }
    return {
      site, ...siteNote(site), tally, results,
      note: "Each verdict describes Google's last crawl (last_crawl), not the live page: a fix made after that date still shows the old state. "
        + "\"Discovered - currently not indexed\" means Google knows the URL but hasn't spent a crawl on it; \"Crawled - currently not indexed\" "
        + "means it crawled and declined. Google's index-coverage report in the Search Console UI lags this by days. Requesting indexing "
        + "and submitting sitemaps can only be done in Search Console itself.",
    };
  }

  /** Sitemaps submitted for the property: when Google last fetched each, URL counts and error/warning counts. Read-only. */
  async searchConsoleSitemaps(site: string) {
    const list = await this.sc.sitemaps(site);
    return {
      site, ...siteNote(site),
      sitemaps: list.map((m) => ({
        path: m.path, last_submitted: m.lastSubmitted ?? null, last_downloaded: m.lastDownloaded ?? null, pending: m.isPending ?? false,
        index: m.isSitemapsIndex ?? false, errors: Number(m.errors ?? 0), warnings: Number(m.warnings ?? 0),
        urls_submitted: (m.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0),
      })),
      note: list.length ? "Submitting or resubmitting a sitemap can only be done in Search Console itself."
        : "No sitemap is submitted for this property. The user can submit one in Search Console (Indexing > Sitemaps).",
    };
  }

  /**
   * Ads search terms joined with the same site's organic queries over the same days: searches the account pays for
   * where the site already ranks near the top, and searches the site ranks on page 2+ for with no ads at all.
   */
  async paidOrganicOverlap(customerId: string, site: string, o: { days: number; max_position: number; min_impressions: number; limit: number }) {
    const a = await this.account(customerId);
    const w = searchConsoleWindow(o.days);
    const [terms, organic, have] = await Promise.all([
      this.ads.search(a.customerId, `SELECT search_term_view.search_term, campaign.id, campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM search_term_view WHERE segments.date BETWEEN '${w.start}' AND '${w.end}'`, a.loginCustomerId),
      this.sc.searchAnalytics(site, { startDate: w.start, endDate: w.end, dimensions: ["query"], rowLimit: 25000 }),
      this.keywordsInAccount(a),
    ]);
    const paid = new Map(aggregate(terms, (r) => norm(String(r.searchTermView?.searchTerm ?? "")),
      (r) => ({ term: norm(String(r.searchTermView?.searchTerm ?? "")), cost: 0, clicks: 0, conversions: 0, campaigns: new Set<string>() }),
      (e, r) => { if (r.campaign?.name) e.campaigns.add(String(r.campaign.name)); })
      .filter((e) => e.term && e.cost > 0).map((e) => [e.term, e]));

    const paidAndRanking = organic.flatMap((r) => {
      const p = paid.get(norm(r.keys[0] ?? ""));
      return p && r.position <= o.max_position ? [{
        query: r.keys[0], organic_position: Math.round(r.position * 10) / 10, organic_clicks: r.clicks, organic_impressions: r.impressions,
        ad_cost: round(p.cost), ad_clicks: p.clicks, ad_conversions: round(p.conversions), campaigns: [...p.campaigns],
      }] : [];
    }).sort((x, y) => y.ad_cost - x.ad_cost);

    const organicGaps = organic.flatMap((r) => {
      const q = norm(r.keys[0] ?? "");
      return r.position > 10 && r.impressions >= o.min_impressions && !paid.has(q) && !have.has(q)
        ? [{ query: r.keys[0], ...organicMetrics(r) }] : [];
    }).sort((x, y) => y.impressions - x.impressions);

    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      site, ...demoNote(a.customerId), ...siteNote(site), window: w,
      paid_and_ranking: paidAndRanking.slice(0, o.limit),
      paid_and_ranking_total: { queries: paidAndRanking.length, ad_cost: round(paidAndRanking.reduce((s, x) => s + x.ad_cost, 0)) },
      organic_gaps: organicGaps.slice(0, o.limit), organic_gaps_total: organicGaps.length,
      how_to_use: `paid_and_ranking: searches the account pays for where the site already averages position ${o.max_position} or better organically. `
        + "Ads sit above organic results and brand terms defend against competitors, so don't cut them all: suggest testing one at a time "
        + "(set_keyword_bid lower, or add_negative_keywords) and comparing total clicks before and after. "
        + "organic_gaps: searches the site shows up for on page 2 or lower with no ad and no keyword in the account; check them with "
        + `keyword_metrics, then add_keywords or add_ad_group through ${this.tool("propose_changes")}. Search Console leaves out rare queries, so both lists are partial.`,
    };
  }

  // ---------------------------------------------------------------- write

  async propose(customerId: string, rawChanges: unknown[], undoOf?: string): Promise<Proposed | AlreadyInPlace> {
    const ga = customerId === GA_TARGET;
    const a = ga ? { customerId: GA_TARGET, loginCustomerId: null } : await this.account(customerId);
    const changes: AnyChange[] = rawChanges.map((c) => (ga ? GaChangeSchema : ChangeSchema).parse(c));
    // GA4 has no dry run, so a Google Ads id this login can't reach would only fail at apply: check it now.
    for (const c of changes) {
      if (c.type !== "link_google_ads") continue;
      if (!(await this.accounts()).some((x) => x.customerId === c.customer_id && !isDemo(x.customerId))) {
        throw new Error(`Google Ads account ${c.customer_id} isn't one this login can reach (list_accounts shows them), so it can't be linked.`);
      }
    }
    const count = changes.reduce((n, c) => n + (c.type === "add_negative_keywords" || c.type === "add_keywords" ? c.keywords.length : 1), 0);
    if (count > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} changes per proposal (got ${count}). Split it.`);
    const pending = pendingOf(changes as Change[]);
    // Resolving only reads, and `pending` already carries what sibling changes set, so the changes resolve in parallel.
    const resolved = await mapLimited(changes, (c) => this.resolve(a.customerId, a.loginCustomerId, c, pending))
      .catch((e) => this.explainUnappliedGa4(e, changes));
    const live = resolved.filter((r) => r.operations.length);
    // Not an error: the account already reads as asked, and that is the answer.
    if (!live.length) {
      return { status: "already in place", changes: 0, skipped: resolved.map((r) => r.describe),
        note: "Nothing to propose: every requested change is already in place in the account, so there's nothing to approve or apply." };
    }
    // Dry run against Google so problems surface now, not after the user approves.
    await mapLimited(live, (r) => this.write(a.customerId, a.loginCustomerId, r, true))
      .catch((e) => this.explainEuBlock(e, a.customerId, a.loginCustomerId));
    const id = `p_${randomUUID().slice(0, 8)}`;
    const summary = summarize(live);
    this.deps.db.prepare(`INSERT INTO proposals (id, user_id, customer_id, login_customer_id, changes, summary, status, undo_of, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`)
      .run(id, this.user.id, a.customerId, a.loginCustomerId, JSON.stringify(live.map((r) => r.change)), summary, undoOf ?? null, now());
    const skipped = resolved.filter((r) => !r.operations.length).map((r) => r.describe);
    return { proposal_id: id, summary, changes: live.length, skipped };
  }

  async apply(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status === "applied") return this.alreadyApplied(p);
    if (p.status !== "proposed") throw new Error(`Proposal ${proposalId} is already ${p.status}.`);
    const changes = JSON.parse(p.changes) as AnyChange[];
    // Claim it before any write: a client retrying after a timeout would otherwise apply it twice. applied_at
    // marks the claim, and an undo also claims the change it reverses, so two undos of one change can't both run.
    // A claim left by a server that died mid-apply can be retaken after STALE_CLAIM, unless re-running could
    // duplicate something (re-resolving skips what's already in place, but ads, ad groups and sitelinks have no
    // natural key to find them by).
    const retake = !changes.some((c) => NOT_REPEATABLE.has(c.type));
    const claimed = this.deps.db.prepare(`UPDATE proposals SET applied_at = ? WHERE id = ? AND status = 'proposed'
        AND (applied_at IS NULL OR (? AND applied_at < ?))
        AND (undo_of IS NULL OR NOT EXISTS (SELECT 1 FROM proposals o WHERE o.undo_of = proposals.undo_of AND o.id <> proposals.id
          AND o.applied_at IS NOT NULL AND o.status <> 'failed'))`).run(now(), p.id, retake ? 1 : 0, now() - STALE_CLAIM).changes;
    if (!claimed) {
      const cur = this.proposal(proposalId);
      if (cur.status === "applied") return this.alreadyApplied(cur);
      if (cur.status !== "proposed") throw new Error(`Proposal ${proposalId} is already ${cur.status}.`);
      if (cur.applied_at && cur.applied_at < now() - STALE_CLAIM) {
        throw new Error(`Proposal ${proposalId} was interrupted while applying, and it adds ads, ad groups or sitelinks, which re-running could duplicate. `
          + "Check the account with run_gaql and propose what's still missing.");
      }
      if (cur.applied_at) throw new Error(`Proposal ${proposalId} is already being applied.`);
      throw new Error(`Proposal ${p.undo_of} has already been undone.`);
    }
    const save = (status: "applied" | "failed", outcomes: Outcome[]) => this.deps.db
      .prepare("UPDATE proposals SET status = ?, result = ?, applied_at = ? WHERE id = ?").run(status, JSON.stringify(outcomes), now(), p.id);

    // All or nothing. Re-resolve (the account may have moved since the proposal was made) and validate every
    // change with Google before writing any; reads and validation run all at once, writes one at a time, in order.
    const pending = pendingOf(changes as Change[]);
    const checked = await mapLimited(changes, (c) => this.resolve(p.customer_id, p.login_customer_id, c, pending)
      .then((r) => (r.operations.length ? this.write(p.customer_id, p.login_customer_id, r, true) : Promise.resolve(null))
        .then(() => ({ r }), (e: Error) => ({ e, describe: r.describe })), (e: Error) => ({ e, describe: c.type as string })));
    if (checked.some((x) => "e" in x)) {
      const outcomes = checked.map((x): Outcome => ("e" in x
        ? { describe: x.describe, ok: false, error: x.e.message }
        : { describe: x.r.describe, ok: false, error: "not applied: another change in this proposal would fail" }));
      save("failed", outcomes);
      return { proposal_id: p.id, status: "failed", note: "Nothing was changed.", results: publicResults(outcomes) };
    }
    const drift = await this.drifted(p, checked.map((x) => (x as { r: AnyResolved }).r));
    if (drift) return drift;

    const outcomes: Outcome[] = [];
    let failed: { at: number; error: string } | undefined;
    for (const [i, x] of checked.entries()) {
      const r = (x as { r: AnyResolved }).r;
      if (!r.operations.length) { outcomes.push({ describe: `${r.describe} (already in place)`, ok: true }); continue; }
      try {
        const w = await this.write(p.customer_id, p.login_customer_id, r);
        outcomes.push({ describe: r.describe, ok: true, inverse: w.inverse, ...(w.note ? { note: w.note } : {}) });
      } catch (e) {
        failed = { at: i, error: (e as Error).message };
        outcomes.push({ describe: r.describe, ok: false, error: failed.error });
        break;
      }
    }
    if (!failed) {
      save("applied", outcomes);
      return { proposal_id: p.id, status: "applied", results: publicResults(outcomes),
        // A removal has no inverse (a removed campaign can't be restored), so don't offer an undo that would fail.
        undo: outcomes.some((o) => o.inverse) ? `To reverse this, call ${this.tool("undo_changes")} with proposal_id "${p.id}".` : undefined };
    }

    // A write failed despite validating (the account changed in between, or Google hiccuped): roll back the
    // writes before it, newest first. One that can't be rolled back stays applied, and undo_changes can still try.
    for (const o of outcomes.slice(0, -1).reverse()) {
      if (!o.inverse) { if (!o.describe.endsWith("(already in place)")) o.error = "applied, and can't be rolled back"; continue; }
      try {
        const r = await this.resolve(p.customer_id, p.login_customer_id, o.inverse, pendingOf([]));
        if (r.operations.length) await this.write(p.customer_id, p.login_customer_id, r);
        Object.assign(o, { ok: false, error: "rolled back", inverse: undefined });
      } catch (e) {
        o.error = `applied, and rolling it back failed: ${(e as Error).message}`;
      }
    }
    for (const x of checked.slice(failed.at + 1)) {
      outcomes.push({ describe: (x as { r: AnyResolved }).r.describe, ok: false, error: "not applied: an earlier change failed" });
    }
    const stuck = outcomes.some((o) => o.ok && o.inverse);
    save(outcomes.some((o) => o.ok && !o.describe.endsWith("(already in place)")) ? "applied" : "failed", outcomes);
    return {
      proposal_id: p.id, status: outcomes.some((o) => o.ok && o.error) ? "partially applied" : "failed",
      note: outcomes.some((o) => o.ok && o.error) ? "Some changes stayed applied; see results." : "Nothing was changed: the changes made before the failure were rolled back.",
      results: publicResults(outcomes),
      undo: stuck ? `To reverse what stayed applied, call ${this.tool("undo_changes")} with proposal_id "${p.id}".` : undefined,
    };
  }

  /**
   * The user approved a summary, and the summary carries the account's values at proposal time ("now ENABLED",
   * "$10 → $20"). Re-resolved against the account as it is now, the same changes must read the same, however old the
   * proposal is; if they don't, the account moved and what they approved is no longer what would run. Then nothing is
   * written: the old proposal is discarded and the same request is proposed afresh, for the user to approve. Not an
   * error: it's the expected answer to an account that changed. (Replaced a flat 24-hour expiry, 2026-10-15.)
   */
  /** A repeat apply of an applied proposal: not an error, the change is in, and that is the answer (2026-10-28: a model
   *  re-sent apply_changes 8s after it succeeded). Nothing is written again; the first apply's results are returned. */
  private alreadyApplied(p: ProposalRow) {
    const outcomes = p.result ? JSON.parse(p.result) as Outcome[] : [];
    const at = p.applied_at ? ` at ${new Date(p.applied_at * 1000).toISOString()}` : "";
    return { proposal_id: p.id, status: "applied", note: `Already applied${at}; nothing was changed again.`,
      results: publicResults(outcomes) };
  }

  private async drifted(p: ProposalRow, resolved: AnyResolved[]) {
    const live = resolved.filter((r) => r.operations.length);
    if (live.length && sameSummary(summarize(live), p.summary)) return null;
    this.deps.db.prepare("UPDATE proposals SET status = 'discarded', applied_at = NULL WHERE id = ?").run(p.id);
    if (!live.length) {
      return { proposal_id: p.id, status: "already in place",
        note: "Nothing was applied: every change in this proposal is already in place in the account, so there's nothing left to do." };
    }
    // `live` is non-empty, so this stores a proposal.
    const fresh = await this.propose(p.customer_id, live.map((r) => r.change), p.undo_of ?? undefined) as Proposed;
    return { proposal_id: fresh.proposal_id, status: "needs approval", replaces: p.id, summary: fresh.summary, skipped: fresh.skipped,
      note: `Nothing was applied: the account changed since ${p.id} was proposed, so it no longer matches what was approved. `
        + `Show the user this updated summary and call apply_changes with ${fresh.proposal_id} only after they approve it.` };
  }

  /**
   * An import fails until its key event is marked and the property linked. ChatGPT proposed mark_key_event, never applied
   * it, and tried the import 18 minutes later (prod, 2026-10-25). If an open GA4 proposal would make the import work,
   * name it, so the AI asks the user to approve it instead of retrying or giving up.
   */
  private explainUnappliedGa4(e: unknown, changes: AnyChange[]): never {
    if (!(e instanceof Error) || !e.message.startsWith("Google Ads has no conversion action for")) throw e;
    const imports = changes.filter((c): c is Extract<Change, { type: "import_ga4_key_event" }> => c.type === "import_ga4_key_event");
    const open = this.deps.db.prepare(`SELECT id, changes FROM proposals WHERE user_id = ? AND customer_id = ? AND status = 'proposed'
        ORDER BY created_at DESC`).all(this.user.id, GA_TARGET) as { id: string; changes: string }[];
    const waiting = open.filter((p) => (JSON.parse(p.changes) as GaChange[]).some((g) => imports.some((i) => (g.type === "link_google_ads"
      && g.property_id === i.property_id) || (g.type === "mark_key_event" && g.property_id === i.property_id && g.event_name === i.event_name))));
    if (!waiting.length) throw e;
    const ids = waiting.map((p) => p.id).join(", ");
    e.message += ` Proposal ${ids} would do that but hasn't been applied: show the user its summary, call apply_changes with it `
      + `once they approve, then propose this import again.`;
    throw e;
  }

  /**
   * Google refuses every change to an account with an undeclared campaign, and the hint alone left the AI to look them up.
   * When the lookup came back empty it had nothing to propose and stopped, twice for one user (prod, 2026-10-22). So
   * look them up here and name them, or say plainly that none show through the API and the user must answer in Google
   * Ads, and report that case: the account state that triggers it isn't known yet.
   */
  private async explainEuBlock(e: unknown, customerId: string, login: string | null): Promise<never> {
    if (!(e instanceof AdsApiError) || !e.body.includes("EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED")) throw e;
    const head = "Google Ads API 400: EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED Google refuses every change to this account until it has "
      + "the EU political advertising declaration. ";
    const missing = await this.ads.search(customerId, "SELECT campaign.id, campaign.name FROM campaign "
      + "WHERE campaign.missing_eu_political_advertising_declaration = TRUE AND campaign.status != 'REMOVED'", login).catch(() => null);
    if (!missing) throw e; // the static hint still says how to look them up
    if (missing.length) {
      e.message = head + `Not declared yet: ${missing.map((r) => `"${r.campaign.name}" (id ${r.campaign.id})`).join(", ")}. Ask the user whether `
        + "any of them run EU political ads (it is their legal declaration; most businesses answer no), propose set_eu_political_advertising "
        + "for each in one proposal, apply it, then propose this change again.";
      throw e;
    }
    e.message = head + "No campaign shows as missing it through the API, so Camberstack can't make the declaration. Ask the user to answer "
      + "the EU political ads question in Google Ads (in each campaign's settings, or Admin → Account settings), then propose this change again.";
    const state = await Promise.all([
      this.ads.search(customerId, "SELECT customer.contains_eu_political_advertising FROM customer", login),
      this.ads.search(customerId, "SELECT campaign.id, campaign.status, campaign.advertising_channel_type, campaign.contains_eu_political_advertising FROM campaign", login),
    ]).then(([[c], camps]) => `account ${c?.customer?.containsEuPoliticalAdvertising ?? "unset"}; campaigns not declared: `
      + (camps.filter((r) => !/^(CONTAINS|DOES_NOT_CONTAIN)_EU/.test(r.campaign.containsEuPoliticalAdvertising ?? ""))
        .map((r) => `${r.campaign.id} ${r.campaign.status} ${r.campaign.advertisingChannelType}`).join(", ") || "none"),
    (err: Error) => `state unreadable: ${err.message.slice(0, 200)}`);
    reportBug(`EU declaration required but none missing: customer ${customerId}, ${state}`, "propose_changes");
    throw e;
  }

  /** Read what a change would do against the live account (Google Ads) or property (Google Analytics). */
  private resolve(target: string, login: string | null, c: AnyChange, pending: ReturnType<typeof pendingOf>): Promise<AnyResolved> {
    // Only reads, so a brief Google outage is retried once.
    return retryTransient<AnyResolved>(() => (target === GA_TARGET ? resolveGaChange(this.ga, c as GaChange)
      : resolveChange(this.ads, target, login, c as Change, pending)), true);
  }

  /** Write a resolved change; `validateOnly` is Google Ads' dry run (GA4 has none: re-resolving is its check). */
  private async write(target: string, login: string | null, r: AnyResolved, validateOnly = false): Promise<{ inverse?: AnyChange; note?: string }> {
    // A write that creates nothing (a status change, a delete) is safe to repeat after a brief outage; a create isn't,
    // since Google may have made it before failing to answer.
    const repeatable = !JSON.stringify(r.operations).includes('"create"') && !(r.service === "ga4" && r.operations.some((o) => o.method === "POST"));
    if (r.service === "ga4") {
      if (validateOnly) return {};
      const res = await retryTransient(() => writeGa(this.ga, r.operations as GaOp[]), repeatable);
      return { inverse: gaInverseAfterApply(r, res), note: gaNoteAfterApply(res) };
    }
    const res = await retryTransient(() => this.ads.mutate(target, (r as ResolvedChange).service, r.operations,
      { loginCustomerId: login, ...(validateOnly ? { validateOnly: true } : {}) }), validateOnly || repeatable);
    if (validateOnly) return {};
    return { inverse: inverseAfterApply(r, (res.results ?? []).map((n) => n.resourceName).filter((n): n is string => !!n)) };
  }

  async undo(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status !== "applied") throw new Error(`Only applied proposals can be undone (${proposalId} is ${p.status}).`);
    if (this.deps.db.prepare("SELECT 1 FROM proposals WHERE undo_of = ? AND status = 'applied'").get(p.id)) {
      throw new Error(`Proposal ${proposalId} has already been undone.`);
    }
    const outcomes = JSON.parse(p.result ?? "[]") as Outcome[];
    const inverses = outcomes.map((o) => o.inverse).filter((x): x is AnyChange => !!x).reverse();
    if (!inverses.length) throw new Error("Nothing to undo: none of the changes in that proposal altered the account.");
    return this.propose(p.customer_id, inverses, p.id);
  }

  discard(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status !== "proposed") throw new Error(`Proposal ${proposalId} is ${p.status}; only open proposals can be discarded.`);
    this.deps.db.prepare("UPDATE proposals SET status = 'discarded' WHERE id = ?").run(p.id);
    return { proposal_id: p.id, status: "discarded" };
  }

  history(customerId: string | undefined, limit: number) {
    const rows = (customerId
      ? this.deps.db.prepare("SELECT * FROM proposals WHERE user_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.user.id, bareCid(customerId), limit)
      : this.deps.db.prepare("SELECT * FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.user.id, limit)) as ProposalRow[];
    return rows.map((p) => ({
      proposal_id: p.id, customer_id: p.customer_id, status: p.status, summary: p.summary,
      proposed_at: new Date(p.created_at * 1000).toISOString(),
      applied_at: p.applied_at ? new Date(p.applied_at * 1000).toISOString() : null,
      undo_of: p.undo_of,
      results: p.result ? publicResults(JSON.parse(p.result) as Outcome[]) : undefined,
    }));
  }

  private forgetGoogle(): void {
    this.deps.db.prepare("UPDATE users SET enc_refresh = NULL WHERE id = ?").run(this.user.id);
    clearGoogleCache(this.user.id);
  }

  private proposal(id: string): ProposalRow {
    const p = this.deps.db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(id, this.user.id) as ProposalRow | undefined;
    if (!p) throw new Error(`No proposal ${id} for this user.`);
    return p;
  }

  /** Revoke at Google, forget the refresh token and every token we issued. Change history is kept. */
  async disconnect() {
    if (this.user.enc_refresh) await revokeGoogleToken(decrypt(this.deps.encryptionKey, this.user.enc_refresh));
    this.forgetGoogle();
    this.deps.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(this.user.id);
    return { disconnected: true, note: "Google access revoked and stored credentials deleted. To delete your change history too, email adam@camberstack.io." };
  }
}

export interface KeywordPlanOpts { location_ids: string[]; language_id: string }

/** keyword_metrics answers with one object per keyword up to this many, a compact table above it. */
const COMPACT_OVER = 100;

const planTarget = (o: KeywordPlanOpts) => ({
  language: `languageConstants/${o.language_id}`,
  geoTargetConstants: o.location_ids.map((id) => `geoTargetConstants/${id}`),
  keywordPlanNetwork: "GOOGLE_SEARCH",
});

/** One Keyword Planner result, bids in the account's currency; `metrics` is keywordIdeaMetrics or keywordMetrics. */
function keywordRow(text: string, metrics: any, have: Map<string, "keyword" | "negative">) {
  const bid = (m: unknown) => (m == null ? null : round(micros(m)));
  const inAccount = have.get(String(text).toLowerCase());
  return {
    keyword: String(text),
    avg_monthly_searches: metrics?.avgMonthlySearches == null ? null : Number(metrics.avgMonthlySearches),
    competition: metrics?.competition ?? null,
    top_of_page_bid: { low: bid(metrics?.lowTopOfPageBidMicros), high: bid(metrics?.highTopOfPageBidMicros) },
    ...(inAccount ? { in_account: inAccount } : {}),
  };
}

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
/** Last 12 months of searches as { "2026-08": 1900, ... }, oldest first. */
function monthly(volumes: { year?: number | string; month?: string; monthlySearches?: number | string }[] | undefined) {
  return Object.fromEntries((volumes ?? []).slice(-12).map((v) =>
    [`${v.year}-${String(MONTHS.indexOf(v.month ?? "") + 1).padStart(2, "0")}`, Number(v.monthlySearches ?? 0)]));
}

/**
 * Search Console's window: its last ~2 days are still incomplete, so it ends 3 days ago. The overlap tool reads the
 * Ads side over the same dates, so the two sides compare like for like.
 */
function searchConsoleWindow(days: number, before = 0): { start: string; end: string } {
  const d = Math.max(1, Math.min(480, Math.floor(days)));
  const end = new Date(Date.now() - (3 + before) * 86_400_000);
  const start = new Date(end.getTime() - (d - 1) * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export interface ScWindowOpts { days: number; start_date?: string; end_date?: string; fresh?: boolean }
export interface ScFilterOpts { query_contains?: string; page_contains?: string; query_regex?: string; exclude_query_regex?: string; page_regex?: string }
const SC_MAX_ROWS = 100_000;
const FRESH_NOTE = "The window includes the last 2-3 days, which Google is still filling in, so recent days read low.";
const dataState = (fresh?: boolean): { dataState?: "all" } => (fresh ? { dataState: "all" } : {});
const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * The window a Search Console tool reads: exact dates when both are given, otherwise the last `days` days ending 3 days ago
 * (or yesterday with fresh data). Google keeps about 16 months.
 */
function scWindow(o: ScWindowOpts): { start: string; end: string } {
  if (o.start_date || o.end_date) {
    if (!o.start_date || !o.end_date) throw new Error("Pass both start_date and end_date, or neither (then days is used).");
    const a = Date.parse(o.start_date), b = Date.parse(o.end_date);
    if (Number.isNaN(a) || Number.isNaN(b)) throw new Error("start_date and end_date must be real dates, YYYY-MM-DD.");
    if (a > b) throw new Error("start_date is after end_date.");
    if (b - a > 479 * DAY) throw new Error("A window can span at most 480 days; Search Console keeps about 16 months.");
    return { start: o.start_date, end: o.end_date };
  }
  if (!o.fresh) return searchConsoleWindow(o.days);
  const d = Math.max(1, Math.min(480, Math.floor(o.days)));
  const end = Date.now() - DAY;
  return { start: isoDay(end - (d - 1) * DAY), end: isoDay(end) };
}

/** The same number of days immediately before a window. */
function priorWindow(w: { start: string; end: string }): { start: string; end: string } {
  const len = Date.parse(w.end) - Date.parse(w.start);
  const end = Date.parse(w.start) - DAY;
  return { start: isoDay(end - len), end: isoDay(end) };
}

/** Text and regex filters; regexes use Google's RE2 syntax, case-sensitive unless prefixed with (?i). */
function scFilters(o: ScFilterOpts) {
  return [
    ...(o.query_contains ? [{ dimension: "query", operator: "contains", expression: o.query_contains }] : []),
    ...(o.page_contains ? [{ dimension: "page", operator: "contains", expression: o.page_contains }] : []),
    ...(o.query_regex ? [{ dimension: "query", operator: "includingRegex", expression: o.query_regex }] : []),
    ...(o.exclude_query_regex ? [{ dimension: "query", operator: "excludingRegex", expression: o.exclude_query_regex }] : []),
    ...(o.page_regex ? [{ dimension: "page", operator: "includingRegex", expression: o.page_regex }] : []),
  ];
}

interface TrendRow {
  key: string; impressions: number; prior_impressions: number; impressions_change: number; impressions_pct: number | null;
  clicks: number; prior_clicks: number; position: number | null; prior_position: number | null; position_change: number | null;
  state?: "new" | "lost";
}
/** Per-key comparison of two windows; keys under minImpressions in both are noise (1 -> 3 is +200% and means nothing). */
function diffWindows(cur: SearchAnalyticsRow[], prev: SearchAnalyticsRow[], minImpressions: number): TrendRow[] {
  const c = new Map(cur.map((r) => [r.keys[0] ?? "", r])), p = new Map(prev.map((r) => [r.keys[0] ?? "", r]));
  const out: TrendRow[] = [];
  for (const key of new Set([...c.keys(), ...p.keys()])) {
    const a = c.get(key), b = p.get(key);
    const ai = a?.impressions ?? 0, bi = b?.impressions ?? 0;
    if (Math.max(ai, bi) < minImpressions) continue;
    const pos = (r?: SearchAnalyticsRow) => (r && r.impressions ? Math.round(r.position * 10) / 10 : null);
    out.push({
      key, impressions: ai, prior_impressions: bi, impressions_change: ai - bi, impressions_pct: bi > 0 ? round(((ai - bi) / bi) * 100) : null,
      clicks: a?.clicks ?? 0, prior_clicks: b?.clicks ?? 0, position: pos(a), prior_position: pos(b),
      position_change: ai && bi ? Math.round((a!.position - b!.position) * 10) / 10 : null,
      ...(bi === 0 ? { state: "new" as const } : ai === 0 ? { state: "lost" as const } : {}),
    });
  }
  return out;
}

/** Typical organic CTR by position (blended desktop and mobile); used only to rank opportunities. */
const CTR_BY_POSITION = [0.28, 0.15, 0.10, 0.07, 0.05, 0.04, 0.032, 0.026, 0.022, 0.019];
const ctrAt = (pos: number) => (pos <= 10 ? CTR_BY_POSITION[Math.max(1, Math.round(pos)) - 1]! : pos <= 20 ? 0.010 : 0.005);
const QUESTION = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b|\bvs\b|alternative|best|free|cost|price/i;

/** Google fills fields it has no answer for with *_UNSPECIFIED (e.g. a never-crawled URL's fetch state); report those as null. */
const known = (v?: string) => (v && !v.endsWith("_UNSPECIFIED") ? v : null);

function inspectionRow(url: string, r: UrlInspection) {
  const s = r.indexStatusResult ?? {};
  const items = (r.richResultsResult?.detectedItems ?? []).flatMap((d) => (d.items ?? [{}]).map((it) => {
    const issues = it.issues ?? [];
    return { type: d.richResultType, severity: issues.some((x) => x.severity === "ERROR") ? "ERROR" : issues.length ? "WARNING" : "VALID",
      issues: issues.map((x) => x.issueMessage) };
  }));
  return {
    url, indexed: s.verdict === "PASS", coverage_state: s.coverageState ?? null, last_crawl: s.lastCrawlTime ?? null,
    robots_txt: known(s.robotsTxtState), indexing_allowed: known(s.indexingState), fetch: known(s.pageFetchState),
    google_canonical: s.googleCanonical ?? null, declared_canonical: s.userCanonical ?? null,
    ...(s.googleCanonical && s.userCanonical && s.googleCanonical !== s.userCanonical ? { canonical_mismatch: true } : {}),
    crawled_as: known(s.crawledAs), ...(s.sitemap?.length ? { in_sitemaps: s.sitemap } : {}),
    ...(s.referringUrls?.length ? { referring_urls: s.referringUrls.slice(0, 5) } : {}),
    structured_data: r.richResultsResult ? { verdict: r.richResultsResult.verdict ?? null, items } : null,
  };
}

const organicMetrics = (r: SearchAnalyticsRow) => ({
  clicks: r.clicks, impressions: r.impressions, ctr_pct: round(r.ctr * 100), position: Math.round(r.position * 10) / 10,
});

function dateRange(days: number): string {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  const end = new Date(Date.now() - 86_400_000);           // yesterday: today is partial
  const start = new Date(end.getTime() - (d - 1) * 86_400_000);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return `segments.date BETWEEN '${iso(start)}' AND '${iso(end)}'`;
}

/**
 * AIs reach for DURING LAST_90_DAYS, which Google rejects (INVALID_VALUE_WITH_DURING_OPERATOR): it only has
 * LAST_7/14/30_DAYS. Run any other LAST_N_DAYS as the same window in explicit dates instead of failing.
 */
export function expandDuring(query: string): { query: string; rewrote: string[] } {
  const rewrote: string[] = [];
  const q = query.replace(/([\w.]+)\s+DURING\s+LAST_(\d+)_DAYS\b/gi, (m, field: string, n: string) => {
    if (["7", "14", "30"].includes(n)) return m;
    const r = dateRange(Number(n)).replace(/^segments\.date/, field);
    rewrote.push(`LAST_${n}_DAYS as ${r}`);
    return r;
  });
  return { query: q, rewrote };
}

/**
 * Fields the API dropped for a renamed one, which models still write from older docs: sent as is they can only fail
 * (UNRECOGNIZED_FIELD), so they're renamed before the query goes out, like expandDuring. Only exact one-to-one renames
 * belong here; a field that moved somewhere with a different shape (url_expansion_opt_out) gets a hint instead.
 */
const RENAMED_FIELDS: Record<string, string> = {
  "campaign.start_date": "campaign.start_date_time",
  "campaign.end_date": "campaign.end_date_time",
};
export function renameFields(query: string): { query: string; renamed: string[] } {
  const renamed: string[] = [];
  let q = query;
  for (const [old, now] of Object.entries(RENAMED_FIELDS)) {
    const re = new RegExp(`\\b${old.replace(".", "\\.")}\\b`, "g");
    if (re.test(q)) { q = q.replace(re, now); renamed.push(`${old} as ${now}`); }
  }
  return { query: q, renamed };
}

/** Fields Google says a GAQL query must also SELECT (EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE), from its error body. */
export function missingSelectFields(body: string): string[] {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    return (e?.details ?? []).flatMap((d: any) => d.errors ?? [])
      .filter((d: any) => d.errorCode?.queryError === "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE")
      .map((d: any) => /'([a-z_]+(?:\.[a-z0-9_]+)+)'/.exec(String(d.message ?? ""))?.[1])
      .filter((f: string | undefined): f is string => !!f);
  } catch {
    return [];
  }
}

/** Google's "try again" answers (503 UNAVAILABLE): retried once, after a second, when `safe` says repeating can't duplicate anything. */
async function retryTransient<T>(fn: () => Promise<T>, safe: boolean): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!safe || !/\b503\b|UNAVAILABLE/.test((e as Error).message)) throw e;
    await new Promise((r) => setTimeout(r, 1000));
    return fn();
  }
}

/** Two decimals, for money and fractional conversions. */
const round = (n: number) => Math.round(n * 100) / 100;

/** Sum rows' cost, clicks and conversions per key (Google returns one row per segment); `add` sums any extra metrics. */
function aggregate<T extends { cost: number; clicks: number; conversions: number }>(
  rows: any[], key: (r: any) => string, init: (r: any) => T, add?: (e: T, r: any) => void,
): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const e = m.get(k) ?? init(r);
    e.cost += micros(r.metrics?.costMicros);
    e.clicks += Number(r.metrics?.clicks ?? 0);
    e.conversions += Number(r.metrics?.conversions ?? 0);
    add?.(e, r);
    m.set(k, e);
  }
  return [...m.values()];
}
