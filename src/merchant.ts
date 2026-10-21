/**
 * Google Merchant Center (Merchant API v1), read-only: which accounts the login can read, why products are disapproved
 * or demoted, and any Merchant Center report (MCQL), such as Shopping clicks and impressions per product. Its scope
 * (`content`) isn't in the main Google consent: the first call without it returns a personal /connect/merchant-center
 * link (grant.ts) that adds it to the user's existing connection.
 *
 * Google blocks every call from a Cloud project that isn't registered with a Merchant Center account (a one-time
 * `developerRegistration:registerGcp` against the operator's own account; merchants don't register). Unregistered,
 * calls answer 401 "not registered", which the tools report as Camberstack's to fix, not the user's.
 *
 * The demo account (DEMO_MERCHANT) answers the same calls with sample data, like the demo Ads account and property.
 */
import { NotGrantedError, scopeMissing } from "./google.js";

const API = "https://merchantapi.googleapis.com";
export const DEMO_MERCHANT = "000000001";
const DEMO_NAME = "DEMO: Northwind Plumbing Supply (sample data)";
const DEMO_NOTE = "Sample data from Camberstack's demo Merchant Center account (a fictional plumbing supply store), not a real account.";
/** Products the issue summary reads at most; past it, the counts say they're partial. */
const MAX_SCAN = 20_000;

export interface MerchantAccount { account_id: string; name: string; test_account?: boolean }
export interface SearchResult { rows: Record<string, unknown>[]; truncated: boolean }

/** The Merchant API calls the tools make; the demo account answers the same ones. */
export type Merchant = {
  accounts(): Promise<MerchantAccount[]>;
  /** Account-level issues (Merchant Center's "needs attention" list). */
  accountIssues(accountId: string): Promise<any[]>;
  /** An MCQL query's rows (the queried view's object), up to maxRows. */
  search(accountId: string, query: string, maxRows: number): Promise<SearchResult>;
};

/** What to do about the Merchant API errors AIs and users actually hit, appended to Google's message. */
function merchantFix(status: number, msg: string): string {
  if (/advanced account/i.test(msg)) return " → reports work on a standalone account or a sub-account, not an advanced (multi-client) account: use a sub-account's account_id from merchant_accounts.";
  if (status === 403 && /performance|PERFORMANCE_REPORTING/i.test(msg)) return " → performance views need the \"Performance and insights\" access in Merchant Center (People and access) for this Google login.";
  if (status === 403) return " → this Google login has no access to that Merchant Center account: use an account_id from merchant_accounts.";
  return "";
}

/** One user's view of the Merchant API (read-only). */
export class MerchantClient implements Merchant {
  constructor(private accessToken: () => Promise<string>, private grantLink: () => string | null, private f: typeof fetch = fetch) {}

  private async call(path: string, body?: object): Promise<any> {
    const res = await this.f(`${API}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      if (scopeMissing(res.status, text)) throw new NotGrantedError("merchant-center", this.grantLink());
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
      if (res.status === 401 && /not registered|AUTH_GCP_NOT_REGISTERED/i.test(text)) {
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
}

/** Sends the demo account's calls to the demo, everything else to Google. */
export function routedMerchant(google: Merchant, demo: Merchant): Merchant {
  return {
    accounts: () => google.accounts(),
    accountIssues: (id) => (id === DEMO_MERCHANT ? demo.accountIssues(id) : google.accountIssues(id)),
    search: (id, q, n) => (id === DEMO_MERCHANT ? demo.search(id, q, n) : google.search(id, q, n)),
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

/** A product's status: its worst issue decides, as in Merchant Center. */
const demoStatus = (p: DemoProduct) => {
  const sev = p.issues.map((i) => i.severity);
  return sev.includes("DISAPPROVED") ? "NOT_ELIGIBLE_OR_DISAPPROVED" : sev.includes("PENDING") ? "PENDING" : sev.includes("DEMOTED") ? "ELIGIBLE_LIMITED" : "ELIGIBLE";
};

export class DemoMerchant implements Merchant {
  async accounts() { return []; }
  async accountIssues() { return DEMO_ACCOUNT_ISSUES; }

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
      rows = DEMO_PRODUCTS.map((p) => {
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
        for (const p of DEMO_PRODUCTS) for (const method of ["ADS", "ORGANIC"]) {
          // A disapproved product stops serving from the day its issue started; a demoted one serves at half strength.
          const off = p.issues.some((i) => i.severity === "DISAPPROVED" && daysAgo <= i.since) || p.issues.some((i) => i.severity === "PENDING");
          const demoted = p.issues.some((i) => i.severity === "DEMOTED");
          const clicks = off ? 0 : Math.round(p.clicks * (method === "ADS" ? 1 : 0.35) * (demoted ? 0.5 : 1) * (1 + ((daysAgo * 7 + p.price) % 5) / 10));
          const impressions = off ? 0 : clicks * (method === "ADS" ? 42 : 65) + (p.price % 13);
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
