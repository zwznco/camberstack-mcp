/** What the paid plan costs and includes: the one copy every page, email and tool reads. */

export const PRO_PRICE_LABEL = "$15/month";
/** Plans are sized in Google Ads accounts used over this rolling window (session.ts accountsInUse). */
export const ACCOUNT_WINDOW_DAYS = 30;
/** Error text the account gate starts with; lifecycle.ts finds blocked users by it in tool_calls. */
export const PLAN_LIMIT_PREFIX = "Plan limit:";
/** Error text of the notice before a plan's one switch is spent (session.ts admit). Not a refusal: lifecycle.ts doesn't match it. */
export const SWITCH_NOTICE_PREFIX = "Account switch:";

/** "1 Google Ads account" / "10 Google Ads accounts". */
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
