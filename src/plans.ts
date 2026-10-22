/** What the paid plan costs and includes: the one copy every page, email and tool reads. */

export const PRO_PRICE_LABEL = "$15/month";
/** Google Ads accounts Pro covers at a time (PRO_ACCOUNTS overrides it, e.g. in tests). Was 10 until 2026-10-22. */
export const PRO_ACCOUNTS = 5;
/** Plans are sized in Google Ads accounts used over this rolling window (session.ts accountsInUse). */
export const ACCOUNT_WINDOW_DAYS = 30;
/** Error text the account gate starts with; lifecycle.ts finds blocked users by it in tool_calls. */
export const PLAN_LIMIT_PREFIX = "Plan limit:";
/** Error text of the notice before a plan's one switch is spent (session.ts admit). Not a refusal: lifecycle.ts doesn't match it. */
export const SWITCH_NOTICE_PREFIX = "Account switch:";

/** "1 Google Ads account" / "5 Google Ads accounts". */
export const accountsLabel = (n: number) => `${n} Google Ads account${n === 1 ? "" : "s"}`;

/**
 * The account gate's refusal. `message` keeps the PLAN_LIMIT_PREFIX sentence (logs, lifecycle.ts); `detail` is
 * the same facts as fields, which tools.ts returns as a structured error for the assistant to present.
 */
export class PlanLimitError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown>) { super(message); }
}
