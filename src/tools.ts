import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ListToolsResult, ToolAnnotations } from "@modelcontextprotocol/server";
import { MAX_CHANGES, PUBLIC_CHANGES, PublicChangeSchema } from "./changes.js";
import { landingPages, listProperties, report } from "./ga4.js";
import { fieldQuery, queryShape } from "./gaql.js";
import { GA_TARGET, PUBLIC_GA_CHANGES, PublicGaChangeSchema, gaSetup } from "./ga4-changes.js";
import { ACCOUNT_WINDOW_DAYS, PlanLimitError } from "./plans.js";
import { isDemo, type Account, type UserSession } from "./session.js";
import { isUnexpected, reportError } from "./sentry.js";

const SERVER_NAME = "camberstack";
export const SERVER_VERSION = "0.17.0";

const INSTRUCTIONS = `Camberstack connects the user's Google Ads account.
Start with list_accounts. Answer the user's questions with account_overview and run_gaql (read-only). To change something: propose_changes → show the user the summary and ask for approval → apply_changes.
Never call apply_changes unless the user has explicitly approved that specific proposal in this conversation. Every applied proposal can be reversed with undo_changes.
Each Google service is added separately: when a result says one isn't part of the connection, give the user its grant_url (one click adds it); never tell them to reconnect.
For keyword_ideas and keyword_metrics, pass the account's own market: location_ids default to the United States.
Search Console is read-only: lead with search_console_summary (per-query rows leave out rare queries). Camberstack can't request indexing or submit sitemaps: the user does that in Search Console.
Account 000-000-0001 is a demo with sample data: anyone can try every tool on it, and changes there never touch Google. Always say when you are using it.`;

/** ChatGPT's connections have no propose_changes or undo_changes: one propose_<operation> tool per change, and propose_undo. */
const CHATGPT_INSTRUCTIONS = INSTRUCTIONS
  .replace("propose_changes → show", "the propose_<operation> tool for that change (propose_pause_campaign, propose_set_daily_budget, …) → show")
  .replace("reversed with undo_changes", "reversed with propose_undo (a proposal like any other: approve, then apply_changes)");

/** Tools that read or propose on one Google Ads account, so count toward the plan's accounts (session.ts checkAccount). */
const GATED = new Set(["account_overview", "run_gaql", "keyword_ideas", "keyword_metrics", "propose_changes", "paid_organic_overlap", "switch_account",
  ...PUBLIC_CHANGES.map((c) => `propose_${c.shape.type.value}`)]);

/** A run_gaql field lookup reads Google's field catalog, not the account named: no plan gate, and no account in the log. */
const isLookup = (name: string, a: unknown) => {
  const q = (a as { query?: unknown } | undefined)?.query;
  return name === "run_gaql" && typeof q === "string" && fieldQuery(q) !== null;
};

/**
 * Callable but not listed. gaql_fields moved into run_gaql (a SELECT with no FROM), since most apps never listed or
 * called it; apps that still hold it keep a working tool, because a failed call counts against the directory listings.
 */
const UNLISTED = new Set(["gaql_fields"]);

const customerId = z.string().describe("Google Ads customer ID, with or without dashes (from list_accounts)");
const locationIds = z.array(z.string().regex(/^\d+$/)).min(1).max(10).default(["2840"])
  .describe("Google geo target IDs. 2840 United States, 2826 United Kingdom, 2124 Canada, 2036 Australia, 2356 India. "
    + "For a state, city or other country, look the ID up with run_gaql: SELECT geo_target_constant.id, geo_target_constant.canonical_name "
    + "FROM geo_target_constant WHERE geo_target_constant.name = 'Denver'");
const languageId = z.string().regex(/^\d+$/).default("1000")
  .describe("Google language ID. 1000 English, 1003 Spanish, 1002 French, 1001 German, 1014 Portuguese");
