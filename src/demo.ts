/**
 * The demo account: a fictional advertiser ("Northwind Plumbing") that behaves like a Google Ads account
 * behind the same search/mutate interface, so every tool works on it unchanged. It exists so people can
 * try the whole flow (diagnose → propose → apply → undo) before trusting a tool with their real account,
 * and so directory reviewers never need a shared Google login with Ads access.
 *
 * Shown in list_accounts only when a login has no readable real account; reachable by its id always.
 * Writes change a per-user copy kept in SQLite (demo_state), never Google, and never use free applies.
 *
 * search() understands the GAQL the tools send and simple hand-written queries (run_gaql): FROM one of
 * the resources below, WHERE conditions joined by AND (=, !=, <, >, <=, >=, IN, LIKE), ORDER BY, LIMIT.
 * Rows come back whole (camelCase, like the API); metrics scale with the segments.date window.
 */
import { demoShopping } from "./merchant.js";
import type { DB } from "./db.js";
import { now } from "./db.js";
import type { SearchAnalyticsRequest, Sitemap, UrlInspection } from "./google.js";

export const DEMO_CID = "0000000001";
export const DEMO_NAME = "DEMO: Northwind Plumbing (sample data)";
export const DEMO_NOTE = "Sample data from Camberstack's demo account (a fictional plumbing business), not a real Google Ads account. Changes apply to the demo only.";

const HISTORY_DAYS = 180;

// ---------------------------------------------------------------- the account, 180 days of history

