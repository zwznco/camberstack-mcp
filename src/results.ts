/**
 * change_results: what an applied Google Ads change did, measured from Google's own numbers.
 *
 * Grounded on what users apply (prod, 60 days to 2026-11-12: 1,066 proposals by 50 users). Each kind is measured the
 * one way that's honest for it:
 *   blocked  negatives (32 of 50 users): the searches they block, what those cost in the window before vs after.
 *   stopped  paused keywords, ad groups, ads, campaigns (20, 12, 10, 17): what they spent before, and how the rest of
 *            their campaign did before vs after (did pausing cost conversions?).
 *   campaign budget, bid strategy, enabling, schedule, location mode, device bids (18, 15, 21, ...): the campaign
 *            before vs after.
 *   new      campaigns, ad groups, keywords Camberstack created (18, 16, 24): what they've done since, no "before".
 * Everything else (ad text, sitelinks, assets, conversion settings) is listed as not measured: there's no before/after
 * figure for it that isn't mostly noise.
 *
 * Windows are equal lengths either side of the day the change was applied (that day is left out: it's half and half),
 * in the account's time zone, up to MAX_DAYS; the after window ends yesterday. Results wait until MIN_DAYS of after
 * exist: users come back to change_history mostly 1-7 days after applying, so 7 is the first visit that can show one.
 * Nothing here controls for season or anything else that moved: each result says before/after, never "caused".
 */
type AnyChange = { type: string };
import { micros } from "./google.js";

export const MIN_DAYS = 7;
export const MAX_DAYS = 30;

export type Kind = "blocked" | "stopped" | "campaign" | "new";
export interface Metrics { cost: number; clicks: number; conversions: number }
type Outcome = { describe: string; ok: boolean; inverse?: AnyChange };
type Neg = { text: string; match_type: string };

/** One measurable change, with what to read for it. */
export type Target =
  | { kind: "blocked"; describe: string; negatives: Neg[]; campaigns?: string[]; adGroup?: string }
  | { kind: "stopped"; describe: string; level: "keyword" | "ad_group" | "ad" | "campaign"; adGroup?: string; id: string }
  | { kind: "campaign"; describe: string; campaign: string }
  | { kind: "new"; describe: string; level: "campaign" | "ad_group" | "keyword"; ids: string[] };

const CAMPAIGN_LEVEL = new Set(["set_daily_budget", "set_bidding_strategy", "enable_campaign", "set_ad_schedule", "set_location_mode", "set_device_bid"]);
const NEW_CAMPAIGN = new Set(["create_campaign", "create_display_campaign", "create_demand_gen_campaign", "create_performance_max_campaign"]);
const last = (rn: string | undefined) => rn?.split("/").at(-1);

/** What each applied change in a proposal can be measured by; null for a change there's no honest figure for. */
export function targets(changes: AnyChange[], outcomes: Outcome[]): { measured: Target[]; notMeasured: string[] } {
  const measured: Target[] = [], notMeasured: string[] = [];
  changes.forEach((raw, i) => {
    const o = outcomes[i];
    if (!o?.ok) return;
    const c = raw as any, inv = o.inverse as any, describe = o.describe;
    const t: Target | null =
      c.type === "add_negative_keywords" ? { kind: "blocked", describe, negatives: c.keywords, campaigns: [c.campaign_id] }
      : c.type === "add_ad_group_negatives" ? { kind: "blocked", describe, negatives: c.keywords, adGroup: c.ad_group_id }
      : c.type === "create_negative_list" && c.campaign_ids?.length ? { kind: "blocked", describe, negatives: c.keywords, campaigns: c.campaign_ids }
      // A shared list's campaigns aren't stored with the change: read the whole account.
      : c.type === "edit_negative_list" && c.add?.length ? { kind: "blocked", describe, negatives: c.add }
      : c.type === "pause_keyword" ? { kind: "stopped", describe, level: "keyword", adGroup: c.ad_group_id, id: c.criterion_id }
      : c.type === "pause_ad_group" ? { kind: "stopped", describe, level: "ad_group", id: c.ad_group_id }
      : c.type === "pause_ad" ? { kind: "stopped", describe, level: "ad", adGroup: c.ad_group_id, id: c.ad_id }
      : c.type === "pause_campaign" ? { kind: "stopped", describe, level: "campaign", id: c.campaign_id }
      : CAMPAIGN_LEVEL.has(c.type) ? { kind: "campaign", describe, campaign: c.campaign_id }
      : NEW_CAMPAIGN.has(c.type) && last(inv?.resource_name) ? { kind: "new", describe, level: "campaign", ids: [last(inv.resource_name)!] }
      : c.type === "add_ad_group" && last(inv?.resource_name) ? { kind: "new", describe, level: "ad_group", ids: [last(inv.resource_name)!] }
      : c.type === "add_keywords" && inv?.resource_names?.length
        ? { kind: "new", describe, level: "keyword", ids: (inv.resource_names as string[]).map((r) => last(r)!) }  // "<ad group>~<criterion>"
      : null;
    if (t) measured.push(t); else notMeasured.push(describe);
  });
  return { measured, notMeasured };
}

