/**
 * account_overview's ready-made checks (session.ts attention): things a user found only by writing GAQL themselves
 * (Forum & Lex feedback, 2026-11-17): keyword final URLs overriding the ad's, a bid strategy change buried in change
 * history, a conversion action that stopped firing, call conversions that skip short calls, and attorney-advertising
 * wording. Pure functions over Google's rows, so each is testable without Google; session.ts runs the queries.
 */
import { BIDDING, BY } from "./results.js";
import { DEMO_CID } from "./demo.js";
import type { Q } from "./db.js";

/** How many examples each check names; the rest are counted. */
const CHECK_EXAMPLES = 10;
/** A conversion action that had at least STOPPED_MIN conversions in the last 90 days and none in the last STOPPED_DAYS has stopped. */
const STOPPED_DAYS = 14, STOPPED_MIN = 3;

// ---------------------------------------------------------------- queries

export const KEYWORD_URLS_QUERY = `SELECT campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
    ad_group_criterion.final_urls FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status = 'ENABLED'
    AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED' LIMIT 10000`;
/** One read serves the keyword URL check (final_urls) and the wording check (the text). */
export const LIVE_ADS_QUERY = `SELECT ad_group.id, ad_group.name, campaign.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls,
    ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad
    WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED' LIMIT 5000`;
export const CONVERSION_ACTIONS_QUERY = `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.primary_for_goal,
    conversion_action.phone_call_duration_seconds, metrics.conversion_last_conversion_date FROM conversion_action WHERE conversion_action.status = 'ENABLED'`;
/** Conversions per action over 90 days (by click date). Google takes LAST_90_DAYS only as explicit dates. */
export const conversionCountsQuery = (from: string, to: string) => `SELECT segments.conversion_action, metrics.all_conversions FROM customer
    WHERE segments.date BETWEEN '${from}' AND '${to}'`;
export const callsQuery = (from: string) => `SELECT call_view.call_duration_seconds, call_view.call_status FROM call_view
    WHERE call_view.start_call_date_time >= '${from} 00:00:00' LIMIT 10000`;
/** Campaign updates in the window: change_event needs both ends inside Google's 30 days and a LIMIT. */
export const campaignChangesQuery = (from: string, to: string) => `SELECT change_event.change_date_time, change_event.changed_fields,
    change_event.client_type, change_event.user_email, change_event.old_resource, change_event.new_resource, change_event.campaign, campaign.name
    FROM change_event WHERE change_event.change_date_time >= '${from}' AND change_event.change_date_time <= '${to}'
    AND change_event.change_resource_type = 'CAMPAIGN' AND change_event.resource_change_operation = 'UPDATE'
    ORDER BY change_event.change_date_time DESC LIMIT 1000`;

// ---------------------------------------------------------------- keyword final URLs

/** Host and path, lowercased, without query, fragment or trailing slash: tracking parameters don't make a different page. */
export function samePage(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch { return u.trim().toLowerCase(); }
}

/**
 * Enabled keywords with a final URL of their own that matches none of their ad group's ads: a click on that keyword
 * lands there, not on the ad's page. A keyword URL equal to the ad's changes nothing and isn't named.
 */
export function keywordUrlOverrides(keywordRows: any[], adRows: any[]) {
  const adUrls = new Map<string, Set<string>>();
  for (const r of adRows) {
    const g = String(r.adGroup?.id ?? "");
    for (const u of r.adGroupAd?.ad?.finalUrls ?? []) (adUrls.get(g) ?? adUrls.set(g, new Set()).get(g)!).add(String(u));
  }
  const found = [];
  for (const r of keywordRows) {
    const own = (r.adGroupCriterion?.finalUrls ?? []) as string[];
    const ads = adUrls.get(String(r.adGroup?.id ?? ""));
    if (!own.length || !ads?.size) continue;
    const pages = new Set([...ads].map(samePage));
    if (own.some((u) => pages.has(samePage(u)))) continue;
    found.push({ keyword: r.adGroupCriterion?.keyword?.text, criterion_id: String(r.adGroupCriterion?.criterionId ?? ""),
      ad_group: r.adGroup?.name, campaign: r.campaign?.name, keyword_url: own[0], ad_urls: [...ads].slice(0, 2) });
  }
  if (!found.length) return {};
  return { keyword_urls_override_ads: { count: found.length, keywords: found.slice(0, CHECK_EXAMPLES),
    note: "These keywords have their own final URL, so a click on them lands there instead of on the ad's page. "
      + "Often left over from an old setup; clear the keyword's URL in Google Ads if the ad's page is the right one." } };
}