type Campaign = { id: string; name: string; type: string; bidding: string; budget: number; status: string; hidden?: { cost: number; clicks: number; conv: number } };
const CAMPAIGNS: Campaign[] = [
  { id: "2001", name: "Emergency Plumbing – Search", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 40, status: "ENABLED" },
  { id: "2002", name: "Water Heaters – Search", type: "SEARCH", bidding: "MANUAL_CPC", budget: 25, status: "ENABLED" },
  { id: "2003", name: "Drain Cleaning – Search", type: "SEARCH", bidding: "MANUAL_CPC", budget: 20, status: "ENABLED" },
  { id: "2004", name: "Brand – Northwind", type: "SEARCH", bidding: "TARGET_IMPRESSION_SHARE", budget: 10, status: "ENABLED" },
  { id: "2005", name: "Performance Max – Services", type: "PERFORMANCE_MAX", bidding: "MAXIMIZE_CONVERSIONS", budget: 30, status: "ENABLED",
    hidden: { cost: 1624.35, clicks: 1208, conv: 9 } },
  { id: "2006", name: "Bathroom Remodels – Search", type: "SEARCH", bidding: "MANUAL_CPC", budget: 15, status: "PAUSED" },
];
const AD_GROUPS: { id: string; campaign: string; name: string; status: string }[] = [
  { id: "3001", campaign: "2001", name: "Emergency Plumber", status: "ENABLED" },
  { id: "3002", campaign: "2001", name: "Burst Pipes & Leaks", status: "ENABLED" },
  { id: "3003", campaign: "2002", name: "Water Heater Install", status: "ENABLED" },
  { id: "3004", campaign: "2002", name: "Water Heater Repair", status: "ENABLED" },
  { id: "3005", campaign: "2003", name: "Drain Cleaning", status: "ENABLED" },
  { id: "3006", campaign: "2003", name: "Sewer Line", status: "PAUSED" },
  { id: "3007", campaign: "2004", name: "Brand", status: "ENABLED" },
  { id: "3008", campaign: "2006", name: "Bathroom Remodel", status: "ENABLED" },
];
const KEYWORDS: { id: string; adGroup: string; text: string; match: string; status: string }[] = [
  { id: "4001", adGroup: "3001", text: "emergency plumber", match: "PHRASE", status: "ENABLED" },
  { id: "4002", adGroup: "3001", text: "24 hour plumber", match: "PHRASE", status: "ENABLED" },
  { id: "4003", adGroup: "3001", text: "plumber near me", match: "BROAD", status: "ENABLED" },
  { id: "4004", adGroup: "3002", text: "burst pipe repair", match: "PHRASE", status: "ENABLED" },
  { id: "4005", adGroup: "3002", text: "water leak repair", match: "BROAD", status: "ENABLED" },
  { id: "4006", adGroup: "3003", text: "water heater installation", match: "PHRASE", status: "ENABLED" },
  { id: "4007", adGroup: "3003", text: "tankless water heater", match: "BROAD", status: "ENABLED" },
  { id: "4008", adGroup: "3004", text: "water heater repair", match: "PHRASE", status: "ENABLED" },
  { id: "4009", adGroup: "3005", text: "drain cleaning", match: "BROAD", status: "ENABLED" },
  { id: "4010", adGroup: "3005", text: "clogged drain", match: "BROAD", status: "ENABLED" },
  { id: "4011", adGroup: "3006", text: "sewer line repair", match: "PHRASE", status: "ENABLED" },
  { id: "4012", adGroup: "3007", text: "northwind plumbing", match: "EXACT", status: "ENABLED" },
  { id: "4013", adGroup: "3008", text: "bathroom remodel", match: "PHRASE", status: "ENABLED" },
];
// [keyword id, search term, cost, clicks, conversions] over 180 days
const TERMS: [string, string, number, number, number][] = [
  ["4001", "emergency plumber near me", 412.5, 96, 14], ["4001", "emergency plumber", 288.1, 70, 9],
  ["4002", "24 hour plumber near me", 196.4, 44, 6], ["4003", "plumber near me", 355.2, 118, 7],
  ["4003", "plumber jobs near me", 84.6, 31, 0], ["4003", "plumber salary", 41.2, 16, 0],
  ["4003", "how to become a plumber", 37.9, 12, 0], ["4003", "plumbing apprenticeship near me", 52.3, 15, 0],
  ["4004", "burst pipe repair", 164.8, 29, 4], ["4005", "water leak repair near me", 121.4, 33, 3],
  ["4005", "how to fix a leaking pipe", 63.7, 27, 0], ["4005", "free leak detection", 38.2, 11, 0],
  ["4006", "water heater installation", 302.6, 58, 5], ["4007", "tankless water heater", 241.3, 87, 1],
  ["4007", "tankless water heater reviews", 118.9, 44, 0], ["4007", "best tankless water heater", 97.4, 39, 0],
  ["4007", "how to install a tankless water heater", 72.1, 25, 0], ["4008", "water heater repair", 188.7, 41, 4],
  ["4008", "water heater repair free estimate", 46.3, 12, 1],
  ["4009", "drain cleaning", 214.4, 61, 0], ["4009", "drain cleaning near me", 176.2, 49, 0],
  ["4010", "how to unclog a drain", 118.6, 52, 0], ["4010", "diy drain cleaner", 66.3, 28, 0],
  ["4010", "free drain cleaning", 44.9, 14, 0], ["4010", "clogged drain", 129.8, 40, 0],
  ["4011", "sewer line repair", 98.2, 15, 0],
  ["4012", "northwind plumbing", 62.4, 88, 11], ["4012", "northwind plumbing reviews", 18.3, 21, 2],
  ["4013", "bathroom remodel near me", 140.2, 30, 1], ["4013", "bathroom remodel ideas", 88.5, 41, 0],
];
const CONVERSION_ACTIONS = [
  { id: "5001", name: "Calls from ads", category: "PHONE_CALL_LEAD", status: "ENABLED", primaryForGoal: true, type: "AD_CALL" },
  { id: "5002", name: "Online booking", category: "SUBMIT_LEAD_FORM", status: "ENABLED", primaryForGoal: true, type: "WEBPAGE" },
  { id: "5003", name: "Thank-you page view", category: "PAGE_VIEW", status: "ENABLED", primaryForGoal: false, type: "WEBPAGE" },
];
/** Keyword Planner sample: [text, avg monthly searches, competition, low bid, high bid]. Fictional, US-plumbing-shaped. */
const PLANNER: [string, number, string, number, number][] = [
  ["plumber near me", 246000, "MEDIUM", 9.8, 38.5], ["emergency plumber", 40500, "MEDIUM", 14.2, 61.0],
  ["emergency plumber near me", 33100, "MEDIUM", 15.1, 64.3], ["24 hour plumber", 14800, "MEDIUM", 13.0, 55.2],
  ["24 hour plumber near me", 12100, "HIGH", 13.6, 58.9], ["plumbing companies near me", 22200, "MEDIUM", 10.4, 41.7],
  ["water heater repair", 27100, "HIGH", 8.9, 34.0], ["water heater installation", 14800, "HIGH", 9.7, 39.8],
  ["water heater replacement", 18100, "HIGH", 10.2, 42.6], ["tankless water heater", 49500, "HIGH", 2.1, 9.4],
  ["tankless water heater installation", 9900, "HIGH", 11.3, 44.1], ["water heater repair near me", 12100, "HIGH", 9.4, 36.2],
  ["drain cleaning", 18100, "MEDIUM", 7.6, 29.9], ["drain cleaning near me", 14800, "MEDIUM", 8.3, 32.4],
  ["clogged drain", 9900, "LOW", 3.2, 14.8], ["hydro jetting", 6600, "MEDIUM", 9.1, 35.5],
  ["sewer line repair", 8100, "HIGH", 16.4, 72.0], ["sewer line replacement", 5400, "HIGH", 18.9, 80.3],
  ["sewer camera inspection", 3600, "MEDIUM", 8.0, 30.1], ["burst pipe repair", 2900, "MEDIUM", 11.8, 46.0],
  ["water leak repair", 4400, "MEDIUM", 10.6, 40.2], ["slab leak repair", 3600, "HIGH", 14.7, 59.1],
  ["leak detection", 9900, "MEDIUM", 9.3, 37.4], ["diy drain cleaning", 2400, "LOW", 0.8, 3.1],
  ["plumber salary", 27100, "LOW", 0.6, 2.2], ["plumber jobs near me", 14800, "LOW", 0.9, 3.6],
];
/** Seasonal shape for the demo's monthly searches, January first (frozen pipes in winter). */
const MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const SEASON = [1.25, 1.2, 1.0, 0.92, 0.88, 0.86, 0.9, 0.92, 0.95, 1.0, 1.08, 1.24];

