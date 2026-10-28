/**
 * End to end over real HTTP against a fake Google: register an MCP client, authorize with PKCE,
 * bounce through "Google", get tokens, then drive the tools through MCP, including the
 * propose → apply → undo cycle and the guards around apply.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./server.js";
import { now, openDb } from "./db.js";
import type { Config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { AdsApiError, NotGrantedError } from "./google.js";
import { io, PUBLIC_CHANGES } from "./changes.js";
import { PUBLIC_GA_CHANGES } from "./ga4-changes.js";
import { SERVER_VERSION, servicesOf } from "./tools.js";
import { plansPage } from "./pages.js";
import { CATALOG_QUERY } from "./gaql.js";
import { reportBug } from "./sentry.js";

vi.mock("./sentry.js", async (orig) => ({ ...(await orig<typeof import("./sentry.js")>()), reportBug: vi.fn() }));

const key = randomBytes(32);
const idToken = (sub: string, email: string) =>
  `h.${Buffer.from(JSON.stringify({ sub, email, email_verified: true })).toString("base64url")}.s`;

/** Who "Google" signs in as; a test can switch it to connect a second, brand-new user. */
const googleUser = { sub: "google-sub-1", email: "Owner@Example.com" };

/** What Google's token endpoint grants; the Analytics test widens it. */
const googleGrant = { scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/adwords", refresh: "g-refresh" };

/** Google's token endpoint. */
const googleFetch: typeof fetch = async (url) => {
  if (String(url).includes("oauth2.googleapis.com/token")) {
    return new Response(JSON.stringify({
      access_token: "g-access", expires_in: 3600, refresh_token: googleGrant.refresh,
      scope: googleGrant.scope,
      id_token: idToken(googleUser.sub, googleUser.email),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

/** A tiny in-memory Google Ads account. */
class FakeAds {
  mutations: { service: string; operations: any[]; validateOnly: boolean }[] = [];
  negatives: { text: string; matchType: string; rn: string }[] = [];
  kwStatus = "ENABLED";
  campaignStatus = "ENABLED";
  campaignEnd: string | undefined;
  /** campaign.contains_eu_political_advertising; undefined reads as Google's "not declared". */
  euPolitical: string | undefined;
  /** When set, Google refuses every mutate for want of the EU declaration, and these campaigns read as missing it. */
  euBlock: { id: string; name: string }[] | undefined;
  async listAccessibleCustomers() { return ["1112223333"]; }
  fieldQueries: string[] = [];
  /** Google's field catalog: a trimmed real v23 snapshot. Any other query is a run_gaql field lookup, answered as Google shapes it. */
  async searchFields(q: string) {
    if (q === CATALOG_QUERY) return JSON.parse(readFileSync(new URL("./fixtures/gaql-catalog.json", import.meta.url), "utf8"));
    this.fieldQueries.push(q);
    if (q.includes("quota")) throw new AdsApiError(429, JSON.stringify({ error: { code: 429, message: "Resource has been exhausted." } }));
    if (q.includes("bogus_column")) {
      throw new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" },
        message: "Unrecognized field in the query: 'bogus_column'." }] }] } }));
    }
    return [{ resourceName: "googleAdsFields/segments.search_term", name: "segments.search_term", category: "SEGMENT", selectable: true,
      selectableWith: Array.from({ length: 650 }, (_, i) => `resource_${i}`) }];
  }
  async search(_cid: string, q: string): Promise<any[]> {
    // 30-day spend per account (session.ts spendActivity): 2223334444 is the dormant one.
    if (q.includes("metrics.cost_micros FROM customer WHERE segments.date")) return [{ metrics: { costMicros: _cid === "2223334444" ? "0" : "5000000" } }];
    if (q.includes("missing_eu_political_advertising_declaration = TRUE")) return (this.euBlock ?? []).map((c) => ({ campaign: c }));
    if (q.endsWith("FROM customer")) return [{ customer: { containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" } }];
    // Google's rule: a field in WHERE or ORDER BY must be in SELECT too.
    if (q.includes("ORDER BY campaign.status") && !/^SELECT[^]*campaign\.status[^]*FROM/.test(q)) {
      throw new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: [{ errorCode: { queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" },
        message: "The following field must be present in SELECT clause: 'campaign.status'." }] }] } }));
    }
    if (q.includes("maximize_clicks")) {
      throw new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" },
        message: "Unrecognized field in the query: 'campaign.maximize_clicks.cpc_bid_ceiling_micros'." }] }] } }));
    }
    if (q.includes("FROM customer_client")) {
      return [{ customerClient: { id: "1112223333", descriptiveName: "Acme", currencyCode: "USD", timeZone: "Europe/London", manager: false, level: 0 } }];
    }
    if (q.includes("FROM campaign_criterion")) {
      return this.negatives.map((n) => ({ campaign: { id: "10" }, campaignCriterion: { keyword: { text: n.text, matchType: n.matchType } } }));
    }
    if (q.includes("FROM ad_group_criterion")) {
      return [{ adGroupCriterion: { status: this.kwStatus, cpcBidMicros: this.kwBid, keyword: { text: "invoice", matchType: "BROAD" } }, adGroup: { name: "AG", cpcBidMicros: this.agBid }, campaign: { name: "Search" } }];
    }
    if (q.includes("WHERE campaign_conversion_goal.biddable = TRUE")) {
      return Object.entries(this.goals).filter(([, b]) => b).map(([cat]) => ({ campaignConversionGoal: { resourceName: `customers/1112223333/campaignConversionGoals/10~${cat}~WEBSITE` } }));
    }
    if (q.includes("FROM customer_conversion_goal")) {
      const cat = /category = '(\w+)'/.exec(q)![1]!;
      return cat in this.acctGoals ? [{ customerConversionGoal: { resourceName: `customers/1112223333/customerConversionGoals/${cat}~WEBSITE`, biddable: this.acctGoals[cat] } }] : [];
    }
    if (q.includes("FROM campaign_conversion_goal WHERE campaign_conversion_goal.category")) {
      const cat = /category = '(\w+)'/.exec(q)![1]!;
      return cat in this.goals ? [{ campaign: { name: "Search", status: "PAUSED" }, campaignConversionGoal: {
        resourceName: `customers/1112223333/campaignConversionGoals/10~${cat}~WEBSITE`, biddable: this.goals[cat] } }] : [];
    }
    if (q.includes("FROM campaign_conversion_goal")) {
      return Object.entries(this.goals).map(([cat, biddable]) => ({ campaign: { name: "Search" }, campaignConversionGoal: {
        resourceName: `customers/1112223333/campaignConversionGoals/10~${cat}~WEBSITE`, category: cat, origin: "WEBSITE", biddable } }));
    }
    if (q.includes("FROM ad_group WHERE")) return [{ adGroup: { name: "AG", cpcBidMicros: this.agBid }, campaign: { name: "Search", status: this.campaignStatus } }];
    if (q.includes("FROM ad_group_ad")) return [{ adGroupAd: { status: "ENABLED", ad: { finalUrls: ["https://example.com/old"] } }, adGroup: { name: "AG" }, campaign: { name: "Search" } }];
    if (q.includes("FROM conversion_action WHERE conversion_action.name")) return [];
    if (q.includes("google_analytics_4_settings.event_name")) {
      return q.includes("property_id = 321") && q.includes("'generate_lead'") ? [{ conversionAction: { resourceName: "customers/1112223333/conversionActions/90",
        name: "Site (web) generate_lead", category: "SUBMIT_LEAD_FORM", ...this.ga4Lead } }] : [];
    }
    if (q.includes("FROM conversion_action WHERE conversion_action.id = 78")) return [{ conversionAction: { name: "Site (web) generate_lead", countingType: "MANY_PER_CLICK", type: "GOOGLE_ANALYTICS_4_CUSTOM" } }];
    if (q.includes("FROM conversion_action WHERE conversion_action.id")) return [{ conversionAction: { name: "Signup", countingType: "MANY_PER_CLICK", type: "WEBPAGE" } }];
    if (q.includes("campaign.name = ")) return q.includes("campaign.name = 'Search'") ? [{ campaign: { id: "10" } }] : [];
    if (q.includes("FROM bidding_strategy WHERE bidding_strategy.name")) return q.includes("'Taken'") ? [{ biddingStrategy: { id: "5" } }] : [];
    if (q.includes("FROM bidding_strategy WHERE")) {
      return this.portfolio && q.includes(`bidding_strategy.id = ${this.portfolio.id}`)
        ? [{ biddingStrategy: { name: "Shared tCPA", type: "TARGET_CPA", targetCpa: { targetCpaMicros: this.portfolio.cpa } } }] : [];
    }
    if (q.includes("WHERE campaign.bidding_strategy = ")) {
      return (this.strategyCampaigns ?? [{ id: "10", name: "Search" }, { id: "11", name: "Brand" }]).map((c) => ({ campaign: c }));
    }
    if (q.includes("FROM campaign")) {
      return [{ campaign: { id: "10", name: "Search", status: this.campaignStatus, endDateTime: this.campaignEnd, advertisingChannelType: "SEARCH",
          ...(this.portfolio ? { biddingStrategyType: "TARGET_CPA", biddingStrategy: `customers/1112223333/biddingStrategies/${this.portfolio.id}` }
            : { biddingStrategyType: "MANUAL_CPC", manualCpc: { enhancedCpcEnabled: false } }), finalUrlSuffix: "",
          containsEuPoliticalAdvertising: this.euPolitical },
        campaignBudget: { resourceName: "customers/1112223333/campaignBudgets/99", amountMicros: "20000000", explicitlyShared: false },
        metrics: { costMicros: "200000000", clicks: "80", impressions: "900", conversions: 4, conversionsValue: 400 } }];
    }
    if (q.includes("FROM search_term_view")) {
      return [
        { searchTermView: { searchTerm: "invoice app" }, campaign: { id: "10", name: "Search" }, metrics: { costMicros: "120000000", clicks: "30", conversions: 4 } },
        { searchTermView: { searchTerm: "free invoice maker" }, campaign: { id: "10", name: "Search" }, metrics: { costMicros: "60000000", clicks: "25", conversions: 0 } },
      ];
    }
    if (q.includes("FROM keyword_view")) return [];
    if (q.includes("FROM conversion_action")) {
      return [{ conversionAction: { id: "1", name: "Purchase", category: "PURCHASE", status: "ENABLED", primaryForGoal: true, type: "WEBPAGE" } }];
    }
    return [];
  }
  plannerCalls: { method: string; req: any }[] = [];
  async keywordPlan(_cid: string, method: string, req: any) {
    this.plannerCalls.push({ method, req });
    if (method === "generateKeywordIdeas") {
      return { results: [
        { text: "invoice", keywordIdeaMetrics: { avgMonthlySearches: "90500", competition: "HIGH", lowTopOfPageBidMicros: "2100000", highTopOfPageBidMicros: "9800000" } },
        { text: "invoice software", keywordIdeaMetrics: { avgMonthlySearches: "12100", competition: "HIGH", lowTopOfPageBidMicros: "8000000", highTopOfPageBidMicros: "31000000" } },
        { text: "free invoice maker", keywordIdeaMetrics: { avgMonthlySearches: "40", competition: "LOW" } },
        { text: "invoice template docx" },
      ] };
    }
    // A big list: one row per keyword, searches = its position, so a test can tell rows apart.
    if (req.keywords?.length > 100) return { results: req.keywords.map((text: string, i: number) => ({ text, keywordMetrics: {
      avgMonthlySearches: String(i), competition: "LOW", monthlySearchVolumes: [{ year: "2026", month: "SEPTEMBER", monthlySearches: String(i) }] } })) };
    return { results: [{ text: "invoice software", closeVariants: ["invoicing software"], keywordMetrics: {
      avgMonthlySearches: "12100", competition: "HIGH",
      monthlySearchVolumes: [{ year: "2026", month: "AUGUST", monthlySearches: "11000" }, { year: "2026", month: "SEPTEMBER", monthlySearches: "13000" }],
    } }] };
  }
  goals: Record<string, boolean> = { PURCHASE: true, SIGNUP: true };
  /** The HIDDEN copy Google Ads keeps of linked GA4 property 321's key event generate_lead. */
  ga4Lead = { status: "HIDDEN", primaryForGoal: false };
  /** The account's default conversion goals: category → biddable. */
  acctGoals: Record<string, boolean> = { PURCHASE: true, SIGNUP: false };
  /** When set, campaign 10 is on this shared (portfolio) Target CPA strategy, with campaign "Brand". */
  portfolio: { id: string; cpa: string } | undefined;
  /** Campaigns a strategy-membership query returns; default: Search and Brand. */
  strategyCampaigns: { id: string; name: string }[] | undefined;
  agBid = "1000000";
  kwBid: string | undefined;
  removed: string[] = [];
  /** A test can make Google refuse operations mentioning `text`: at validation too, or only on the real write. */
  failOn: { text: string; writesOnly?: boolean } | undefined;
  async mutate(_cid: string, service: string, operations: any[], opts: { validateOnly?: boolean } = {}) {
    if (this.euBlock) {
      throw new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: [{ errorCode: { euPoliticalAdvertisingError: "EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED" },
        message: "Mutates are generally not allowed if the customer contains non-exempt campaigns without the EU political advertising declaration." }] }] } }));
    }
    if (this.failOn && JSON.stringify(operations).includes(this.failOn.text) && !(this.failOn.writesOnly && opts.validateOnly)) {
      throw new Error(`Google Ads API 400: refused ${this.failOn.text}`);
    }
    this.mutations.push({ service, operations, validateOnly: !!opts.validateOnly });
    if (opts.validateOnly) return { results: [] };
    if (service === "googleAds") {
      return { results: operations.map((op, i) => {
        const key = Object.keys(op)[0]!, inner = op[key];
        if (key === "conversionActionOperation" && inner.remove?.endsWith("/90")) { this.ga4Lead.status = "REMOVED"; return { resourceName: inner.remove }; }
        if (key === "campaignConversionGoalOperation") this.goals[inner.update.resourceName.split("~")[1]] = inner.update.biddable;
        if (key === "customerConversionGoalOperation") this.acctGoals[inner.update.resourceName.split("/").at(-1).split("~")[0]] = inner.update.biddable;
        if (key.endsWith("ConversionGoalOperation")) return { resourceName: inner.update.resourceName };
        if (inner.remove) { this.removed.push(inner.remove); return { resourceName: inner.remove }; }
        const coll = key.replace(/Operation$/, "").replace(/Criterion$/, "Criteria").replace(/y$/, "ie").replace(/^(?!.*Criteria$)(.*)$/, "$1s");
        return { resourceName: `customers/1112223333/${coll}/${500 + i}` };
      }) };
    }
    if (service === "campaignConversionGoals") {
      for (const op of operations) this.goals[op.update.resourceName.split("~")[1]] = op.update.biddable;
      return { results: operations.map((op) => ({ resourceName: op.update.resourceName })) };
    }
    if (operations[0]?.remove && service === "conversionActions" && operations[0].remove.endsWith("/90")) this.ga4Lead.status = "REMOVED";
    if (operations[0]?.remove && service !== "campaignCriteria") {
      this.removed.push(...operations.map((op) => op.remove));
      return { results: operations.map((op) => ({ resourceName: op.remove })) };
    }
    if (service === "adGroupCriteria" && operations[0]?.create) {
      return { results: operations.map((_op, i) => ({ resourceName: `customers/1112223333/adGroupCriteria/20~${700 + i}` })) };
    }
    return {
      results: operations.map((op, i) => {
        if (op.create?.negative) {
          const rn = `customers/1112223333/campaignCriteria/10~${900 + this.negatives.length + i}`;
          this.negatives.push({ text: op.create.keyword.text, matchType: op.create.keyword.matchType, rn });
          return { resourceName: rn };
        }
        if (service === "conversionActions" && op.update?.status) {
          Object.assign(this.ga4Lead, op.update);
          // Like Google: a primary action makes its category bid in the account's default goals, and in campaigns that use them.
          if (op.update.primaryForGoal) this.acctGoals.SUBMIT_LEAD_FORM = this.goals.SUBMIT_LEAD_FORM = true;
          return { resourceName: op.update.resourceName };
        }
        if (op.remove) { this.negatives = this.negatives.filter((n) => n.rn !== op.remove); return { resourceName: op.remove }; }
        if (op.updateMask === "cpc_bid_micros") {
          if (service === "adGroups") this.agBid = op.update.cpcBidMicros; else this.kwBid = op.update.cpcBidMicros;
          return { resourceName: op.update.resourceName };
        }
        if (op.update?.containsEuPoliticalAdvertising) { this.euPolitical = op.update.containsEuPoliticalAdvertising; return { resourceName: op.update.resourceName }; }
        if (op.update?.endDateTime) { this.campaignEnd = op.update.endDateTime; return { resourceName: op.update.resourceName }; }
        if (op.update?.status && service === "campaigns") { this.campaignStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        if (op.update?.status) { this.kwStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        return { resourceName: op.update?.resourceName };
      }),
    };
  }
}

/** A tiny Search Console: one site whose queries overlap FakeAds' search terms. */
class FakeSearchConsole {
  /** The grant link to hand out as "Search Console not granted", or "" when it is. */
  notGranted = "";
  /** Site totals (no dimension) returned in call order. */
  totals: any[] = [];
  requests: { site: string; req: any }[] = [];
  /** Overrides the rows for a request (per window, per page of results); undefined falls through to the defaults. */
  rowsFor?: (req: any) => any[] | undefined;
  inspected: string[] = [];
  async sites() {
    if (this.notGranted) throw new NotGrantedError("search-console", this.notGranted);
    return [{ siteUrl: "sc-domain:acme.test", permissionLevel: "siteOwner" }, { siteUrl: "https://other.test/", permissionLevel: "siteUnverifiedUser" }];
  }
  async searchAnalytics(site: string, req: any) {
    if (this.notGranted) throw new NotGrantedError("search-console", this.notGranted);
    this.requests.push({ site, req });
    if (!req.dimensions.length) return [this.totals.shift()!];
    const custom = this.rowsFor?.(req);
    if (custom) return custom;
    return [
      { keys: ["Invoice App"], clicks: 40, impressions: 800, ctr: 0.05, position: 2.14 },        // paid, ranks top 3
      { keys: ["free invoice maker"], clicks: 3, impressions: 400, ctr: 0.0075, position: 8.2 }, // paid, ranks lower
      { keys: ["invoice template"], clicks: 5, impressions: 900, ctr: 0.0056, position: 14 },    // gap
      { keys: ["invoice"], clicks: 9, impressions: 2000, ctr: 0.0045, position: 15 },            // already a keyword
      { keys: ["invoice pdf"], clicks: 0, impressions: 50, ctr: 0, position: 12 },               // too few impressions
    ];
  }
  async sitemaps(_site: string) {
    return [{ path: "https://acme.test/sitemap.xml", lastSubmitted: "2026-09-01T00:00:00Z", lastDownloaded: "2026-10-01T00:00:00Z",
      isPending: false, isSitemapsIndex: false, errors: "0", warnings: "2", contents: [{ type: "web", submitted: "36" }] }];
  }
  async inspect(_site: string, url: string) {
    this.inspected.push(url);
    if (url.includes("broken")) throw new Error("Search Console API 403: You do not own this site, or the inspected URL is not part of this property.");
    if (url.endsWith("/queued")) return { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed",
      robotsTxtState: "ROBOTS_TXT_STATE_UNSPECIFIED", pageFetchState: "PAGE_FETCH_STATE_UNSPECIFIED", crawledAs: "CRAWLING_USER_AGENT_UNSPECIFIED" } };
    return { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-05T10:00:00Z",
      robotsTxtState: "ALLOWED", pageFetchState: "SUCCESSFUL", googleCanonical: "https://acme.test/a", userCanonical: url },
      richResultsResult: { verdict: "FAIL", detectedItems: [{ richResultType: "FAQ", items: [{ name: "x", issues: [{ issueMessage: "Missing field \"name\"", severity: "ERROR" }] }] }] } };
  }
}