// ---------------------------------------------------------------- bid strategy changes

const SNAKE = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

/** Campaign bid strategy changes in Google's change log: who, when, and from what to what when Google says. */
export function bidStrategyChanges(rows: any[]) {
  const found = [];
  for (const r of rows) {
    const e = r.changeEvent ?? {};
    const fields = String(e.changedFields ?? "");
    if (!BIDDING.test(fields)) continue;
    const from = e.oldResource?.campaign?.biddingStrategyType, to = e.newResource?.campaign?.biddingStrategyType;
    found.push({ date: String(e.changeDateTime ?? "").slice(0, 16), campaign: r.campaign?.name ?? String(e.campaign ?? "").split("/").at(-1),
      ...(from || to ? { from: from ? SNAKE(String(from)).replace(/_/g, " ") : null, to: to ? SNAKE(String(to)).replace(/_/g, " ") : null } : {}),
      changed: fields.split(",").filter((f) => BIDDING.test(f)).join(", "),
      by: `${BY[e.clientType] ?? String(e.clientType ?? "unknown").toLowerCase().replace(/_/g, " ")}${e.userEmail ? ` (${e.userEmail})` : ""}` });
  }
  if (!found.length) return {};
  return { bid_strategy_changes_last_30_days: found.slice(0, CHECK_EXAMPLES),
    ...(found.length > CHECK_EXAMPLES ? { more_bid_strategy_changes: found.length - CHECK_EXAMPLES } : {}) };
}

// ---------------------------------------------------------------- conversions that stopped

/**
 * Enabled conversion actions that were firing (STOPPED_MIN or more in 90 days) and have had none for STOPPED_DAYS:
 * a lead form, tag or import that broke. Returns the names too, so the 30-day "quiet" line doesn't repeat them.
 */
export function stoppedConversions(actionRows: any[], countRows: any[], today: string) {
  const counts = new Map<string, number>();
  for (const r of countRows) {
    const id = String(r.segments?.conversionAction ?? "").split("/").at(-1) ?? "";
    counts.set(id, (counts.get(id) ?? 0) + Number(r.metrics?.allConversions ?? 0));
  }
  const cutoff = new Date(Date.parse(today) - STOPPED_DAYS * 86400_000).toISOString().slice(0, 10);
  const found = actionRows.filter((r) => {
    const n = counts.get(String(r.conversionAction?.id ?? "")) ?? 0, last = r.metrics?.conversionLastConversionDate;
    return n >= STOPPED_MIN && (!last || last < cutoff);
  }).map((r) => ({ name: r.conversionAction.name as string, type: String(r.conversionAction.type ?? "").toLowerCase().replace(/_/g, " "),
    primary: !!r.conversionAction.primaryForGoal, last_conversion: r.metrics?.conversionLastConversionDate ?? null,
    conversions_last_90_days: Math.round((counts.get(String(r.conversionAction.id)) ?? 0) * 10) / 10 }));
  if (!found.length) return { names: new Set<string>(), out: {} };
  return { names: new Set(found.map((f) => f.name)), out: { conversions_stopped: { actions: found,
    note: `Each was recording conversions, then none for ${STOPPED_DAYS}+ days. Check the form, tag or import behind it before blaming the ads.` } } };
}

// ---------------------------------------------------------------- short calls