/** Searches Google hides below its privacy threshold: campaign totals run this much above their terms. */
const HIDDEN_SHARE = 1.12;
/** Every demo ad group's default max CPC until changed: $2.00. */
const DEFAULT_BID = "2000000";

// ---------------------------------------------------------------- per-user mutable state

interface State {
  campaignStatus: Record<string, string>;
  /** Merchant Center links this user made on the demo (link_merchant_center); optional: older saved states have none. */
  productLinks?: { resourceName: string; merchantCenterId: string }[];
  budget: Record<string, number>;
  /** Optional: states saved before end dates existed have none. */
  endDateTime?: Record<string, string>;
  adGroupStatus: Record<string, string>;
  keywordStatus: Record<string, string>;
  /** Optional, like endDateTime: max CPCs set through the tools, in micros. A keyword with none uses its ad group's. */
  adGroupBid?: Record<string, string>;
  keywordBid?: Record<string, string>;
  negatives: { resourceName: string; campaign: string; text: string; match: string }[];
  nextId: number;
}

function fresh(): State {
  return {
    campaignStatus: Object.fromEntries(CAMPAIGNS.map((c) => [c.id, c.status])),
    budget: Object.fromEntries(CAMPAIGNS.map((c) => [c.id, c.budget])),
    adGroupStatus: Object.fromEntries(AD_GROUPS.map((g) => [g.id, g.status])),
    keywordStatus: Object.fromEntries(KEYWORDS.map((k) => [k.id, k.status])),
    negatives: [{ resourceName: `customers/${DEMO_CID}/campaignCriteria/2001~9001`, campaign: "2001", text: "diy", match: "PHRASE" }],
    nextId: 9100,
  };
}

export class DemoAds {
  constructor(private db: DB, private userId: string) {}