const siteUrl = z.string().min(1).describe("Search Console property exactly as search_console_sites lists it, e.g. sc-domain:example.com or https://www.example.com/");
const days = z.number().int().min(1).max(365).default(30).describe("Look-back window in days, ending yesterday");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Window options shared by the Search Console tools: a day count, or exact dates; optionally Google's not-yet-final recent days. */
const scWindowShape = (defaultDays: number, maxDays: number) => ({
  days: z.number().int().min(1).max(maxDays).default(defaultDays).describe("Look-back window in days, ending 3 days ago (yesterday with fresh)"),
  start_date: ymd.optional().describe("Exact first day, YYYY-MM-DD. Pass with end_date to use exact dates instead of days"),
  end_date: ymd.optional().describe("Exact last day, YYYY-MM-DD"),
  fresh: z.boolean().default(false).describe("Include the last 2-3 days, which Google is still filling in (they read low). Use to check something from the last few days"),
});
const propertyId = z.string().regex(/^\d+$/, "digits only").describe("GA4 property id, digits only (from analytics_properties)");
/** Window options shared by the Google Analytics tools: a day count ending yesterday, or exact dates. */
const gaWindowShape = {
  days: z.number().int().min(1).max(540).default(28).describe("Look-back window in days, ending yesterday"),
  start_date: ymd.optional().describe("Exact first day, YYYY-MM-DD. Pass with end_date to use exact dates instead of days"),
  end_date: ymd.optional().describe("Exact last day, YYYY-MM-DD"),
};
type GaWindow = { days: number; start_date?: string; end_date?: string };
const excludeQueryRegex = z.string().min(1).max(500).optional()
  .describe("Leave out queries matching this RE2 regex, typically the brand name, e.g. (?i)acme|ac me");

