/**
 * Google Merchant Center (Merchant API v1): which accounts the login can read, why products are disapproved or demoted,
 * any Merchant Center report (MCQL), such as Shopping clicks and impressions per product, and the product overrides
 * merchant-changes.ts proposes (written to Camberstack's own supplemental data source, never the feed). Its scope
 * (`content`) isn't in the main Google consent: the first call without it returns a personal /connect/merchant-center
 * link (grant.ts) that adds it to the user's existing connection.
 *
 * Google blocks every call from a Cloud project that isn't registered with a Merchant Center account (a one-time
 * `developerRegistration:registerGcp` against the operator's own account; merchants don't register). Unregistered,
 * calls answer 401 "not registered", which the tools report as Camberstack's to fix, not the user's.
 *
 * The demo account (DEMO_MERCHANT) answers the same calls with sample data, like the demo Ads account and property.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { NotGrantedError, scopeMissing } from "./google.js";

const API = "https://merchantapi.googleapis.com";
export const DEMO_MERCHANT = "000000001";
const DEMO_NAME = "DEMO: Northwind Plumbing Supply (sample data)";
const DEMO_NOTE = "Sample data from Camberstack's demo Merchant Center account (a fictional plumbing supply store), not a real account.";
/** Products the issue summary reads at most; past it, the counts say they're partial. */
const MAX_SCAN = 20_000;

export interface MerchantAccount { account_id: string; name: string; test_account?: boolean }
export interface SearchResult { rows: Record<string, unknown>[]; truncated: boolean }
/** What names a product across Merchant Center's data sources. */
export interface ProductKey { offerId: string; contentLanguage: string; feedLabel: string }
/** productAttributes fields Camberstack overrides for one product, in the API's names. */
export type Overrides = Record<string, unknown>;
/**
 * Whether a product's primary data source takes Camberstack's overrides: already linked, linked by the first write (a
 * one-time change to that source's rules), or impossible (sources made in the Merchant Center UI, or autofeed).
 */
export interface LinkState { state: "linked" | "will_link" | "cannot"; label: string; why?: string }
/** Camberstack's supplemental data source, found by this name. */
export const SOURCE_NAME = "Camberstack overrides";
/** Camberstack's primary data source, for products it creates (merchant-changes.ts add_product), found by this name. */
export const PRODUCTS_SOURCE_NAME = "Camberstack products";
/** OverrideStore key space for the products Camberstack created: their full attributes, as last written. */
export const ownSpace = (account: string) => `own:${account}`;

/** The API's product id: unpadded base64url of contentLanguage~feedLabel~offerId, which any offer id survives. */
export const encodeKey = (k: ProductKey) => Buffer.from(`${k.contentLanguage}~${k.feedLabel}~${k.offerId}`).toString("base64url");
const keyId = (k: ProductKey) => `${k.contentLanguage}~${k.feedLabel}~${k.offerId}`;

/**
 * Camberstack's copy of the overrides it holds per product: Merchant Center applies them but can't read them back, and
 * undo has to restore exactly what was there. Keyed by account, not user, since it mirrors the account's source.
 */
/** product_view has a row per channel (online, local) and feed label: one row per offer, with every issue, or an offer's spend counts twice. */
export function oneRowPerOffer<T extends { offerId?: unknown; itemIssues?: { type?: { code?: string } }[] }>(rows: T[]): T[] {
  const byOffer = new Map<string, T>();
  for (const p of rows) {
    const key = String(p.offerId).toLowerCase(), had = byOffer.get(key);
    if (!had) { byOffer.set(key, p); continue; }
    const codes = new Set((had.itemIssues ?? []).map((i) => i.type?.code));
    byOffer.set(key, { ...had, itemIssues: [...(had.itemIssues ?? []), ...(p.itemIssues ?? []).filter((i) => !codes.has(i.type?.code))] });
  }
  return [...byOffer.values()];
}