  private load(): State {
    const row = this.db.prepare("SELECT state FROM demo_state WHERE user_id = ?").get(this.userId) as { state: string } | undefined;
    if (!row) return fresh();
    // Before 2026-10-13 a bid or URL-suffix change saved its entity's status as undefined, which JSON drops;
    // fill any missing status back in from the base data.
    const s = JSON.parse(row.state) as State, f = fresh();
    for (const k of ["campaignStatus", "adGroupStatus", "keywordStatus"] as const) s[k] = { ...f[k], ...s[k] };
    return s;
  }
  private save(s: State): void {
    this.db.prepare(`INSERT INTO demo_state (user_id, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(this.userId, JSON.stringify(s), now());
  }

  /** Every row of a resource, built from the base data plus this user's changes, scaled to `days`. */
  private rows(resource: string, s: State, days: number): any[] {
    const f = Math.min(days, HISTORY_DAYS) / HISTORY_DAYS;
    const m = (cost: number, clicks: number, conv: number, share = 1) => ({
      costMicros: String(Math.round(cost * share * f * 1e6)), clicks: String(Math.round(clicks * share * f)),
      impressions: String(Math.round(clicks * share * f * 14)), conversions: Math.round(conv * f * 10) / 10, conversionsValue: 0,
    });
    const camp = (id: string) => {
      const c = CAMPAIGNS.find((x) => x.id === id)!;
      return { id: c.id, name: c.name, status: s.campaignStatus[c.id], endDateTime: s.endDateTime?.[c.id], advertisingChannelType: c.type, biddingStrategyType: c.bidding,
        resourceName: `customers/${DEMO_CID}/campaigns/${c.id}` };
    };
    const group = (id: string) => {
      const g = AD_GROUPS.find((x) => x.id === id)!;
      return { id: g.id, name: g.name, status: s.adGroupStatus[g.id], cpcBidMicros: s.adGroupBid?.[g.id] ?? DEFAULT_BID, resourceName: `customers/${DEMO_CID}/adGroups/${g.id}` };
    };
    const kwOf = (k: typeof KEYWORDS[number]) => ({
      criterionId: k.id, status: s.keywordStatus[k.id], cpcBidMicros: s.keywordBid?.[k.id], type: "KEYWORD", keyword: { text: k.text, matchType: k.match },
      resourceName: `customers/${DEMO_CID}/adGroupCriteria/${k.adGroup}~${k.id}`,
    });
    const termsOfKw = (kid: string) => TERMS.filter((t) => t[0] === kid);
    const sum = (ts: typeof TERMS) => ts.reduce((a, t) => [a[0] + t[2], a[1] + t[3], a[2] + t[4]], [0, 0, 0]);
    const groupOfKw = (kid: string) => KEYWORDS.find((k) => k.id === kid)!.adGroup;
    const campOfGroup = (gid: string) => AD_GROUPS.find((g) => g.id === gid)!.campaign;

    switch (resource) {
      // The demo store's products (merchant.ts), as a Performance Max campaign's Shopping ads report them; the window ends yesterday.
      case "shopping_performance_view":
        return demoShopping(days, 1);
      case "product_link":
        return (s.productLinks ?? []).map((l) => ({ productLink: { resourceName: l.resourceName, type: "MERCHANT_CENTER", merchantCenter: { merchantCenterId: l.merchantCenterId } } }));
      case "customer":
        return [{ customer: { id: DEMO_CID, descriptiveName: DEMO_NAME, currencyCode: "USD", timeZone: "America/Chicago", manager: false } }];
      case "customer_client":
        return [{ customerClient: { id: DEMO_CID, descriptiveName: DEMO_NAME, currencyCode: "USD", manager: false, level: 0, status: "ENABLED" } }];
      case "campaign":
        return CAMPAIGNS.map((c) => {
          const ts = TERMS.filter((t) => campOfGroup(groupOfKw(t[0])) === c.id);
          const [cost, clicks, conv] = c.hidden ? [c.hidden.cost, c.hidden.clicks, c.hidden.conv] : sum(ts);
          return { campaign: camp(c.id),
            campaignBudget: { resourceName: `customers/${DEMO_CID}/campaignBudgets/${c.id}`, amountMicros: String(Math.round(s.budget[c.id]! * 1e6)), explicitlyShared: false },
            metrics: m(cost, clicks, conv, c.hidden ? 1 : HIDDEN_SHARE) };
        });
      case "ad_group":
        return AD_GROUPS.map((g) => {
          const [cost, clicks, conv] = sum(TERMS.filter((t) => groupOfKw(t[0]) === g.id));
          return { campaign: camp(g.campaign), adGroup: group(g.id), metrics: m(cost, clicks, conv, HIDDEN_SHARE) };
        });
      case "keyword_view":
      case "ad_group_criterion":
        return KEYWORDS.map((k) => {
          const [cost, clicks, conv] = sum(termsOfKw(k.id));
          return { campaign: camp(campOfGroup(k.adGroup)), adGroup: group(k.adGroup), adGroupCriterion: kwOf(k), metrics: m(cost, clicks, conv) };
        });
      case "search_term_view":
        return TERMS.map(([kid, term, cost, clicks, conv]) => ({
          campaign: camp(campOfGroup(groupOfKw(kid))), adGroup: group(groupOfKw(kid)),
          searchTermView: { searchTerm: term, status: "NONE" }, metrics: m(cost, clicks, conv),
        }));
      case "conversion_action":
        return CONVERSION_ACTIONS.map((a) => ({ conversionAction: { ...a, resourceName: `customers/${DEMO_CID}/conversionActions/${a.id}` } }));
      case "campaign_criterion":
        return s.negatives.map((n) => ({
          campaign: camp(n.campaign),
          campaignCriterion: { resourceName: n.resourceName, criterionId: n.resourceName.split("~")[1], type: "KEYWORD", negative: true,
            keyword: { text: n.text, matchType: n.match } },
        }));
      // Sitelinks a build adds are simulated, so the sample has none to delete.
      case "campaign_asset":
        return [];
      // So a build's summary names its targeting ("United States, English") as it does on a real account.
      case "geo_target_constant":
        return Object.entries(GEOS).map(([id, canonicalName]) =>
          ({ geoTargetConstant: { resourceName: `geoTargetConstants/${id}`, id, name: canonicalName.split(",")[0], canonicalName } }));
      case "language_constant":
        return Object.entries(LANGUAGES).map(([id, name]) => ({ languageConstant: { resourceName: `languageConstants/${id}`, id, name } }));
      default:
        throw new Error(`The demo account supports these GAQL resources: customer, campaign, ad_group, keyword_view, ad_group_criterion, `
          + `search_term_view, campaign_criterion, campaign_asset, conversion_action, geo_target_constant, language_constant. "${resource}" isn't one of them.`);
    }
  }