/**
 * Calls from ads (call_view) shorter than the call conversion action's minimum length, so they never counted.
 * call_view covers calls from call ads and call assets only; website calls aren't in it.
 */
export function shortCalls(actionRows: any[], callRows: any[]) {
  const actions = actionRows.filter((r) => r.conversionAction?.type === "AD_CALL" && Number(r.conversionAction.phoneCallDurationSeconds) > 0);
  if (!actions.length) return {};
  const received = callRows.filter((r) => r.callView?.callStatus === "RECEIVED");
  if (!received.length) return {};
  const out = actions.map((r) => {
    const min = Number(r.conversionAction.phoneCallDurationSeconds);
    return { conversion_action: r.conversionAction.name, counts_calls_of_at_least_seconds: min, answered_calls_last_30_days: received.length,
      shorter_so_not_counted: received.filter((c) => Number(c.callView?.callDurationSeconds ?? 0) < min).length };
  }).filter((x) => x.shorter_so_not_counted > 0);
  if (!out.length) return {};
  return { short_calls_not_counted: { actions: out,
    note: "Answered calls from ads shorter than the action's call length don't count as conversions. If short calls are real "
      + "leads for this business, lower the call length in the conversion action's settings." } };
}

// ---------------------------------------------------------------- attorney advertising wording

/** Text that says the advertiser is a lawyer or law firm. "Lex" or "P.C." alone doesn't: plenty of other businesses use them. */
const LEGAL = /\b(attorneys?|lawyers?|law (?:firm|office|offices|group|practice)|legal (?:services|help|counsel|advice|representation)|esq\.?|abogad[oa]s?|counsel(?:l)?ors? at law)\b/i;
export const looksLegal = (texts: string[]) => texts.some((t) => LEGAL.test(t));

/**
 * Wording state bar advertising rules commonly restrict (they differ by state). A flag to check, never a block:
 * Camberstack can't know the jurisdiction or whether, say, a specialist certification exists.
 */
const WORDING: { re: RegExp; why: string }[] = [
  { re: /\bspeciali[sz](?:t|ts|e|es|ed|ing|ation)\b/i, why: "claiming a specialty is often limited to lawyers certified as specialists" },
  { re: /\bexperts?\b/i, why: "\"expert\" is often treated like a specialty claim" },
  { re: /\btop[- ]rated\b|\bbest\b|\bleading\b|\bpremier\b|(?:#|\bno\.?\s?|\bnumber\s)1\b/i, why: "superlatives and rankings must be verifiable, and some states bar them outright" },
  { re: /\bguarantee[ds]?\b|\b100\s?%|\bwe win\b|\bproven results\b|\bwin(?:s)? every\b/i, why: "promising or implying results can be misleading" },
];

/** Each flagged phrase once per text, with why. */
export function flaggedWording(texts: string[]): { text: string; flagged: string; why: string }[] {
  const out = [];
  for (const text of new Set(texts)) for (const w of WORDING) {
    const m = w.re.exec(text);
    if (m) out.push({ text, flagged: m[0], why: w.why });
  }
  return out;
}

export const WORDING_NOTE = "This looks like a law firm's account. Attorney advertising rules differ by state, and words like these are "
  + "commonly restricted. This is a prompt to check, not legal advice: the firm's own bar rules decide.";

/** The live ads' check: only when the account or its ads say legal. */
export function adWording(accountName: string, adRows: any[]) {
  const texts = (r: any) => [...(r.adGroupAd?.ad?.responsiveSearchAd?.headlines ?? []), ...(r.adGroupAd?.ad?.responsiveSearchAd?.descriptions ?? [])]
    .map((t: { text?: string }) => t.text ?? "").filter(Boolean) as string[];
  if (!looksLegal([accountName, ...adRows.flatMap(texts), ...adRows.flatMap((r) => r.adGroupAd?.ad?.finalUrls ?? [])])) return {};
  const found = adRows.flatMap((r) => flaggedWording(texts(r)).map((f) => ({ ad_id: String(r.adGroupAd?.ad?.id ?? ""), ad_group: r.adGroup?.name, ...f })));
  if (!found.length) return {};
  return { attorney_advertising_wording: { count: found.length, items: found.slice(0, CHECK_EXAMPLES), note: WORDING_NOTE } };
}

/** Keys in a change that hold ad text people read (headlines, sitelinks, callouts, …): the rest are ids, URLs and settings. */
const TEXT_KEYS = new Set(["headlines", "long_headlines", "descriptions", "description", "description1", "description2", "callouts",
  "link_text", "business_name", "long_headline", "headline", "values", "header"]);

/** The ad text in a change, however deep (a campaign's sitelinks, an ad group's ad). */
export function adCopyOf(change: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, text: boolean) => {
    if (typeof v === "string") { if (text) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, text); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, text || TEXT_KEYS.has(k));
  };
  walk(change, false);
  return out;
}