/** Whether a proposal has anything change_results can measure (cheap: no Google calls), for change_history. */
export const measurable = (changesJson: string, resultJson: string | null) =>
  !!resultJson && targets(JSON.parse(changesJson), JSON.parse(resultJson)).measured.length > 0;

// ---------------------------------------------------------------- matching

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);

/** Whether a negative keyword blocks a search term. Google's negatives don't match close variants, so neither does this. */
export function blocks(term: string, neg: Neg): boolean {
  const t = words(term), k = words(neg.text);
  if (!k.length) return false;
  if (neg.match_type === "EXACT") return t.join(" ") === k.join(" ");
  if (neg.match_type === "PHRASE") return ` ${t.join(" ")} `.includes(` ${k.join(" ")} `);
  const have = new Set(t);
  return k.every((w) => have.has(w));
}

// ---------------------------------------------------------------- windows

export const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const localDay = (unixSeconds: number, timeZone = "UTC") =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unixSeconds * 1000));

export interface Windows { days: number; before: [string, string]; after: [string, string] }

/**
 * Equal windows either side of the apply day, or when a result will be ready. `today` is the account's local date.
 * A change measured "new" has no before window worth reading, but it's computed the same way.
 */
export function windows(appliedDay: string, today: string): Windows | { readyOn: string } {
  const yesterday = addDays(today, -1);
  const days = Math.min(MAX_DAYS, Math.round((Date.parse(yesterday) - Date.parse(appliedDay)) / 86_400_000));
  if (days < MIN_DAYS) return { readyOn: addDays(appliedDay, MIN_DAYS + 1) };
  return { days, before: [addDays(appliedDay, -days), addDays(appliedDay, -1)], after: [addDays(appliedDay, 1), addDays(appliedDay, days)] };
}

export const between = ([a, b]: [string, string]) => `segments.date BETWEEN '${a}' AND '${b}'`;

// ---------------------------------------------------------------- figures

export const zero = (): Metrics => ({ cost: 0, clicks: 0, conversions: 0 });
export const add = (into: Metrics, r: any): Metrics => {
  into.cost += micros(r.metrics?.costMicros);
  into.clicks += Number(r.metrics?.clicks ?? 0);
  into.conversions += Number(r.metrics?.conversions ?? 0);
  return into;
};
export const minus = (a: Metrics, b: Metrics): Metrics =>
  ({ cost: Math.max(0, a.cost - b.cost), clicks: Math.max(0, a.clicks - b.clicks), conversions: Math.max(0, a.conversions - b.conversions) });

const r2 = (n: number) => Math.round(n * 100) / 100;
export const shown = (m: Metrics) => ({
  cost: r2(m.cost), clicks: m.clicks, conversions: r2(m.conversions), cost_per_conversion: m.conversions > 0 ? r2(m.cost / m.conversions) : null,
});

const money = (n: number, cur: string) => `${cur === "USD" ? "$" : ""}${r2(n).toFixed(2)}${cur === "USD" ? "" : ` ${cur}`}`;
const conv = (n: number) => `${r2(n)} conversion${r2(n) === 1 ? "" : "s"}`;

/** One plain sentence per result, so every app reads the same figures the same way. Before/after, never "because". */
export function reading(t: Target, days: number, cur: string, before: Metrics, after: Metrics, context?: { before: Metrics; after: Metrics }): string {
  const span = `the ${days} days`;
  if (t.kind === "blocked") {
    if (!before.cost && !before.clicks) return `The searches these negatives block had no recorded clicks in ${span} before.`;
    return `Searches these negatives block cost ${money(before.cost, cur)} (${before.clicks} clicks, ${conv(before.conversions)}) in ${span} before; `
      + `${money(after.cost, cur)} (${after.clicks} clicks) in ${span} after.`;
  }
  if (t.kind === "stopped") {
    const s = `It spent ${money(before.cost, cur)} for ${conv(before.conversions)} in ${span} before it was paused`
      + (after.cost > 0 ? `, and ${money(after.cost, cur)} after (it was probably re-enabled).` : ".");
    if (!context || t.level === "campaign") return s;
    return `${s} The rest of its campaign: ${conv(context.before.conversions)} at ${money(context.before.cost, cur)} before, `
      + `${conv(context.after.conversions)} at ${money(context.after.cost, cur)} after.`;
  }
  if (t.kind === "campaign") {
    const cpa = (m: Metrics) => (m.conversions > 0 ? `, ${money(m.cost / m.conversions, cur)} each` : "");
    return `The campaign: ${conv(before.conversions)} for ${money(before.cost, cur)}${cpa(before)} in ${span} before; `
      + `${conv(after.conversions)} for ${money(after.cost, cur)}${cpa(after)} in ${span} after.`;
  }
  if (!after.cost && !after.clicks) return `No spend or clicks in ${span} since (still paused, or not serving yet).`;
  return `Since it was added: ${money(after.cost, cur)}, ${after.clicks} clicks, ${conv(after.conversions)} over ${span}.`;
}