  async listAccessibleCustomers(): Promise<string[]> { return [DEMO_CID]; }

  async search(_cid: string, query: string): Promise<any[]> {
    const q = parse(query);
    const s = this.load();
    let rows = this.rows(q.from, s, q.days).filter((r) => q.where.every((w) => w(r)));
    if (q.orderBy) {
      const { path, desc } = q.orderBy;
      rows = rows.sort((a, b) => cmp(get(a, path), get(b, path)) * (desc ? -1 : 1));
    }
    return q.limit ? rows.slice(0, q.limit) : rows;
  }

  /** Keyword Planner over PLANNER: ideas share a word with a seed (or everything, for a URL seed); metrics are exact matches. */
  async keywordPlan(_cid: string, method: "generateKeywordIdeas" | "generateKeywordHistoricalMetrics", req: any): Promise<{ results?: any[] }> {
    const metrics = ([, vol, comp, low, high]: typeof PLANNER[number]) => ({
      avgMonthlySearches: String(vol), competition: comp,
      lowTopOfPageBidMicros: String(Math.round(low * 1e6)), highTopOfPageBidMicros: String(Math.round(high * 1e6)),
      monthlySearchVolumes: Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(2025, 9 + i, 1));  // the 12 months to September 2026
        return { year: String(d.getUTCFullYear()), month: MONTH_NAMES[d.getUTCMonth()], monthlySearches: String(Math.round(vol * SEASON[d.getUTCMonth()]!)) };
      }),
    });
    if (method === "generateKeywordHistoricalMetrics") {
      const want = new Set((req.keywords as string[]).map((k) => k.toLowerCase()));
      return { results: PLANNER.filter((p) => want.has(p[0])).map((p) => ({ text: p[0], keywordMetrics: metrics(p) })) };
    }
    const seeds: string[] = req.keywordSeed?.keywords ?? req.keywordAndUrlSeed?.keywords ?? [];
    const words = new Set(seeds.flatMap((k) => k.toLowerCase().split(/\s+/)).filter((w) => w.length > 2));
    const hits = words.size ? PLANNER.filter((p) => p[0].split(" ").some((w) => words.has(w))) : PLANNER;
    return { results: hits.map((p) => ({ text: p[0], keywordIdeaMetrics: metrics(p) })) };
  }

  async mutate(_cid: string, service: string, operations: any[], opts: { validateOnly?: boolean } = {}): Promise<{ results: { resourceName?: string }[] }> {
    const s = this.load();
    const id = (rn: string) => rn.split("/").pop()!;
    if (service === "productLinks") {
      const op = operations[0] as { create?: { merchantCenter: { merchantCenterId: string } }; remove?: string };
      if (opts.validateOnly) return { results: [] };
      s.productLinks ??= [];
      if (op.create) {
        const resourceName = `customers/${DEMO_CID}/productLinks/${s.nextId++}`;
        s.productLinks.push({ resourceName, merchantCenterId: op.create.merchantCenter.merchantCenterId });
        this.save(s);
        return { results: [{ resourceName }] };
      }
      s.productLinks = s.productLinks.filter((l) => l.resourceName !== op.remove);
      this.save(s);
      return { results: [{ resourceName: op.remove! }] };
    }
    // Building (campaigns, ad groups, keywords, ads, sitelinks) is simulated: it validates and returns
    // resource names, so propose → apply → undo all work, but the sample account's reports don't change.
    if (service === "googleAds" || service === "adGroupAds" || (service === "adGroupCriteria" && (op0(operations).create || op0(operations).remove))
      || ((service === "campaigns" || service === "adGroups") && op0(operations).remove)) {
      const results = operations.map((op) => {
        const inner = service === "googleAds" ? Object.values(op)[0] as any : op;
        const coll = service === "googleAds" ? collectionOf(Object.keys(op)[0]!) : service;
        if (inner.remove) return { resourceName: inner.remove as string };
        return { resourceName: `customers/${DEMO_CID}/${coll}/${s.nextId++}` };
      });
      if (!opts.validateOnly) this.save(s);
      return { results: opts.validateOnly ? [] : results };
    }
    const results = operations.map((op) => {
      if (service === "campaignCriteria" && op.create?.keyword) {
        const camp = id(op.create.campaign);
        if (!CAMPAIGNS.some((c) => c.id === camp)) throw new Error(`Campaign ${camp} not found in the demo account`);
        const resourceName = `customers/${DEMO_CID}/campaignCriteria/${camp}~${s.nextId++}`;
        s.negatives.push({ resourceName, campaign: camp, text: op.create.keyword.text, match: op.create.keyword.matchType });
        return { resourceName };
      }
      if (service === "campaignCriteria" && op.remove) {
        s.negatives = s.negatives.filter((n) => n.resourceName !== op.remove);
        return { resourceName: op.remove };
      }
      // Targeting, conversion settings, bids, URL suffixes and bid strategies are simulated like builds:
      // accepted, but the sample reports don't change. Only status, budget, end date and bids are tracked.
      if (op.create) return { resourceName: `customers/${DEMO_CID}/${service}/${s.nextId++}` };
      if (op.remove) return { resourceName: op.remove as string };
      const u = op.update;
      if (!u) throw new Error(`Unsupported demo operation on ${service}`);
      if (service === "campaigns" && u.endDateTime) (s.endDateTime ??= {})[id(u.resourceName)] = u.endDateTime;
      if (op.updateMask === "cpc_bid_micros" && service === "adGroups") (s.adGroupBid ??= {})[id(u.resourceName)] = u.cpcBidMicros;
      if (op.updateMask === "cpc_bid_micros" && service === "adGroupCriteria") {
        const kw = id(u.resourceName).split("~")[1]!;
        if (u.cpcBidMicros === undefined) delete s.keywordBid?.[kw]; else (s.keywordBid ??= {})[kw] = u.cpcBidMicros;
      }
      if (u.status !== undefined) {
        if (service === "campaigns") s.campaignStatus[id(u.resourceName)] = u.status;
        else if (service === "adGroups") s.adGroupStatus[id(u.resourceName)] = u.status;
        else if (service === "adGroupCriteria") s.keywordStatus[id(u.resourceName).split("~")[1]!] = u.status;
      }
      if (service === "campaignBudgets") s.budget[id(u.resourceName)] = Number(u.amountMicros) / 1e6;
      return { resourceName: u.resourceName };
    });
    if (!opts.validateOnly) this.save(s);
    return { results: opts.validateOnly ? [] : results };
  }
}