// ---------------------------------------------------------------- admin (report.ts, admin.ts)


/**
 * Whether each ready-made check earns its place (tool_calls.flags, logged since 0.44.1): of the users whose own-account
 * overviews ran since the checks did, how many it fired for, and how many of those proposed a change on that account within
 * the hour after. wording_review is raised on a proposal itself, so it has no "acted". lsa_* only say a Local Services report
 * ran, which the tools table already counts.
 */
export function checksReport(q: Q, since: number) {
  const from = Math.max(since, q<{ at: number | null }>("SELECT min(at) at FROM tool_calls WHERE flags IS NOT NULL")[0]?.at ?? since);
  const overviewUsers = q<{ n: number }>(`SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id
      WHERE c.tool = 'account_overview' AND c.ok = 1 AND c.error IS NULL AND c.at >= ? AND coalesce(c.customer_id, '') != '${DEMO_CID}'`, from)[0]?.n ?? 0;
  const rows = q<{ user_id: string; flags: string; acted: number }>(`SELECT c.user_id, c.flags,
        EXISTS (SELECT 1 FROM proposals p WHERE p.user_id = c.user_id AND p.customer_id = c.customer_id AND p.created_at BETWEEN c.at AND c.at + 3600) acted
      FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 1 AND c.flags IS NOT NULL`, from);
  const by = new Map<string, { users: Set<string>; acted: Set<string> }>();
  for (const r of rows) for (const f of r.flags.split(",")) {
    if (!f || f.startsWith("preview:") || f.startsWith("lsa_")) continue;
    const e = by.get(f) ?? by.set(f, { users: new Set(), acted: new Set() }).get(f)!;
    e.users.add(r.user_id);
    if (r.acted && f !== "wording_review") e.acted.add(r.user_id);
  }
  return {
    since: from, overview_users: overviewUsers,
    flags: [...by].map(([flag, e]) => ({ flag, users: e.users.size, acted: flag === "wording_review" ? null : e.acted.size }))
      .sort((x, y) => y.users - x.users || (y.acted ?? 0) - (x.acted ?? 0)),
  };
}

/** Previews in the window (account_previews), by kind, and what the user did after: took that account, clicked upgrade, paid. */
export function previewsReport(q: Q, since: number) {
  return q<{ kind: string; previews: number; users: number; took: number; clicked: number; paid: number }>(
    `SELECT coalesce(p.kind, 'unknown') kind, count(*) previews, count(DISTINCT p.user_id) users,
       sum(EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = p.user_id AND c.customer_id = p.customer_id AND c.ok = 1 AND c.error IS NULL AND c.at > p.at)) took,
       count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM plan_events e WHERE e.user_id = p.user_id AND e.kind = 'upgrade_click' AND e.at > p.at) THEN p.user_id END) clicked,
       count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM plan_events e WHERE e.user_id = p.user_id AND e.kind = 'paid' AND e.at > p.at) THEN p.user_id END) paid
     FROM account_previews p JOIN {U} u ON u.id = p.user_id WHERE p.at >= ? GROUP BY 1 ORDER BY 1`, since);
}