export class OverrideStore {
  private mem = new Map<string, Overrides>();
  constructor(private db?: DB) {}
  get(account: string, k: ProductKey): Overrides | null {
    if (!this.db) return this.mem.get(`${account}\u0000${keyId(k)}`) ?? null;
    const r = this.db.prepare("SELECT attrs FROM merchant_overrides WHERE account_id = ? AND product = ?").get(account, keyId(k)) as { attrs: string } | undefined;
    return r ? JSON.parse(r.attrs) as Overrides : null;
  }
  set(account: string, k: ProductKey, o: Overrides | null): void {
    if (!this.db) { if (o) this.mem.set(`${account}\u0000${keyId(k)}`, o); else this.mem.delete(`${account}\u0000${keyId(k)}`); return; }
    if (!o) { this.db.prepare("DELETE FROM merchant_overrides WHERE account_id = ? AND product = ?").run(account, keyId(k)); return; }
    this.db.prepare(`INSERT INTO merchant_overrides (account_id, product, attrs, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, product) DO UPDATE SET attrs = excluded.attrs, updated_at = excluded.updated_at`).run(account, keyId(k), JSON.stringify(o), now());
  }
  /** Every product with something stored under `account`. */
  list(account: string): { key: ProductKey; attrs: Overrides }[] {
    const parse = (id: string, attrs: Overrides) => {
      const [contentLanguage, feedLabel, ...rest] = id.split("~");
      return { key: { contentLanguage: contentLanguage!, feedLabel: feedLabel!, offerId: rest.join("~") }, attrs };
    };
    if (!this.db) return [...this.mem.entries()].filter(([k]) => k.startsWith(`${account}\u0000`)).map(([k, v]) => parse(k.slice(account.length + 1), v));
    return (this.db.prepare("SELECT product, attrs FROM merchant_overrides WHERE account_id = ?").all(account) as { product: string; attrs: string }[])
      .map((r) => parse(r.product, JSON.parse(r.attrs) as Overrides));
  }
  any(account: string): boolean {
    if (!this.db) return [...this.mem.keys()].some((k) => k.startsWith(`${account}\u0000`));
    return !!this.db.prepare("SELECT 1 FROM merchant_overrides WHERE account_id = ? LIMIT 1").get(account);
  }
}

/** The Merchant API calls the tools make; the demo account answers the same ones. */
export type Merchant = {
  accounts(): Promise<MerchantAccount[]>;
  /** Account-level issues (Merchant Center's "needs attention" list). */
  accountIssues(accountId: string): Promise<any[]>;
  /** An MCQL query's rows (the queried view's object), up to maxRows. */
  search(accountId: string, query: string, maxRows: number): Promise<SearchResult>;
  /** The products with this offer_id (one per feed language and label). */
  productKeys(accountId: string, offerId: string): Promise<ProductKey[]>;
  /** A product's final attributes (feed plus overrides, after processing) and its primary data source. */
  product(accountId: string, key: ProductKey): Promise<{ attributes: Record<string, unknown>; dataSource: string }>;
  /** The overrides Camberstack holds for the product (null: none). */
  overrides(accountId: string, key: ProductKey): Promise<Overrides | null>;
  linkState(accountId: string, primary: string): Promise<LinkState>;
  /** Replace the product's overrides (null removes them), linking the primary source first if it isn't yet. */
  setOverrides(accountId: string, key: ProductKey, primary: string, overrides: Overrides | null): Promise<void>;
  /** Products Camberstack created in this account, with the attributes it last wrote. */
  ownProducts(accountId: string): Promise<{ key: ProductKey; attrs: Overrides }[]>;
  /** Create or replace one of Camberstack's own products (null deletes it), in its own primary source. */
  setOwnProduct(accountId: string, key: ProductKey, attributes: Overrides | null): Promise<void>;
};

/** What to do about the Merchant API errors AIs and users actually hit, appended to Google's message. */
function merchantFix(status: number, msg: string): string {
  if (/advanced account/i.test(msg)) return " → reports work on a standalone account or a sub-account, not an advanced (multi-client) account: use a sub-account's account_id from merchant_accounts.";
  if (status === 403 && /performance|PERFORMANCE_REPORTING/i.test(msg)) return " → performance views need the \"Performance and insights\" access in Merchant Center (People and access) for this Google login.";
  if (/Terms of Service is not signed/i.test(msg)) return " → the account hasn't accepted Merchant Center's terms of service yet: the account's admin opens it at merchants.google.com and accepts them. Camberstack doesn't accept terms on anyone's behalf.";
  // Google answers 401 for an account the login can't reach (seen live, 2026-10-22), 403 elsewhere.
  if (status === 403 || /does not have access to the accounts/i.test(msg)) return " → this Google login has no access to that Merchant Center account: use an account_id from merchant_accounts.";
  return "";
}

/** One user's view of the Merchant API (read-only). */
export class MerchantClient implements Merchant {
  constructor(private accessToken: () => Promise<string>, private grantLink: () => string | null, private f: typeof fetch = fetch,
    private store = new OverrideStore()) {}