/** Stripe, just enough of it: Checkout, session lookup, the sweep's list, subscriptions, the portal. */
const stripe = { subStatus: "active", checkouts: [] as URLSearchParams[], portalReturn: "" };
const stripeFetch: typeof fetch = async (url, init) => {
  const u = String(url).replace("https://api.stripe.com/v1/", "");
  const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u === "checkout/sessions" && init?.method === "POST") {
    stripe.checkouts.push(init.body as URLSearchParams);
    return j({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  }
  if (u === "checkout/sessions/cs_test_1") {
    const f = stripe.checkouts.at(-1)!;
    return j({ id: "cs_test_1", status: "complete", metadata: { app: f.get("metadata[app]") },
      client_reference_id: f.get("client_reference_id"), customer: "cus_1", subscription: "sub_1" });
  }
  if (u.startsWith("checkout/sessions?")) {
    const f = stripe.checkouts.at(-1);
    return j({ data: f ? [{ id: "cs_test_1", status: "complete", metadata: { app: f.get("metadata[app]") },
      client_reference_id: f.get("client_reference_id"), customer: "cus_1", subscription: "sub_1" }] : [] });
  }
  if (u === "subscriptions/sub_1") return j({ id: "sub_1", status: stripe.subStatus });
  if (u === "subscriptions/sub_gone") return new Response(JSON.stringify({ error: { message: "No such subscription" } }), { status: 404 });
  if (u === "subscriptions/sub_flaky") return new Response(JSON.stringify({ error: { message: "try again" } }), { status: 500 });
  if (u.startsWith("billing_portal/configurations")) return j({ data: [{ id: "bpc_1", is_default: false, active: true }] });
  if (u === "billing_portal/sessions") {
    expect((init?.body as URLSearchParams).get("configuration")).toBe("bpc_1");
    stripe.portalReturn = (init?.body as URLSearchParams).get("return_url") ?? "";
    return j({ url: "https://billing.stripe.com/p/session_1" });
  }
  throw new Error(`unexpected stripe ${u}`);
};

/** A Google Analytics connection: not granted until the user's stored token is the one the grant returned. */
const ga = {
  async summaries(userId: string) {
    const enc = (db.prepare("SELECT enc_refresh FROM users WHERE id = ?").get(userId) as { enc_refresh: string }).enc_refresh;
    if (decrypt(key, enc) !== "g-refresh-with-analytics") throw new NotGrantedError("analytics", grants.link("analytics", userId));
    return { accounts: [{ account_id: "77", name: "Example Inc" }], properties: [{ property_id: "321", name: "Example", account: "Example Inc", account_id: "77" }] };
  },
  async runReport() { return { row_count: 0, rows: [] }; },
  /** Property 321's setup, which the changes below alter. */
  keyEvents: [] as { name: string; eventName: string; countingMethod: string; deletable?: boolean }[],
  links: [] as { name: string; customerId: string }[],
  failOn: "",
  /** Writes of this method that answer 503 once before working, like a brief Google outage. */
  flaky: { method: "", times: 0 },
  async admin(method: string, path: string, body?: any): Promise<any> {
    if (this.flaky.times && method === this.flaky.method) { this.flaky.times--; throw new Error("Google Analytics API 503: The service is currently unavailable."); }
    if (this.failOn && path.includes(this.failOn) && method !== "GET") throw new Error(`Google Analytics API 400: refused ${this.failOn}`);
    if (method === "GET" && path === "properties/321") return { displayName: "Example", timeZone: "America/New_York", currencyCode: "USD" };
    if (method === "GET" && path.startsWith("properties/321/keyEvents")) return { keyEvents: this.keyEvents };
    if (method === "GET" && path.startsWith("properties/321/googleAdsLinks")) return { googleAdsLinks: this.links };
    if (method === "POST" && path === "properties/321/keyEvents") {
      const k = { name: `properties/321/keyEvents/${this.keyEvents.length + 1}`, eventName: body.eventName, countingMethod: body.countingMethod, deletable: true };
      this.keyEvents.push(k); return k;
    }
    if (method === "POST" && path === "properties/321/googleAdsLinks") {
      const l = { name: `properties/321/googleAdsLinks/${this.links.length + 1}`, customerId: body.customerId };
      this.links.push(l); return l;
    }
    if (method === "DELETE") {
      this.keyEvents = this.keyEvents.filter((k) => k.name !== path); this.links = this.links.filter((l) => l.name !== path); return {};
    }
    throw new Error(`fake GA: ${method} ${path}`);
  },
};

/** Operations (~/operations), which our own ad's conversions are handed to. */
const conversionUploads: any[] = [];
const adsConversionFetch: typeof fetch = async (url, init) => {
  if (String(url) === "http://operations.test/v1/conversions") {
    conversionUploads.push({ auth: (init?.headers as Record<string, string>).Authorization, ...JSON.parse(String(init?.body)) });
    return new Response('{"queued":true}', { status: 202 });
  }
  throw new Error(`unexpected ${url}`);
};

let app: ReturnType<typeof createApp>["app"];
let billing: ReturnType<typeof createApp>["billing"];
let grants: ReturnType<typeof createApp>["grants"];
let deps: ReturnType<typeof createApp>["deps"];
let server: Server;
let base = "";
const ads = new FakeAds();
const sc = new FakeSearchConsole();
const db = openDb(":memory:");
/** ALLOWED_EMAILS: empty (anyone may connect) except inside the test that fills it. */
const allowedEmails = new Set<string>();

beforeAll(async () => {
  const cfg: Config = {
    baseUrl: "http://localhost", port: 0, dataDir: ":memory:", encryptionKey: key,
    google: { clientId: "gid", clientSecret: "gsecret" },
    freeAccounts: 1, proAccounts: 5, stripe: { secretKey: "sk_test_x", proPriceId: "price_pro" }, proEmails: new Set(), adminEmails: new Set(["owner@example.com"]), allowedEmails, gitSha: "test", gitCommitDate: "",
  };
  // Bind first so baseUrl (the OAuth issuer) is the real test origin.
  server = await new Promise<Server>((resolve) => { const s = createApp(cfg, db).app.listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  server.close();
  server = await new Promise<Server>((resolve) => {
    ({ app, billing, grants, deps } = createApp({ ...cfg, baseUrl: base, adminUrl: base.replace("localhost", "127.0.0.1"), openaiAppsChallenge: "tok_test_123",
      conversions: { opsUrl: "http://operations.test/v1/conversions", opsKey: "crk_ours", actionId: "555" } }, db, { fetch: googleFetch, stripeFetch, adsConversionFetch, adsFactory: () => ads as any, scFactory: () => sc, gaFactory: (u) => ({ summaries: () => ga.summaries(u.id), runReport: () => ga.runReport(), admin: (m, p, b) => ga.admin(m, p, b) }) }));
    const s = app.listen(Number(new URL(base).port), () => resolve(s));
  });
});
afterAll(() => { server?.close(); });

async function connect(cookie?: string, state = "xyz"): Promise<string> {
  const redirect = "http://localhost:9999/callback";
  const reg = await fetch(`${base}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test AI", token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(reg.status).toBe(201);
  const client = await reg.json();

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(`${base}/authorize`);
  auth.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state, scope: "ads" }).toString();
  const { g, consent } = await approve(auth);
  expect(g.host).toBe("accounts.google.com");
  expect(g.searchParams.get("scope")).toContain("adwords");
  expect(g.searchParams.get("scope")).toContain("webmasters.readonly");

  const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`,
    { redirect: "manual", headers: { cookie: [cookie, consent].filter(Boolean).join("; ") } });
  expect(back.status).toBe(302);
  lastCallbackCookies = back.headers.get("set-cookie") ?? "";
  const cb = new URL(back.headers.get("location")!);
  expect(cb.searchParams.get("state")).toBe(state);

  const tok = await fetch(`${base}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: cb.searchParams.get("code")!, code_verifier: verifier,
      client_id: client.client_id, redirect_uri: redirect }),
  });
  expect(tok.status).toBe(200);
  return (await tok.json()).access_token;
}

/** /authorize → our consent page → "Continue to Google". Returns Google's URL and the browser's consent cookie. */
async function approve(auth: URL, decision = "approve"): Promise<{ g: URL; consent: string; html: string; id: string }> {
  const page = await fetch(auth, { redirect: "manual" });
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  const html = await page.text();
  const consent = page.headers.get("set-cookie")!.split(";")[0]!;
  expect(consent).toMatch(/^cs_auth_/);
  const id = html.match(/name="id" value="([^"]+)"/)![1]!;
  const post = await fetch(`${base}/oauth/consent`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: consent },
    body: new URLSearchParams({ id, decision }),
  });
  expect(post.status).toBe(303);
  return { g: new URL(post.headers.get("location")!), consent, html, id };
}

/** The sign-in nonce cookie a page's /login set, which its callback needs to see from the same browser. */
const stateCookie = (login: Response) => login.headers.get("set-cookie")!.split(";")[0]!;

/** The test user's id (everyone here signs in as googleUser). */
const ownerId = () => (db.prepare("SELECT id FROM users WHERE google_sub = ?").get(googleUser.sub) as { id: string }).id;

/** Google → our shared callback → the page's own callback, which sets its session cookie. */
async function signIn(google: URL, state: string): Promise<string> {
  const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${google.searchParams.get("state")}`, { redirect: "manual" });
  expect(back.status).toBe(302);
  const hop = await fetch(new URL(back.headers.get("location")!, base), { redirect: "manual", headers: { cookie: state } });
  expect(hop.status).toBe(302);
  expect(hop.headers.get("set-cookie")).toContain("HttpOnly");
  return hop.headers.get("set-cookie")!.split(";")[0]!;
}

let lastCallbackCookies = "";
let rpcId = 0;
async function call(token: string, name: string, args: object = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  return { isError: !!body.result?.isError, text, json: body.result?.isError ? null : JSON.parse(text || "null") };
}

/**
 * What every connection loads before its first call, so it can't grow unnoticed (2026-10-23: 18.5K tokens, a third of it
 * field descriptions repeated per change kind). The budgets sit just above that day's sizes: raising one is a decision,
 * not a side effect. Claude Code cuts any description past 4,096 characters (its MCP docs), so none may get there.
 */
function expectToolBudget(tools: { name: string; description?: string }[], b: { total: number; perTool: number; except?: Record<string, number> }) {
  expect(JSON.stringify(tools).length, "tools/list bytes").toBeLessThanOrEqual(b.total);
  for (const t of tools) {
    expect(JSON.stringify(t).length, t.name).toBeLessThanOrEqual(b.except?.[t.name] ?? b.perTool);
    expect((t.description ?? "").length, t.name).toBeLessThanOrEqual(4096);
  }
}

describe("OAuth + MCP end to end", () => {
  let token = "";

  it("rejects /mcp without a token and points at the resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("turns away a Google account not on ALLOWED_EMAILS, and stores nothing for it", async () => {
    allowedEmails.add("owner@example.com");
    googleUser.sub = "google-sub-stranger"; googleUser.email = "stranger@example.com";
    try {
      const redirect = "http://localhost:9999/callback";
      const client = await (await fetch(`${base}/register`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test AI", token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      })).json();
      const auth = new URL(`${base}/authorize`);
      auth.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code",
        code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s1", scope: "ads" }).toString();
      const { g, consent } = await approve(auth);
      const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`,
        { redirect: "manual", headers: { cookie: consent } });
      const cb = new URL(back.headers.get("location")!);
      expect(cb.searchParams.get("error")).toBe("access_denied");
      expect(cb.searchParams.get("code")).toBeNull();
      expect(db.prepare("SELECT 1 FROM users WHERE google_sub = ?").get("google-sub-stranger")).toBeUndefined();
    } finally {
      allowedEmails.clear();
      googleUser.sub = "google-sub-1"; googleUser.email = "Owner@Example.com";
    }
  });

  it("connects through Google and stores the Google refresh token encrypted", async () => {
    token = await connect();
    const u = db.prepare("SELECT * FROM users").get() as any;
    expect(u.email).toBe("owner@example.com");
    expect(u.enc_refresh).not.toContain("g-refresh");
    expect(decrypt(key, u.enc_refresh)).toBe("g-refresh");
    const raw = db.prepare("SELECT token_hash FROM tokens").all() as any[];
    expect(raw.some((r) => r.token_hash === token)).toBe(false); // hashed, never stored raw
  });

  it("answers 401 once Google is disconnected, so the AI app signs in again instead of showing a dead connector", async () => {
    const saved = (db.prepare("SELECT enc_refresh FROM users WHERE email = 'owner@example.com'").get() as { enc_refresh: string }).enc_refresh;
    db.prepare("UPDATE users SET enc_refresh = NULL WHERE email = 'owner@example.com'").run();
    try {
      const res = await fetch(`${base}/mcp`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "list_accounts", arguments: {} } }) });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    } finally {
      db.prepare("UPDATE users SET enc_refresh = ? WHERE email = 'owner@example.com'").run(saved);
    }
    expect((await call(token, "list_accounts")).isError).toBe(false);
  });

  it("shows who's asking before Google, and won't finish a sign-in this browser didn't approve", async () => {
    // A stranger registers their own client (open DCR) and builds the links a phishing mail would carry.
    const evil = "https://attacker.example/cb";
    const reg = await (await fetch(`${base}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [evil], client_name: "<b>Claude</b>", token_endpoint_auth_method: "none" }),
    })).json();
    const auth = new URL(`${base}/authorize`);
    auth.search = new URLSearchParams({ client_id: reg.client_id, redirect_uri: evil, response_type: "code",
      code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s1", scope: "ads" }).toString();

    // The page names the app (escaped) and where it returns to, and warns about an unknown host.
    const { g, html, id } = await approve(auth);
    expect(html).toContain("&lt;b&gt;Claude&lt;/b&gt;");
    expect(html).not.toContain("<b>Claude</b>");
    expect(html).toContain("attacker.example");
    expect(html).toContain("Unrecognized address");

    // The attacker approved in THEIR browser; the Google link they forward fails in the victim's (no cookie).
    const victim = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`, { redirect: "manual" });
    expect(victim.status).toBe(400);
    expect(await victim.text()).toContain("wasn't started in this browser");

    // A cross-site auto-submit of the consent form carries no cookie either.
    const forged = await fetch(`${base}/oauth/consent`, {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id, decision: "approve" }),
    });
    expect(forged.status).toBe(400);

    // Skipping the page: Google's URL for a request nobody approved is refused even with the right cookie.
    const page = await fetch(auth, { redirect: "manual" });
    const consent = page.headers.get("set-cookie")!.split(";")[0]!;
    const pid = (await page.text()).match(/name="id" value="([^"]+)"/)![1]!;
    const skipped = await fetch(`${base}/oauth/google/callback?code=gcode&state=${pid}`, { redirect: "manual", headers: { cookie: consent } });
    expect(skipped.status).toBe(400);
    expect(await skipped.text()).toContain("wasn't approved");

    // Cancel goes back to the app with access_denied, and the request is gone.
    const { g: denied } = await approve(auth, "deny");
    expect(denied.origin + denied.pathname).toBe(evil);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("state")).toBe("s1");

    // A known AI app gets no warning.
    const ok = await (await fetch(`${base}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude", token_endpoint_auth_method: "none" }),
    })).json();
    auth.search = new URLSearchParams({ client_id: ok.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code",
      code_challenge: "x".repeat(43), code_challenge_method: "S256", scope: "ads" }).toString();
    expect(await (await fetch(auth)).text()).not.toContain("Unrecognized address");
  });

  it("lists tools", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = (await res.json()).result.tools;
    // Recorded as the tool set this user's app now holds (the admin's "tool list").
    await new Promise((r) => setTimeout(r, 20));  // written on the response's finish
    expect(db.prepare("SELECT version FROM client_tools").all()).toEqual([{ version: SERVER_VERSION }]);
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["list_accounts", "account_overview", "keyword_ideas", "keyword_metrics", "propose_changes", "apply_changes", "undo_changes"]));
    // The AI sees what each change field means, and never the undo-only change type.
    expectToolBudget(tools, { total: 72_000, perTool: 6_000, except: { propose_changes: 40_000 } });
    const propose = JSON.stringify(tools.find((t: any) => t.name === "propose_changes").inputSchema);
    expect(propose).toContain("not micros");
    expect(propose).toContain("campaign_id from account_overview");
    expect(propose).not.toContain("remove_negative_keywords");
    // Directory listings read the human-readable name from annotations.title, and need the safety hints.
    for (const t of tools) {
      expect(t.annotations?.title, t.name).toBe(t.title);
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      if (!t.annotations.readOnlyHint) expect(typeof t.annotations.destructiveHint, t.name).toBe("boolean");
    }
  });

  it("looks fields up in Google's catalog, and names the real ones when Google rejects a guessed field", async () => {
    // gaql_fields is unlisted but still answers, for apps that hold it: a failed call would count against the listings.
    const f = await call(token, "gaql_fields", { resource: "campaign", search: "cpc_bid_ceiling" });
    expect(f.json.fields.names.join(" ")).toContain("campaign.target_spend.cpc_bid_ceiling_micros");
    const listed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = (await listed.json()).result.tools.map((t: any) => t.name);
    expect(names).toContain("run_gaql");
    expect(names).not.toContain("gaql_fields");
    expect(await (await fetch(`${base}/tools`)).text()).not.toContain("gaql_fields");

    // The lookup every app has: run_gaql with no FROM (or FROM google_ads_field) reads the catalog, as Google shapes it.
    const look = await call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT name, selectable_with FROM google_ads_field WHERE name = 'segments.search_term'" });
    expect(ads.fieldQueries.at(-1)).toBe("SELECT name, selectable_with WHERE name = 'segments.search_term'");
    expect(look.json.field_lookup).toBeDefined();
    expect(look.json.rows[0].resourceName).toBeUndefined();
    expect(look.json.rows[0].selectableWith).toHaveLength(501);
    expect(look.json.rows[0].selectableWith.at(-1)).toBe("… 150 more not shown");
    // A bad lookup gets the lookup's columns, not run_gaql's fixes for account queries (seen on dev, 2026-10-16).
    const wrong = await call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT name, bogus_column WHERE name = 'campaign.id'" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("UNRECOGNIZED_FIELD Unrecognized field in the query: 'bogus_column'.");
    expect(wrong.text).not.toContain("prefixed with their resource");
    expect(wrong.text).toContain("A query with no FROM is a field lookup, which selects from: name, category");
    expect(wrong.text).toContain("To read the account instead, add FROM");
    // Only a rejected lookup (400) gets that: a quota or server error isn't a syntax problem.
    const busy = await call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT name WHERE name = 'quota'" });
    expect(busy.isError).toBe(true);
    expect(busy.text).not.toContain("field lookup");

    const bad = await call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT campaign.id, campaign.maximize_clicks.cpc_bid_ceiling_micros FROM campaign" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("UNRECOGNIZED_FIELD");   // Google's own words stay
    expect(bad.text).toContain("Google's field catalog: campaign.maximize_clicks.cpc_bid_ceiling_micros doesn't exist");
    expect(bad.text).toContain("campaign.target_spend.cpc_bid_ceiling_micros");
    // The same error a third time in a row (the quota error above broke the run): the model gets the feedback link to pass on, once.
    expect(bad.text).not.toContain("/feedback");
    const again = () => call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT campaign.id, campaign.maximize_clicks.cpc_bid_ceiling_micros FROM campaign" });
    expect((await again()).text).not.toContain("/feedback");
    expect((await again()).text).toContain("/feedback, saying what they were trying to get");
    expect((await again()).text).not.toContain("/feedback");
  });

  it("reads an account overview", async () => {
    const r = await call(token, "account_overview", { customer_id: "111-222-3333", days: 30 });
    expect(r.isError).toBe(false);
    expect(r.json.campaigns.length).toBeGreaterThan(0);
  });

  it("remembers the time zone of the account they work on, for lifecycle email timing", async () => {
    await call(token, "account_overview", { customer_id: "111-222-3333", days: 30 });
    expect(db.prepare("SELECT DISTINCT time_zone tz FROM users WHERE enc_refresh IS NOT NULL").all()).toEqual([{ tz: "Europe/London" }]);
  });

  it("records how many accounts the login can reach, for the admin's used-of-visible", async () => {
    await call(token, "list_accounts");
    expect(db.prepare("SELECT DISTINCT ads_accounts a, ads_managers m, ads_manager_ids ids FROM users WHERE enc_refresh IS NOT NULL AND ads_accounts_at IS NOT NULL").all())
      .toEqual([{ a: 1, m: 0, ids: "[]" }]);
  });

  it("lists clients of a manager nested under another manager", async () => {
    const realList = ads.listAccessibleCustomers.bind(ads), realSearch = ads.search.bind(ads);
    // Google's customer_client: the root manager 9990001111, a sub-manager 9990002222 under it, and its client 2223334444.
    const tree = [
      { id: "9990001111", descriptiveName: "Agency", manager: true, level: 0 },
      { id: "9990002222", descriptiveName: "Agency East", manager: true, level: 1 },
      { id: "2223334444", descriptiveName: "Beta", manager: false, level: 2 },
    ];
    ads.listAccessibleCustomers = async () => ["9990001111"];
    ads.search = async (cid: string, q: string) => {
      if (!q.includes("FROM customer_client")) return realSearch(cid, q);
      const max = /level <= (\d+)/.exec(q)?.[1];
      return tree.filter((c) => max === undefined || c.level <= Number(max)).map((c) => ({ customerClient: { ...c, currencyCode: "USD", status: "ENABLED" } }));
    };
    try {
      const { accounts } = (await call(token, "list_accounts")).json as { accounts: { customerId: string; loginCustomerId: string | null }[] };
      expect(accounts.find((a) => a.customerId === "2223334444")).toMatchObject({ loginCustomerId: "9990001111" });
      expect(db.prepare("SELECT DISTINCT ads_accounts a, ads_managers m FROM users WHERE enc_refresh IS NOT NULL AND ads_accounts_at IS NOT NULL").all())
        .toEqual([{ a: 1, m: 2 }]);
    } finally {
      ads.listAccessibleCustomers = realList;
      ads.search = realSearch;
      await call(token, "list_accounts");  // back to the usual one account for the tests after
    }
  });

  it("lists accounts once across requests, not once per tool call", async () => {
    const real = ads.listAccessibleCustomers.bind(ads);
    let lists = 0;
    ads.listAccessibleCustomers = async () => { lists++; return real(); };
    await call(token, "list_accounts");
    for (let i = 0; i < 3; i++) expect((await call(token, "account_overview", { customer_id: "111-222-3333", days: 30 })).isError).toBe(false);
    ads.listAccessibleCustomers = real;
    expect(lists).toBe(1);
  });

  it("serves 2026-07-28 clients: server/discover, then a tool call bound to the caller", async () => {
    const before = (db.prepare("SELECT COUNT(*) n FROM tool_calls").get() as any).n;
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const modern = (method: string, params: { name?: string; arguments?: object } = {}, auth = token) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
        ...("name" in params ? { "Mcp-Name": String(params.name) } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: meta } }),
    });
    expect((await modern("server/discover", {}, "bogus")).status).toBe(401);
    const disc = await modern("server/discover");
    const discovered = await disc.json();
    expect(disc.status, JSON.stringify(discovered)).toBe(200);
    expect(discovered.result.supportedVersions).toContain("2026-07-28");
    const res = await modern("tools/call", { name: "account_overview", arguments: { customer_id: "111-222-3333", days: 30 } });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0].text).campaigns.length).toBeGreaterThan(0);
    const row = db.prepare("SELECT * FROM tool_calls ORDER BY id DESC LIMIT 1").get() as any;
    expect((db.prepare("SELECT COUNT(*) n FROM tool_calls").get() as any).n).toBe(before + 1);
    expect(row).toMatchObject({ tool: "account_overview", ok: 1 });
    expect(row.user_id).toBeTruthy();
    expect(row.client_id).toBeTruthy();
  });

  it("proposes without writing, applies, and undoes", async () => {
    const p = await call(token, "propose_changes", { customer_id: "1112223333", changes: [
      { type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "free", match_type: "PHRASE" }] },
      { type: "pause_keyword", ad_group_id: "5", criterion_id: "7" },
    ] });
    expect(p.isError).toBe(false);
    expect(p.json.summary).toContain('"free"');
    expect(ads.mutations.every((m) => m.validateOnly)).toBe(true);
    expect(ads.negatives).toHaveLength(0);

    const a = await call(token, "apply_changes", { proposal_id: p.json.proposal_id });
    expect(a.json.status).toBe("applied");
    expect(ads.negatives.map((n) => n.text)).toEqual(["free"]);
    expect(ads.kwStatus).toBe("PAUSED");

    const again = await call(token, "apply_changes", { proposal_id: p.json.proposal_id });
    expect(again.isError).toBe(false);  // a repeat apply answers with the first one's results and writes nothing
    expect(again.json.status).toBe("applied");
    expect(again.json.note).toContain("Already applied");
    expect(again.json.results).toEqual(a.json.results);
    expect(ads.negatives).toHaveLength(1);

    const u = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    expect(u.json.summary).toContain("Enable keyword");
    expect(u.json.summary).toContain('Remove 1 negative keyword(s) previously added to campaign "Search"');
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.negatives).toHaveLength(0);
    expect(ads.kwStatus).toBe("ENABLED");

    const h = await call(token, "change_history", {});
    expect(h.json.map((x: any) => x.status)).toEqual(["applied", "applied"]);
  });

  it("covers 1 account on Free with unlimited changes, asks to upgrade on a second; undo is never gated", async () => {
    const negative = async (text: string) => {
      const p = await call(token, "propose_changes", { customer_id: "1112223333",
        changes: [{ type: "add_negative_keywords", campaign_id: "10", keywords: [{ text, match_type: "PHRASE" }] }] });
      return p.json.proposal_id as string;
    };
    // The account already in use takes any number of changes.
    for (const t of ["jobs", "login", "how to"]) expect((await call(token, "apply_changes", { proposal_id: await negative(t) })).json.status).toBe("applied");
    const third = (await call(token, "change_history", {})).json[0].proposal_id as string;

    // This month's switch is already used (2223334444, five days ago), so a third account is refused before
    // any Google call, with a personal upgrade link.
    const uid = (db.prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get() as { id: string }).id;
    const switched = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, ?, 'account_overview', '2223334444', 1, 1, 1)")
      .run(Math.floor(Date.now() / 1000) - 5 * 86400, uid).lastInsertRowid;
    const blocked = await call(token, "account_overview", { customer_id: "999-888-7777", days: 30 });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("Plan limit:");
    expect(blocked.text).toContain("2 Google Ads accounts in the last 30 days (1112223333, 2223334444)");
    expect(blocked.text).toContain("1 at a time (active: 1112223333), with one switch per 30 days, already used");
    const link = blocked.text.match(/https?:\/\/\S+\/upgrade\?t=[\w.-]+/)![0];
    // The refusal is structured: facts as fields, no instructions to the assistant.
    const limit = JSON.parse(blocked.text.slice(blocked.text.indexOf("\n") + 1));
    expect(limit).toMatchObject({ error: "plan_limit", plan: "free", accounts_in_use: ["1112223333", "2223334444"], active_accounts: ["1112223333"], accounts_included: 1,
      refused_account: "9998887777", upgrade: { plan: "pro", accounts_included: 5 } });
    expect(limit.upgrade.upgrade_url).toBe(link);
    expect(blocked.text).not.toMatch(/word for word|Show the user/i);

    // ChatGPT connections (known by their chatgpt.com redirect) get the same limit with no plan pitch or checkout link:
    // its plugin guidelines bar promoting upgrades. The one link is /plans, which its guidelines allow (facts only).
    const clientId = (db.prepare("SELECT client_id FROM tool_calls WHERE client_id IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { client_id: string }).client_id;
    const info = (db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as { info: string }).info;
    db.prepare("UPDATE clients SET info = ? WHERE client_id = ?")
      .run(JSON.stringify({ ...JSON.parse(info), redirect_uris: ["https://chatgpt.com/connector/oauth/abc"] }), clientId);
    const gpt = await call(token, "account_overview", { customer_id: "999-888-7777", days: 30 });
    expect(gpt.text).toContain("Plan limit:");
    expect(gpt.text).toContain("More accounts at a time need a different plan.");
    expect(gpt.text).not.toMatch(/upgrade|\bPro\b|\$|pricing/i);
    expect(gpt.text).toContain(`"plans_page": "${base}/plans"`);
    const gptPlan = await call(token, "billing", {});
    expect(gptPlan.json).toMatchObject({ plan: "free", accounts_included: 1, plans_page: `${base}/plans` });
    expect(JSON.stringify(gptPlan.json).replaceAll(`${base}/plans`, "")).not.toMatch(/upgrade|\bPro\b|\$|account_page|https?:/i);
    // The page it links to describes plans and starts nothing: no upgrade buttons, no checkout links.
    const plansHtml = await (await fetch(`${base}/plans`)).text();
    expect(plansHtml).toContain("<h2>Pro · $15/month</h2>");
    expect(plansHtml).not.toMatch(/upgrade=|\/checkout|Upgrade to/i);
    const list = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
    const billingTool = (await list.json()).result.tools.find((t: { name: string }) => t.name === "billing");
    expect(billingTool.description).not.toMatch(/upgrade|\bPro\b/i);
    db.prepare("UPDATE clients SET info = ? WHERE client_id = ?").run(info, clientId);
    // A refused call doesn't count as use, and the demo never counts.
    expect((await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).isError).toBe(false);

    // Undo still works.
    const u = await call(token, "undo_changes", { proposal_id: third });
    expect((await call(token, "apply_changes", { proposal_id: u.json.proposal_id })).json.status).toBe("applied");

    const plan = await call(token, "billing", {});
    expect(plan.json).toMatchObject({ plan: "free", accounts_in_use: ["1112223333", "2223334444"], accounts_included: 1, window_days: 30 });
    expect(plan.json.upgrade_url).toContain("/upgrade?t=");

    // A tampered link is refused; the real one goes to Stripe Checkout as a subscription for this user.
    expect((await fetch(link.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { redirect: "manual" })).status).toBe(400);
    const go = await fetch(link, { redirect: "manual" });
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toContain("checkout.stripe.com");
    const form = stripe.checkouts.at(-1)!;
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer_email")).toBe("owner@example.com");

    // Paid, but closed the tab before /upgraded: the gate asks Stripe first, so the very next call gets through.
    expect(db.prepare("SELECT plan FROM users WHERE email = 'owner@example.com'").get()).toEqual({ plan: "free" });
    const paidNoTab = await call(token, "account_overview", { customer_id: "999-888-7777", days: 30 });
    expect(paidNoTab.text).not.toContain("Plan limit:");  // past the gate; this login just can't read that account
    expect(db.prepare("SELECT plan FROM users WHERE email = 'owner@example.com'").get()).toEqual({ plan: "pro" });
    db.prepare("DELETE FROM tool_calls WHERE id = ?").run(switched);

    // /upgraded is still fine afterwards (settling is idempotent).
    const done = await fetch(`${base}/upgraded?session_id=cs_test_1`);
    expect(done.status).toBe(200);
    const doneHtml = await done.text();
    expect(doneHtml).toContain("on Camberstack Pro");
    expect(doneHtml).toContain('href="/account"');
    expect(doneHtml).toContain("up to 5 Google Ads accounts");

    const pro = await call(token, "billing", {});
    expect(pro.json.plan).toBe("pro");
    const portal = await fetch(pro.json.manage_billing, { redirect: "manual" });
    expect(portal.headers.get("location")).toContain("billing.stripe.com");
    expect(stripe.portalReturn).toBe(`${base}/account`);

    // Cancelled at period end: the hourly sweep drops the plan back to free.
    stripe.subStatus = "canceled";
    await billing.sweep();
    expect((await call(token, "billing", {})).json.plan).toBe("free");
    // Reloading the old /upgraded link doesn't bring Pro back.
    expect((await fetch(`${base}/upgraded?session_id=cs_test_1`)).status).toBe(400);
    expect((await call(token, "billing", {})).json.plan).toBe("free");
    // A completed checkout for a cancelled subscription never makes anyone Pro again, sweep after sweep.
    db.prepare("UPDATE users SET stripe_sub = NULL").run();
    await billing.sweep();
    expect((await call(token, "billing", {})).json.plan).toBe("free");
    // Not re-linked at all (the old sweep re-linked, then downgraded in the same pass: right result, wrong path).
    expect(db.prepare("SELECT count(*) n FROM users WHERE stripe_sub IS NOT NULL").get()).toEqual({ n: 0 });

    // One subscription Stripe has lost and one it fails to answer for: neither stops the sweep. The lost one ends Pro;
    // the failed one keeps Pro until Stripe answers.
    const add = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, stripe_sub) VALUES (?, ?, ?, 'pro', 0, ?)");
    add.run("u_flaky", "sub-flaky", "flaky@example.com", "sub_flaky");
    add.run("u_gone", "sub-gone", "gone@example.com", "sub_gone");
    await billing.sweep();
    const plans = db.prepare("SELECT id, plan FROM users WHERE id IN ('u_flaky', 'u_gone') ORDER BY id").all();
    expect(plans).toEqual([{ id: "u_flaky", plan: "pro" }, { id: "u_gone", plan: "free" }]);
    db.prepare("DELETE FROM users WHERE id IN ('u_flaky', 'u_gone')").run();
  });

  it("refuses to apply a proposal that doesn't exist or isn't the user's", async () => {
    const r = await call(token, "apply_changes", { proposal_id: "p_nope" });
    expect(r.isError).toBe(true);
  });

  it("applies a proposal once when the client sends apply twice at the same time", async () => {
    const p = await call(token, "propose_changes", { customer_id: "1112223333", changes: [
      { type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "twice", match_type: "PHRASE" }] }] });
    const writes = () => ads.mutations.filter((m) => !m.validateOnly).length;
    const before = writes();
    // A slow Google, so the second call arrives while the first is still re-reading the account.
    const realSearch = ads.search.bind(ads);
    ads.search = async (cid: string, q: string) => { await new Promise((r) => setTimeout(r, 50)); return realSearch(cid, q); };
    const [a, b] = await Promise.all([1, 2].map(() => call(token, "apply_changes", { proposal_id: p.json.proposal_id })))
      .finally(() => { ads.search = realSearch; });
    expect([a, b].filter((r) => !r.isError).map((r) => r.json.status)).toEqual(["applied"]);
    expect([a, b].find((r) => r.isError)!.text).toMatch(/already (being )?applied/);
    expect(writes()).toBe(before + 1);
    expect(ads.negatives.filter((n) => n.text === "twice")).toHaveLength(1);
    // The undo still knows what to remove: the losing call didn't overwrite the result.
    const u = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    expect(u.json.summary).toContain("Remove 1 negative keyword(s)");
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.negatives.filter((n) => n.text === "twice")).toHaveLength(0);
  });

  it("applies all of a proposal or none of it", async () => {
    const writes = () => ads.mutations.filter((m) => !m.validateOnly).length;
    const propose = async (text: string) => (await call(token, "propose_changes", { customer_id: "1112223333", changes: [
      { type: "pause_keyword", ad_group_id: "5", criterion_id: "7" },
      { type: "add_negative_keywords", campaign_id: "10", keywords: [{ text, match_type: "PHRASE" }] }] })).json.proposal_id as string;

    // Google would refuse the second change: checked before writing, so the first isn't written either.
    const p1 = await propose("refused-at-check");
    ads.failOn = { text: "refused-at-check" };
    const before = writes();
    const a1 = (await call(token, "apply_changes", { proposal_id: p1 })).json;
    ads.failOn = undefined;
    expect(a1).toMatchObject({ status: "failed", note: "Nothing was changed." });
    expect(a1.results[1].error).toContain("refused-at-check");
    expect(a1.results[0].error).toContain("another change in this proposal would fail");
    expect(writes()).toBe(before);
    expect(ads.kwStatus).toBe("ENABLED");

    // It passes the check but the write fails: the pause before it is rolled back.
    const p2 = await propose("refused-at-write");
    ads.failOn = { text: "refused-at-write", writesOnly: true };
    const a2 = (await call(token, "apply_changes", { proposal_id: p2 })).json;
    ads.failOn = undefined;
    expect(a2.status).toBe("failed");
    expect(a2.note).toContain("rolled back");
    expect(a2.results.map((r: any) => r.error)).toEqual(["rolled back", expect.stringContaining("refused-at-write")]);
    expect(ads.kwStatus).toBe("ENABLED");
    expect(ads.negatives.some((n) => n.text === "refused-at-write")).toBe(false);
    expect((await call(token, "undo_changes", { proposal_id: p2 })).text).toContain("Only applied proposals");
  });

  it("retakes an apply a dead server left behind, unless re-running could duplicate an ad", async () => {
    const neg = (await call(token, "propose_changes", { customer_id: "1112223333", changes: [
      { type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "interrupted", match_type: "PHRASE" }] }] })).json.proposal_id;
    const ad = (await call(token, "propose_changes", { customer_id: "1112223333", changes: [{ type: "add_responsive_search_ad", ad_group_id: "5",
      ad: { headlines: ["One", "Two", "Three"], descriptions: ["First line.", "Second line."], final_url: "https://example.com/" } }] }));
    if (ad.isError) throw new Error(ad.text);
    const claim = db.prepare("UPDATE proposals SET applied_at = ? WHERE id = ?");
    const t = Math.floor(Date.now() / 1000);
    claim.run(t - 60, neg);
    expect((await call(token, "apply_changes", { proposal_id: neg })).text).toContain("already being applied");
    claim.run(t - 11 * 60, neg);
    expect((await call(token, "apply_changes", { proposal_id: neg })).json.status).toBe("applied");
    claim.run(t - 11 * 60, ad.json.proposal_id);
    expect((await call(token, "apply_changes", { proposal_id: ad.json.proposal_id })).text).toContain("interrupted while applying");
    await call(token, "apply_changes", { proposal_id: (await call(token, "undo_changes", { proposal_id: neg })).json.proposal_id });
  });

  it("adds Google Analytics to a connection through a personal link, for the same Google account only", async () => {
    // Not granted: the demo property, and a personal link to add Analytics.
    const before = (await call(token, "analytics_properties")).json;
    expect(before.properties[0].property_id).toBe("000000001");
    expect(before.not_granted).toContain("isn't part of this Google connection");
    const link: string = before.grant_url;
    expect(link).toContain("/connect/analytics?t=");
    expect((await fetch(link.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { redirect: "manual" })).status).toBe(400);

    const start = async () => {
      const go = await fetch(link, { redirect: "manual" });
      const g = new URL(go.headers.get("location")!);
      return { g, state: g.searchParams.get("state")!, cookie: go.headers.get("set-cookie")!.split(";")[0]! };
    };
    const back = (s: { state: string }, cookie?: string) =>
      fetch(`${base}/oauth/google/callback?code=gcode&state=${s.state}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const first = await start();
    // Only Analytics is asked for, added to what was granted before, for the account already connected.
    expect(first.g.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/analytics.edit");
    expect(first.g.searchParams.get("include_granted_scopes")).toBe("true");
    expect(first.g.searchParams.get("login_hint")).toBe("owner@example.com");

    googleGrant.scope += " https://www.googleapis.com/auth/analytics.readonly";
    googleGrant.refresh = "g-refresh-with-analytics";
    try {
      // From another browser (no cookie): refused, nothing stored.
      expect((await back(first)).status).toBe(400);
      // A different Google account: refused.
      const other = await start();
      googleUser.sub = "someone-else";
      const wrong = await back(other, other.cookie);
      googleUser.sub = "google-sub-1";
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain("different Google account");
      expect((await call(token, "analytics_properties")).json.not_granted).toBeTruthy();

      const ok = await start();
      const done = await back(ok, ok.cookie);
      expect(done.status).toBe(200);
      expect(await done.text()).toContain("Google Analytics is now part of your Camberstack connection");
      expect((await call(token, "analytics_properties")).json.properties).toEqual([{ property_id: "321", name: "Example", account: "Example Inc", account_id: "77" }]);
    } finally {
      googleGrant.scope = googleGrant.scope.replace(" https://www.googleapis.com/auth/analytics.readonly", "");
      googleGrant.refresh = "g-refresh";
    }
  });

  it("proposes, applies and undoes Google Analytics setup changes, all or nothing", async () => {
    // Runs after the grant above, so this connection has Google Analytics.
    const p = await call(token, "propose_analytics_changes", { changes: [
      { type: "mark_key_event", property_id: "321", event_name: "generate_lead", counting: "ONCE_PER_SESSION" },
      { type: "link_google_ads", property_id: "321", customer_id: "111-222-3333" }] });
    if (p.isError) throw new Error(p.text);
    expect(p.json.summary).toContain('Mark "generate_lead" as a key event in GA4 property "Example" (counted once per session)');
    expect(p.json.summary).toContain("import it there once this is applied (the import_ga4_key_event change");
    expect(p.json.summary).toContain('Link GA4 property "Example" to Google Ads account 111-222-3333');
    expect(ga.keyEvents).toHaveLength(0);  // proposing writes nothing

    expect((await call(token, "apply_changes", { proposal_id: p.json.proposal_id })).json.status).toBe("applied");
    expect(ga.keyEvents.map((k) => [k.eventName, k.countingMethod])).toEqual([["generate_lead", "ONCE_PER_SESSION"]]);
    expect(ga.links.map((l) => l.customerId)).toEqual(["1112223333"]);
    const again = await call(token, "propose_analytics_changes", { changes: [{ type: "mark_key_event", property_id: "321", event_name: "generate_lead" }] });
    expect(again.text).toContain("already in place");

    const setup = (await call(token, "analytics_setup", { property_id: "321" }));
    expect(setup.isError).toBe(true);  // the fake has no data streams; analytics_setup itself is covered in ga4.test.ts

    const u = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    expect(u.json.summary).toContain('Unlink GA4 property "Example" from Google Ads account 111-222-3333');
    expect(u.json.summary).toContain('Stop counting "generate_lead" as a key event');
    expect((await call(token, "apply_changes", { proposal_id: u.json.proposal_id })).json.status).toBe("applied");
    expect([ga.keyEvents.length, ga.links.length]).toEqual([0, 0]);

    // An Ads account this login can't reach is refused when proposing, since GA4 has no dry run.
    const unreachable = await call(token, "propose_analytics_changes", { changes: [{ type: "link_google_ads", property_id: "321", customer_id: "123-456-7890" }] });
    expect(unreachable.text).toContain("isn't one this login can reach");

    // The link fails at write: the key event marked before it is rolled back.
    const p2 = await call(token, "propose_analytics_changes", { changes: [
      { type: "mark_key_event", property_id: "321", event_name: "sign_up" },
      { type: "link_google_ads", property_id: "321", customer_id: "111-222-3333" }] });
    ga.failOn = "googleAdsLinks";
    const a2 = (await call(token, "apply_changes", { proposal_id: p2.json.proposal_id })).json;
    ga.failOn = "";
    expect(a2.status).toBe("failed");
    expect(a2.results.map((r: any) => r.error)).toEqual(["rolled back", expect.stringContaining("refused googleAdsLinks")]);
    expect(ga.keyEvents).toHaveLength(0);

    // A brief outage on a delete is retried; on a create it isn't (Google may have made it), so that apply fails cleanly.
    const p3 = await call(token, "propose_analytics_changes", { changes: [{ type: "mark_key_event", property_id: "321", event_name: "purchase" }] });
    ga.flaky = { method: "POST", times: 1 };
    expect((await call(token, "apply_changes", { proposal_id: p3.json.proposal_id })).json.status).toBe("failed");
    const p4 = await call(token, "propose_analytics_changes", { changes: [{ type: "mark_key_event", property_id: "321", event_name: "purchase" }] });
    await call(token, "apply_changes", { proposal_id: p4.json.proposal_id });
    const u4 = await call(token, "undo_changes", { proposal_id: p4.json.proposal_id });
    ga.flaky = { method: "DELETE", times: 1 };
    expect((await call(token, "apply_changes", { proposal_id: u4.json.proposal_id })).json.status).toBe("applied");
    expect(ga.keyEvents).toHaveLength(0);

    // A built-in key event (purchase) can't be deleted: refused when proposing, not by a rollback at apply.
    ga.keyEvents.push({ name: "properties/321/keyEvents/9", eventName: "purchase", countingMethod: "ONCE_PER_EVENT" });
    const builtIn = await call(token, "propose_analytics_changes", { changes: [
      { type: "mark_key_event", property_id: "321", event_name: "sign_up" },
      { type: "unmark_key_event", property_id: "321", event_name: "purchase" }] });
    expect(builtIn.isError).toBe(true);
    expect(builtIn.text).toContain("built-in key event");
    ga.keyEvents = [];

    const h = (await call(token, "change_history", { customer_id: "ga4" })).json;
    expect(h[0].customer_id).toBe("ga4");
  });

  it("gives ChatGPT one propose tool per operation, with the same proposals, apply and undo", async () => {
    // ChatGPT's plugin guidelines: each model-callable operation is its own tool, not one picked by a `type` field.
    const clientId = (db.prepare("SELECT client_id FROM tool_calls WHERE client_id IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { client_id: string }).client_id;
    const info = (db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as { info: string }).info;
    db.prepare("UPDATE clients SET info = ? WHERE client_id = ?")
      .run(JSON.stringify({ ...JSON.parse(info), redirect_uris: ["https://chatgpt.com/connector/oauth/abc"] }), clientId);
    try {
      const listed = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
      const tools = (await listed.json()).result.tools as { name: string; description: string; inputSchema: { properties: Record<string, unknown> }; annotations: Record<string, unknown> }[];
      const names = tools.map((t) => t.name);
      expectToolBudget(tools, { total: 90_000, perTool: 6_000 });
      expect(names).not.toContain("propose_changes");
      expect(names).not.toContain("propose_analytics_changes");
      expect(names).not.toContain("undo_changes");
      for (const n of ["propose_pause_campaign", "propose_create_performance_max_campaign", "propose_set_conversion_counting",
        "propose_link_google_ads", "propose_create_ga4_property", "propose_undo", "apply_changes"]) expect(names).toContain(n);
      expect(names.filter((n) => n.startsWith("propose_"))).toHaveLength(PUBLIC_CHANGES.length + PUBLIC_GA_CHANGES.length + 1);
      for (const t of tools.filter((t) => t.name.startsWith("propose_"))) {
        expect(t.description, t.name).not.toMatch(/undefined|propose_changes|undo_changes/);
        expect(t.inputSchema.properties, t.name).not.toHaveProperty("type");
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
      }
      // The Ads account a GA4 link names isn't logged as Google Ads use: it is ads_customer_id, not customer_id.
      expect(tools.find((t) => t.name === "propose_link_google_ads")!.inputSchema.properties).toHaveProperty("ads_customer_id");

      const p = await call(token, "propose_pause_keyword", { customer_id: "111-222-3333", ad_group_id: "5", criterion_id: "7" });
      if (p.isError) throw new Error(p.text);
      expect(p.json.summary).toContain("Pause keyword");
      const a = await call(token, "apply_changes", { proposal_id: p.json.proposal_id });
      expect(a.json.status).toBe("applied");
      expect(a.json.undo).toContain("call propose_undo with proposal_id");
      expect(ads.kwStatus).toBe("PAUSED");
      const u = await call(token, "propose_undo", { proposal_id: p.json.proposal_id });
      expect((await call(token, "apply_changes", { proposal_id: u.json.proposal_id })).json.status).toBe("applied");
      expect(ads.kwStatus).toBe("ENABLED");

      const before = (db.prepare("SELECT count(*) n FROM tool_calls WHERE customer_id = '1112223333'").get() as { n: number }).n;
      const g = await call(token, "propose_link_google_ads", { property_id: "321", ads_customer_id: "111-222-3333" });
      if (g.isError) throw new Error(g.text);
      expect(g.json.summary).toContain('Link GA4 property "Example" to Google Ads account 111-222-3333');
      expect((db.prepare("SELECT count(*) n FROM tool_calls WHERE customer_id = '1112223333'").get() as { n: number }).n).toBe(before);
      await call(token, "discard_proposal", { proposal_id: g.json.proposal_id });
    } finally {
      db.prepare("UPDATE clients SET info = ? WHERE client_id = ?").run(info, clientId);
    }
  });

  it("undoes a change only once", async () => {
    const p = await call(token, "propose_changes", { customer_id: "1112223333", changes: [{ type: "pause_campaign", campaign_id: "10" }] });
    await call(token, "apply_changes", { proposal_id: p.json.proposal_id });
    // Two undo proposals made before either is applied: the second can't run once the first has.
    const u1 = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    const u2 = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    expect((await call(token, "apply_changes", { proposal_id: u1.json.proposal_id })).json.status).toBe("applied");
    const again = await call(token, "apply_changes", { proposal_id: u2.json.proposal_id });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already been undone");
    const third = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("already been undone");
    expect(ads.campaignStatus).toBe("ENABLED");
  });

  it("keeps the demo's statuses through bid, suffix and location-mode changes", async () => {
    const p = await call(token, "propose_changes", { customer_id: "0000000001", changes: [
      { type: "set_keyword_bid", ad_group_id: "3005", criterion_id: "4009", max_cpc: 3.5 },
      { type: "set_ad_group_bid", ad_group_id: "3005", max_cpc: 2.5 },
      { type: "set_url_suffix", campaign_id: "2003", suffix: "utm_source=google" },
      { type: "set_location_mode", campaign_id: "2003", presence_only: true },
      { type: "add_campaign_targeting", campaign_id: "2003", location_ids: ["2826"] },
    ] });
    if (p.isError) throw new Error(p.text);
    const a = (await call(token, "apply_changes", { proposal_id: p.json.proposal_id })).json;
    expect(a.status).toBe("applied");
    const q = (query: string) => call(token, "run_gaql", { customer_id: "0000000001", query });
    const camp = (await q("SELECT campaign.status FROM campaign WHERE campaign.id = 2003")).json.rows[0].campaign;
    const ag = (await q("SELECT ad_group.status FROM ad_group WHERE ad_group.id = 3005")).json.rows[0].adGroup;
    const kw = (await q("SELECT ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.criterion_id = 4009")).json.rows[0].adGroupCriterion;
    expect([camp.status, ag.status, kw.status]).toEqual(["ENABLED", "ENABLED", "ENABLED"]);
    const bids = async () => (await q("SELECT ad_group.cpc_bid_micros, ad_group_criterion.cpc_bid_micros FROM ad_group_criterion WHERE ad_group_criterion.criterion_id = 4009")).json.rows[0];
    expect(await bids()).toMatchObject({ adGroup: { cpcBidMicros: "2500000" }, adGroupCriterion: { cpcBidMicros: "3500000" } });
    const u = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    if (u.isError) throw new Error(u.text);
    expect((await call(token, "apply_changes", { proposal_id: u.json.proposal_id })).json.status).toBe("applied");
    const back = await bids();
    expect(back.adGroup.cpcBidMicros).toBe("2000000");
    expect(back.adGroupCriterion.cpcBidMicros).toBeUndefined();
  });

  it("heals demo state saved with a status wiped by an old bid change", async () => {
    const row = db.prepare("SELECT user_id, state FROM demo_state LIMIT 1").get() as { user_id: string; state: string };
    const s = JSON.parse(row.state);
    delete s.campaignStatus["2002"];
    db.prepare("UPDATE demo_state SET state = ? WHERE user_id = ?").run(JSON.stringify(s), row.user_id);
    const r = (await call(token, "run_gaql", { customer_id: "0000000001", query: "SELECT campaign.status FROM campaign WHERE campaign.id = 2002" })).json;
    expect(r.rows[0].campaign.status).toBe("ENABLED");
  });

  it("lets no more new accounts through than the plan allows when the AI calls them in parallel", async () => {
    const uid = (db.prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get() as { id: string }).id;
    const saved = db.prepare("SELECT * FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").all(uid);
    db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").run(uid);
    const realSearch = ads.search.bind(ads);
    ads.search = async (cid: string, q: string) => { await new Promise((r) => setTimeout(r, 50)); return realSearch(cid, q); };
    try {
      // Free takes one account plus one switch, so of three new accounts at once exactly one is refused.
      const all = await Promise.all(["111-222-3333", "999-888-7777", "888-777-6666"].map((c) => call(token, "switch_account", { customer_id: c })));
      expect(all.filter((r) => r.text.includes("Plan limit:"))).toHaveLength(1);
    } finally {
      ads.search = realSearch;
      db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").run(uid);
      const put = db.prepare("INSERT INTO tool_calls (id, at, user_id, client_id, tool, customer_id, ok, error, ms, bytes) VALUES (@id, @at, @user_id, @client_id, @tool, @customer_id, @ok, @error, @ms, @bytes)");
      for (const r of saved) put.run(r);
    }
  });

  it("lets Free switch accounts once a month, and keeps the most recent after a downgrade", async () => {
    const uid = (db.prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get() as { id: string }).id;
    // One account in use: a new one is the switch. The first call only says what spending it would lock, and uses nothing.
    const ask = await call(token, "account_overview", { customer_id: "222-333-4444", days: 30 });
    // Not an error: nothing failed, and errors count against the directory's reliability metrics.
    expect(ask.isError).toBe(false);
    expect(ask.text).not.toContain("Plan limit:");  // a notice, not a refusal: no limit_reached email
    const notice = ask.json;
    expect(notice.notice).toContain("Account switch: using 2223334444 spends this plan's one switch per 30 days. 1112223333 would lock until ");
    expect(notice).toMatchObject({ status: "switch_confirmation_needed", switch_to: "2223334444", locks_account: "1112223333",
      keep_both: { plan: "pro", accounts_included: 5 } });
    // Logged as ok with no account: the notice used nothing, so it neither counts as an error nor toward the plan.
    expect(db.prepare("SELECT tool, customer_id, ok, substr(error, 1, 15) e FROM tool_calls WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(uid))
      .toEqual({ tool: "account_overview", customer_id: null, ok: 1, e: "Account switch:" });
    expect(notice.keep_both.upgrade_url).toContain("/upgrade?t=");
    expect(notice.to_go_ahead).toContain("call switch_account with customer_id 2223334444");
    // A field lookup reads Google's catalog, not the account it names: no switch, and the account isn't logged as used.
    const look = await call(token, "run_gaql", { customer_id: "222-333-4444", query: "SELECT name, category WHERE name LIKE '%search_term%'" });
    expect(look.isError).toBe(false);
    expect(look.text).not.toContain("Account switch:");
    expect(db.prepare("SELECT tool, customer_id, ok, query_shape FROM tool_calls WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(uid))
      .toEqual({ tool: "run_gaql", customer_id: null, ok: 1, query_shape: "SELECT name, category WHERE name LIKE ?" });
    expect((db.prepare("SELECT count(*) n FROM tool_calls WHERE user_id = ? AND customer_id = '2223334444' AND ok = 1").get(uid) as { n: number }).n).toBe(0);
    // The account in use, the demo and the switch once confirmed all go through (this login just can't read 2223334444).
    expect((await call(token, "account_overview", { customer_id: "111-222-3333", days: 30 })).text).not.toContain("Account switch:");
    expect((await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).isError).toBe(false);
    // Spending the switch is its own write tool: no read tool takes a flag that changes the plan. It never spends the
    // switch on an account the login can't reach.
    const unreachable = await call(token, "switch_account", { customer_id: "222-333-4444" });
    expect(unreachable.isError).toBe(true);
    expect(unreachable.text).toContain("Nothing was spent");
    expect((db.prepare("SELECT count(*) n FROM tool_calls WHERE user_id = ? AND customer_id = '2223334444' AND ok = 1").get(uid) as { n: number }).n).toBe(0);
    const realSearch = ads.search.bind(ads);
    ads.search = async (cid: string, q: string) => q.includes("FROM customer_client")
      ? [...await realSearch(cid, q), { customerClient: { id: "2223334444", descriptiveName: "Beta", currencyCode: "USD", manager: false, level: 1 } }]
      : realSearch(cid, q);
    try {
      const sw = await call(token, "switch_account", { customer_id: "222-333-4444" });
      expect(sw.json).toMatchObject({ switched_to: "2223334444", active_accounts: ["2223334444"] });
      const after = await call(token, "account_overview", { customer_id: "222-333-4444", days: 30 });
      expect(after.text).not.toContain("Plan limit:");
      expect(after.text).not.toContain("Account switch:");
    } finally {
      ads.search = realSearch;
      db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id = '2223334444'").run(uid);
    }

    // As if they'd been on Pro: three accounts used, 2223334444 most recently. Free covers one, the switch is spent.
    const saved = db.prepare("SELECT * FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").all(uid);
    db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").run(uid);
    const t = Math.floor(Date.now() / 1000);
    const use = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, ?, 'account_overview', ?, 1, 1, 1)");
    use.run(t - 10 * 86400, uid, "1112223333");
    use.run(t - 3 * 86400, uid, "3334445555");
    use.run(t - 86400, uid, "2223334444");
    try {
      const blocked = await call(token, "switch_account", { customer_id: "111-222-3333" });
      expect(blocked.text).toContain("Plan limit:");
      // Switching back to an account used before: lead with Pro, then when it opens again.
      expect(blocked.text).toContain("Pro ($15/month) covers up to 5, so 1112223333 works right away. On Free, 1112223333 opens again on ");
      const limit = JSON.parse(blocked.text.slice(blocked.text.indexOf("\n") + 1));
      // The switch comes back when the second most recent account ages out of the window.
      const opens = new Date((t - 3 * 86400 + 30 * 86400) * 1000).toISOString().slice(0, 10);
      expect(limit).toMatchObject({ active_accounts: ["2223334444"], accounts_in_use: ["2223334444", "3334445555", "1112223333"] });
      expect(limit.switching).toContain(opens);

      const list = (await call(token, "list_accounts")).json;
      expect(list.accounts.find((a: any) => a.customerId === "1112223333").plan_status).toBe("locked");
      expect(list.plan).toMatchObject({ plan: "free", accounts_included: 1, active_accounts: ["2223334444"] });
      expect(list.plan.switching).toContain(opens);

      // A reset by hand: usage before plan_reset_at no longer counts, so the locked account is the only one in use.
      db.prepare("UPDATE users SET plan_reset_at = ? WHERE id = ?").run(t, uid);
      const back = await call(token, "account_overview", { customer_id: "111-222-3333", days: 30 });
      expect(back.text).not.toContain("Plan limit:");
      expect(back.text).not.toContain("Account switch:");
      expect((await call(token, "account_overview", { customer_id: "222-333-4444", days: 30 })).text).toContain("Account switch:");
    } finally {
      db.prepare("UPDATE users SET plan_reset_at = NULL WHERE id = ?").run(uid);
      db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").run(uid);
      // OR REPLACE: rows logged in the try reuse freed ids (no AUTOINCREMENT).
      const put = db.prepare("INSERT OR REPLACE INTO tool_calls (id, at, user_id, client_id, tool, customer_id, ok, error, ms, bytes) VALUES (@id, @at, @user_id, @client_id, @tool, @customer_id, @ok, @error, @ms, @bytes)");
      for (const r of saved) put.run(r);
    }
    // Back to normal: the one account in use is active, and a plan with nothing locked says nothing.
    const list = (await call(token, "list_accounts")).json;
    expect(list.plan).toBeUndefined();
    expect(list.accounts.find((a: any) => a.customerId === "1112223333").plan_status).toBe("active");
  });

  it("asks which account to start on when the login has more than the plan covers", async () => {
    const uid = (db.prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get() as { id: string }).id;
    const saved = db.prepare("SELECT * FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").all(uid);
    db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").run(uid);
    const fresh = token;
    // One account: nothing to choose.
    expect((await call(fresh, "list_accounts")).json.plan).toBeUndefined();
    const realSearch = ads.search.bind(ads);
    ads.search = async (cid: string, q: string) => q.includes("FROM customer_client")
      ? [...await realSearch(cid, q), { customerClient: { id: "2223334444", descriptiveName: "Beta", currencyCode: "USD", manager: false, level: 1 } }]
      : realSearch(cid, q);
    try {
      const list = (await call(fresh, "list_accounts")).json;
      expect(list.plan).toMatchObject({ plan: "free", accounts_included: 1, active_accounts: [] });
      expect(list.plan.choosing).toContain("ask the user which to work on");
      // Which accounts are live, so the user doesn't spend Free's one account on a dormant one; only the count is stored.
      expect(list.accounts.filter((a: any) => !a.manager).map((a: any) => [a.customerId, a.spentLast30Days]))
        .toEqual(expect.arrayContaining([["1112223333", true], ["2223334444", false]]));
      expect(db.prepare("SELECT ads_accounts, ads_active FROM users WHERE id = ?").get(uid)).toEqual({ ads_accounts: 2, ads_active: 1 });
      // An AI that goes ahead anyway, even on several at once, is stopped: none of them takes the plan, and nothing is spent.
      const since = (db.prepare("SELECT coalesce(max(id), 0) m FROM tool_calls").get() as { m: number }).m;
      const tries = await Promise.all(["111-222-3333", "222-333-4444"].map((c) => call(fresh, "account_overview", { customer_id: c, days: 30 })));
      for (const t of tries) {
        expect(t.isError).toBe(false);
        expect(t.json.notice).toContain("Account choice: this plan covers 1 Google Ads account at a time and this login has 2.");
        expect(t.json).toMatchObject({ status: "account_choice_needed", accounts_included: 1 });
        expect(t.json.accounts.map((a: any) => [a.customer_id, a.spent_last_30_days]).sort()).toEqual([["1112223333", true], ["2223334444", false]]);
        expect(t.json.note).toContain("may be dormant");
      }
      // Logged as ok with no account, and not as a switch notice, so no switch_wanted email.
      expect(db.prepare("SELECT count(*) n FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").get(uid)).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) n FROM tool_calls WHERE user_id = ? AND id > ? AND error LIKE 'Account choice:%' AND ok = 1").get(uid, since)).toEqual({ n: 2 });
      expect(db.prepare("SELECT count(*) n FROM tool_calls WHERE user_id = ? AND id > ? AND error LIKE 'Account switch:%'").get(uid, since)).toEqual({ n: 0 });
      // The demo never counts, so it stays open while choosing.
      expect((await call(fresh, "account_overview", { customer_id: "0000000001", days: 30 })).text).not.toContain("Account choice:");
      // The user picks: switch_account takes it without spending the switch, and the plan is full from there.
      const pick = await call(fresh, "switch_account", { customer_id: "111-222-3333" });
      expect(pick.json).toMatchObject({ switched_to: "1112223333", active_accounts: ["1112223333"] });
      const now = await call(fresh, "account_overview", { customer_id: "111-222-3333", days: 30 });
      expect(now.text).not.toContain("Account choice:");
      expect(now.text).not.toContain("Account switch:");
      // Another account now is the ordinary switch, which is still unspent.
      expect((await call(fresh, "account_overview", { customer_id: "222-333-4444", days: 30 })).text).toContain("Account switch:");
      // Once one is in use the plan is full, and list_accounts says what a switch would cost instead.
      const after = (await call(fresh, "list_accounts")).json;
      expect(after.plan.choosing).toBeUndefined();
      expect(after.plan.switching).toContain("One switch per 30 days");
    } finally {
      ads.search = realSearch;
      db.prepare("DELETE FROM tool_calls WHERE user_id = ? AND customer_id IS NOT NULL").run(uid);
      const put = db.prepare("INSERT OR REPLACE INTO tool_calls (id, at, user_id, client_id, tool, customer_id, ok, error, ms, bytes) VALUES (@id, @at, @user_id, @client_id, @tool, @customer_id, @ok, @error, @ms, @bytes)");
      for (const r of saved) put.run(r);
    }
  });

  it("surfaces Google's refusal instead of reporting no accounts", async () => {
    const realSearch = ads.search.bind(ads);
    ads.search = async (cid: string, q: string) => {
      if (q.includes("FROM customer_client")) throw new Error("Google Ads API 403: ACTION_NOT_PERMITTED The Google Cloud project is only approved for use with test accounts.");
      return realSearch(cid, q);
    };
    // list_accounts always reads Google, so the accounts cached by earlier tests don't apply.
    const fresh = await connect();
    const r = await call(fresh, "list_accounts");
    ads.search = realSearch;
    // Not a dead end: the demo account is offered, and Google's reason is still reported.
    expect(r.isError).toBe(false);
    expect(r.json.accounts.map((x: any) => x.customerId)).toEqual(["0000000001"]);
    expect(r.json.unreadable[0].error).toContain("ACTION_NOT_PERMITTED");
    expect(r.json.note).toContain("demo");
    // Demo-only must not read as "signed out": the note names who is signed in.
    expect(r.json.note).toMatch(/IS connected and signed in, as \S+@/);
    // A refusal isn't "no accounts": nothing is recorded for the admin's used-of-visible.
    expect(db.prepare("SELECT count(*) n FROM users WHERE ads_accounts_at IS NOT NULL AND ads_accounts = 0").get()).toEqual({ n: 0 });
  });

  it("gets Keyword Planner ideas and metrics without changing anything", async () => {
    const before = ads.mutations.length;
    const i = await call(token, "keyword_ideas", { customer_id: "111-222-3333", keywords: ["invoice"], url: "https://acme.test/", min_searches: 100 });
    expect(i.isError).toBe(false);
    const sent = ads.plannerCalls.at(-1)!;
    expect(sent.method).toBe("generateKeywordIdeas");
    expect(sent.req).toMatchObject({ language: "languageConstants/1000", geoTargetConstants: ["geoTargetConstants/2840"],
      keywordAndUrlSeed: { keywords: ["invoice"], url: "https://acme.test/" } });
    // Biggest first; below min_searches and no-data ideas dropped; bids in currency units, not micros.
    expect(i.json.ideas.map((x: any) => x.keyword)).toEqual(["invoice", "invoice software"]);
    expect(i.json.ideas[1].top_of_page_bid).toEqual({ low: 8, high: 31 });
    expect(i.json.ideas[0].in_account).toBe("keyword");
    expect(i.json.ideas[1].in_account).toBeUndefined();

    const m = await call(token, "keyword_metrics", { customer_id: "1112223333", keywords: ["Invoicing Software", "zzz"], location_ids: ["2826"] });
    expect(ads.plannerCalls.at(-1)!.req.geoTargetConstants).toEqual(["geoTargetConstants/2826"]);
    expect(m.json.keywords[0]).toMatchObject({ keyword: "invoice software", avg_monthly_searches: 12100, monthly: { "2026-08": 11000, "2026-09": 13000 } });
    expect(m.json.no_data).toEqual(["zzz"]);

    // Over 100 keywords: a compact table, one header and arrays, instead of an object per keyword. Up to 500.
    const many = Array.from({ length: 150 }, (_, i) => `kw ${i}`);
    const big = await call(token, "keyword_metrics", { customer_id: "1112223333", keywords: many });
    expect(big.json.keywords).toBeUndefined();
    expect(big.json.columns).toEqual(["keyword", "avg_monthly_searches", "competition", "bid_low", "bid_high", "in_account", "monthly"]);
    expect(big.json.months).toEqual(["2026-09"]);
    expect(big.json.rows).toHaveLength(150);
    expect(big.json.rows[5]).toEqual(["kw 5", 5, "LOW", null, null, null, [5]]);
    expect(big.json.no_data).toEqual([]);
    expect((await call(token, "keyword_metrics", { customer_id: "1112223333", keywords: [...many, ...Array.from({ length: 900 }, (_, i) => `x ${i}`)] })).isError).toBe(true);

    expect((await call(token, "keyword_ideas", { customer_id: "1112223333" })).isError).toBe(true);  // needs a seed
    expect(ads.mutations.length).toBe(before);
  });

  it("reads Search Console and joins it with the account's search terms, changing nothing", async () => {
    const before = ads.mutations.length;
    const sites = (await call(token, "search_console_sites")).json;
    expect(sites.sites).toEqual([{ site_url: "sc-domain:acme.test", permission: "siteOwner" }]);  // unverified dropped, no demo

    const perf = (await call(token, "search_console_performance", { site_url: "sc-domain:acme.test", dimensions: ["query"], query_contains: "invoice", limit: 10 })).json;
    expect(sc.requests.at(-1)!.req).toMatchObject({ dimensions: ["query"], rowLimit: 10,
      dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: "invoice" }] }] });
    expect(perf.rows[0]).toEqual({ query: "Invoice App", clicks: 40, impressions: 800, ctr_pct: 5, position: 2.1 });
    // The window ends 3 days ago (Search Console's recent days are incomplete) and spans the default 28 days.
    expect(Date.parse(perf.window.end) - Date.parse(perf.window.start)).toBe(27 * 86_400_000);

    sc.totals = [{ keys: [], clicks: 120, impressions: 4000, ctr: 0.03, position: 9.4 }, { keys: [], clicks: 100, impressions: 5000, ctr: 0.02, position: 10.1 }];
    const sum = (await call(token, "search_console_summary", { site_url: "sc-domain:acme.test", days: 28 })).json;
    sc.totals = [];
    expect(sum.current).toMatchObject({ clicks: 120, impressions: 4000, ctr_pct: 3, position: 9.4 });
    expect(sum.change).toEqual({ clicks_pct: 20, impressions_pct: -20, ctr_points: 1, position: -0.7 });
    // No dimension (true site totals); the previous window is the 28 days right before the current one.
    const [a, b] = sc.requests.slice(-2).map((r) => r.req);
    expect(a.dimensions).toEqual([]);
    expect(Date.parse(sum.current.window.start) - Date.parse(sum.previous.window.end)).toBe(86_400_000);
    expect([a.startDate, b.startDate].sort()).toEqual([sum.previous.window.start, sum.current.window.start]);

    const o = (await call(token, "paid_organic_overlap", { customer_id: "111-222-3333", site_url: "sc-domain:acme.test", days: 30 })).json;
    // Paid and in the top 3 organically, matched case-insensitively; "free invoice maker" ranks too low to count.
    expect(o.paid_and_ranking).toEqual([{ query: "Invoice App", organic_position: 2.1, organic_clicks: 40, organic_impressions: 800,
      ad_cost: 120, ad_clicks: 30, ad_conversions: 4, campaigns: ["Search"] }]);
    expect(o.paid_and_ranking_total).toEqual({ queries: 1, ad_cost: 120 });
    // Page 2+, enough impressions, not paid and not already a keyword.
    expect(o.organic_gaps.map((g: any) => g.query)).toEqual(["invoice template"]);
    // Both sides read over the same dates.
    expect(o.window).toEqual({ start: sc.requests.at(-1)!.req.startDate, end: sc.requests.at(-1)!.req.endDate });
    expect(ads.mutations.length).toBe(before);
  });

  it("reads exact date windows, fresh data and regex filters", async () => {
    const perf = (await call(token, "search_console_performance", { site_url: "sc-domain:acme.test", start_date: "2026-09-01", end_date: "2026-09-14",
      fresh: true, dimensions: ["page", "date"], query_regex: "(?i)invoice", exclude_query_regex: "(?i)acme", page_regex: "/tools/" })).json;
    expect(perf.window).toEqual({ start: "2026-09-01", end: "2026-09-14" });
    expect(sc.requests.at(-1)!.req).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-14", dataState: "all", dimensionFilterGroups: [{ filters: [
      { dimension: "query", operator: "includingRegex", expression: "(?i)invoice" },
      { dimension: "query", operator: "excludingRegex", expression: "(?i)acme" },
      { dimension: "page", operator: "includingRegex", expression: "/tools/" }] }] });
    expect(perf.note).toContain("still filling in");

    // fresh with a day count ends yesterday; without it, 3 days ago and no dataState sent.
    const f = (await call(token, "search_console_performance", { site_url: "sc-domain:acme.test", days: 7, fresh: true })).json;
    expect(f.window.end).toBe(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
    await call(token, "search_console_performance", { site_url: "sc-domain:acme.test", days: 7 });
    expect(sc.requests.at(-1)!.req.dataState).toBeUndefined();

    // Exact-date summary compares with the same number of days right before.
    const sum = (await call(token, "search_console_summary", { site_url: "sc-domain:acme.test", start_date: "2026-09-15", end_date: "2026-09-28" })).json;
    expect(sum.previous.window).toEqual({ start: "2026-09-01", end: "2026-09-14" });

    for (const bad of [{ start_date: "2026-09-01" }, { start_date: "2026-09-10", end_date: "2026-09-01" }, { start_date: "2024-01-01", end_date: "2026-01-01" }]) {
      const r = await call(token, "search_console_performance", { site_url: "sc-domain:acme.test", ...bad });
      expect(r.isError).toBe(true);
    }
  });

  it("compares two windows query by query and page by page, paging past 25,000 rows", async () => {
    const big = Array.from({ length: 25_000 }, (_, i) => ({ keys: [`tail ${i}`], clicks: 0, impressions: 1, ctr: 0, position: 50 }));
    sc.rowsFor = (req) => {
      const cur = req.startDate === "2026-09-15";
      if (req.dimensions[0] === "page") return cur
        ? [{ keys: ["https://acme.test/a"], clicks: 5, impressions: 300, ctr: 0.017, position: 12 }, { keys: ["https://acme.test/b/"], clicks: 0, impressions: 5, ctr: 0, position: 30 }]
        : [{ keys: ["https://acme.test/a"], clicks: 4, impressions: 100, ctr: 0.04, position: 15 }, { keys: ["https://acme.test/b/"], clicks: 1, impressions: 90, ctr: 0.01, position: 28 }];
      if (cur && !req.startRow) return big;
      if (cur) return [
        { keys: ["invoice template"], clicks: 3, impressions: 400, ctr: 0.0075, position: 18 },  // rising, losing ground
        { keys: ["markup calculator"], clicks: 1, impressions: 40, ctr: 0.025, position: 20 },   // falling
        { keys: ["plumbing invoice"], clicks: 0, impressions: 60, ctr: 0, position: 34 },        // new
      ];
      return [
        { keys: ["invoice template"], clicks: 4, impressions: 200, ctr: 0.02, position: 12 },
        { keys: ["markup calculator"], clicks: 2, impressions: 110, ctr: 0.018, position: 24 },
        { keys: ["deposit calculator"], clicks: 0, impressions: 30, ctr: 0, position: 40 },     // lost
        { keys: ["rare"], clicks: 0, impressions: 3, ctr: 0, position: 60 },                    // under min_impressions
      ];
    };
    sc.totals = [{ keys: [], clicks: 10, impressions: 1200, ctr: 0.008, position: 26 }, { keys: [], clicks: 8, impressions: 800, ctr: 0.01, position: 22 }];
    const n = sc.requests.length;
    try {
      const t = (await call(token, "search_console_trend", { site_url: "sc-domain:acme.test", start_date: "2026-09-15", end_date: "2026-09-28",
        exclude_query_regex: "(?i)acme" })).json;
      expect(t.prior_window).toEqual({ start: "2026-09-01", end: "2026-09-14" });
      expect(t.totals).toMatchObject({ current: { impressions: 1200 }, prior: { impressions: 800 }, impressions_pct: 50 });
      expect(t.rising_queries.map((r: any) => r.key)).toEqual(["invoice template"]);
      expect(t.falling_queries[0]).toMatchObject({ key: "markup calculator", impressions_change: -70, position_change: -4 });
      expect(t.new_queries.map((r: any) => r.key)).toEqual(["plumbing invoice"]);
      expect(t.lost_queries.map((r: any) => r.key)).toEqual(["deposit calculator"]);
      expect(t.losing_ground[0]).toMatchObject({ key: "invoice template", position_change: 6 });
      expect(t.rising_pages[0].key).toBe("https://acme.test/a");
      expect(t.falling_pages[0]).toMatchObject({ key: "https://acme.test/b/", impressions_change: -85 });
      expect(t.counts.queries_current).toBe(25_003);
      const reqs = sc.requests.slice(n).map((r) => r.req);
      // The second page was fetched; the brand filter went to Google on query pulls only.
      expect(reqs.some((r) => r.startRow === 25_000)).toBe(true);
      for (const r of reqs.filter((r) => r.dimensions[0] === "query")) expect(r.dimensionFilterGroups[0].filters[0].operator).toBe("excludingRegex");
      for (const r of reqs.filter((r) => r.dimensions[0] === "page")) expect(r.dimensionFilterGroups).toBeUndefined();
    } finally { sc.rowsFor = undefined; sc.totals = []; }
  });

  it("finds striking-distance queries and weak snippets", async () => {
    const o = (await call(token, "search_console_opportunities", { site_url: "sc-domain:acme.test" })).json;
    // Ranked by projected click gain from a ~3-place climb; "invoice pdf" has only 50 impressions but clears the 15 floor.
    expect(o.striking_distance.map((r: any) => r.query)).toEqual(["free invoice maker", "invoice", "invoice template", "invoice pdf"]);
    expect(o.striking_distance[0]).toMatchObject({ target_position: 5, projected_clicks: 20, click_gain: 17 });
    // Position 2 with 5% CTR, under half the usual 15%.
    expect(o.snippet_gaps).toEqual([{ query: "Invoice App", clicks: 40, impressions: 800, ctr_pct: 5, position: 2.1, typical_ctr_pct: 15, click_gain: 80 }]);
    expect(o.question_queries.map((r: any) => r.query)).toEqual(["free invoice maker"]);
    expect(Date.parse(o.window.end) - Date.parse(o.window.start)).toBe(89 * 86_400_000);
  });

  it("inspects URLs one by one, keeping a failed URL from sinking the rest, and lists sitemaps", async () => {
    sc.inspected = [];
    const urls = ["https://acme.test/a", "https://acme.test/queued", "https://broken.test/x", "https://acme.test/d", "https://acme.test/e", "https://acme.test/f"];
    const r = (await call(token, "search_console_inspect_urls", { site_url: "sc-domain:acme.test", urls })).json;
    expect([...sc.inspected].sort()).toEqual([...urls].sort());
    expect(r.results.map((x: any) => x.url)).toEqual(urls);  // in the order asked, despite running in parallel
    expect(r.tally).toEqual({ "Submitted and indexed": 4, "Discovered - currently not indexed": 1, error: 1 });
    expect(r.results[2].error).toContain("not part of this property");
    expect(r.results[0]).toMatchObject({ indexed: true, last_crawl: "2026-10-05T10:00:00Z", google_canonical: "https://acme.test/a", declared_canonical: "https://acme.test/a" });
    expect(r.results[0].canonical_mismatch).toBeUndefined();
    expect(r.results[3]).toMatchObject({ canonical_mismatch: true });
    expect(r.results[0].structured_data).toEqual({ verdict: "FAIL", items: [{ type: "FAQ", severity: "ERROR", issues: ["Missing field \"name\""] }] });
    // Never crawled: Google's *_UNSPECIFIED placeholders come back as null.
    expect(r.results[1]).toMatchObject({ indexed: false, coverage_state: "Discovered - currently not indexed", last_crawl: null, robots_txt: null, fetch: null, crawled_as: null });
    expect(r.note).toContain("last crawl");
    expect((await call(token, "search_console_inspect_urls", { site_url: "sc-domain:acme.test", urls: Array(21).fill("https://acme.test/a") })).isError).toBe(true);

    const m = (await call(token, "search_console_sitemaps", { site_url: "sc-domain:acme.test" })).json;
    expect(m.sitemaps).toEqual([{ path: "https://acme.test/sitemap.xml", last_submitted: "2026-09-01T00:00:00Z", last_downloaded: "2026-10-01T00:00:00Z",
      pending: false, index: false, errors: 0, warnings: 2, urls_submitted: 36 }]);
  });

  it("hands out a link that adds Search Console when the connection doesn't include it, and offers the demo site", async () => {
    sc.notGranted = grants.link("search-console", ownerId());
    try {
      const s = (await call(token, "search_console_sites")).json;
      expect(s.sites).toEqual([{ site_url: "sc-domain:northwind-plumbing.example", permission: "demo" }]);
      expect(s.grant_url).toBe(sc.notGranted);
      const r = await call(token, "search_console_performance", { site_url: "sc-domain:acme.test" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("/connect/search-console?t=");
      const go = await fetch(s.grant_url, { redirect: "manual" });
      expect(new URL(go.headers.get("location")!).searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/webmasters.readonly");
    } finally { sc.notGranted = ""; }
  });

  it("connects with Search Console only, then adds Google Ads with one link", async () => {
    const saved = { ...googleGrant };
    googleGrant.scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly";
    const realList = ads.listAccessibleCustomers.bind(ads);
    try {
      const scOnly = await connect();  // Google Ads unticked: still connects
      ads.listAccessibleCustomers = async () => { throw new NotGrantedError("google-ads", grants.link("google-ads", ownerId())); };
      const l = (await call(scOnly, "list_accounts")).json;
      expect(l.accounts.map((a: any) => a.customerId)).toEqual(["0000000001"]);
      expect(l.note).toContain("without Google Ads access");
      const go = await fetch(l.grant_url, { redirect: "manual" });
      expect(new URL(go.headers.get("location")!).searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/adwords");
      const state = new URL(go.headers.get("location")!).searchParams.get("state");
      googleGrant.scope += " https://www.googleapis.com/auth/adwords";
      const done = await fetch(`${base}/oauth/google/callback?code=gcode&state=${state}`,
        { redirect: "manual", headers: { cookie: go.headers.get("set-cookie")!.split(";")[0]! } });
      expect(await done.text()).toContain("Google Ads is now part of your Camberstack connection");
    } finally {
      Object.assign(googleGrant, saved);
      ads.listAccessibleCustomers = realList;
    }
  });

  it("connects with only Google Analytics ticked, since sign-in asks for it", async () => {
    const saved = { ...googleGrant };
    googleGrant.scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/analytics.readonly";
    try {
      expect(await connect()).toBeTruthy();
    } finally {
      Object.assign(googleGrant, saved);
      await connect();  // record the full grant again for the tests after this one
    }
  });

  it("serves the page beacon without a Google Analytics tag unless a measurement ID is configured", async () => {
    const js = await (await fetch(`${base}/e.js`)).text();
    expect(js).toContain("sendBeacon");
    expect(js).not.toContain("googletagmanager");
  });

  it("runs the whole flow on the demo account without touching Google or the free allowance", async () => {
    const before = ads.mutations.length;
    const left = (await call(token, "billing", {})).json;
    const w = (await call(token, "account_overview", { customer_id: "000-000-0001", days: 180 })).json;
    expect(w.note).toContain("Sample data");
    expect(w.campaigns.map((c: any) => c.name)).toContain("Drain Cleaning – Search");

    const ov = (await call(token, "paid_organic_overlap", { customer_id: "0000000001", site_url: "sc-domain:northwind-plumbing.example" })).json;
    expect(ov.note).toContain("Sample data");
    expect(ov.paid_and_ranking.map((x: any) => x.query)).toContain("emergency plumber near me");
    expect(ov.paid_and_ranking.map((x: any) => x.query)).not.toContain("tankless water heater");  // paid, but position 14
    expect(ov.organic_gaps.map((x: any) => x.query)).toContain("slab leak repair");

    const DS = "sc-domain:northwind-plumbing.example";
    const tr = (await call(token, "search_console_trend", { site_url: DS })).json;
    expect(tr.note).toContain("Sample data");
    expect(tr.rising_pages.map((x: any) => x.key)).toContain("https://northwind-plumbing.example/blog/noisy-water-heater");
    const ins = (await call(token, "search_console_inspect_urls", { site_url: DS,
      urls: ["https://northwind-plumbing.example/drains", "https://northwind-plumbing.example/blog/winterize-pipes", "https://northwind-plumbing.example/nope"] })).json;
    expect(ins.results.map((x: any) => x.coverage_state)).toEqual(["Submitted and indexed", "Discovered - currently not indexed", "URL is unknown to Google"]);
    expect((await call(token, "search_console_sitemaps", { site_url: DS })).json.sitemaps[0].errors).toBe(0);
    const op = (await call(token, "search_console_opportunities", { site_url: DS, exclude_query_regex: "(?i)northwind" })).json;
    expect(op.question_queries.map((x: any) => x.query)).toContain("how to shut off water main");
    expect(ov.organic_gaps.map((x: any) => x.query)).not.toContain("tankless water heater");      // already paid for
    expect(sc.requests.some((r) => r.site.includes("northwind"))).toBe(false);                     // never reached "Google"

    const q = (await call(token, "run_gaql", { customer_id: "0000000001",
      query: "SELECT ad_group_criterion.keyword.text, metrics.cost_micros FROM keyword_view WHERE campaign.id = 2003 AND segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 2" })).json;
    expect(q.rows).toHaveLength(2);
    expect(q.rows[0].adGroupCriterion.keyword.text).toBe("drain cleaning");

    const p = (await call(token, "propose_changes", { customer_id: "0000000001", changes: [
      { type: "pause_campaign", campaign_id: "2003" },
      { type: "add_negative_keywords", campaign_id: "2001", keywords: [{ text: "jobs", match_type: "PHRASE" }] },
      { type: "set_daily_budget", campaign_id: "2001", amount: 50 },
      { type: "set_end_date", campaign_id: "2001", end_date: "2030-01-31" },
    ] })).json;
    expect(p.summary).toContain('Pause campaign "Drain Cleaning – Search"');
    expect(p.summary).toContain('Set end date of campaign "Emergency Plumbing – Search" from no end date to 2030-01-31');
    const a = (await call(token, "apply_changes", { proposal_id: p.proposal_id })).json;
    expect(a.status).toBe("applied");
    const after = (await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).json;
    expect(after.campaigns.find((c: any) => c.campaign_id === "2003").status).toBe("PAUSED");
    expect(after.campaigns.find((c: any) => c.campaign_id === "2001").daily_budget).toBe(50);

    const u = (await call(token, "undo_changes", { proposal_id: p.proposal_id })).json;
    await call(token, "apply_changes", { proposal_id: u.proposal_id });
    const reverted = (await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).json;
    expect(reverted.campaigns.find((c: any) => c.campaign_id === "2003").status).toBe("ENABLED");
    expect(reverted.campaigns.find((c: any) => c.campaign_id === "2001").daily_budget).toBe(40);
    const endQ = `SELECT campaign.end_date_time FROM campaign WHERE campaign.id = 2001`;
    const end = (await call(token, "run_gaql", { customer_id: "0000000001", query: endQ })).json;
    expect(end.rows[0].campaign.endDateTime).toBe("2037-12-30 23:59:59");  // undo removed it

    // Building is simulated on the demo: it proposes, applies and undoes without touching Google.
    const ad = { headlines: ["Sewer Line Repair", "Same-Day Service", "Licensed Plumbers"], descriptions: ["Call now.", "Upfront prices."], final_url: "https://example.com/sewer" };
    const b = await call(token, "propose_changes", { customer_id: "0000000001", changes: [{ type: "create_campaign", name: "Sewer – Search", daily_budget: 15,
      ad_groups: [{ name: "Sewer", default_max_cpc: 6, keywords: [{ text: "sewer line repair", match_type: "PHRASE" }], ads: [ad] }] },
      { type: "add_keywords", ad_group_id: "3005", keywords: [{ text: "drain unclogging", match_type: "PHRASE" }] }] });
    if (b.isError) throw new Error(b.text);
    expect(b.json.summary).toContain('Create Search campaign "Sewer – Search", PAUSED');
    expect((await call(token, "apply_changes", { proposal_id: b.json.proposal_id })).json.status).toBe("applied");
    const bu = (await call(token, "undo_changes", { proposal_id: b.json.proposal_id })).json;
    expect(bu.summary).toContain('Remove campaign "Sewer – Search"');
    expect((await call(token, "apply_changes", { proposal_id: bu.proposal_id })).json.status).toBe("applied");

    const ideas = (await call(token, "keyword_ideas", { customer_id: "0000000001", keywords: ["water heater"] })).json;
    expect(ideas.note).toContain("Sample data");
    expect(ideas.ideas[0].keyword).toBe("tankless water heater");
    expect(ideas.ideas.find((x: any) => x.keyword === "water heater repair").in_account).toBe("keyword");
    const kws = (await call(token, "keyword_metrics", { customer_id: "0000000001", keywords: ["sewer line repair"] })).json;
    expect(Object.keys(kws.keywords[0].monthly)).toHaveLength(12);

    expect(ads.mutations.length).toBe(before);  // Google was never called
    const now = (await call(token, "billing", {})).json;  // allowance untouched (the signed link's expiry may tick)
    expect({ plan: now.plan, used: now.accounts_in_use }).toEqual({ plan: left.plan, used: left.accounts_in_use });
  });

  it("logs each tool call by name, without arguments or results; for run_gaql only the query's shape", async () => {
    await call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.name = 'Secret Brand' AND campaign.id = 10" });
    const gaql = db.prepare("SELECT query_shape FROM tool_calls WHERE tool = 'run_gaql' ORDER BY id DESC LIMIT 1").get();
    expect(gaql).toEqual({ query_shape: "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.name = ? AND campaign.id = ?" });
    const rows = db.prepare("SELECT * FROM tool_calls ORDER BY id").all() as any[];
    expect(JSON.stringify(rows)).not.toContain("Secret Brand");
    expect(rows.filter((r) => r.tool !== "run_gaql").every((r) => r.query_shape === null)).toBe(true);
    const tools = rows.map((r) => r.tool);
    expect(tools).toContain("account_overview");
    expect(tools).toContain("apply_changes");
    const overview = rows.find((r) => r.tool === "account_overview" && r.customer_id === "1112223333");
    expect(overview).toMatchObject({ ok: 1, error: null, customer_id: "1112223333" });
    expect(overview.client_id).toBeTruthy();
    expect(overview.bytes).toBeGreaterThan(0);
    const failed = rows.find((r) => r.ok === 0);
    expect(failed?.error).toBeTruthy();
    expect(failed?.error).not.toMatch(/^Error: /);
    expect(JSON.stringify(rows)).not.toContain("free invoice maker");
  });

  it("serves the admin site only on its own host, behind a Google sign-in for ADMIN_EMAILS", async () => {
    const admin = base.replace("localhost", "127.0.0.1");
    // The main site has no /admin at all.
    expect((await fetch(`${base}/admin`, { redirect: "manual" })).status).toBe(404);
    const gate = await fetch(`${admin}/`, { redirect: "manual" });
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe("/login");
    const login = await fetch(`${admin}/login`, { redirect: "manual" });
    const g = new URL(login.headers.get("location")!);
    expect(g.searchParams.get("scope")).toBe("openid email");
    // Google returns to the main site's registered callback, which forwards to the admin host.
    expect(g.searchParams.get("redirect_uri")).toBe(`${base}/oauth/google/callback`);
    // A callback reached without the browser that started the sign-in (a link someone was sent) is refused.
    const other = await fetch(`${admin}/login`, { redirect: "manual" });
    const otherState = new URL(other.headers.get("location")!).searchParams.get("state");
    expect((await fetch(`${admin}/callback?code=gcode&state=${otherState}`, { redirect: "manual" })).status).toBe(400);
    const cookie = await signIn(g, stateCookie(login));
    expect(cookie).toMatch(/^cs_admin=/);
    // The operator (ADMIN_EMAILS) is always left out of the numbers; a customer with the owner's scopes and a call shows.
    const owner = db.prepare("SELECT google_scopes FROM users WHERE email = 'owner@example.com'").get() as { google_scopes: string };
    db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, google_scopes, enc_refresh) VALUES ('u_cust', 'sub-cust', 'customer@example.com', 'free', unixepoch(), ?, 'x')")
      .run(owner.google_scopes);
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (unixepoch(), 'u_cust', 'account_overview', '1112223333', 1, 5, 10)").run();
    const page = await fetch(`${admin}/?days=30`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Top tools");   // which tools make its top 6 depends on the whole run; /activity (below) lists them all
    expect(html).toContain("customer@example.com");
    expect(html).not.toContain("owner@example.com</a>");   // only as the signed-in admin, never as a user
    expect(html).not.toContain("internal=1");
    // The other pages, and a user's own page with their Google permissions.
    const users = await (await fetch(`${admin}/users?days=30`, { headers: { cookie } })).text();
    expect(users).toContain("customer@example.com");
    expect(users).not.toContain("owner@example.com</a>");
    const id = users.match(/href="\/users\/([^"?]+)/)![1]!;
    // The list follows the window, by last seen; ?all=1 keeps users idle past 90d reachable.
    const seen = db.prepare("SELECT last_seen_at, created_at FROM users WHERE id = ?").get(id) as { last_seen_at: number | null; created_at: number };
    db.prepare("UPDATE users SET last_seen_at = ?, created_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 100 * 86400, 1, id);
    const idle = await (await fetch(`${admin}/users?days=90`, { headers: { cookie } })).text();
    expect(idle).not.toContain(`href="/users/${id}`);
    expect(idle).toContain('href="?days=90&all=1">all</a>');
    expect(await (await fetch(`${admin}/users?days=90&all=1`, { headers: { cookie } })).text()).toContain(`href="/users/${id}`);
    db.prepare("UPDATE users SET last_seen_at = ?, created_at = ? WHERE id = ?").run(seen.last_seen_at, seen.created_at, id);
    const one = await fetch(`${admin}/users/${id}`, { headers: { cookie } });
    expect(one.status).toBe(200);
    const detail = await one.text();
    expect(detail).toContain("Google permissions");
    expect(detail).toContain(`<span class="chip on">Google Ads</span>`);  // recorded from the scopes Google granted at sign-in
    expect(detail).toContain("account_overview");
    expect((await fetch(`${admin}/users/nope`, { headers: { cookie } })).status).toBe(404);
    expect(await (await fetch(`${admin}/activity?days=30`, { headers: { cookie } })).text()).toContain("account_overview");
    expect((await fetch(`${admin}/revenue`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${admin}/users`, { redirect: "manual" })).status).toBe(302);  // every page is behind sign-in
    // Announcements: preset cards; a preset's page previews it and has the Send button; a POST from another site is refused;
    // with no email configured, nothing can send.
    const postForm = (path: string, fields: Record<string, string>, origin = new URL(admin).origin) => fetch(`${admin}${path}`, { method: "POST", redirect: "manual",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    const list = await (await fetch(`${admin}/announcements`, { headers: { cookie } })).text();
    expect(list).toContain('href="/announcements/ga4-open"');
    const preset = await (await fetch(`${admin}/announcements/ga4-open`, { headers: { cookie } })).text();
    expect(preset).toContain("<li>Which landing pages");   // the rendered preview
    expect(preset).toMatch(/<button class="primary" disabled>Send to \d+ (person|people)<\/button>/);   // disabled: no email configured
    expect((await postForm("/announcements/ga4-open/send", { count: "0" }, "https://evil.test")).status).toBe(403);
    expect((await postForm("/announcements/ga4-open/send", { count: "999" })).status).toBe(400);   // not the list the page showed
    expect((await fetch(`${admin}/announcements/nope`, { headers: { cookie } })).status).toBe(404);
    // The operator's own account is internal: always hidden, so only the customer counts.
    const json = await (await fetch(`${admin}/?format=json`, { headers: { cookie } })).json();  // still served, just not linked
    expect(json.funnel.all.connected).toBe(1);
    // The admin host serves nothing else from the public site.
    expect((await fetch(`${admin}/privacy`)).status).toBe(404);
    expect((await fetch(`${admin}/.well-known/oauth-authorization-server`)).status).toBe(404);
    // A replayed state is refused; a forged cookie gets the sign-in redirect.
    expect((await fetch(`${admin}/callback?code=gcode&state=${g.searchParams.get("state")}`, { redirect: "manual" })).status).toBe(400);
    expect((await fetch(`${admin}/`, { headers: { cookie: "cs_admin=forged" }, redirect: "manual" })).status).toBe(302);
  });

  it("shows a connected user their plan and changes at /account, and disconnects from there", async () => {
    expect(await (await fetch(`${base}/account`)).text()).toContain("Sign in with Google");
    // The pricing CTA's sign-in link carries the upgrade intent; a plain visit's doesn't, and no cookie lingers.
    const intent = await fetch(`${base}/account?upgrade=1`);
    expect(await intent.text()).toContain('href="/account/login?next=upgrade"');
    expect(intent.headers.get("set-cookie")).toBeNull();
    const login = await fetch(`${base}/account/login`, { redirect: "manual" });
    const g = new URL(login.headers.get("location")!);
    expect(g.searchParams.get("scope")).toBe("openid email");
    const cookie = await signIn(g, stateCookie(login));
    expect(cookie).toMatch(/^cs_account=/);
    // A sign-in started from the upgrade screen comes back to /account?upgrade=1; an ordinary one to /account.
    const upLogin = await fetch(`${base}/account/login?next=upgrade`, { redirect: "manual" });
    const viaUpgrade = new URL(upLogin.headers.get("location")!);
    const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${viaUpgrade.searchParams.get("state")}`, { redirect: "manual" });
    const hop = await fetch(new URL(back.headers.get("location")!, base), { redirect: "manual", headers: { cookie: stateCookie(upLogin) } });
    expect(hop.headers.get("location")).toBe("/account?upgrade=1");
    expect((await fetch(`${base}/account`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(html).toContain("owner@example.com");
    expect(html).toContain('class="pill undone"');
    expect(html).toContain("data-copy=\"Undo Camberstack proposal ");
    expect(html).toContain('Add 1 negative keyword');
    // An applied undo folds into the change it reversed instead of being its own entry.
    expect(html).not.toContain('Remove 1 negative keyword');
    // Disconnect needs the explicit confirmation.
    const noConfirm = await fetch(`${base}/account/disconnect`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(noConfirm.status).toBe(303);
    expect(db.prepare("SELECT enc_refresh FROM users").get()).not.toMatchObject({ enc_refresh: null });
    // (Disconnecting for real would end the shared test user's connection; covered by the tool's own path.)
    expect((await fetch(`${base}/account`, { headers: { cookie: "cs_account=forged" } })).status).toBe(200);
    expect(await (await fetch(`${base}/account`, { headers: { cookie: "cs_account=forged" } })).text()).toContain("Sign in with Google");
  });

  it("lets an admin log in as a user from the admin site, without billing or disconnect", async () => {
    const admin = base.replace("localhost", "127.0.0.1");
    const alogin = await fetch(`${admin}/login`, { redirect: "manual" });
    const acookie = await signIn(new URL(alogin.headers.get("location")!), stateCookie(alogin));
    const id = ownerId();
    expect(await (await fetch(`${admin}/users/${id}`, { headers: { cookie: acookie } })).text()).toContain(`action="/users/${id}/login-as"`);
    const loginAs = (origin = new URL(admin).origin, cookie = acookie, who = id) =>
      fetch(`${admin}/users/${who}/login-as`, { method: "POST", redirect: "manual", headers: { cookie, origin } });
    // Only from the admin site's own pages, signed in, for a real user.
    expect((await loginAs("https://evil.test")).status).toBe(403);
    expect((await loginAs(undefined, "")).headers.get("location")).toBe("/login");
    expect((await loginAs(undefined, acookie, "nope")).status).toBe(404);

    const go = await loginAs();
    expect(go.status).toBe(303);
    const link = go.headers.get("location")!;
    expect(link).toMatch(new RegExp(`^${base}/account/lau\\?t=`));
    const hop = await fetch(link, { redirect: "manual" });
    expect(hop.status).toBe(302);
    expect(hop.headers.get("location")).toBe("/account");
    const cookie = hop.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^cs_account=/);
    expect(hop.headers.get("set-cookie")).toContain("Max-Age=3600");
    // The link works once.
    expect((await fetch(link, { redirect: "manual" })).status).toBe(400);

    db.prepare("UPDATE users SET last_seen_at = 1 WHERE id = ?").run(id);
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(db.prepare("SELECT last_seen_at FROM users WHERE id = ?").get(id)).toEqual({ last_seen_at: 1 });   // not "seen" by an admin's look
    expect(html).toContain("Logged in as owner@example.com");
    expect(html).toContain("as admin owner@example.com");
    expect(html).toContain('class="pill undone"');   // the user's own page, changes and all
    expect(html).not.toContain("Disconnect Google Ads");
    expect(html).not.toMatch(/\/(upgrade|billing)\?t=/);
    // No checkout either, and the disconnect POST is refused outright.
    expect((await fetch(`${base}/account?upgrade=1`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
    const before = db.prepare("SELECT enc_refresh FROM users WHERE id = ?").get(id);
    const disc = await fetch(`${base}/account/disconnect`, { method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "confirm=yes" });
    expect(disc.status).toBe(403);
    expect(db.prepare("SELECT enc_refresh FROM users WHERE id = ?").get(id)).toEqual(before);
    // Ending it returns to that user on the admin site and ends the session.
    const end = await fetch(`${base}/account/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(end.headers.get("location")).toBe(`${admin}/users/${id}`);
    expect(await (await fetch(`${base}/account`, { headers: { cookie } })).text()).toContain("Sign in with Google");

    // A link older than a minute is refused.
    const stale = new URL((await loginAs()).headers.get("location")!);
    db.prepare("UPDATE pending_auth SET created_at = created_at - 61 WHERE client_id = '__lau'").run();
    expect((await fetch(stale, { redirect: "manual" })).status).toBe(400);
  });

  it("takes feedback at /feedback from a signed-in Google account, and lists it on the admin site", async () => {
    // Public page; sending needs a sign-in, and a POST without one stores nothing.
    const open = await (await fetch(`${base}/feedback`)).text();
    expect(open).toContain('href="/feedback/login"');
    const post = (cookie: string, fields: Record<string, string>) => fetch(`${base}/feedback`, { method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    expect((await post("", { kind: "bug", message: "no session" })).headers.get("location")).toBe("/feedback");
    expect(db.prepare("SELECT count(*) n FROM feedback").get()).toEqual({ n: 0 });

    const login = await fetch(`${base}/feedback/login`, { redirect: "manual" });
    const g = new URL(login.headers.get("location")!);
    expect(g.searchParams.get("scope")).toBe("openid email");
    const cookie = await signIn(g, stateCookie(login));
    expect(cookie).toMatch(/^cs_feedback=/);
    expect(await (await fetch(`${base}/feedback`, { headers: { cookie } })).text()).toContain("Sending as owner@example.com");

    expect((await post(cookie, { kind: "nonsense", message: "hi there" })).status).toBe(400);
    expect((await post(cookie, { kind: "idea", message: "x".repeat(5001) })).status).toBe(400);
    const sent = await post(cookie, { kind: "idea", message: "Please add <b>Microsoft Ads</b>" });
    expect(sent.headers.get("location")).toBe("/feedback?sent=1");
    expect(db.prepare("SELECT email, kind, message, user_id IS NOT NULL connected FROM feedback").get())
      .toEqual({ email: "owner@example.com", kind: "idea", message: "Please add <b>Microsoft Ads</b>", connected: 1 });
    // Five a day per sender.
    for (let i = 0; i < 4; i++) expect((await post(cookie, { kind: "other", message: `more ${i}` })).status).toBe(303);
    expect((await post(cookie, { kind: "other", message: "one too many" })).status).toBe(429);

    // The admin site lists it, escaped.
    const admin = base.replace("localhost", "127.0.0.1");
    const alogin = await fetch(`${admin}/login`, { redirect: "manual" });
    const acookie = await signIn(new URL(alogin.headers.get("location")!), stateCookie(alogin));
    const list = await (await fetch(`${admin}/feedback`, { headers: { cookie: acookie } })).text();
    expect(list).toContain("Please add &lt;b&gt;Microsoft Ads&lt;/b&gt;");
    expect(list).toContain("An idea or request");
    db.prepare("DELETE FROM feedback").run();
  });

  it("pauses and re-enables a campaign, warning before it spends again; flags big budget increases", async () => {
    db.prepare("UPDATE users SET plan = 'pro'").run();  // the free applies were used up above
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };

    const pause = await propose([{ type: "pause_campaign", campaign_id: "10" }]);
    expect(pause.summary).toContain('Pause campaign "Search" (now ENABLED)');
    expect(pause.summary).not.toContain("⚠");
    await call(token, "apply_changes", { proposal_id: pause.proposal_id });
    expect(ads.campaignStatus).toBe("PAUSED");

    // Pausing again is already in place: a plain answer, not an error, and nothing stored.
    const again = await propose([{ type: "pause_campaign", campaign_id: "10" }]);
    expect(again.status).toBe("already in place");
    expect(again.proposal_id).toBeUndefined();

    const enable = await propose([{ type: "enable_campaign", campaign_id: "10" }]);
    expect(enable.summary).toContain("⚠ it starts spending again, up to an average of 20.00/day");
    await call(token, "apply_changes", { proposal_id: enable.proposal_id });
    expect(ads.campaignStatus).toBe("ENABLED");

    // Undo of the pause re-enables; undo of the enable pauses.
    const u = await call(token, "undo_changes", { proposal_id: enable.proposal_id });
    expect(u.json.summary).toContain('Pause campaign "Search"');
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.campaignStatus).toBe("PAUSED");

    const big = await propose([{ type: "set_daily_budget", campaign_id: "10", amount: 100 }]);
    expect(big.summary).toContain("from 20.00 to 100.00 ⚠ 5.0× the current budget");
    const small = await propose([{ type: "set_daily_budget", campaign_id: "10", amount: 30 }]);
    expect(small.summary).not.toContain("⚠");
  });

  it("warns with the budget and end date a proposal sets, not the ones it replaces; end dates undo", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    expect(ads.campaignStatus).toBe("PAUSED");

    // Budget $20 live; the proposal lowers it to $10 and caps the run, then enables.
    const test = await propose([
      { type: "set_daily_budget", campaign_id: "10", amount: 10 },
      { type: "set_end_date", campaign_id: "10", end_date: "2030-01-31" },
      { type: "enable_campaign", campaign_id: "10" },
    ]);
    expect(test.summary).toContain('Set end date of campaign "Search" from no end date to 2030-01-31 (it stops serving after that day)');
    expect(test.summary).toContain("⚠ it starts spending again, up to an average of 10.00/day until 2030-01-31");
    expect(test.summary).not.toContain("20.00/day");
    const applied = await call(token, "apply_changes", { proposal_id: test.proposal_id });
    expect(applied.json.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(ads.campaignEnd).toBe("2030-01-31 23:59:59");
    expect(ads.campaignStatus).toBe("ENABLED");

    // Setting the same date again is already in place.
    expect((await propose([{ type: "set_end_date", campaign_id: "10", end_date: "2030-01-31" }])).status).toBe("already in place");

    // Undo pauses, restores the budget and removes the end date (Google's 2037-12-30 stand-in).
    const u = await call(token, "undo_changes", { proposal_id: test.proposal_id });
    expect(u.json.summary).toContain("from 2030-01-31 to no end date");
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.campaignEnd).toBe("2037-12-30 23:59:59");
    expect(ads.campaignStatus).toBe("PAUSED");
  });

  it("applies a proposal of any age that still reads the same, and re-proposes one the account has moved under", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    const status = (id: string) => (db.prepare("SELECT status FROM proposals WHERE id = ?").get(id) as { status: string }).status;
    const age = (id: string) => db.prepare("UPDATE proposals SET created_at = created_at - 3 * 86400 WHERE id = ?").run(id);
    const was = { status: ads.campaignStatus, end: ads.campaignEnd };
    ads.campaignStatus = "ENABLED";
    ads.campaignEnd = "2030-01-31 23:59:59";

    // Three days old, account unchanged: applied as approved.
    const old = await propose([{ type: "set_end_date", campaign_id: "10", end_date: "2031-06-30" }]);
    age(old.proposal_id);
    const done = await call(token, "apply_changes", { proposal_id: old.proposal_id });
    expect(done.isError).toBe(false);
    expect(done.json.status).toBe("applied");
    expect(ads.campaignEnd).toBe("2031-06-30 23:59:59");

    // The end date moved after proposing: what was approved ("from 2031-06-30") no longer holds. Nothing is written, and
    // the answer is a fresh proposal to approve, not an error.
    const moved = await propose([{ type: "set_end_date", campaign_id: "10", end_date: "2032-03-31" }]);
    expect(moved.summary).toContain("from 2031-06-30 to 2032-03-31");
    ads.campaignEnd = "2031-09-30 23:59:59";
    const again = await call(token, "apply_changes", { proposal_id: moved.proposal_id });
    expect(again.isError).toBe(false);
    expect(again.json).toMatchObject({ status: "needs approval", replaces: moved.proposal_id });
    expect(again.json.summary).toContain("from 2031-09-30 to 2032-03-31");
    expect(again.json.note).toContain(`apply_changes with ${again.json.proposal_id} only after they approve`);
    expect(ads.campaignEnd).toBe("2031-09-30 23:59:59");
    expect(status(moved.proposal_id)).toBe("discarded");
    expect((await call(token, "apply_changes", { proposal_id: moved.proposal_id })).text).toContain("already discarded");
    expect((await call(token, "apply_changes", { proposal_id: again.json.proposal_id })).json.status).toBe("applied");
    expect(ads.campaignEnd).toBe("2032-03-31 23:59:59");

    // Done meanwhile by someone else: nothing left to apply, also not an error.
    const pause = await propose([{ type: "pause_campaign", campaign_id: "10" }]);
    ads.campaignStatus = "PAUSED";
    const noop = await call(token, "apply_changes", { proposal_id: pause.proposal_id });
    expect(noop.isError).toBe(false);
    expect(noop.json.status).toBe("already in place");
    expect(status(pause.proposal_id)).toBe("discarded");

    ads.campaignStatus = was.status;
    ads.campaignEnd = was.end;
  });

  it("builds a paused campaign atomically, adds keywords, scopes its conversion goal, and undoes each", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    const ad = { headlines: ["Cleaning Invoice Template", "Send It With a Pay Button", "Start Free"], descriptions: ["Fill it in free.", "Clients pay by card."],
      final_url: "https://example.com/cleaning", path1: "cleaning" };
    const campaign = { type: "create_campaign", name: "Cleaning Test", daily_budget: 20, end_date: "2030-12-03",
      negative_keywords: [{ text: "jobs", match_type: "PHRASE" }],
      sitelinks: [{ text: "Pricing", url: "https://example.com/pricing", description1: "Free to start", description2: "No card" }],
      ad_groups: [{ name: "Invoicing", default_max_cpc: 4, keywords: [{ text: "cleaning invoice", match_type: "PHRASE", max_cpc: 3 }], ads: [ad] }] };

    // Name clash and manual CPC with no bid are refused before anything is stored.
    await expect(propose([{ ...campaign, name: "Search" }])).rejects.toThrow('A campaign named "Search" already exists');
    await expect(propose([{ ...campaign, ad_groups: [{ ...campaign.ad_groups[0], default_max_cpc: undefined, keywords: [{ text: "x", match_type: "PHRASE" }] }] }]))
      .rejects.toThrow("Manual CPC needs a bid");
    // Repeated ad text is refused by name, before Google (whose DUPLICATE_ASSET names only the field) is asked; capitals differ, so they pass.
    const sent = ads.mutations.length;
    const twice = { ...ad, headlines: ["Start Free", "Start  Free ", "Pay By Card"], descriptions: ["Fill it in free.", "Clients pay by card."] };
    await expect(propose([{ ...campaign, ad_groups: [{ ...campaign.ad_groups[0], ads: [twice] }] }])).rejects.toThrow('"Start Free" is in this list twice');
    await expect(propose([{ type: "add_responsive_search_ad", ad_group_id: "20", ad: { ...ad, descriptions: ["Fill it in free.", "Fill it in free."] } }]))
      .rejects.toThrow('"Fill it in free." is in this list twice');
    expect(ads.mutations.length).toBe(sent);
    expect((await propose([{ type: "add_responsive_search_ad", ad_group_id: "20", ad: { ...ad, headlines: ["Start Free", "start free", "Pay By Card"] } }])).summary)
      .toContain("3 headlines");

    const before = ads.mutations.length;
    const p = await propose([campaign]);
    expect(p.summary).toContain('Create Search campaign "Cleaning Test", PAUSED (nothing spends until you enable it): 20.00/day, manual CPC');
    expect(p.summary).toContain("ends 2030-12-03");
    expect(p.summary).toContain('"Invoicing" (1 keyword(s), bid 4.00, 1 ad(s) → https://example.com/cleaning)');
    // One atomic, dry-run request: budget → campaign (PAUSED) → criteria → sitelink → ad group → ad → keyword.
    const dry = ads.mutations.slice(before);
    expect(dry).toHaveLength(1);
    expect(dry[0]!.service).toBe("googleAds");
    expect(dry[0]!.validateOnly).toBe(true);
    const ops = dry[0]!.operations;
    expect(ops[1].campaignOperation.create).toMatchObject({ status: "PAUSED", campaignBudget: ops[0].campaignBudgetOperation.create.resourceName,
      endDateTime: "2030-12-03 23:59:59", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } });
    expect(ops.filter((o: any) => o.campaignCriterionOperation)).toHaveLength(3); // US, English, 1 negative
    expect(ops.find((o: any) => o.adGroupCriterionOperation).adGroupCriterionOperation.create.cpcBidMicros).toBe("3000000");

    const applied = await call(token, "apply_changes", { proposal_id: p.proposal_id });
    expect(applied.json.status).toBe("applied");
    const u = await call(token, "undo_changes", { proposal_id: p.proposal_id });
    expect(u.json.summary).toContain('Remove campaign "Cleaning Test" that Camberstack created ⚠');
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.removed).toContain("customers/1112223333/campaigns/501");

    // Keywords: duplicates of what's there are skipped; undo removes exactly what was added.
    const k = await propose([{ type: "add_keywords", ad_group_id: "20", keywords: [
      { text: "invoice", match_type: "BROAD" }, { text: "cleaning invoice", match_type: "PHRASE", max_cpc: 3 }] }]);
    expect(k.summary).toContain('Add 1 keyword(s) to ad group "AG" (campaign "Search"): "cleaning invoice" @ 3.00 (1 already present or repeated, skipped)');
    await call(token, "apply_changes", { proposal_id: k.proposal_id });
    const ku = await call(token, "undo_changes", { proposal_id: k.proposal_id });
    await call(token, "apply_changes", { proposal_id: ku.json.proposal_id });
    expect(ads.removed).toContain("customers/1112223333/adGroupCriteria/20~700");

    // Conversion goal: bid on SIGNUP only, undo restores PURCHASE.
    await expect(propose([{ type: "set_conversion_goal", campaign_id: "10", category: "PHONE_CALL_LEAD" }])).rejects.toThrow(/No PHONE_CALL_LEAD goal.*import_ga4_key_event/);
    const g = await propose([{ type: "set_conversion_goal", campaign_id: "10", category: "SIGNUP" }]);
    expect(g.summary).toContain('Campaign "Search" counts and bids on SIGNUP conversions only (was: PURCHASE, SIGNUP)');
    await call(token, "apply_changes", { proposal_id: g.proposal_id });
    expect(ads.goals).toEqual({ PURCHASE: false, SIGNUP: true });
    const gu = await call(token, "undo_changes", { proposal_id: g.proposal_id });
    await call(token, "apply_changes", { proposal_id: gu.json.proposal_id });
    expect(ads.goals).toEqual({ PURCHASE: true, SIGNUP: true });
  });

  it("builds paused Display, Demand Gen (YouTube) and Performance Max campaigns with uploaded images, and undoes them", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    const PNG = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([n])]);
    const fetched: string[] = [];
    const real = io.fetchImage;
    // The landscape and square URLs differ but the logo repeats the square's bytes: one upload, not two.
    io.fetchImage = async (u: string) => { fetched.push(u); return PNG(u.includes("wide") ? 1 : 2); };
    try {
      const display = { type: "create_display_campaign", name: "Display Test", daily_budget: 10, max_cpc_ceiling: 0.8,
        ad_groups: [{ name: "Remarketing", ads: [{ headlines: ["Invoices that get paid"], long_headline: "Send an invoice with a pay button",
          descriptions: ["Clients pay by card."], business_name: "Acme", final_url: "https://example.com/",
          marketing_images: ["https://img.example.com/wide.png"], square_marketing_images: ["https://img.example.com/square.png"],
          square_logo_images: ["https://img.example.com/logo.png"] }] }] };
      await expect(propose([{ ...display, ad_groups: [{ ...display.ad_groups[0], ads: [{ ...display.ad_groups[0]!.ads[0], marketing_images: ["123"] }] }] }]))
        .rejects.toThrow("Image asset 123 isn't in this account");

      const before = ads.mutations.length;
      const d = await propose([display]);
      expect(d.summary).toContain('Create Display campaign "Display Test", PAUSED (nothing spends until you enable it): 10.00/day, maximize clicks (max 0.80/click)');
      expect(d.summary).toContain("2 image(s) to upload");
      const ops = ads.mutations[before]!.operations;
      expect(ads.mutations[before]!.validateOnly).toBe(true);
      expect(ops[1].campaignOperation.create).toMatchObject({ status: "PAUSED", advertisingChannelType: "DISPLAY", targetSpend: { cpcBidCeilingMicros: "800000" } });
      expect(ops.filter((o: any) => o.assetOperation)).toHaveLength(2);
      expect(ops.find((o: any) => o.adGroupOperation).adGroupOperation.create.type).toBe("DISPLAY_STANDARD");
      const rda = ops.find((o: any) => o.adGroupAdOperation).adGroupAdOperation.create.ad.responsiveDisplayAd;
      expect(rda.squareLogoImages[0].asset).toBe(rda.squareMarketingImages[0].asset);
      expect(rda.marketingImages[0].asset).not.toBe(rda.squareMarketingImages[0].asset);
      expect(rda).toMatchObject({ longHeadline: { text: "Send an invoice with a pay button" }, businessName: "Acme" });

      const applied = await call(token, "apply_changes", { proposal_id: d.proposal_id });
      expect(applied.json.status).toBe("applied");
      const u = await call(token, "undo_changes", { proposal_id: d.proposal_id });
      expect(u.json.summary).toContain('Remove campaign "Display Test" that Camberstack created');

      // Demand Gen: targeting goes on the ad group; YouTube URLs and ids resolve to one video asset.
      const dg = await propose([{ type: "create_demand_gen_campaign", name: "YouTube Test", daily_budget: 15,
        ad_groups: [{ name: "Explainer", ads: [{ videos: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
          headlines: ["Invoices that get paid"], long_headlines: ["Send an invoice with a pay button"], descriptions: ["Clients pay by card."],
          business_name: "Acme", logo_image: "https://img.example.com/logo.png", final_url: "https://example.com/" }] }] }]);
      expect(dg.summary).toContain('Create Demand Gen (YouTube video ads) campaign "YouTube Test", PAUSED (nothing spends until you enable it): 15.00/day, maximize conversions');
      expect(dg.summary).toContain("⚠ bidding for conversions needs working conversion tracking");
      const gops = ads.mutations.at(-1)!.operations;
      expect(gops[1].campaignOperation.create).toMatchObject({ advertisingChannelType: "DEMAND_GEN", maximizeConversions: {} });
      expect(gops.filter((o: any) => o.campaignCriterionOperation)).toHaveLength(0);
      expect(gops.filter((o: any) => o.adGroupCriterionOperation)).toHaveLength(2);  // US + English on the ad group
      const vids = gops.filter((o: any) => o.assetOperation?.create.type === "YOUTUBE_VIDEO");
      expect(vids).toHaveLength(1);
      const ad = gops.find((o: any) => o.adGroupAdOperation).adGroupAdOperation.create.ad;
      expect(ad.name).toBe("Video ad 1");
      expect(ad.demandGenVideoResponsiveAd.videos).toEqual([{ asset: vids[0].assetOperation.create.resourceName }, { asset: vids[0].assetOperation.create.resourceName }]);
      await expect(propose([{ type: "create_demand_gen_campaign", name: "Bad", daily_budget: 5, ad_groups: [{ name: "x", ads: [{ ...{ headlines: ["a"], long_headlines: ["b"],
        descriptions: ["c"], business_name: "d", logo_image: "https://img.example.com/logo.png", final_url: "https://example.com/" }, videos: ["https://vimeo.com/123"] }] }] }]))
        .rejects.toThrow("isn't a YouTube video id or URL");

      // Performance Max: business name + logo on the campaign (brand guidelines), the rest on the asset group,
      // and text shared between two asset groups is one asset.
      const group = (name: string) => ({ name, final_url: "https://example.com/", headlines: ["Invoices that get paid", "Pay by card", "Start free"],
        long_headlines: ["Send an invoice with a pay button"], descriptions: ["Clients pay by card.", "Free to start."],
        marketing_images: ["https://img.example.com/wide.png"], square_marketing_images: ["https://img.example.com/square.png"] });
      await expect(propose([{ type: "create_performance_max_campaign", name: "P", daily_budget: 5, bidding: "MAXIMIZE_CONVERSION_VALUE", target_cpa: 9,
        business_name: "Acme", logo_images: ["https://img.example.com/logo.png"], asset_groups: [group("a")] }])).rejects.toThrow("target_cpa only goes with MAXIMIZE_CONVERSIONS");
      const pm = await propose([{ type: "create_performance_max_campaign", name: "PMax Test", daily_budget: 25, target_cpa: 12, business_name: "Acme",
        logo_images: ["https://img.example.com/logo.png"], asset_groups: [group("Invoicing"), { ...group("Payments"), videos: ["dQw4w9WgXcQ"] }] }]);
      expect(pm.summary).toContain('Create Performance Max campaign "PMax Test", PAUSED (nothing spends until you enable it): 25.00/day, maximize conversions (target 12.00/conversion)');
      expect(pm.summary).toContain("⚠ bidding for conversions needs working conversion tracking");
      const pops = ads.mutations.at(-1)!.operations;
      expect(pops[1].campaignOperation.create).toMatchObject({ advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: true,
        maximizeConversions: { targetCpaMicros: "12000000" } });
      expect(pops.filter((o: any) => o.campaignAssetOperation).map((o: any) => o.campaignAssetOperation.create.fieldType)).toEqual(["BUSINESS_NAME", "LOGO"]);
      expect(pops.filter((o: any) => o.assetGroupOperation)).toHaveLength(2);
      expect(pops.filter((o: any) => o.assetOperation?.create.textAsset)).toHaveLength(7);  // 3 + 1 + 2 shared texts, plus the business name
      const links = pops.filter((o: any) => o.assetGroupAssetOperation).map((o: any) => o.assetGroupAssetOperation.create.fieldType);
      expect(links.filter((f: string) => f === "HEADLINE")).toHaveLength(6);
      expect(links).toContain("YOUTUBE_VIDEO");
      expect(links).not.toContain("BUSINESS_NAME");
      // Every asset is created before anything links to it.
      const firstLink = pops.findIndex((o: any) => o.campaignAssetOperation || o.assetGroupAssetOperation);
      expect(pops.slice(firstLink).some((o: any) => o.assetOperation)).toBe(false);
      await call(token, "apply_changes", { proposal_id: pm.proposal_id });
      const pu = await call(token, "undo_changes", { proposal_id: pm.proposal_id });
      expect(pu.json.summary).toContain('Remove campaign "PMax Test" that Camberstack created');
      // Applying a removal offers no undo: a removed campaign can't come back.
      const removed = await call(token, "apply_changes", { proposal_id: pu.json.proposal_id });
      expect(removed.json.status).toBe("applied");
      expect(removed.json.undo).toBeUndefined();
    } finally {
      io.fetchImage = real;
    }
  });

  it("tunes bids, ads, bidding, URL suffix and conversion actions, each with an undo", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    const last = () => ads.mutations.filter((m) => !m.validateOnly).at(-1)!;
    const applyUndo = async (id: string) => {
      await call(token, "apply_changes", { proposal_id: id });
      const u = await call(token, "undo_changes", { proposal_id: id });
      return u.json;
    };

    const bid = await propose([{ type: "set_ad_group_bid", ad_group_id: "20", max_cpc: 3 }]);
    expect(bid.summary).toContain('Set default max CPC of ad group "AG" (campaign "Search") from 1.00 to 3.00 ⚠ 3.0× the current bid');
    const bidUndo = await applyUndo(bid.proposal_id);
    expect(bidUndo.summary).toContain("from 3.00 to 1.00");
    await call(token, "apply_changes", { proposal_id: bidUndo.proposal_id });
    expect(ads.agBid).toBe("1000000");

    const kw = await propose([{ type: "set_keyword_bid", ad_group_id: "20", criterion_id: "30", max_cpc: 2 }]);
    expect(kw.summary).toContain("from the ad group's 1.00 to 2.00");
    const kwUndo = await applyUndo(kw.proposal_id);
    expect(kwUndo.summary).toContain("to the ad group's 1.00");
    await call(token, "apply_changes", { proposal_id: kwUndo.proposal_id });
    expect(last().operations[0]).toEqual({ update: { resourceName: "customers/1112223333/adGroupCriteria/20~30" }, updateMask: "cpc_bid_micros" });  // cleared

    const ad = await propose([{ type: "pause_ad", ad_group_id: "20", ad_id: "40" }]);
    expect(ad.summary).toContain('Pause ad 40 (→ https://example.com/old) in ad group "AG"');

    const strat = await propose([{ type: "set_bidding_strategy", campaign_id: "10", strategy: "MAXIMIZE_CLICKS", max_cpc_ceiling: 4 }]);
    expect(strat.summary).toContain('from manual CPC to maximize clicks (max 4.00/click) ⚠ Google re-learns');
    const stratUndo = await applyUndo(strat.proposal_id);
    expect(stratUndo.summary).toContain("back to manual CPC");
    await call(token, "apply_changes", { proposal_id: stratUndo.proposal_id });
    expect(last().operations[0]).toMatchObject({ update: { manualCpc: { enhancedCpcEnabled: false } }, updateMask: "manual_cpc.enhanced_cpc_enabled" });

    // On a shared (portfolio) strategy: one campaign moves off it, and undo puts it back on.
    ads.portfolio = { id: "88", cpa: "30000000" };
    const off = await propose([{ type: "set_bidding_strategy", campaign_id: "10", strategy: "MAXIMIZE_CLICKS" }]);
    expect(off.summary).toContain('from shared strategy "Shared tCPA" to maximize clicks (this campaign only; 1 other campaign stays on "Shared tCPA")');
    const offUndo = await applyUndo(off.proposal_id);
    expect(offUndo.summary).toContain('back to shared strategy "Shared tCPA"');
    await call(token, "apply_changes", { proposal_id: offUndo.proposal_id });
    expect(last().operations[0]).toEqual({ update: { resourceName: "customers/1112223333/campaigns/10", biddingStrategy: "customers/1112223333/biddingStrategies/88" }, updateMask: "bidding_strategy" });
    // The shared strategy itself: every campaign on it is named, and undo restores the old target.
    const sh = await propose([{ type: "set_shared_bid_strategy", bidding_strategy_id: "88", target_cpa: 40 }]);
    expect(sh.summary).toContain('Change shared bid strategy "Shared tCPA": target CPA 30.00 → 40.00 ⚠ applies to every campaign on it (2): "Search", "Brand"');
    await call(token, "apply_changes", { proposal_id: sh.proposal_id });
    expect(last()).toMatchObject({ service: "biddingStrategies", operations: [{ update: { resourceName: "customers/1112223333/biddingStrategies/88",
      targetCpa: { targetCpaMicros: "40000000" } }, updateMask: "target_cpa.target_cpa_micros" }] });
    const shUndo = (await call(token, "undo_changes", { proposal_id: sh.proposal_id })).json;
    expect(shUndo.summary).toContain('Set shared bid strategy "Shared tCPA" back to target CPA 30.00');
    await call(token, "apply_changes", { proposal_id: shUndo.proposal_id });
    expect(last().operations[0]).toEqual({ update: { resourceName: "customers/1112223333/biddingStrategies/88", targetCpa: { targetCpaMicros: "30000000" } },
      updateMask: "target_cpa.target_cpa_micros" });
    await expect(propose([{ type: "set_shared_bid_strategy", bidding_strategy_id: "88", target_roas: 4 }])).rejects.toThrow("TARGET_CPA, which has no target_roas. It takes: target_cpa, max_cpc_ceiling");
    await expect(propose([{ type: "set_shared_bid_strategy", bidding_strategy_id: "99", target_cpa: 4 }])).rejects.toThrow("not found");
    ads.portfolio = undefined;

    // Creating a shared strategy and moving a campaign onto it is one atomic request; undo moves it back, then removes the strategy.
    const mk = await propose([{ type: "create_shared_bid_strategy", name: "Solar tCPA", strategy: "TARGET_CPA", target_cpa: 25, campaign_ids: ["10"] }]);
    expect(mk.summary).toContain('Create shared bid strategy "Solar tCPA" (target CPA 25.00) and move 1 campaign onto it: "Search" (from manual CPC) ⚠');
    await call(token, "apply_changes", { proposal_id: mk.proposal_id });
    expect(last()).toMatchObject({ service: "googleAds", operations: [
      { biddingStrategyOperation: { create: { resourceName: "customers/1112223333/biddingStrategies/-1", name: "Solar tCPA", targetCpa: { targetCpaMicros: "25000000" } } } },
      { campaignOperation: { update: { resourceName: "customers/1112223333/campaigns/10", biddingStrategy: "customers/1112223333/biddingStrategies/-1" }, updateMask: "bidding_strategy" } }] });
    const created = "customers/1112223333/biddingStrategies/500";
    ads.strategyCampaigns = [{ id: "10", name: "Search" }, { id: "12", name: "Other" }];
    expect((await call(token, "undo_changes", { proposal_id: mk.proposal_id })).text).toContain('now also used by "Other"');  // someone else's campaign: refuse
    ads.strategyCampaigns = [{ id: "10", name: "Search" }];
    const mkUndo = (await call(token, "undo_changes", { proposal_id: mk.proposal_id })).json;
    expect(mkUndo.summary).toContain('Remove shared bid strategy "Solar tCPA" that Camberstack created, moving "Search" back to manual CPC');
    await call(token, "apply_changes", { proposal_id: mkUndo.proposal_id });
    expect(last().operations).toEqual([
      { campaignOperation: { update: { resourceName: "customers/1112223333/campaigns/10", manualCpc: { enhancedCpcEnabled: false } }, updateMask: "manual_cpc.enhanced_cpc_enabled" } },
      { biddingStrategyOperation: { remove: created } }]);
    ads.strategyCampaigns = undefined;
    await expect(propose([{ type: "create_shared_bid_strategy", name: "Taken", strategy: "MAXIMIZE_CLICKS" }])).rejects.toThrow("already exists");
    await expect(propose([{ type: "create_shared_bid_strategy", name: "X", strategy: "TARGET_ROAS" }])).rejects.toThrow("TARGET_ROAS needs target_roas");
    await expect(propose([{ type: "create_shared_bid_strategy", name: "X", strategy: "MAXIMIZE_CLICKS", target_cpa: 5 }])).rejects.toThrow("MAXIMIZE_CLICKS has no target_cpa");

    const sfx = await propose([{ type: "set_url_suffix", campaign_id: "10", suffix: "?utm_source=google&utm_term={keyword}" }]);
    expect(sfx.summary).toContain('from none to "utm_source=google&utm_term={keyword}"');

    // The EU political ads declaration: Google refuses every change to an account with an undeclared campaign (prod, 2026-10-22).
    // A first declaration can't be undone (Google has no "not declared" to go back to); a changed one can.
    const eu = await propose([{ type: "set_eu_political_advertising", campaign_id: "10", contains_eu_political_advertising: false }]);
    expect(eu.summary).toContain('Declare that campaign "Search" does not contain EU political advertising (was: not declared)');
    expect(eu.summary).not.toContain("⚠");
    const euApplied = (await call(token, "apply_changes", { proposal_id: eu.proposal_id })).json;
    expect(last().operations).toEqual([{ update: { resourceName: "customers/1112223333/campaigns/10",
      containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" }, updateMask: "contains_eu_political_advertising" }]);
    expect(euApplied.undo).toBeUndefined();
    expect((await call(token, "undo_changes", { proposal_id: eu.proposal_id })).text).toContain("Nothing to undo");
    expect((await call(token, "propose_changes", { customer_id: "1112223333", changes: [{ type: "set_eu_political_advertising", campaign_id: "10",
      contains_eu_political_advertising: false }] })).text).toContain("already in place");
    const euYes = await propose([{ type: "set_eu_political_advertising", campaign_id: "10", contains_eu_political_advertising: true }]);
    expect(euYes.summary).toContain('contains EU political advertising (was: does not contain) ⚠ Google no longer runs political ads in the EU');
    const euBack = await applyUndo(euYes.proposal_id);
    expect(ads.euPolitical).toBe("CONTAINS_EU_POLITICAL_ADVERTISING");
    expect(euBack.summary).toContain('does not contain EU political advertising (was: contains)');
    await call(token, "apply_changes", { proposal_id: euBack.proposal_id });
    expect(ads.euPolitical).toBe("DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");

    // Google refuses the change for want of the declaration: the undeclared campaigns are named, so the AI can propose them.
    const neg = { customer_id: "1112223333", changes: [{ type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "eu", match_type: "PHRASE" }] }] };
    ads.euBlock = [{ id: "10", name: "Search" }];
    const named = (await call(token, "propose_changes", neg)).text;
    expect(named).toContain('Not declared yet: "Search" (id 10)');
    expect(named).toContain("propose set_eu_political_advertising");
    // None reads as missing, yet Google still refuses (prod, 2026-10-22): the AI was left with nothing to propose and stopped.
    // Now it's told the user must answer in Google Ads, and the account state goes to Bugsink.
    ads.euBlock = [];
    const none = (await call(token, "propose_changes", neg)).text;
    ads.euBlock = undefined;
    expect(none).toContain("No campaign shows as missing it through the API");
    expect(none).toContain("in Google Ads");
    expect(none).not.toContain("propose set_eu_political_advertising");
    expect(reportBug).toHaveBeenCalledWith(expect.stringContaining("customer 1112223333, account DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING; "
      + "campaigns not declared: none"), "propose_changes");

    const ca = await propose([{ type: "create_conversion_action", name: "Provider signup", category: "SIGNUP" }]);
    expect(ca.summary).toContain('Create conversion action "Provider signup" (SIGNUP, uploaded click ids, one per click, primary) ⚠');
    // Calls from ads: what a clinic's user built by hand when Google's own call action couldn't be recounted (2026-10-26).
    const calls = await propose([{ type: "create_conversion_action", name: "Calls from ads", category: "PHONE_CALL_LEAD", source: "AD_CALL" }]);
    expect(calls.summary).toContain('Create conversion action "Calls from ads" (PHONE_CALL_LEAD, calls from ads lasting 60s or more, one per click, primary)');
    expect(ads.mutations.at(-1)!.operations[0].create).toMatchObject({ type: "AD_CALL", phoneCallDurationSeconds: "60", countingType: "ONE_PER_CLICK", valueSettings: { alwaysUseDefaultValue: true } });
    expect((await call(token, "propose_changes", { customer_id: "1112223333", changes: [{ type: "create_conversion_action", name: "x", category: "SIGNUP", call_min_seconds: 30 }] })).text)
      .toContain("only for AD_CALL and WEBSITE_CALL");
    const cnt = await propose([{ type: "set_conversion_counting", conversion_action_id: "77", counting: "ONE_PER_CLICK" }]);
    expect(cnt.summary).toContain('"Signup" to count one conversion per click (was MANY_PER_CLICK)');
    // A GA4 import's counting is GA4's: refused before Google is asked, with where to change it.
    const ga4Count = (await call(token, "propose_changes", { customer_id: "1112223333", changes: [{ type: "set_conversion_counting", conversion_action_id: "78", counting: "ONE_PER_CLICK" }] })).text;
    expect(ga4Count).toContain('"Site (web) generate_lead" is imported (GOOGLE_ANALYTICS_4_CUSTOM)');
    expect(ga4Count).toContain("Change counting method");

    // Importing a GA4 key event enables Google's HIDDEN copy; Google can't hide it again, so undo removes it, and undoing that re-enables it.
    const imp = await propose([{ type: "import_ga4_key_event", property_id: "321", event_name: "generate_lead" }]);
    expect(imp.summary).toContain('Import GA4 key event "generate_lead" into Google Ads as "Site (web) generate_lead" (SUBMIT_LEAD_FORM, primary)');
    expect(imp.summary).toContain("⚠");
    await call(token, "apply_changes", { proposal_id: imp.proposal_id });
    expect(last().operations).toEqual([{ update: { resourceName: "customers/1112223333/conversionActions/90", status: "ENABLED", primaryForGoal: true },
      updateMask: "status,primary_for_goal" }]);
    expect((await call(token, "propose_changes", { customer_id: "111-222-3333", changes: [{ type: "import_ga4_key_event", property_id: "321", event_name: "generate_lead" }] })).text)
      .toContain("already in place");
    expect([ads.acctGoals.SUBMIT_LEAD_FORM, ads.goals.SUBMIT_LEAD_FORM]).toEqual([true, true]);
    // A campaign bidding only on the import's category can't be left with no goal: refused with what to do.
    const others = { ...ads.goals };
    ads.goals = { SUBMIT_LEAD_FORM: true, PURCHASE: false };
    expect((await call(token, "undo_changes", { proposal_id: imp.proposal_id })).text).toContain('"Search" bid only on SUBMIT_LEAD_FORM conversions');
    ads.goals = others;
    const impUndo = (await call(token, "undo_changes", { proposal_id: imp.proposal_id })).json;
    expect(impUndo.summary).toContain('Remove conversion action "Site (web) generate_lead" from Google Ads');
    expect(impUndo.summary).toContain(`and stop bidding on SUBMIT_LEAD_FORM conversions in the account's default goals and in campaign(s) "Search", which bid on them since the import`);
    await call(token, "apply_changes", { proposal_id: impUndo.proposal_id });
    expect(last()).toMatchObject({ service: "googleAds", operations: [
      { conversionActionOperation: { remove: "customers/1112223333/conversionActions/90" } },
      { customerConversionGoalOperation: { update: { resourceName: "customers/1112223333/customerConversionGoals/SUBMIT_LEAD_FORM~WEBSITE", biddable: false }, updateMask: "biddable" } },
      { campaignConversionGoalOperation: { update: { resourceName: "customers/1112223333/campaignConversionGoals/10~SUBMIT_LEAD_FORM~WEBSITE", biddable: false }, updateMask: "biddable" } }] });
    expect([ads.ga4Lead.status, ads.acctGoals.SUBMIT_LEAD_FORM, ads.goals.SUBMIT_LEAD_FORM]).toEqual(["REMOVED", false, false]);
    const redo = (await call(token, "undo_changes", { proposal_id: impUndo.proposal_id })).json;
    expect(redo.summary).toContain('Import GA4 key event "generate_lead"');
    await call(token, "apply_changes", { proposal_id: redo.proposal_id });
    expect(ads.ga4Lead).toMatchObject({ status: "ENABLED", primaryForGoal: true });
    ads.ga4Lead = { status: "HIDDEN", primaryForGoal: false };
    delete ads.goals.SUBMIT_LEAD_FORM; delete ads.acctGoals.SUBMIT_LEAD_FORM;
    await expect(propose([{ type: "import_ga4_key_event", property_id: "321", event_name: "sign_up" }])).rejects.toThrow(/no conversion action for "sign_up".*link_google_ads/);
    // Marked as a key event but never applied (ChatGPT, prod 2026-10-25): the error names the open proposal to apply first.
    const mark = await call(token, "propose_analytics_changes", { changes: [{ type: "mark_key_event", property_id: "321", event_name: "sign_up" }] });
    if (mark.isError) throw new Error(mark.text);
    await expect(propose([{ type: "import_ga4_key_event", property_id: "321", event_name: "sign_up" }]))
      .rejects.toThrow(`Proposal ${mark.json.proposal_id} would do that but hasn't been applied`);
    await call(token, "discard_proposal", { proposal_id: mark.json.proposal_id });
  });

  it("uploads one conversion for a first connection that came from our ad, and none otherwise", async () => {
    // A visitor lands from an ad: the click id is kept in a first-party cookie and the page isn't shared-cached.
    const land = await fetch(`${base}/google-ads-claude?gclid=Cj0KCQtest_click_1234`);
    expect(land.headers.get("set-cookie")).toMatch(/cs_click=gclid:Cj0KCQtest_click_1234;.*HttpOnly/);
    expect(land.headers.get("cache-control")).toContain("private");
    const cookie = "cs_click=gclid:Cj0KCQtest_click_1234";

    // An existing user reconnecting from the ad: cookie cleared, nothing uploaded.
    await connect(cookie);
    expect(lastCallbackCookies).toContain("cs_click=;");
    await new Promise((r) => setTimeout(r, 20));
    expect(conversionUploads).toHaveLength(0);

    // A brand-new user connecting from the ad: exactly one upload, to OUR account and action.
    googleUser.sub = "google-sub-ads"; googleUser.email = "new@example.com";
    try { await connect(cookie); } finally { googleUser.sub = "google-sub-1"; googleUser.email = "Owner@Example.com"; }
    await new Promise((r) => setTimeout(r, 50));
    expect(conversionUploads).toHaveLength(1);
    const c = conversionUploads[0];
    expect(c).toMatchObject({ auth: "Bearer crk_ours", conversion_action_id: "555", gclid: "Cj0KCQtest_click_1234" });
    expect(c.conversion_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(db.prepare("SELECT uploaded_at FROM ad_conversions").get()).toMatchObject({ uploaded_at: expect.any(Number) });
    // Nothing about the user travels with it.
    expect(JSON.stringify(conversionUploads)).not.toContain("new@example.com");
  });

  it("selects a field Google says WHERE or ORDER BY needs, and reruns", async () => {
    const r = await call(token, "run_gaql", { customer_id: "1112223333", query: "SELECT campaign.name FROM campaign ORDER BY campaign.status" });
    expect(r.isError).toBeFalsy();
    expect(r.json.added_to_select).toContain("campaign.status");
  });

  it("refuses write GAQL", async () => {
    const r = await call(token, "run_gaql", { customer_id: "1112223333", query: "UPDATE campaign SET x" });
    expect(r.isError).toBe(true);
  });

  it("serves protected-resource metadata at the root path too, identical to the SDK's", async () => {
    const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    const sdk = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(root).toEqual(sdk);
    // Issuer is the bare origin (no trailing slash), and the two documents agree on it.
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.issuer).toBe(new URL(base).origin);
    expect(sdk.authorization_servers).toEqual([as.issuer]);
    expect(as.token_endpoint).toBe(`${new URL(base).origin}/token`);
    expect((await fetch(`${base}/geo-audit`)).status).toBe(410);
    expect((await fetch(`${base}/.well-known/glama.json`)).status).toBe(404);
  });

  it("documents every registered tool on /tools and in llms.txt", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listed = (await res.json()).result.tools;
    const names: string[] = listed.map((t: any) => t.name);
    // /tools shows each parameter's description, so every one needs one.
    for (const t of listed) for (const [k, v] of Object.entries<any>(t.inputSchema.properties ?? {})) expect(v.description, `${t.name}.${k}`).toBeTruthy();
    const page = await (await fetch(`${base}/tools`)).text();
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    for (const n of names) {
      expect(page, n).toContain(`id="${n}"`);
      expect(llms, n).toContain(n);
    }
    expect(page).toContain(`${names.length} tools`);
    // Parameters come from the schemas: defaults and descriptions, not hand-written copy.
    expect(page).toContain("<code>location_ids</code>");
    expect(page).toContain("Default [&quot;2840&quot;].");
    expect(page).toContain("https://github.com/zwznco/camberstack-mcp");
    expect(page).toContain('<span class="pill act">Needs your go-ahead</span>');
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/tools`);
    // The changelog: every release from changelog.ts, the newest matching the version the server reports, and in the sitemap.
    const cl = await (await fetch(`${base}/changelog`)).text();
    expect(cl).toContain(`id="v${SERVER_VERSION}"`);
    expect(cl).toContain("<strong>Shared (portfolio) bid strategies.</strong>");
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/changelog`);
  });

  it("serves /docs and points the OAuth metadata's documentation at it", async () => {
    const d = await fetch(`${base}/docs`);
    expect(d.status).toBe(200);
    const html = await d.text();
    expect(html).toContain("<h1>Camberstack documentation</h1>");
    expect(html).toContain(`${base}/mcp`);
    expect(html).toContain("under its own developer-token access, with the user's Google OAuth consent");
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/docs`);
    expect(await (await fetch(`${base}/llms.txt`)).text()).toContain(`${base}/docs`);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(prm.resource_documentation).toBe(`${base}/docs`);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.service_documentation).toBe(`${base}/docs`);
  });

  it("serves the ChatGPT plugin domain token as bare plain text", async () => {
    const r = await fetch(`${base}/.well-known/openai-apps-challenge`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(await r.text()).toBe("tok_test_123");
  });

  it("serves the Search Console page, listed and linked", async () => {
    const r = await fetch(`${base}/google-search-console-mcp`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<h1>Google Search Console MCP server</h1>");
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/google-search-console-mcp`);
    expect(await (await fetch(`${base}/llms.txt`)).text()).toContain(`${base}/google-search-console-mcp`);
    expect(await (await fetch(`${base}/`)).text()).toContain('href="/google-search-console-mcp"');
  });

  it("serves the Claude guide and lists it in the sitemap", async () => {
    const g = await fetch(`${base}/google-ads-claude`);
    expect(g.status).toBe(200);
    const html = await g.text();
    expect(html).toContain("<h1>Connect Google Ads to Claude</h1>");
    expect(html).toContain(`${base}/mcp`);
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/google-ads-claude`);
    expect(await (await fetch(`${base}/`)).text()).toContain('href="/google-ads-claude"');
    const c = await fetch(`${base}/google-ads-chatgpt`);
    expect(c.status).toBe(200);
    const chatgpt = await c.text();
    // ChatGPT setup goes through the published plugin, not developer mode.
    expect(chatgpt).toContain('href="https://chatgpt.com/plugins/plugin_asdk_app_6ad5f787afc88191b997b629bbb30866"');
    expect(chatgpt).not.toContain("Developer mode");
    const claude = await (await fetch(`${base}/google-ads-claude`)).text() + await (await fetch(`${base}/google-ads-chatgpt`)).text()
      + await (await fetch(`${base}/google-ads-gemini`)).text();
    for (const m of claude.matchAll(/src="(\/shots\/[^"]+)"/g)) {
      const img = await fetch(`${base}${m[1]}`);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toContain("image/webp");
    }
    // Claude setup goes through the connector directory, not a custom connector.
    const dir = await (await fetch(`${base}/google-ads-claude`)).text();
    expect(dir).toContain('href="https://claude.ai/directory/connectors/camberstack"');
    expect(dir).not.toContain("paste the server URL");
    // The Reddit "demo" ad lands here, so the demo is on the first screen, under a button to the directory.
    const firstScreen = dir.split('<h2 id="setup">Set it up</h2>')[0];
    expect(firstScreen).toContain('<a class="btn btn-lg" href="https://claude.ai/directory/connectors/camberstack">');
    expect(firstScreen).toContain("Show me Camberstack's demo account");
    // Error messages are troubleshot once, on /docs, in the words users see; each guide keeps its own app's fix and links there,
    // so the two guides don't repeat each other (Google declined to index them while they were 54% identical).
    const cg = await (await fetch(`${base}/google-ads-claude`)).text(), gg = await (await fetch(`${base}/google-ads-chatgpt`)).text();
    const docs = await (await fetch(`${base}/docs`)).text();
    for (const msg of ["NOT_ADS_USER", "TWO_STEP_VERIFICATION_NOT_ENROLLED", "The account changed since it was proposed", "Plan limit", "sufficient permission for site"])
      expect(docs).toContain(msg);
    for (const g of [cg, gg]) {
      expect(g).toContain('href="/docs#troubleshooting"');
      expect(g).not.toContain("TWO_STEP_VERIFICATION_NOT_ENROLLED");
    }
    expect(cg).toContain("turn Camberstack on");
    expect(gg).toContain("@Camberstack how did my campaigns");
    expect((await fetch(`${base}/shots/..%2Fserver.ts`)).status).toBe(404);
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/google-ads-chatgpt`);
    expect(await (await fetch(`${base}/`)).text()).toContain('href="/google-ads-chatgpt"');
    expect(claude).toContain('src="/shots/gemini-3.webp"');
    // Gemini doesn't complete the connection yet: the guide stays up but unlisted.
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).not.toContain(`${base}/google-ads-gemini`);
    expect(await (await fetch(`${base}/`)).text()).not.toContain('href="/google-ads-gemini"');
    expect(await (await fetch(`${base}/google-ads-gemini`)).text()).toContain('<meta name="robots" content="noindex">');
  });

  it("hands back a Gemini-sized state (~1.4k chars, base64url) byte for byte", async () => {
    const state = randomBytes(1050).toString("base64url");
    expect(await connect(undefined, state)).toBeTruthy();
  });

  it("registers Gemini's relay as a public client, everyone else with a secret", async () => {
    const reg = (redirect_uris: string[]) => fetch(`${base}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris, client_name: "Google", token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const g = await reg(["oauth-redirect", "oauth-redirect-sandbox", "oauth-redirect-test"].flatMap((h) =>
      ["r", "a"].map((k) => `https://${h}.googleusercontent.com/${k}/user_bound_custom-mcp-1-camberstack_io`)));
    expect(g.status).toBe(201);
    expect(g.body.token_endpoint_auth_method).toBe("none");
    expect(g.body.client_secret).toBeUndefined();
    const other = await reg(["https://claude.ai/api/mcp/auth_callback"]);
    expect(other.body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(other.body.client_secret).toBeTruthy();
    const mixed = await reg(["https://oauth-redirect.googleusercontent.com/r/x", "https://evil.example/cb"]);
    expect(mixed.body.client_secret).toBeTruthy();
  });

  it("serves the pages Google's brand verification reads", async () => {
    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain('href="/privacy"');
    const privacy = await (await fetch(`${base}/privacy`)).text();
    expect(privacy).toContain("Limited Use");
    expect(privacy).toContain("auth/adwords");
    const logo = await fetch(`${base}/logo.png`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/png");
  });

  it("with FREE_ONE_SERVICE, covers one Google service on Free: the demo is free, another service waits or needs Pro", async () => {
    googleUser.sub = "google-sub-one-service"; googleUser.email = "oneservice@example.com";
    deps.freeOneService = true;
    try {
      const t = await connect();
      const uid = (db.prepare("SELECT id FROM users WHERE google_sub = ?").get("google-sub-one-service") as { id: string }).id;
      // The demo site uses no service, so it doesn't pick one.
      expect((await call(t, "search_console_summary", { site_url: "sc-domain:northwind-plumbing.example", days: 28 })).isError).toBe(false);
      expect((await call(t, "billing")).json).toMatchObject({ plan: "free", service_in_use: null, services_included: 1 });
      // The first real call asks instead of picking: nothing runs, nothing is taken, and it isn't an error.
      expect((await call(t, "switch_account", { customer_id: "111-222-3333" })).isError).toBe(false);
      const ask = await call(t, "account_overview", { customer_id: "111-222-3333", days: 30 });
      expect(ask.isError).toBe(false);
      expect(ask.json).toMatchObject({ stop: "service_choice", this_call_uses: "Google Ads" });
      expect(ask.text).toContain("Service choice: The Free plan covers one Google service at a time");
      expect((await call(t, "billing")).json.service_in_use).toBeNull();
      // The next real call is the user's answer and takes the plan.
      expect((await call(t, "account_overview", { customer_id: "111-222-3333", days: 30 })).json.campaigns).toBeDefined();
      const sc1 = await call(t, "search_console_summary", { site_url: "sc-domain:acme.test", days: 28 });
      expect(sc1.isError).toBe(false);  // a stop, not a failure
      expect(sc1.json).toMatchObject({ stop: "service_limit", service_in_use: "Google Ads", service_requested: "Search Console" });
      expect(sc1.text).toContain("Service limit: the Free plan covers one Google service at a time");
      expect(sc1.text).toContain("Pro ($15/month) covers all three together");
      // A refused call takes nothing: Ads still works, and billing names it.
      expect((await call(t, "account_overview", { customer_id: "111-222-3333", days: 30 })).json.campaigns).toBeDefined();
      const plan = (await call(t, "billing")).json;
      expect(plan).toMatchObject({ service_in_use: "Google Ads" });
      expect(plan.included).toContain("1 Google service at a time");
      expect(plan.pro).toContain("Google Ads, Search Console and Google Analytics together");
      // A reset by hand clears it: Search Console becomes the one, and Ads waits.
      db.prepare("UPDATE users SET plan_reset_at = ? WHERE id = ?").run(now() + 1, uid);
      await new Promise((r) => setTimeout(r, 1100));
      expect((await call(t, "search_console_summary", { site_url: "sc-domain:acme.test", days: 28 })).json.stop).toBe("service_choice");
      expect((await call(t, "search_console_summary", { site_url: "sc-domain:acme.test", days: 28 })).json.current).toBeDefined();
      expect((await call(t, "account_overview", { customer_id: "111-222-3333", days: 30 })).text).toContain("this login uses it for Search Console");
      // Paid plans cover all three.
      db.prepare("UPDATE users SET plan = 'pro' WHERE id = ?").run(uid);
      expect((await call(t, "account_overview", { customer_id: "111-222-3333", days: 30 })).isError).toBe(false);
    } finally {
      deps.freeOneService = false;
      googleUser.sub = "google-sub-1"; googleUser.email = "Owner@Example.com";
      const u = db.prepare("SELECT id FROM users WHERE google_sub = ?").get("google-sub-one-service") as { id: string } | undefined;
      // Every table keyed by user, so later tests see only the users they made.
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
        .filter((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "user_id"));
      if (u) for (const t of tables) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u.id);
      db.prepare("DELETE FROM users WHERE google_sub = ?").run("google-sub-one-service");
    }
  });

  it("describes whichever Free plan is live on /plans", () => {
    const off = plansPage("https://x.test", { freeOneService: false }), on = plansPage("https://x.test", { freeOneService: true });
    expect(off).toContain("on <strong>1 Google Ads account</strong> at a time");
    expect(off).toContain("Search Console and Google Analytics are included and don't count");
    expect(on).toContain("<strong>one Google service at a time</strong>");
    expect(on).toContain("Google Ads, Search Console and Google Analytics together, on <strong>up to 5 Google Ads accounts</strong>");
    // The body (the site header's nav is every page's): nothing that starts an upgrade or links the account page.
    for (const h of [off, on]) expect(h.slice(h.indexOf('<div class="legal">'))).not.toMatch(/upgrade=|Upgrade to|href="\/account/i);
  });

  it("names the Google services a call uses: none for the demo, listings, lookups and proposal bookkeeping", () => {
    expect(servicesOf("run_gaql", { customer_id: "111-222-3333", query: "SELECT campaign.id FROM campaign" })).toEqual(["ads"]);
    expect(servicesOf("run_gaql", { customer_id: "0000000001", query: "SELECT campaign.id FROM campaign" })).toEqual([]);
    expect(servicesOf("run_gaql", { customer_id: "111-222-3333", query: "SELECT name, category WHERE name LIKE 'campaign.%'" })).toEqual([]);
    expect(servicesOf("search_console_sites", {})).toEqual([]);
    expect(servicesOf("search_console_trend", { site_url: "sc-domain:acme.test" })).toEqual(["search_console"]);
    expect(servicesOf("analytics_report", { property_id: "123" })).toEqual(["analytics"]);
    expect(servicesOf("analytics_report", { property_id: "000000001" })).toEqual([]);
    expect(servicesOf("analytics_properties", {})).toEqual([]);
    expect(servicesOf("propose_mark_key_event", { property_id: "123" })).toEqual(["analytics"]);
    expect(servicesOf("propose_analytics_changes", { changes: [{ type: "create_ga4_property" }] })).toEqual(["analytics"]);
    expect(servicesOf("paid_organic_overlap", { customer_id: "111-222-3333", site_url: "sc-domain:acme.test" })).toEqual(["ads", "search_console"]);
    for (const n of ["apply_changes", "undo_changes", "change_history", "list_accounts", "switch_account", "billing"])
      expect(servicesOf(n, { customer_id: "111-222-3333" })).toEqual([]);
  });

});

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt(key, "secret"), b = encrypt(key, "secret");
    expect(a).not.toBe(b);
    expect(decrypt(key, a)).toBe("secret");
  });
});