const op0 = (ops: any[]) => ops[0] ?? {};
/** "campaignBudgetOperation" → "campaignBudgets", "adGroupCriterionOperation" → "adGroupCriteria". */
function collectionOf(opKey: string): string {
  const base = opKey.replace(/Operation$/, "");
  return base.endsWith("Criterion") ? base.replace(/Criterion$/, "Criteria") : `${base}s`;
}

// ---------------------------------------------------------------- a small GAQL reader

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
/** The locations and languages the demo can name: the ones the tools' descriptions use as examples, plus the demo's own city. */
const GEOS: Record<string, string> = {
  "2840": "United States", "2826": "United Kingdom", "2124": "Canada", "2036": "Australia", "2372": "Ireland", "2554": "New Zealand",
  "1016367": "Chicago,Illinois,United States",
};
const LANGUAGES: Record<string, string> = { "1000": "English", "1003": "Spanish", "1002": "French", "1001": "German" };

const get = (row: any, path: string[]) => path.reduce((o, k) => (o == null ? undefined : o[k]), row);
const lit = (v: string): string | number => {
  const t = v.trim();
  if (/^'.*'$|^".*"$/.test(t)) return t.slice(1, -1);
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t.toUpperCase() === "TRUE" ? 1 : t.toUpperCase() === "FALSE" ? 0 : t;
};
const norm = (v: unknown): string | number => (typeof v === "boolean" ? Number(v) : typeof v === "number" ? v
  : v != null && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v ?? ""));
