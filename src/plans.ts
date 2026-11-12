/** What the paid plans cost and include: the one copy every page, email and tool reads. */

export const PRO_PRICE_LABEL = "$15/month";
/**
 * Plus (projects/camberstack/PRICING-TEST.md): unlimited applied changes on one Google Ads account. Sold while the change
 * cap is on (FREE_CHANGE_CAP); without it, Plus would equal Free.
 */
export const PLUS_PRICE_LABEL = "$7/month";
export const PLUS_ACCOUNTS = 1;
/** Google Ads accounts Pro covers at a time. Was 10 until 2026-10-22. */
export const PRO_ACCOUNTS = 5;
export const AGENCY_PRICE_LABEL = "$49/month";
/** Google Ads accounts Agency covers at a time. */
export const AGENCY_ACCOUNTS = 25;
/** users.plan: free, or a paid plan its Stripe subscription's price decides (billing.ts). */
export type Plan = "free" | "plus" | "pro" | "agency";
/** SQL for a paying user: `alias` is "u." or "". A plan with no Stripe subscription (PRO_EMAILS) doesn't count. */
export const payingSql = (alias = "") => `${alias}plan IN ('plus', 'pro', 'agency') AND coalesce(${alias}stripe_sub, '') != ''`;
export const isPaid = (plan: string | null | undefined) => plan === "plus" || plan === "pro" || plan === "agency";
/** "Plus" / "Pro" / "Agency" / "Free". */
export const planLabel = (plan: string) => plan === "agency" ? "Agency" : plan === "pro" ? "Pro" : plan === "plus" ? "Plus" : "Free";
/** Plans are sized in Google Ads accounts used over this rolling window (session.ts accountsInUse). */
export const ACCOUNT_WINDOW_DAYS = 30;
/** Error text the account gate starts with; lifecycle.ts finds blocked users by it in tool_calls. */
export const PLAN_LIMIT_PREFIX = "Plan limit:";
/** Text of the notice that came before spending the plan's one switch (removed 2026-11-06). Still matched in old tool_calls rows (report.ts gate hits). */
export const SWITCH_NOTICE_PREFIX = "Account switch:";
/** Text of the notice before a plan's first account is taken (session.ts admit): a choice, not a switch, so no switch_wanted email. */
export const ACCOUNT_CHOICE_PREFIX = "Account choice:";

/**
 * The change cap (projects/camberstack/PRICING-TEST.md, replacing one-service Free before it switched on, 2026-11-11):
 * Free applies at most this many proposals per ACCOUNT_WINDOW_DAYS, counted per approval (one apply_changes of a
 * proposal, however many changes it holds); paid plans are unlimited. Undo and the demo don't count. Set once at boot
 * from FREE_CHANGE_CAP (a whole number; unset = unlimited), and read by every page, email and tool result that describes Free.
 */
let changeCapValue: number | null = null;
let changeCapStart = 0;
/** `from` (FREE_CHANGE_CAP_FROM, unix seconds): only approvals since then count, so everyone starts at 0 when it goes on. */
export const setChangeCap = (n: number | null, from = 0) => { changeCapValue = n && n > 0 ? Math.floor(n) : null; changeCapStart = from; };
export const changeCap = () => changeCapValue;
export const changeCapFrom = () => changeCapStart;
/** FREE_CHANGE_CAP_FROM: an ISO time ("2026-11-12T02:00:00Z") → unix seconds; unset or unreadable = 0 (the whole window counts). */
export const parseCapFrom = (v: string | undefined): number => { const t = Date.parse(v ?? ""); return Number.isNaN(t) ? 0 : Math.floor(t / 1000); };
export const parseChangeCap = (v: string | undefined): number | null => (/^\d+$/.test(v ?? "") && Number(v) > 0 ? Number(v) : null);
/** "unlimited applied changes" / "10 applied changes every 30 days". */
export const freeChanges = () => (changeCapValue ? `${changeCapValue} applied changes every ${ACCOUNT_WINDOW_DAYS} days` : "unlimited applied changes");
/** The short form for taglines: "unlimited changes" / "10 changes a month". */
export const freeChangesShort = () => (changeCapValue ? `${changeCapValue} changes a month` : "unlimited changes");
/** Text of the change cap's stop. Not PLAN_LIMIT_PREFIX: lifecycle.ts's limit_reached email is about Ads accounts. */
export const CHANGE_LIMIT_PREFIX = "Change limit:";

/** The Google services a call can use (tools.ts servicesOf), logged per call in tool_calls.service for the reports. */
export type Service = "ads" | "search_console" | "analytics" | "merchant" | "tag_manager";
export const SERVICE_LABELS: Record<Service, string> = { ads: "Google Ads", search_console: "Search Console", analytics: "Google Analytics", merchant: "Merchant Center", tag_manager: "Tag Manager" };
/** The services every page, email and tool result names, in order. Merchant Center is the 4th (public since 2026-11-04), Tag Manager the 5th. */
export const listedServices = (): Service[] => ["ads", "search_console", "analytics", "merchant", "tag_manager"];
/** "Google Ads, Search Console, Google Analytics, Merchant Center or Tag Manager". */
export const servicesOr = () => joinLabels(listedServices().map((s) => SERVICE_LABELS[s]), "or");
/** "Google Ads, Search Console, Google Analytics, Merchant Center and Tag Manager". */
export const servicesAnd = () => joinLabels(listedServices().map((s) => SERVICE_LABELS[s]), "and");
const joinLabels = (xs: string[], word: string) => `${xs.slice(0, -1).join(", ")} ${word} ${xs.at(-1)}`;
/** "November 16". */
export const dateLabel = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
/** Every service together: "Google Ads, Search Console, Google Analytics, Merchant Center and Tag Manager together". */
export const allServices = () => `${joinLabels(listedServices().map((s) => SERVICE_LABELS[s]), "and")} together`;

/** "1 Google Ads account" / "5 Google Ads accounts". */
export const accountsLabel = (n: number, pool: Pool = "ads") => `${n} ${pool === "mc" ? "Merchant Center" : "Google Ads"} account${n === 1 ? "" : "s"}`;
/**
 * Which allowance an account counts against: Google Ads accounts, or Merchant Center accounts (`mc:<id>`, merchant-changes.ts).
 * Each plan covers the same number of each, counted and switched separately, so one store with one Ads account fits Free.
 */
export type Pool = "ads" | "mc";
export const poolOf = (cid: string): Pool => (cid.startsWith("mc:") ? "mc" : "ads");

/**
 * The account gate's refusal. `message` keeps the PLAN_LIMIT_PREFIX sentence (logs, lifecycle.ts); `detail` is
 * the same facts as fields, which tools.ts returns as a structured error for the assistant to present.
 */
export class PlanLimitError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown>) { super(message); }
}

/**
 * The account choice notice (ACCOUNT_CHOICE_PREFIX), the plan-limit refusal, and the change cap's stop
 * (CHANGE_LIMIT_PREFIX). Thrown to stop the tool, but returned as a normal result, not isError:
 * nothing failed, and an error here counted against the directory's reliability metrics.
 */
export class SwitchNotice extends PlanLimitError {}