  private async call(path: string, body?: object, method = body ? "POST" : "GET"): Promise<any> {
    const res = await this.f(`${API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      if (scopeMissing(res.status, text)) throw new NotGrantedError("merchant-center", this.grantLink());
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
      // Registered, but with no verified API developer on the registering account: also Camberstack's side (the operator's account).
      if (res.status === 401 && (/not registered|AUTH_GCP_NOT_REGISTERED/i.test(text) || /API_DEVELOPER/.test(text))) {
        throw new Error("Camberstack's Merchant Center access isn't set up on Google's side yet (developer registration). This is Camberstack's "
          + "to fix, not the user's: nothing is wrong with their account. The Google Ads, Search Console and Analytics tools work as usual.");
      }
      throw new Error(`Merchant API ${res.status}: ${msg}${merchantFix(res.status, msg)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async accounts(): Promise<MerchantAccount[]> {
    const out: MerchantAccount[] = [];
    let page = "";
    do {
      const r = await this.call(`accounts/v1/accounts?pageSize=500${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      for (const a of r.accounts ?? []) out.push({ account_id: String(a.accountId), name: a.accountName, ...(a.testAccount ? { test_account: true } : {}) });
      page = r.nextPageToken ?? "";
    } while (page);
    return out;
  }

  async accountIssues(accountId: string): Promise<any[]> {
    const out: any[] = [];
    let page = "";
    do {
      const r = await this.call(`accounts/v1/accounts/${accountId}/issues?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      out.push(...(r.accountIssues ?? []));
      page = r.nextPageToken ?? "";
    } while (page);
    return out;
  }

  async search(accountId: string, query: string, maxRows: number): Promise<SearchResult> {
    const rows: Record<string, unknown>[] = [];
    let page = "";
    do {
      const r = await this.call(`reports/v1/accounts/${accountId}/reports:search`,
        { query, pageSize: Math.min(1000, maxRows - rows.length), ...(page ? { pageToken: page } : {}) });
      // Each result row holds only the view that was queried (productView, productPerformanceView, …).
      for (const x of r.results ?? []) rows.push(Object.values(x)[0] as Record<string, unknown>);
      page = r.nextPageToken ?? "";
    } while (page && rows.length < maxRows);
    return { rows: rows.slice(0, maxRows), truncated: !!page || rows.length > maxRows };
  }

  async productKeys(accountId: string, offerId: string): Promise<ProductKey[]> {
    const { rows } = await this.search(accountId, `SELECT id, offer_id, language_code, feed_label FROM product_view WHERE offer_id = '${offerId}'`, 50);
    const keys = new Map<string, ProductKey>();
    // product_view has a row per channel (online, local); the API's product is the same for both.
    for (const r of rows as { offerId: string; languageCode: string; feedLabel: string }[]) {
      const k = { offerId: r.offerId, contentLanguage: r.languageCode, feedLabel: r.feedLabel };
      keys.set(keyId(k), k);
    }
    return [...keys.values()];
  }

  async product(accountId: string, key: ProductKey) {
    const r = await this.call(`products/v1/accounts/${accountId}/products/${encodeKey(key)}`);
    return { attributes: (r.productAttributes ?? {}) as Record<string, unknown>, dataSource: String(r.dataSource ?? "") };
  }

  async overrides(accountId: string, key: ProductKey) { return this.store.get(accountId, key); }

  /** Camberstack's supplemental source (or, with primary, its own products' source) in the account, if it has one. */
  private async source(accountId: string, primary = false): Promise<string | null> {
    let page = "";
    do {
      const r = await this.call(`datasources/v1/accounts/${accountId}/dataSources?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      const s = (r.dataSources ?? []).find((d: any) => (primary
        ? d.displayName === PRODUCTS_SOURCE_NAME && d.primaryProductDataSource
        : d.displayName === SOURCE_NAME && d.supplementalProductDataSource));
      if (s) return s.name as string;
      page = r.nextPageToken ?? "";
    } while (page);
    return null;
  }

  async linkState(accountId: string, primary: string): Promise<LinkState> {
    const p = await this.call(`datasources/v1/${primary}`);
    const label = String(p.displayName ?? primary);
    if (!p.primaryProductDataSource) return { state: "cannot", label, why: "it isn't a primary product data source" };
    // The API can't change the rules of sources made in the Merchant Center UI, or of autofeed.
    if (p.input === "UI" || p.input === "AUTOFEED") {
      return { state: "cannot", label, why: `it was made ${p.input === "UI" ? "in the Merchant Center interface" : "by autofeed"}, whose rules the API can't change` };
    }
    const ours = await this.source(accountId);
    const take = (p.primaryProductDataSource.defaultRule?.takeFromDataSources ?? []) as { self?: boolean; supplementalDataSourceName?: string }[];
    return { state: ours && take.some((t) => t.supplementalDataSourceName === ours) ? "linked" : "will_link", label };
  }

  async setOverrides(accountId: string, key: ProductKey, primary: string, overrides: Overrides | null): Promise<void> {
    let src = await this.source(accountId);
    if (overrides) {
      src ??= (await this.call(`datasources/v1/accounts/${accountId}/dataSources`, { displayName: SOURCE_NAME, supplementalProductDataSource: {} })).name as string;
      const p = await this.call(`datasources/v1/${primary}`);
      const take = (p.primaryProductDataSource?.defaultRule?.takeFromDataSources ?? [{ self: true }]) as { self?: boolean; supplementalDataSourceName?: string }[];
      if (!take.some((t) => t.supplementalDataSourceName === src)) {
        // A patch replaces the whole rule, so keep every source already in it (the feed itself included), with ours first: first wins.
        await this.call(`datasources/v1/${primary}?updateMask=primaryProductDataSource.defaultRule`,
          { name: primary, primaryProductDataSource: { defaultRule: { takeFromDataSources: [{ supplementalDataSourceName: src }, ...take] } } }, "PATCH");
      }
      await this.call(`products/v1/accounts/${accountId}/productInputs:insert?dataSource=${encodeURIComponent(src)}`,
        { offerId: key.offerId, contentLanguage: key.contentLanguage, feedLabel: key.feedLabel, productAttributes: overrides });
    } else if (src) {
      try {
        await this.call(`products/v1/accounts/${accountId}/productInputs/${encodeKey(key)}?dataSource=${encodeURIComponent(src)}`, undefined, "DELETE");
      } catch (e) {
        if (!/Merchant API 404/.test((e as Error).message)) throw e;  // already gone: the goal
      }
    }
    this.store.set(accountId, key, overrides);
  }

  async ownProducts(accountId: string) { return this.store.list(ownSpace(accountId)); }

  async setOwnProduct(accountId: string, key: ProductKey, attributes: Overrides | null): Promise<void> {
    let src = await this.source(accountId, true);
    if (attributes) {
      // No feed label or language on the source: an API source then takes products of any.
      // Without destinations Google enables free listings only (seen live, 2026-10-22): ask for Shopping ads too.
      src ??= (await this.call(`datasources/v1/accounts/${accountId}/dataSources`, { displayName: PRODUCTS_SOURCE_NAME, primaryProductDataSource: {
        destinations: [{ destination: "SHOPPING_ADS", state: "ENABLED" }, { destination: "FREE_LISTINGS", state: "ENABLED" }] } })).name as string;
      await this.call(`products/v1/accounts/${accountId}/productInputs:insert?dataSource=${encodeURIComponent(src)}`,
        { offerId: key.offerId, contentLanguage: key.contentLanguage, feedLabel: key.feedLabel, productAttributes: attributes });
    } else if (src) {
      try {
        await this.call(`products/v1/accounts/${accountId}/productInputs/${encodeKey(key)}?dataSource=${encodeURIComponent(src)}`, undefined, "DELETE");
      } catch (e) {
        if (!/Merchant API 404/.test((e as Error).message)) throw e;
      }
    }
    this.store.set(ownSpace(accountId), key, attributes);
  }
}

/** Sends the demo account's calls to the demo, everything else to Google. */
export function routedMerchant(google: Merchant, demo: Merchant): Merchant {
  return {
    accounts: () => google.accounts(),
    accountIssues: (id) => (id === DEMO_MERCHANT ? demo.accountIssues(id) : google.accountIssues(id)),
    search: (id, q, n) => (id === DEMO_MERCHANT ? demo.search(id, q, n) : google.search(id, q, n)),
    productKeys: (id, o) => (id === DEMO_MERCHANT ? demo.productKeys(id, o) : google.productKeys(id, o)),
    product: (id, k) => (id === DEMO_MERCHANT ? demo.product(id, k) : google.product(id, k)),
    overrides: (id, k) => (id === DEMO_MERCHANT ? demo.overrides(id, k) : google.overrides(id, k)),
    linkState: (id, p) => (id === DEMO_MERCHANT ? demo.linkState(id, p) : google.linkState(id, p)),
    setOverrides: (id, k, p, o) => (id === DEMO_MERCHANT ? demo.setOverrides(id, k, p, o) : google.setOverrides(id, k, p, o)),
    ownProducts: (id) => (id === DEMO_MERCHANT ? demo.ownProducts(id) : google.ownProducts(id)),
    setOwnProduct: (id, k, a) => (id === DEMO_MERCHANT ? demo.setOwnProduct(id, k, a) : google.setOwnProduct(id, k, a)),
  };
}

const demoNote = (accountId: string) => (accountId === DEMO_MERCHANT ? { note: DEMO_NOTE } : {});

// ---------------------------------------------------------------- what the tools return

/** Accounts this login can read; the demo account only when there are none (or Merchant Center isn't granted). */
export async function listMerchantAccounts(m: Merchant) {
  const demo = [{ account_id: DEMO_MERCHANT, name: DEMO_NAME }];
  try {
    const accounts = await m.accounts();
    if (accounts.length) return { accounts };
    return { accounts: demo, note: "This Google login has no Merchant Center account, so only the demo account (sample data) is offered. Say so plainly." };
  } catch (e) {
    if (!(e instanceof NotGrantedError)) throw e;
    return { accounts: demo, not_granted: e.message, ...(e.link ? { grant_url: e.link } : {}),
      note: "Only the demo account is available until the user adds Merchant Center. Say so plainly and give them grant_url." };
  }
}

const SEVERITY_ORDER = ["DISAPPROVED", "DEMOTED", "PENDING"];
const rank = (s: string) => { const i = SEVERITY_ORDER.indexOf(s); return i < 0 ? SEVERITY_ORDER.length : i; };

/**
 * Why products don't show: the account's own issues, how many products are eligible, limited, pending or disapproved,
 * and every product issue with how many products it hits (worst first) and a few examples. With offer_id, that
 * product's issues in full instead.
 */
export async function productIssues(m: Merchant, accountId: string, o: { offer_id?: string; examples: number }) {
  const where = o.offer_id ? ` WHERE offer_id = '${o.offer_id}'` : "";
  const [accountIssues, products] = await Promise.all([
    m.accountIssues(accountId),
    m.search(accountId, `SELECT id, offer_id, title, aggregated_reporting_context_status, item_issues FROM product_view${where}`, MAX_SCAN),
  ]);
  const account_issues = accountIssues.map((i) => ({ title: i.title, severity: i.severity, ...(i.detail ? { detail: i.detail } : {}),
    ...(i.documentationUri ? { documentation: i.documentationUri } : {}) }));
  if (o.offer_id) {
    if (!products.rows.length) throw new Error(`No product with offer_id ${o.offer_id} in account ${accountId}. offer_id is the merchant's own product ID, as in the feed.`);
    return { account_id: accountId, ...demoNote(accountId), account_issues, products: products.rows };
  }
  const status_counts: Record<string, number> = {};
  type IssueGroup = { code: string; attribute?: string; severity: string; resolution?: string; products: number; examples: { offer_id: string; title: string }[] };
  const byIssue = new Map<string, IssueGroup>();
  for (const p of products.rows as any[]) {
    const st = p.aggregatedReportingContextStatus ?? "UNKNOWN";
    status_counts[st] = (status_counts[st] ?? 0) + 1;
    for (const i of p.itemIssues ?? []) {
      const code = i.type?.code ?? "unknown", attribute = i.type?.canonicalAttribute;
      const severity = i.severity?.aggregatedSeverity ?? "UNKNOWN";
      const key = `${code}\u0000${attribute ?? ""}`;
      const g: IssueGroup = byIssue.get(key) ?? { code, ...(attribute ? { attribute } : {}), severity, resolution: i.resolution, products: 0, examples: [] };
      if (rank(severity) < rank(g.severity)) g.severity = severity;
      g.products++;
      if (g.examples.length < o.examples) g.examples.push({ offer_id: p.offerId, title: p.title });
      byIssue.set(key, g);
    }
  }
  const issues = [...byIssue.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || b.products - a.products);
  return {
    account_id: accountId, ...demoNote(accountId), account_issues,
    products_checked: products.rows.length, ...(products.truncated ? { partial: `Only the first ${MAX_SCAN} products were checked.` } : {}),
    status_counts, issues,
  };
}

export async function merchantReport(m: Merchant, accountId: string, query: string, limit: number) {
  if (!/^\s*SELECT\s/i.test(query)) throw new Error("Only SELECT queries: Merchant Center reports are read-only.");
  const r = await m.search(accountId, query, limit);
  return { account_id: accountId, ...demoNote(accountId), row_count: r.rows.length, ...(r.truncated ? { truncated: true } : {}), rows: r.rows };
}

// ---------------------------------------------------------------- demo account

type DemoIssue = { code: string; attribute: string; severity: "DISAPPROVED" | "DEMOTED" | "PENDING"; resolution: string; since: number };
type DemoProduct = { offerId: string; title: string; brand: string; price: number; clicks: number; issues: DemoIssue[] };
const ISSUE = {
  price: { code: "price_mismatch", attribute: "price", severity: "DISAPPROVED", resolution: "MERCHANT_ACTION", since: 9 },
  image: { code: "image_too_small", attribute: "image_link", severity: "DISAPPROVED", resolution: "MERCHANT_ACTION", since: 40 },
  gtin: { code: "missing_gtin", attribute: "gtin", severity: "DEMOTED", resolution: "MERCHANT_ACTION", since: 60 },
  review: { code: "pending_initial_policy_review", attribute: "", severity: "PENDING", resolution: "PENDING_PROCESSING", since: 1 },
} as const satisfies Record<string, DemoIssue>;
/** The story the demo should let someone find: the best sellers were disapproved for a price mismatch 9 days ago, so Shopping clicks fell. */
const DEMO_PRODUCTS: DemoProduct[] = [
  ["NW-TWH-50", "Tankless Water Heater 5.0 GPM, Natural Gas", "Rinnai", 1149, 38, [ISSUE.price]],
  ["NW-TWH-38", "Tankless Water Heater 3.8 GPM, Electric", "EcoSmart", 529, 31, [ISSUE.price]],
  ["NW-SP-12", "Sump Pump 1/2 HP Submersible", "Zoeller", 219, 22, []],
  ["NW-GD-34", "Garbage Disposal 3/4 HP", "InSinkErator", 189, 19, [ISSUE.gtin]],
  ["NW-PEX-100", "PEX Tubing 1/2 in. x 100 ft, Red", "SharkBite", 42, 15, [ISSUE.gtin]],
  ["NW-FV-01", "Kitchen Faucet, Pull-Down, Brushed Nickel", "Moen", 249, 14, []],
  ["NW-WS-40", "Water Softener 40,000 Grain", "Morton", 649, 12, [ISSUE.image]],
  ["NW-EXP-2", "Expansion Tank 2 Gallon", "Watts", 54, 9, [ISSUE.gtin]],
  ["NW-SV-34", "Ball Valve 3/4 in. Lead-Free Brass", "Apollo", 18, 7, []],
  ["NW-TOOL-PW", "Pipe Wrench 18 in. Cast Iron", "Ridgid", 39, 6, [ISSUE.image]],
  ["NW-DR-25", "Drain Auger 25 ft, Drill-Powered", "Ridgid", 64, 5, []],
  ["NW-TWH-27", "Tankless Water Heater 2.7 GPM, Point-of-Use", "Stiebel Eltron", 389, 0, [ISSUE.review]],
].map(([offerId, title, brand, price, clicks, issues]) => ({ offerId, title, brand, price, clicks, issues } as DemoProduct));
const DEMO_ACCOUNT_ISSUES = [{ title: "Missing return policy", severity: "ERROR",
  detail: "Add a return policy in Merchant Center (Settings, then Returns) so products can show with return details.",
  documentationUri: "https://support.google.com/merchants/answer/10220642" }];

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const PRODUCT_FIELDS = ["id", "offer_id", "title", "brand", "price", "availability", "channel", "feed_label", "language_code",
  "aggregated_reporting_context_status", "item_issues"];
const PERF_SEGMENTS = ["date", "offer_id", "title", "brand", "marketing_method"];
const PERF_METRICS = ["clicks", "impressions", "click_through_rate"];

/** One demo product's clicks and impressions on a day: the same numbers the demo Ads account's Shopping report uses (demoShopping). */
function demoDay(p: DemoProduct & { excluded?: string[] }, daysAgo: number, method: "ADS" | "ORGANIC") {
  // A disapproved product stops serving from the day its issue started; a demoted one serves at half strength.
  const off = p.issues.some((i) => i.severity === "DISAPPROVED" && daysAgo <= i.since) || p.issues.some((i) => i.severity === "PENDING")
    || (method === "ADS" && !!p.excluded?.includes("SHOPPING_ADS"));
  const demoted = p.issues.some((i) => i.severity === "DEMOTED");
  const clicks = off ? 0 : Math.round(p.clicks * (method === "ADS" ? 1 : 0.35) * (demoted ? 0.5 : 1) * (1 + ((daysAgo * 7 + p.price) % 5) / 10));
  return { clicks, impressions: off ? 0 : clicks * (method === "ADS" ? 42 : 65) + (p.price % 13) };
}

/**
 * The demo Ads account's shopping_performance_view (demo.ts): the demo store's products, as Google Ads reports them
 * (item ids lowercased), over the days ago given. Cost tracks price, and conversions 3% of clicks.
 */
export function demoShopping(fromDaysAgo: number, toDaysAgo: number) {
  return DEMO_PRODUCTS.map((p) => {
    let clicks = 0, impressions = 0;
    for (let d = toDaysAgo; d <= fromDaysAgo; d++) { const x = demoDay(p, d, "ADS"); clicks += x.clicks; impressions += x.impressions; }
    const cpc = 0.6 + Math.min(p.price, 1200) / 800, conversions = Math.round(clicks * 0.03 * 10) / 10;
    return { segments: { productItemId: p.offerId.toLowerCase(), productMerchantId: DEMO_MERCHANT, productTitle: p.title },
      metrics: { costMicros: String(Math.round(clicks * cpc * 1e6)), clicks: String(clicks), impressions: String(impressions),
        conversions, conversionsValue: Math.round(conversions * p.price * 100) / 100 } };
  }).filter((r) => Number(r.metrics.impressions) > 0);
}

/** A product's status: its worst issue decides, as in Merchant Center. */
const demoStatus = (p: DemoProduct) => {
  const sev = p.issues.map((i) => i.severity);
  return sev.includes("DISAPPROVED") ? "NOT_ELIGIBLE_OR_DISAPPROVED" : sev.includes("PENDING") ? "PENDING" : sev.includes("DEMOTED") ? "ELIGIBLE_LIMITED" : "ELIGIBLE";
};

/** An override on the attribute an issue names fixes it, in the demo. */
const FIXED_BY: Record<string, string> = { price: "price", image_link: "imageLink", gtin: "gtins" };
const DEMO_SOURCE = `accounts/${DEMO_MERCHANT}/dataSources/1`;

export class DemoMerchant implements Merchant {
  private store: OverrideStore;
  /** Each user's overrides on the demo are their own (Camberstack's table, under a per-user account key). */
  private acct: string;
  constructor(db?: DB, userId?: string) { this.store = new OverrideStore(db); this.acct = `demo:${userId ?? "anon"}`; }

  async accounts() { return []; }
  async accountIssues() { return DEMO_ACCOUNT_ISSUES; }

  private key = (offerId: string): ProductKey => ({ offerId, contentLanguage: "en", feedLabel: "US" });
  /** The demo's products, plus the ones this user created, with this user's overrides applied. */
  private live(): (DemoProduct & { excluded: string[] })[] {
    const own: DemoProduct[] = this.store.list(ownSpace(this.acct)).map(({ key, attrs }) => ({ offerId: key.offerId, title: String(attrs.title ?? key.offerId),
      brand: String(attrs.brand ?? ""), price: Number((attrs.price as { amountMicros?: string } | undefined)?.amountMicros ?? 0) / 1e6, clicks: 0, issues: [] }));
    return [...DEMO_PRODUCTS, ...own].map((p) => {
      const o = this.store.get(this.acct, this.key(p.offerId)) ?? {};
      const price = (o.price as { amountMicros?: string } | undefined)?.amountMicros;
      return { ...p, title: String(o.title ?? p.title), brand: String(o.brand ?? p.brand), price: price ? Number(price) / 1e6 : p.price,
        issues: p.issues.filter((i) => !(FIXED_BY[i.attribute] && FIXED_BY[i.attribute]! in o)),
        excluded: (o.excludedDestinations as string[] | undefined) ?? [] };
    });
  }

  async productKeys(_id: string, offerId: string) {
    if (DEMO_PRODUCTS.some((p) => p.offerId === offerId)) return [this.key(offerId)];
    return this.store.list(ownSpace(this.acct)).filter((x) => x.key.offerId === offerId).map((x) => x.key);
  }
  async product(_id: string, key: ProductKey) {
    const p = this.live().find((x) => x.offerId === key.offerId);
    if (!p) throw new Error(`Merchant API 404: product ${key.offerId} not found.`);
    const o = this.store.get(this.acct, key) ?? {};
    const own = this.store.get(ownSpace(this.acct), key);
    if (own) return { dataSource: `accounts/${DEMO_MERCHANT}/dataSources/2`, attributes: { ...own, ...o } };
    return { dataSource: DEMO_SOURCE, attributes: { title: p.title, brand: p.brand, availability: "IN_STOCK", condition: "NEW",
      price: { amountMicros: String(Math.round(p.price * 1e6)), currencyCode: "USD" }, link: `https://northwind-plumbing.example/p/${p.offerId.toLowerCase()}`,
      ...o, ...(p.excluded.length ? { excludedDestinations: p.excluded } : {}) } };
  }
  async overrides(_id: string, key: ProductKey) { return this.store.get(this.acct, key); }
  async linkState(): Promise<LinkState> {
    return { state: this.store.any(this.acct) ? "linked" : "will_link", label: "Northwind store feed" };
  }
  async setOverrides(_id: string, key: ProductKey, _primary: string, overrides: Overrides | null) { this.store.set(this.acct, key, overrides); }
  async ownProducts() { return this.store.list(ownSpace(this.acct)); }
  async setOwnProduct(_id: string, key: ProductKey, attributes: Overrides | null) { this.store.set(ownSpace(this.acct), key, attributes); }

  async search(_id: string, query: string, maxRows: number): Promise<SearchResult> {
    const m = /^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/is.exec(query);
    if (!m) throw new Error("Couldn't read that query. The demo account takes SELECT … FROM product_view or product_performance_view [WHERE …] [ORDER BY …] [LIMIT n].");
    const fields = m[1]!.split(",").map((f) => f.trim().toLowerCase());
    const view = m[2]!.toLowerCase();
    let where = m[3] ?? "";
    // Dates first: BETWEEN carries its own AND.
    let range: [string, string] | null = null;
    where = where.replace(/\bdate\s+BETWEEN\s+'(\d{4}-\d{2}-\d{2})'\s+AND\s+'(\d{4}-\d{2}-\d{2})'/i, (_, a: string, b: string) => { range = [a, b]; return ""; })
      .replace(/\bdate\s+DURING\s+LAST_(\d+)_DAYS/i, (_, n: string) => { range = [ymd(Date.now() - Number(n) * DAY), ymd(Date.now() - DAY)]; return ""; });
    const conds = where.split(/\s+AND\s+/i).map((c) => c.trim()).filter(Boolean).map((c) => {
      const e = /^(\w+)\s*(=|!=)\s*'([^']*)'$/.exec(c);
      if (!e) throw new Error(`The demo account filters only with field = 'value', field != 'value' and a date range; not: ${c}`);
      return { field: e[1]!.toLowerCase(), neg: e[2] === "!=", value: e[3]! };
    });
    let rows: Record<string, unknown>[];
    if (view === "product_view") {
      const bad = fields.filter((f) => !PRODUCT_FIELDS.includes(f));
      if (bad.length) throw new Error(`The demo account's product_view has ${PRODUCT_FIELDS.join(", ")}; not ${bad.join(", ")}.`);
      rows = this.live().map((p) => {
        const all: Record<string, unknown> = {
          id: `online~en~US~${p.offerId}`, offer_id: p.offerId, title: p.title, brand: p.brand, price: { amountMicros: String(p.price * 1_000_000), currencyCode: "USD" },
          availability: "IN_STOCK", channel: "ONLINE", feed_label: "US", language_code: "en", aggregated_reporting_context_status: demoStatus(p),
          item_issues: p.issues.map((i) => ({ type: { code: i.code, ...(i.attribute ? { canonicalAttribute: i.attribute } : {}) },
            severity: { aggregatedSeverity: i.severity }, resolution: i.resolution })),
        };
        return all;
      }).filter((r) => conds.every((c) => (String(r[c.field] ?? "") === c.value) !== c.neg))
        .map((r) => Object.fromEntries(fields.map((f) => [snakeToCamel(f), r[f]])));
    } else if (view === "product_performance_view") {
      const bad = fields.filter((f) => !PERF_SEGMENTS.includes(f) && !PERF_METRICS.includes(f));
      if (bad.length) throw new Error(`The demo account's product_performance_view has segments ${PERF_SEGMENTS.join(", ")} and metrics ${PERF_METRICS.join(", ")}; not ${bad.join(", ")}.`);
      if (!range) throw new Error("product_performance_view needs a date range in WHERE: date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD', or date DURING LAST_30_DAYS.");
      if (!fields.some((f) => PERF_METRICS.includes(f))) throw new Error("Select at least one metric: clicks, impressions or click_through_rate.");
      const [from, to] = range as [string, string];
      const segs = fields.filter((f) => PERF_SEGMENTS.includes(f));
      const groups = new Map<string, { seg: Record<string, unknown>; clicks: number; impressions: number }>();
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
        const daysAgo = Math.round((Date.now() - t) / DAY);
        for (const p of this.live()) for (const method of ["ADS", "ORGANIC"] as const) {
          const { clicks, impressions } = demoDay(p, daysAgo, method);
          const r: Record<string, unknown> = { date: ymd(t), offer_id: p.offerId, title: p.title, brand: p.brand, marketing_method: method };
          if (!conds.every((c) => (String(r[c.field] ?? "") === c.value) !== c.neg)) continue;
          const key = segs.map((s) => r[s]).join("\u0000");
          const g = groups.get(key) ?? { seg: Object.fromEntries(segs.map((s) => [s, r[s]])), clicks: 0, impressions: 0 };
          g.clicks += clicks; g.impressions += impressions;
          groups.set(key, g);
        }
      }
      rows = [...groups.values()].map((g) => {
        const metric: Record<string, unknown> = { clicks: g.clicks, impressions: g.impressions,
          click_through_rate: g.impressions ? Math.round((g.clicks / g.impressions) * 10000) / 10000 : 0 };
        return Object.fromEntries(fields.map((f) => [snakeToCamel(f), f in metric ? metric[f] : g.seg[f]]));
      });
    } else {
      throw new Error("The demo account answers product_view and product_performance_view only.");
    }
    for (const o of (m[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean).reverse()) {
      const [f, dir] = o.split(/\s+/);
      const k = snakeToCamel(f!.toLowerCase()), desc = /^desc$/i.test(dir ?? "");
      rows.sort((a, b) => { const x = a[k] as never, y = b[k] as never; return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });
    }
    const cap = Math.min(maxRows, m[5] ? Number(m[5]) : Infinity);
    return { rows: rows.slice(0, cap), truncated: rows.length > cap && cap === maxRows };
  }
}