const cmp = (a: unknown, b: unknown) => { const x = norm(a), y = norm(b); return x < y ? -1 : x > y ? 1 : 0; };

function parse(query: string) {
  const q = query.replace(/\s+/g, " ").trim();
  const from = /\bFROM\s+(\w+)/i.exec(q)?.[1]?.toLowerCase();
  if (!from) throw new Error("GAQL query needs a FROM clause");
  const where = /\bWHERE\s+(.+?)(?:\s+ORDER BY\s+|\s+LIMIT\s+|$)/i.exec(q)?.[1] ?? "";
  const orderBy = /\bORDER BY\s+([\w.]+)(?:\s+(ASC|DESC))?/i.exec(q);
  const limit = Number(/\bLIMIT\s+(\d+)/i.exec(q)?.[1] ?? 0) || undefined;
  let days = HISTORY_DAYS;
  const conds: ((r: any) => boolean)[] = [];
  // Split on AND outside quotes and outside BETWEEN … AND …
  const parts = where ? where.replace(/BETWEEN\s+('[^']*')\s+AND\s+('[^']*')/gi, "BETWEEN $1 && $2").split(/\s+AND\s+(?=(?:[^']*'[^']*')*[^']*$)/i) : [];
  for (const part of parts) {
    const p = part.trim();
    const dr = /^segments\.date\s+BETWEEN\s+'([\d-]+)'\s+&&\s+'([\d-]+)'$/i.exec(p);
    if (dr) { days = Math.round((Date.parse(dr[2]!) - Date.parse(dr[1]!)) / 86_400_000) + 1; continue; }
    const during = /^segments\.date\s+DURING\s+LAST_(\d+)_DAYS$/i.exec(p);
    if (during) { days = Number(during[1]); continue; }
    if (/^segments\./i.test(p)) continue;
    const m = /^([\w.]+)\s*(=|!=|<=|>=|<|>|NOT IN|IN|LIKE|NOT LIKE)\s*(.+)$/i.exec(p);
    if (!m) throw new Error(`The demo account can't read this condition: ${p}`);
    const path = m[1]!.split(".").map(camel);
    const op = m[2]!.toUpperCase();
    const raw = m[3]!;
    if (op === "IN" || op === "NOT IN") {
      const list = raw.replace(/^\(|\)$/g, "").split(",").map((x) => String(lit(x)));
      conds.push((r) => list.includes(String(norm(get(r, path)))) === (op === "IN"));
    } else if (op === "LIKE" || op === "NOT LIKE") {
      const re = new RegExp(`^${String(lit(raw)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
      conds.push((r) => re.test(String(get(r, path) ?? "")) === (op === "LIKE"));
    } else {
      const v = lit(raw);
      conds.push((r) => {
        const c = cmp(get(r, path), v);
        return op === "=" ? c === 0 : op === "!=" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
      });
    }
  }
  return { from, where: conds, orderBy: orderBy ? { path: orderBy[1]!.split(".").map(camel), desc: orderBy[2]?.toUpperCase() === "DESC" } : undefined, limit, days };
}

// ---------------------------------------------------------------- Search Console: the demo's website

export const DEMO_SITE = "sc-domain:northwind-plumbing.example";
const SITE_HOME = "https://northwind-plumbing.example";
// [query, page path, clicks, impressions, average position] over 180 days. Some overlap the demo's paid
// search terms (ranking well and paid for anyway), some are pages ranking on page 2 with no ads at all.
const ORGANIC: [string, string, number, number, number][] = [
  ["northwind plumbing", "/", 1840, 2310, 1.1], ["northwind plumbing reviews", "/reviews", 212, 640, 1.6],
  ["emergency plumber near me", "/emergency", 410, 9800, 2.4], ["emergency plumber", "/emergency", 236, 7200, 3.1],
  ["water heater repair", "/water-heaters/repair", 198, 5400, 2.8], ["burst pipe repair", "/emergency/burst-pipes", 74, 1500, 4.2],
  ["drain cleaning", "/drains", 61, 6900, 7.4], ["plumber near me", "/", 120, 21400, 9.6],
  ["tankless water heater", "/water-heaters/tankless", 22, 8800, 14.2],
  ["water heater replacement", "/water-heaters/replacement", 31, 5200, 11.8], ["slab leak repair", "/leaks/slab", 12, 4200, 18.3],
  ["hydro jetting", "/drains/hydro-jetting", 18, 3100, 12.5], ["sewer camera inspection", "/sewer/camera", 6, 1900, 22.0],
  ["leak detection near me", "/leaks", 27, 2600, 10.9], ["how to shut off water main", "/blog/shut-off-water-main", 520, 6100, 2.9],
  ["why is my water heater making noise", "/blog/noisy-water-heater", 340, 7900, 4.4],
];

/** The demo website's Search Console, answering the calls the tools make. */
export class DemoSearchConsole {
  async sites() { return [{ siteUrl: DEMO_SITE, permissionLevel: "siteOwner" }]; }

  async searchAnalytics(_site: string, req: SearchAnalyticsRequest) {
    if (req.startRow) return [];
    const days = Math.round((Date.parse(req.endDate) - Date.parse(req.startDate)) / 86_400_000) + 1;
    // Guides and blog posts are growing and the service pages slowly fading, so the trend tool has something to show.
    const age = Math.max(0, (Date.now() - Date.parse(req.endDate)) / 86_400_000 + days / 2) / HISTORY_DAYS;
    const filters = req.dimensionFilterGroups?.flatMap((g) => g.filters) ?? [];
    const value = (r: (typeof ORGANIC)[number], dim: string) =>
      dim === "query" ? r[0] : dim === "page" ? SITE_HOME + r[1] : dim === "country" ? "usa" : dim === "device" ? "MOBILE" : req.endDate;
    const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; posSum: number }>();
    for (const r of ORGANIC) {
      if (!filters.every((x) => {
        const v = value(r, x.dimension), e = x.expression;
        if (x.operator === "includingRegex" || x.operator === "excludingRegex") {
          const hit = new RegExp(e.replace(/^\(\?i\)/, ""), e.startsWith("(?i)") ? "i" : "").test(v);
          return x.operator === "includingRegex" ? hit : !hit;
        }
        const lv = v.toLowerCase(), le = e.toLowerCase();
        return x.operator === "contains" ? lv.includes(le) : x.operator === "notContains" ? !lv.includes(le) : lv === le;
      })) continue;
      const growth = r[1].startsWith("/blog") ? 1.4 - 0.8 * age : 1.1 - 0.2 * age;
      const f = (Math.min(days, HISTORY_DAYS) / HISTORY_DAYS) * Math.max(0.2, growth);
      const keys = req.dimensions.map((d) => value(r, d));
      const g = groups.get(keys.join("\u0000")) ?? { keys, clicks: 0, impressions: 0, posSum: 0 };
      g.clicks += Math.round(r[2] * f); g.impressions += Math.round(r[3] * f); g.posSum += r[4] * Math.round(r[3] * f);
      groups.set(keys.join("\u0000"), g);
    }
    return [...groups.values()].filter((g) => g.impressions > 0)
      .map((g) => ({ keys: g.keys, clicks: g.clicks, impressions: g.impressions, ctr: g.clicks / g.impressions, position: g.posSum / g.impressions }))
      .sort((a, b) => b.clicks - a.clicks).slice(0, req.rowLimit);
  }

  async sitemaps(): Promise<Sitemap[]> {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    return [{ path: SITE_HOME + "/sitemap.xml", lastSubmitted: day(40), lastDownloaded: day(2), isPending: false, isSitemapsIndex: false,
      errors: "0", warnings: "0", contents: [{ type: "web", submitted: String(new Set(ORGANIC.map((r) => r[1])).size + 1) }] }];
  }

  /** Every page with organic traffic is indexed; /blog/winterize-pipes is waiting in the queue; anything else is unknown. */
  async inspect(_site: string, url: string): Promise<UrlInspection> {
    const path = url.startsWith(SITE_HOME) ? url.slice(SITE_HOME.length) || "/" : null;
    const crawled = new Date(Date.now() - 6 * 86_400_000).toISOString();
    if (path && ORGANIC.some((r) => r[1] === path)) {
      return { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: crawled, robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", googleCanonical: url, userCanonical: url, crawledAs: "MOBILE",
        sitemap: [SITE_HOME + "/sitemap.xml"] },
        richResultsResult: { verdict: "PASS", detectedItems: [{ richResultType: "Breadcrumbs", items: [{ name: "Unnamed item", issues: [] }] }] } };
    }
    if (path === "/blog/winterize-pipes") {
      return { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED", sitemap: [SITE_HOME + "/sitemap.xml"] } };
    }
    return { indexStatusResult: { verdict: "NEUTRAL", coverageState: "URL is unknown to Google" } };
  }
}
