/** What the paid plan costs and includes: the one copy every page, email and tool reads. */

export const PRO_PRICE_LABEL = "$15/month";
/**
 * Plus (2026-10-28, projects/camberstack/PRICING-TEST.md): Google Ads, Search Console and Google Analytics together on one
 * Google Ads account, for people who want the bridge, not more accounts. Offered once one-service Free is announced.
 */
export const PLUS_PRICE_LABEL = "$7/month";
export const PLUS_ACCOUNTS = 1;
/** Google Ads accounts Pro covers at a time (PRO_ACCOUNTS overrides it, e.g. in tests). Was 10 until 2026-10-22. */
export const PRO_ACCOUNTS = 5;
export const AGENCY_PRICE_LABEL = "$49/month";
/** Google Ads accounts Agency covers at a time (AGENCY_ACCOUNTS overrides it). */
export const AGENCY_ACCOUNTS = 25;
/** users.plan: free, or a paid plan its Stripe subscription's price decides (billing.ts). */
export type Plan = "free" | "plus" | "pro" | "agency";
export const isPaid = (plan: string | null | undefined) => plan === "plus" || plan === "pro" || plan === "agency";
/** "Plus" / "Pro" / "Agency" / "Free". */
export const planLabel = (plan: string) => plan === "agency" ? "Agency" : plan === "pro" ? "Pro" : plan === "plus" ? "Plus" : "Free";
/** Plans are sized in Google Ads accounts used over this rolling window (session.ts accountsInUse). */
export const ACCOUNT_WINDOW_DAYS = 30;
/** Error text the account gate starts with; lifecycle.ts finds blocked users by it in tool_calls. */
export const PLAN_LIMIT_PREFIX = "Plan limit:";
/** Text of the notice before a plan's one switch is spent (session.ts admit, SwitchNotice). Not a refusal: lifecycle.ts doesn't match it. */
export const SWITCH_NOTICE_PREFIX = "Account switch:";
/** Text of the notice before a plan's first account is taken (session.ts admit): a choice, not a switch, so no switch_wanted email. */
export const ACCOUNT_CHOICE_PREFIX = "Account choice:";

/**
 * Option C (projects/camberstack/PRICING-TEST.md), behind FREE_ONE_SERVICE: Free covers one Google service at a time,
 * the most recently used one over ACCOUNT_WINDOW_DAYS; paid plans cover them all together. Off by default.
 * FREE_ONE_SERVICE=YYYY-MM-DD announces it until that day (UTC) and starts it then; =1 starts it now.
 */
export type Service = "ads" | "search_console" | "analytics" | "merchant";
export const SERVICE_LABELS: Record<Service, string> = { ads: "Google Ads", search_console: "Search Console", analytics: "Google Analytics", merchant: "Merchant Center" };
/**
 * Merchant Center is a 4th service in the gate (operator, 2026-10-30), but the copy names it only once it's public
 * (MERCHANT_PUBLIC; until then only internal users can call it). server.ts sets this at boot, before pages render.
 */
let merchantListed = false;
export function listMerchant(on: boolean): void { merchantListed = on; }
/** The services every page, email and tool result names, in order. */
export const listedServices = (): Service[] => merchantListed ? ["ads", "search_console", "analytics", "merchant"] : ["ads", "search_console", "analytics"];
/** "Google Ads, Search Console or Google Analytics" (+ ", … or Merchant Center" once listed). */
export const servicesOr = () => joinLabels(listedServices().map((s) => SERVICE_LABELS[s]), "or");
/** "all three" / "all four". */
export const allN = () => (merchantListed ? "all four" : "all three");
const joinLabels = (xs: string[], word: string) => `${xs.slice(0, -1).join(", ")} ${word} ${xs.at(-1)}`;
/** Text of the service gate's refusal. Not PLAN_LIMIT_PREFIX: lifecycle.ts's limit_reached email is about Ads accounts. */
export const SERVICE_LIMIT_PREFIX = "Service limit:";
/** Text of the notice before Free's one service is picked: the user chooses, so 30 days aren't spent on whatever the AI called first. */
export const SERVICE_CHOICE_PREFIX = "Service choice:";
/** How long after a Service choice notice the next real call counts as the user's answer (session.ts checkService). */
export const SERVICE_CHOICE_SECONDS = 15 * 60;

/**
 * Which Free plan is live: by Google Ads account (FREE_ONE_SERVICE unset), one-service Free announced for a date, or on
 * since `from`. Every page, email and tool result that describes Free reads this, so the copy flips with the gate.
 */
export type FreePlan = { kind: "accounts" } | { kind: "upcoming"; from: number } | { kind: "one_service"; from: number };
export function freePlan(from: number | undefined, t = Math.floor(Date.now() / 1000)): FreePlan {
  return from === undefined ? { kind: "accounts" } : t < from ? { kind: "upcoming", from } : { kind: "one_service", from };
}
/**
 * FREE_ONE_SERVICE → when one-service Free starts: "1" = always (0), "YYYY-MM-DD" = that day at 08:00 UTC, else off.
 * 08:00 UTC is midnight Pacific (PST), so it's already that date in the Americas, Europe and Asia when it starts; at 00:00
 * UTC it would still be the day before across the Americas, while the notice names the day.
 */
export function parseFreeOneService(v: string | undefined): number | undefined {
  if (v === "1") return 0;
  const m = /^\d{4}-\d{2}-\d{2}$/.test(v ?? "") ? Date.parse(`${v}T08:00:00Z`) : NaN;
  return Number.isNaN(m) ? undefined : m / 1000;
}
/** "November 16". */
export const dateLabel = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
/** Free under one-service, as a clause: "one Google service at a time: Google Ads (1 account), Search Console or Google Analytics". */
export const oneServiceFree = () => `one Google service at a time: ${freeServices()}`;
/** The choice itself: "Google Ads (1 account), Search Console or Google Analytics". */
export const freeServices = () => joinLabels(listedServices().map((s) =>
  s === "ads" || s === "merchant" ? `${SERVICE_LABELS[s]} (1 account)` : SERVICE_LABELS[s]), "or");
/** What Plus, Pro and Agency cover beyond account count, once one-service Free is announced: "Google Ads, … and Google Analytics together". */
export const allServices = () => `${joinLabels(listedServices().map((s) => SERVICE_LABELS[s]), "and")} together`;
/**
 * The announcement sentence while one-service Free is upcoming; empty otherwise. `neutral` names no paid plan, for ChatGPT
 * connections (its plugin guidelines bar promoting upgrades; saying a feature needs a different plan is allowed).
 */
export const freePlanChange = (fp: FreePlan, neutral = false) =>
  fp.kind !== "upcoming" ? ""
    : `From ${dateLabel(fp.from)}, ${neutral ? "the current plan" : "Free"} covers ${oneServiceFree()}; `
      + (neutral ? "using several together needs a different plan." : `Plus (${PLUS_PRICE_LABEL}) covers ${allN()} together on 1 Google Ads account, and Pro and Agency on more.`);

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
 * The notice before a plan's switch is spent (SWITCH_NOTICE_PREFIX), and the service gate's choice and refusal
 * (SERVICE_CHOICE_PREFIX, SERVICE_LIMIT_PREFIX). Thrown to stop the tool, but returned as a normal result, not isError:
 * nothing failed, and an error here counted against the directory's reliability metrics.
 */
export class SwitchNotice extends PlanLimitError {}