/** Past this, indentation is most of the reply (a 100-row table pretty-printed is one number per line): send it on one line. */
const PRETTY_MAX = 20_000;
function ok(data: unknown) {
  const pretty = JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: pretty.length > PRETTY_MAX ? JSON.stringify(data) : pretty }] };
}
function fail(e: unknown) {
  // A plan limit carries its facts as fields (plans.ts PlanLimitError); the first line stays the sentence logs match on.
  const detail = e instanceof PlanLimitError ? `\n${JSON.stringify(e.detail, null, 2)}` : "";
  return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}${detail}` }], isError: true };
}

export interface ToolCall {
  tool: string;
  customerId: string | null;
  ok: boolean;
  error: string | null;
  ms: number;
  bytes: number;
  /** run_gaql only: gaql.ts queryShape, never the values. */
  queryShape?: string | null;
}

/** What the /tools page and llms.txt show about each tool; filled as buildServer registers them. */
export interface ToolDoc { name: string; title: string; description: string; inputSchema?: z.ZodRawShape; annotations: ToolAnnotations }

export function buildServer(session: () => UserSession, log: (c: ToolCall) => void = () => {}, catalog: ToolDoc[] = [],
  o: { chatgpt?: boolean } = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: o.chatgpt ? CHATGPT_INSTRUCTIONS : INSTRUCTIONS });
  const wrap = <A>(name: string, fn: (a: A) => Promise<unknown> | unknown) => {
    return async (a: A) => {
      const t0 = Date.now();
      const lookup = isLookup(name, a);
      const cid = lookup ? undefined : (a as { customer_id?: unknown } | undefined)?.customer_id;
      let out: ReturnType<typeof ok> | ReturnType<typeof fail>;
      let release = () => {};
      try {
        if (GATED.has(name) && typeof cid === "string")
          // Only switch_account may spend the plan's switch: the read tools stay free of side effects.
          release = await session().checkAccount(cid, name === "switch_account");
        out = ok(await fn(a));
      } catch (e) {
        out = fail(e);
        if (isUnexpected(e)) reportError(e, name);
      }
      try {
        log({
          tool: name, customerId: typeof cid === "string" ? cid.replace(/-/g, "") : null,
          ok: !("isError" in out), error: "isError" in out ? out.content[0]!.text.slice(7, 1007) : null,
          ms: Date.now() - t0, bytes: out.content[0]!.text.length,
          queryShape: name === "run_gaql" && typeof (a as { query?: unknown })?.query === "string" ? queryShape((a as { query: string }).query) : null,
        });
      } catch { /* logging must never break a tool */ }
      release();  // after the log: the account now counts as used from tool_calls instead
      return out;
    };
  };
  // annotations.title repeats each tool's title: Claude's connector directory reads the name from there.
  // `as never`: registerTool infers its handler type from a literal inputSchema, which a helper cannot pass through.
  const tool = <A>(name: string, config: { title: string; description: string; inputSchema?: z.ZodRawShape; annotations: ToolAnnotations },
    fn: (a: A) => Promise<unknown> | unknown) => (UNLISTED.has(name) || catalog.push({ name, ...config }),
    server.registerTool(name, {
      ...config,
      inputSchema: config.inputSchema && z.object(config.inputSchema),
      annotations: { ...config.annotations, title: config.title },
    }, wrap(name, fn) as never));
  // Every tool sets all three hints (publish.test.ts): ChatGPT's plugin review rejects an unset one.
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

  tool("list_accounts", {
    title: "List Google Ads accounts",
    description: "Lists every Google Ads account this login can reach, including client accounts under a manager (MCC). Start here. "
      + "When the user's plan is at its limit, each account also says whether the plan covers it (plan_status: active, switch or locked).",
    annotations: read,
  }, async () => {
    const s = session();
    const accounts = await s.accounts({ fresh: true });
    const demo = accounts.some((a) => isDemo(a.customerId));
    const grantUrl = s.lastUnreadable.find((u) => u.grant_url)?.grant_url;
    // Only a plan at its limit says anything: until then every account is open, and there's nothing to explain.
    const st = s.planState(new Set(accounts.filter((a) => a.manager).map((a) => a.customerId)));
    const counted = (a: Account) => !a.manager && !isDemo(a.customerId);
    const status = (c: string) => (st.active.includes(c) ? "active" : st.allows(c) ? "switch" : "locked");
    return {
      accounts: st.full ? accounts.map((a) => counted(a) ? { ...a, plan_status: status(a.customerId) } : a) : accounts,
      ...(st.full && accounts.some((a) => counted(a) && !st.active.includes(a.customerId)) ? { plan: {
        plan: s.isPro ? "pro" : "free", accounts_included: s.accountLimit, active_accounts: st.active,
        switching: st.canSwitch
          ? `One switch per ${ACCOUNT_WINDOW_DAYS} days: using a "switch" account makes it active and locks ${st.active.at(-1)}, `
            + "switching back included. Nothing is spent until the user agrees and switch_account is called."
          : `This ${ACCOUNT_WINDOW_DAYS}-day switch is used; locked accounts open up from ${st.switchOpens}`
            + (s.isPro || s.chatgpt ? "." : ", or on Pro, which covers more (the billing tool has the upgrade link)."),
      } } : {}),
      ...(s.lastUnreadable.length ? { unreadable: s.lastUnreadable } : {}),
      // Google Ads wasn't granted (connected for Search Console only): one link adds it, nothing to reconnect.
      ...(grantUrl ? { grant_url: grantUrl, note: `The user IS connected, as ${s.user.email}, but without Google Ads access, so only the demo `
        + "account (sample data) is offered. Tell the user plainly, and give them grant_url: it adds Google Ads to this connection." }
      // Without "signed in as", models read demo-only as "not signed in" and send the user to reconnect, which changes nothing.
      : demo ? { note: `The user IS connected and signed in, as ${s.user.email}; there is nothing to reconnect. That Google login has no `
        + "readable Google Ads account, so only the demo account (sample data, a fictional business) is offered. Tell the user plainly that "
        + "it is a demo, and if `unreadable` is present, explain why their real accounts are missing. To use a real account: give "
        + `${s.user.email} access in Google Ads (Admin, then Access and security), or disconnect and connect again with the Google login that has it.` } : {}),
    };
  });

  tool("account_overview", {
    title: "Account overview",
    description: "Spend, clicks, conversions and cost per conversion per campaign over a window.",
    inputSchema: { customer_id: customerId, days },
    annotations: read,
  }, ({ customer_id, days }: { customer_id: string; days: number }) => session().overview(customer_id, days));

  tool("run_gaql", {
    title: "Run a read-only GAQL query",
    description: "Runs any read-only Google Ads Query Language SELECT for questions the other tools don't cover. Returns up to 500 rows. "
      + "Google rejects queries that break these rules: selecting or segmenting by segments.date needs a finite range in WHERE "
      + "(segments.date DURING LAST_30_DAYS, or BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'); click_view needs a single day (segments.date = 'YYYY-MM-DD'); "
      + "every field used in WHERE or ORDER BY must also be in SELECT. "
      + "Unsure of a field's name or whether it fits this FROM? Look it up first with a query that has no FROM, which reads Google's field "
      + "catalog instead of the account (any customer_id): SELECT name, category, selectable WHERE name LIKE '%search_term%', or "
      + "SELECT attribute_resources, metrics, segments WHERE name = 'campaign' for what can be used FROM campaign.",
    inputSchema: { customer_id: customerId, query: z.string().describe("A GAQL SELECT statement") },
    annotations: read,
  }, ({ customer_id, query }: { customer_id: string; query: string }) => session().runQuery(customer_id, query));

  tool("gaql_fields", {
    title: "Look up GAQL fields",
    description: "Looks fields up in Google's own field catalog for the API version run_gaql uses, so queries name real fields. "
      + "With resource (e.g. campaign, ad_group, keyword_view, bidding_strategy): that resource's fields, the resources whose fields can also be "
      + "selected FROM it, and the metrics and segments it takes. With search alone: matching field names anywhere, e.g. search=\"cpc_bid_ceiling\". "
      + "search narrows a resource's lists too (any of its words). Use it before run_gaql whenever unsure of a name. No account needed.",
    inputSchema: {
      resource: z.string().max(100).optional().describe("A resource to query FROM, e.g. campaign"),
      search: z.string().max(200).optional().describe("Words that must appear in the field name, e.g. \"bidding target\""),
    },
    annotations: read,
  }, ({ resource, search }: { resource?: string; search?: string }) => session().gaqlFields({ resource, search }));

  tool("keyword_ideas", {
    title: "Keyword ideas (Keyword Planner)",
    description: "Google Keyword Planner ideas from seed keywords and/or a landing-page URL: average monthly searches, competition and the top-of-page bid range in the account's currency, biggest first. Ideas the account already targets, or already blocks as negatives, are marked in_account. Changes nothing.",
    inputSchema: {
      customer_id: customerId,
      keywords: z.array(z.string().min(1).max(80)).max(20).optional().describe("Up to 20 seed keywords"),
      url: z.string().url().optional().describe("A page to pull ideas from, such as the ad's landing page"),
      location_ids: locationIds, language_id: languageId,
      min_searches: z.number().int().min(0).default(0).describe("Drop ideas below this many average monthly searches"),
      limit: z.number().int().min(1).max(200).default(50).describe("Most ideas to return"),
    },
    annotations: read,
  }, ({ customer_id, ...o }: { customer_id: string; keywords?: string[]; url?: string; location_ids: string[]; language_id: string; min_searches: number; limit: number }) =>
    session().keywordIdeas(customer_id, o));

  tool("keyword_metrics", {
    title: "Keyword volume and bids (Keyword Planner)",
    description: "Google Keyword Planner numbers for an exact list of keywords: average monthly searches, the last 12 months, competition and the top-of-page bid range in the account's currency. Use it to size keywords before adding them or to check a trend. "
      + "Up to 100 keywords come back as one object each; over 100, as a compact table (columns, months, rows). Changes nothing.",
    inputSchema: {
      customer_id: customerId,
      keywords: z.array(z.string().min(1).max(80)).min(1).max(500).describe("Keywords to look up, up to 500"),
      location_ids: locationIds, language_id: languageId,
    },
    annotations: read,
  }, ({ customer_id, ...o }: { customer_id: string; keywords: string[]; location_ids: string[]; language_id: string }) =>
    session().keywordMetrics(customer_id, o));

  tool("search_console_sites", {
    title: "List Search Console sites",
    description: "Lists the websites (Search Console properties) this Google login can read. Use a site_url from here in the other Search Console tools.",
    annotations: read,
  }, () => session().searchConsoleSites());

  tool("search_console_summary", {
    title: "Search Console summary",
    description: "A website's total organic Google Search clicks, impressions, CTR and average position over a window, next to the same "
      + "number of days before it, with the change. Site-wide totals, more complete than adding up per-query rows. Changes nothing.",
    inputSchema: { site_url: siteUrl, ...scWindowShape(28, 240) },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean }) => session().searchConsoleSummary(site_url, o));

  tool("search_console_performance", {
    title: "Search Console performance",
    description: "Organic Google Search clicks, impressions, CTR and average position for a website, grouped by query, page, country, device or date, most clicks first. "
      + "Search Console's last 2-3 days are incomplete, so the window ends 3 days ago unless fresh is set. Group by query and page together "
      + "to see whether several pages compete for the same search; by page and date to see when a page's impressions or position changed. Changes nothing.",
    inputSchema: {
      site_url: siteUrl,
      ...scWindowShape(28, 480),
      dimensions: z.array(z.enum(["query", "page", "country", "device", "date"])).min(1).max(3).default(["query"]).describe("What to group by"),
      query_contains: z.string().min(1).max(200).optional().describe("Only queries containing this text"),
      page_contains: z.string().min(1).max(500).optional().describe("Only pages whose URL contains this text"),
      query_regex: z.string().min(1).max(500).optional().describe("Only queries matching this RE2 regex"),
      exclude_query_regex: excludeQueryRegex,
      page_regex: z.string().min(1).max(500).optional().describe("Only pages whose URL matches this RE2 regex"),
      limit: z.number().int().min(1).max(1000).default(50).describe("Most rows to return"),
    },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean; dimensions: string[];
    query_contains?: string; page_contains?: string; query_regex?: string; exclude_query_regex?: string; page_regex?: string; limit: number }) =>
    session().searchConsolePerformance(site_url, o));

  tool("search_console_trend", {
    title: "Search Console trend",
    description: "Compares a window with the same number of days right before it, query by query and page by page: rising, falling, new and "
      + "lost queries, rising searches the site is losing position on, and rising and falling pages. Totals are the site's true totals. Changes nothing.",
    inputSchema: {
      site_url: siteUrl, ...scWindowShape(28, 240), exclude_query_regex: excludeQueryRegex,
      min_impressions: z.number().int().min(0).default(10).describe("Skip queries and pages under this many impressions in both windows"),
      limit: z.number().int().min(1).max(200).default(25).describe("Most rows in each list"),
    },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean; exclude_query_regex?: string; min_impressions: number; limit: number }) =>
    session().searchConsoleTrend(site_url, o));

  tool("search_console_opportunities", {
    title: "Search Console opportunities",
    description: "Finds where more organic clicks are within reach: queries on positions 4-20 with the clicks a realistic climb would add, top-5 "
      + "queries with an unusually low click-through rate (a title or description to fix), and question-shaped queries. Changes nothing.",
    inputSchema: {
      site_url: siteUrl, ...scWindowShape(90, 480), exclude_query_regex: excludeQueryRegex,
      limit: z.number().int().min(1).max(200).default(25).describe("Most rows in each list"),
    },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean; exclude_query_regex?: string; limit: number }) =>
    session().searchConsoleOpportunities(site_url, o));

  tool("search_console_inspect_urls", {
    title: "Inspect URLs in Google's index",
    description: "Google's index record for each page: indexed or not and the reason (for example \"Discovered - currently not indexed\"), "
      + "last crawl, robots.txt and fetch result, the canonical Google chose against the one the page declares, and structured-data items "
      + "with their errors. Use it when a page gets no impressions, or seems to have dropped, before assuming a ranking problem. Changes nothing.",
    inputSchema: {
      site_url: siteUrl,
      urls: z.array(z.string().url().max(2000)).min(1).max(20).describe("Full page URLs inside the property, up to 20 per call (Google allows 2,000 a day per site)"),
    },
    annotations: read,
  }, ({ site_url, urls }: { site_url: string; urls: string[] }) => session().searchConsoleInspectUrls(site_url, urls));

  tool("search_console_sitemaps", {
    title: "Search Console sitemaps",
    description: "The sitemaps submitted for a website: when Google last downloaded each one, how many URLs it lists, and its error and "
      + "warning counts. Changes nothing: submitting a sitemap is done in Search Console.",
    inputSchema: { site_url: siteUrl },
    annotations: read,
  }, ({ site_url }: { site_url: string }) => session().searchConsoleSitemaps(site_url));

  tool("paid_organic_overlap", {
    title: "Paid vs organic overlap",
    description: "Joins a Google Ads account's search terms with a website's Search Console queries over the same days. Returns paid_and_ranking "
      + "(searches you pay for where the site already ranks near the top organically, with ad spend) and organic_gaps (searches the site "
      + "shows up for on page 2 or lower with no ad or keyword). Changes nothing; follow up with propose_changes.",
    inputSchema: {
      customer_id: customerId, site_url: siteUrl,
      days: z.number().int().min(7).max(480).default(90).describe("Look-back window in days, ending 3 days ago"),
      max_position: z.number().min(1).max(10).default(3).describe("paid_and_ranking: average organic position at or better than this"),
      min_impressions: z.number().int().min(0).default(100).describe("organic_gaps: only queries with at least this many impressions"),
      limit: z.number().int().min(1).max(200).default(25).describe("Most rows in each list"),
    },
    annotations: read,
  }, ({ customer_id, site_url, ...o }: { customer_id: string; site_url: string; days: number; max_position: number; min_impressions: number; limit: number }) =>
    session().paidOrganicOverlap(customer_id, site_url, o));

  tool("analytics_properties", {
    title: "List Google Analytics properties",
    description: "Lists the Google Analytics 4 properties this Google login can read. Use a property_id from here in the other Google Analytics tools. "
      + "If Google Analytics isn't part of the connection yet, says so and returns grant_url, a personal link the user opens to add it.",
    annotations: read,
  }, () => listProperties(session().ga));

  tool("analytics_setup", {
    title: "Google Analytics setup",
    description: "How a GA4 property is set up: its web streams with their measurement IDs (what the site's tag must use), which events are key events "
      + "(GA4's conversions), and which Google Ads accounts it's linked to. Check this before proposing setup changes. Changes nothing.",
    inputSchema: { property_id: propertyId },
    annotations: read,
  }, ({ property_id }: { property_id: string }) => gaSetup(session().ga, property_id));

  if (!o.chatgpt) tool("propose_analytics_changes", {
    title: "Propose Google Analytics changes (applies nothing)",
    description: "Checks Google Analytics setup changes against the live property and stores them as a proposal with a plain-English summary; "
      + "nothing is changed. Show the summary to the user and apply only after they approve, with apply_changes (undo_changes reverses it). "
      + "Supported: create_ga4_property (a property plus a web stream; the applied result gives the measurement ID and the tag the site needs), "
      + "mark_key_event / unmark_key_event (GA4's conversions), link_google_ads / unlink_google_ads. Point out any ⚠ line before they approve.",
    inputSchema: { changes: z.array(PublicGaChangeSchema).min(1).max(20).describe("Changes to propose; several can go in one proposal") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ changes }: { changes: unknown[] }) => session().propose(GA_TARGET, changes));

  tool("analytics_landing_pages", {
    title: "Google Analytics landing pages",
    description: "Where visitors land and whether it works: sessions, users, engagement rate, key events (GA4's conversions) and key event rate "
      + "per landing page, most sessions first. Pass channel to see one source, e.g. \"Paid Search\" for Google Ads traffic or \"Organic Search\". Changes nothing.",
    inputSchema: { property_id: propertyId, ...gaWindowShape,
      channel: z.string().min(1).max(100).optional().describe("Only sessions whose default channel group contains this, e.g. Paid Search, Organic Search, Direct"),
      limit: z.number().int().min(1).max(500).default(25).describe("Most landing pages to return") },
    annotations: read,
  }, ({ property_id, ...o }: GaWindow & { property_id: string; channel?: string; limit: number }) => landingPages(session().ga, property_id, o));

  tool("analytics_report", {
    title: "Run a Google Analytics report",
    description: "Any GA4 report: dimensions and metrics by their GA4 API names, highest first. Common dimensions: date, landingPage, pagePath, "
      + "sessionDefaultChannelGroup, sessionSourceMedium, sessionCampaignName, sessionGoogleAdsCampaignName, deviceCategory, country, eventName. "
      + "Common metrics: sessions, totalUsers, engagedSessions, engagementRate, keyEvents, sessionKeyEventRate, screenPageViews, purchaseRevenue. Changes nothing.",
    inputSchema: { property_id: propertyId, ...gaWindowShape,
      dimensions: z.array(z.string().regex(/^[A-Za-z][\w:]*$/)).max(5).default([]).describe("GA4 dimension names; none gives totals"),
      metrics: z.array(z.string().regex(/^[A-Za-z][\w:]*$/)).min(1).max(10).describe("GA4 metric names"),
      filter: z.object({ dimension: z.string().regex(/^[A-Za-z][\w:]*$/), contains: z.string().min(1).max(200) }).optional()
        .describe("Only rows whose dimension contains this text (case-insensitive)"),
      order_by: z.string().optional().describe("Metric to sort by, highest first; defaults to the first metric"),
      limit: z.number().int().min(1).max(1000).default(50).describe("Most rows to return") },
    annotations: read,
  }, ({ property_id, ...o }: GaWindow & { property_id: string; dimensions: string[]; metrics: string[];
    filter?: { dimension: string; contains: string }; order_by?: string; limit: number }) => report(session().ga, property_id, o));

  if (!o.chatgpt) tool("propose_changes", {
    title: "Propose Google Ads changes (applies nothing)",
    description: `Checks a set of changes against the live account and dry-runs them with Google, then stores them as a proposal and returns a plain-English summary. Nothing is changed. Show the summary to the user and apply only after they approve. Supported: add_negative_keywords, pause_campaign, enable_campaign, pause_keyword, enable_keyword, pause_ad_group, enable_ad_group, set_daily_budget, set_end_date, and building: create_campaign (Search), create_display_campaign, create_demand_gen_campaign (YouTube), create_performance_max_campaign, all created paused; add_ad_group, add_keywords, add_responsive_search_ad, add_sitelinks, set_conversion_goal; and tuning: set_keyword_bid, set_ad_group_bid, pause_ad, enable_ad (to replace an ad: add the new one and pause the old in one proposal), add_campaign_targeting, remove_campaign_targeting, set_location_mode, set_bidding_strategy, set_shared_bid_strategy, create_shared_bid_strategy, set_url_suffix, create_conversion_action, set_conversion_counting, import_ga4_key_event. Point out any ⚠ line in the summary to the user before they approve. At most ${MAX_CHANGES} changes per proposal, counting each keyword in add_keywords and add_negative_keywords as one (a create_campaign or add_ad_group counts as one however much it holds); for more, split them into several proposals up front and show the user all the summaries together.`,
    inputSchema: { customer_id: customerId, changes: z.array(PublicChangeSchema).min(1).max(MAX_CHANGES).describe(`Changes to propose; several can go in one proposal, up to ${MAX_CHANGES} (each keyword counts as one)`) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ customer_id, changes }: { customer_id: string; changes: unknown[] }) => session().propose(customer_id, changes));

  // ChatGPT's plugin guidelines want each model-callable operation exposed as its own tool, not picked by a `type` field.
  // Same schemas and the same proposal: each tool proposes one change, which apply_changes applies once approved.
  const proposeNote = "Changes nothing: checks the change against the live account, stores it as a proposal and returns a plain-English summary. "
    + "Show the summary, and any ⚠ line in it, to the user and call apply_changes only after they approve.";
  const proposes = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
  if (o.chatgpt) {
    for (const c of PUBLIC_CHANGES) {
      const { type, ...shape } = c.shape;
      const op = type.value;
      tool(`propose_${op}`, {
        title: `Propose: ${op.replace(/_/g, " ")}`,
        description: `${c.description}. ${proposeNote}`,
        inputSchema: { customer_id: customerId, ...shape },
        annotations: proposes,
      }, ({ customer_id, ...rest }: { customer_id: string } & Record<string, unknown>) => session().propose(customer_id, [{ type: op, ...rest }]));
    }
    for (const c of PUBLIC_GA_CHANGES) {
      // A top-level customer_id would be logged as Google Ads use (wrap), so the Ads account a link names is ads_customer_id here.
      const { type, customer_id: ads, ...shape } = c.shape as typeof c.shape & { customer_id?: z.ZodString };
      const op = type.value;
      tool(`propose_${op}`, {
        title: `Propose: ${op.replace(/_/g, " ").replace("ga4", "GA4")}`,
        description: `${c.description}. ${proposeNote}`,
        inputSchema: { ...shape, ...(ads ? { ads_customer_id: ads } : {}) },
        annotations: proposes,
      }, ({ ads_customer_id, ...rest }: { ads_customer_id?: string } & Record<string, unknown>) =>
        session().propose(GA_TARGET, [{ type: op, ...rest, ...(ads_customer_id ? { customer_id: ads_customer_id } : {}) }]));
    }
    tool("propose_undo", {
      title: "Propose reversing an applied proposal",
      description: "Builds a new proposal that would reverse an applied one (removes the negatives it added, restores statuses and budgets). "
        + "Changes nothing by itself: like any proposal, it must be approved and then applied with apply_changes.",
      inputSchema: { proposal_id: z.string().describe("The id of an applied proposal, from change_history or apply_changes") },
      annotations: proposes,
    }, ({ proposal_id }: { proposal_id: string }) => session().undo(proposal_id));
  }

  tool("apply_changes", {
    title: "Apply an approved proposal",
    description: `Applies a proposal from ${o.chatgpt ? "a propose_ tool" : "propose_changes"} to the account. Only call this after the user has explicitly approved that proposal. All or nothing: every change is checked with Google first, and if one still fails the ones before it are rolled back. Each change is logged and can be reversed with ${o.chatgpt ? "propose_undo" : "undo_changes"}. `
      + "If the account changed since the proposal, nothing is applied and the result (status \"needs approval\") is a new proposal with the updated summary: show it to the user and apply it only after they approve.",
    inputSchema: { proposal_id: z.string().describe("The proposal_id a propose tool returned") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ proposal_id }: { proposal_id: string }) => session().apply(proposal_id));

  if (!o.chatgpt) tool("undo_changes", {
    title: "Propose reversing an applied proposal",
    description: "Builds a new proposal that would reverse an applied one (removes the negatives it added, restores statuses and budgets). Changes nothing by itself: like any proposal, it must be approved and then applied with apply_changes.",
    inputSchema: { proposal_id: z.string().describe("The id of an applied proposal, from change_history or apply_changes") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ proposal_id }: { proposal_id: string }) => session().undo(proposal_id));

  tool("discard_proposal", {
    title: "Discard a proposal",
    description: "Marks an open proposal as discarded so it can never be applied; this can't be reversed (propose again instead). Changes nothing in the Google Ads account.",
    inputSchema: { proposal_id: z.string().describe("The proposal_id a propose tool returned") },
    // Cancelling counts as destructive in ChatGPT's annotation rules, even though the account is untouched.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, ({ proposal_id }: { proposal_id: string }) => session().discard(proposal_id));

  tool("change_history", {
    title: "Change history",
    description: "Every proposal made through Camberstack, with what was applied, what failed, and what was undone.",
    inputSchema: { customer_id: customerId.optional(), limit: z.number().int().min(1).max(100).default(20).describe("Most proposals to return, newest first") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, ({ customer_id, limit }: { customer_id?: string; limit: number }) => session().history(customer_id, limit));

  tool("switch_account", {
    title: "Switch the plan's active account",
    description: "Spends the plan's one account switch per 30 days on customer_id: it becomes an active account, and the least recently used active account "
      + "locks until the date the \"Account switch:\" notice gave, switching back included. Call it only after another tool answered \"Account switch:\" "
      + "for this account and the user agreed. Changes nothing in Google Ads; a no-op for an account that is already active.",
    inputSchema: { customer_id: customerId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ customer_id }: { customer_id: string }) => {
    const s = session(), id = customer_id.replace(/-/g, "");
    // Throwing logs the call as failed, which spends nothing: never spend the switch on an account the login can't use.
    const reaches = (list: Account[]) => list.some((a) => a.customerId === id);
    if (!reaches(await s.accounts()) && !reaches(await s.accounts({ fresh: true })))
      throw new Error(`${id} isn't a Google Ads account this login can reach (list_accounts shows the ones it can). Nothing was spent.`);
    return { switched_to: id, active_accounts: s.planState(new Set()).active };
  });

  tool("billing", {
    title: "Plan and billing",
    description: o.chatgpt
      ? "Shows the user's Camberstack plan: the Google Ads accounts used in the last 30 days against the number the plan covers. This is the Camberstack subscription only, not a Google Ads account's own billing, invoices or ad spend."
      : "Shows the user's Camberstack plan: the Google Ads accounts used in the last 30 days against the number the plan covers (Free 1, Pro 10). Returns a personal link to upgrade (Free) or to change card and cancel (Pro). This is the Camberstack subscription only, not a Google Ads account's own billing, invoices or ad spend.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, () => session().plan());

  tool("disconnect", {
    title: "Disconnect Google Ads",
    description: "Revokes Camberstack's Google access and deletes the stored credentials. The user must confirm.",
    inputSchema: { confirm: z.literal(true).describe("Must be true; ask the user first") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, () => session().disconnect());

  // The SDK lists every enabled tool, and a disabled one also refuses calls: filter the listing instead.
  const list = (server.server as unknown as { _getRequestHandler(m: string): (req: unknown, ctx: unknown) => Promise<ListToolsResult> })
    ._getRequestHandler("tools/list");
  // A private SDK method: fail at startup, not by listing nothing, if an SDK update renames it.
  if (typeof list !== "function") throw new Error("MCP SDK: no tools/list handler to filter (UNLISTED in tools.ts)");
  server.server.setRequestHandler("tools/list", async (req, ctx) => {
    const res = await list(req, ctx);
    return { ...res, tools: res.tools.filter((t) => !UNLISTED.has(t.name)) };
  });

  return server;
}

/** Every tool in registration (workflow) order, without a session: nothing is ever called. */
export function toolCatalog(): ToolDoc[] {
  const catalog: ToolDoc[] = [];
  buildServer(() => { throw new Error("catalog only"); }, undefined, catalog);
  return catalog;
}