export const CAVEATS = [
  "Before vs after, not cause and effect: season, competitors and other changes move these numbers too.",
  "Google's search terms report leaves out low-volume searches, so blocked-search figures are a floor.",
  "Conversions can arrive days after the click, so the last few days of an after window may still rise.",
];

// ---------------------------------------------------------------- other changes in the after window

/**
 * Anything else that changed the same campaigns during the after window, from Google's change log (change_event), so a
 * result that's really someone else's pause or budget change says so: on 2026-11-12 the first real check read $0 after a
 * negative that was mostly the campaign being paused 4 days later. It covers changes made anywhere (Google Ads, the API
 * including Camberstack, rules, recommendations), but only the last 30 days: Google keeps no more.
 */
export interface Overlap { date: string; what: string; by: string }

/** The part of the after window Google's change log still covers (it starts a day inside its 30-day limit), or null. */
export function changeLogWindow(after: [string, string], today: string): [string, string] | null {
  const earliest = addDays(today, -29);
  if (after[1] < earliest) return null;
  return [after[0] < earliest ? earliest : after[0], after[1]];
}

export const changeLogQuery = ([a, b]: [string, string]) => `SELECT change_event.change_date_time, change_event.change_resource_type, `
  + `change_event.resource_change_operation, change_event.changed_fields, change_event.client_type, change_event.campaign, change_event.new_resource `
  + `FROM change_event WHERE change_event.change_date_time >= '${a}' AND change_event.change_date_time <= '${addDays(b, 1)}' `
  + `ORDER BY change_event.change_date_time LIMIT 1000`;

const BY: Record<string, string> = {
  GOOGLE_ADS_WEB_CLIENT: "in Google Ads", GOOGLE_ADS_API: "through the API (Camberstack or another tool)", GOOGLE_ADS_EDITOR: "in Google Ads Editor",
  GOOGLE_ADS_MOBILE_APP: "in the Google Ads app", GOOGLE_ADS_AUTOMATED_RULE: "by an automated rule", GOOGLE_ADS_SCRIPTS: "by a script",
  GOOGLE_ADS_BULK_UPLOAD: "by bulk upload", GOOGLE_ADS_RECOMMENDATIONS: "from a Google recommendation", GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: "by Google's auto-applied recommendations", INTERNAL_TOOL: "by Google",
};
// Google names changed fields in camelCase (seen 2026-11-12: "biddingStrategy", "manualCpc.enhancedCpcEnabled", "amountMicros").
// Enhanced CPC on its own is a setting, not a strategy change.
const BIDDING = /biddingStrategy|targetCpa|targetRoas|maximizeConversion|manualCpc(?!\.enhancedCpcEnabled)|targetSpend|targetImpressionShare|percentCpc/;

/** Changes to these campaigns, the notable ones spelled out (status, budget, bidding), the rest counted. */
export function overlaps(rows: any[], campaigns: Set<string>, window: [string, string]): { notable: Overlap[]; other: number } {
  const notable: Overlap[] = [];
  let other = 0;
  for (const r of rows) {
    const e = r.changeEvent ?? {};
    const date = String(e.changeDateTime ?? "").slice(0, 10);
    if (!campaigns.has(String(e.campaign ?? "").split("/").at(-1) ?? "") || date < window[0] || date > window[1]) continue;
    const fields = String(e.changedFields ?? ""), type = e.changeResourceType, op = e.resourceChangeOperation;
    const status = e.newResource?.campaign?.status ?? e.newResource?.adGroup?.status;
    const what = type === "CAMPAIGN" && op === "UPDATE" && /\bstatus\b/.test(fields) && status ? `campaign ${String(status).toLowerCase() === "enabled" ? "enabled" : String(status).toLowerCase()}`
      : type === "CAMPAIGN" && op === "UPDATE" && BIDDING.test(fields) ? "bid strategy changed"
      : type === "CAMPAIGN" && op === "UPDATE" && /campaignBudget/.test(fields) ? "budget changed"
      : type === "CAMPAIGN_BUDGET" && op === "UPDATE" ? "budget changed"
      : type === "AD_GROUP" && op === "UPDATE" && /\bstatus\b/.test(fields) && status ? `an ad group ${String(status).toLowerCase()}`
      : null;
    if (what) notable.push({ date, what, by: BY[e.clientType] ?? String(e.clientType ?? "unknown").toLowerCase().replace(/_/g, " ") });
    else other++;
  }
  return { notable, other };
}

/** The sentence added to a reading when something else changed the campaign in the after window. */
export function overlapNote(o: { notable: Overlap[]; other: number }): string {
  if (!o.notable.length && !o.other) return "";
  const shown = o.notable.slice(0, 3).map((x) => `${x.what} on ${x.date} ${x.by}`);
  const rest = o.other + Math.max(0, o.notable.length - 3);
  const parts = [...shown, ...(rest ? [`${rest} other change${rest === 1 ? "" : "s"} to the campaign`] : [])];
  return ` Also in the after window: ${parts.join("; ")}, so the after figures aren't this change alone.`;
}
