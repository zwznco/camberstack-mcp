/**
 * The admin overview's New tools card: is a tool we just shipped getting used? One row per tool in NEW_TOOLS for
 * NEW_FOR_DAYS after its release (its date comes from the changelog, so the two can't disagree). Add a tool here when
 * it ships; it drops off the card on its own.
 *
 * Counts real use only: a call that ran on the user's own data (ok, no notice text, not the demo account). Demo calls,
 * plan stops (a Plus tool on Free: plans.ts PLUS_FEATURE_PREFIX, logged ok with the stop's text in `error`) and
 * errors are their own columns. The predictions these feed are in ~/scripts/gap-audit/README.md §Predictions.
 */
import { CHANGELOG } from "./changelog.js";
import type { Q } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { PLUS_FEATURE_PREFIX, PLUS_TOOLS } from "./plans.js";

/** Tools by the release that added them, newest first. */
export const NEW_TOOLS: { tool: string; version: string }[] = [
  { tool: "performance_trend", version: "0.48.0" },
  { tool: "search_console_site_audit", version: "0.46.0" },
  { tool: "campaign_details", version: "0.45.0" },
  { tool: "conversion_tracking", version: "0.45.0" },
  { tool: "search_terms_report", version: "0.45.0" },
  { tool: "ads_report", version: "0.45.0" },
  { tool: "keywords_report", version: "0.45.0" },
];
export const NEW_FOR_DAYS = 30;

/** A release's date as unix seconds (UTC midnight), from the changelog. */
const shipped = (version: string) => {
  const d = CHANGELOG.find((r) => r.version === version)?.date;
  return d ? Date.parse(`${d}T00:00:00Z`) / 1000 : null;
};

export function newToolsReport(q: Q, since: number, nowSec: number) {
  const tools = NEW_TOOLS.map((t) => ({ ...t, at: shipped(t.version) }))
    .filter((t): t is typeof t & { at: number } => t.at != null && nowSec - t.at < NEW_FOR_DAYS * 86400);
  const rows = tools.map((t) => {
    const real = `c.tool = ? AND c.ok = 1 AND c.error IS NULL AND coalesce(c.customer_id, '') != '${DEMO_CID}'`;
    const one = <T>(sql: string, ...p: unknown[]) => q<T>(sql, ...p)[0]!;
    const w = one<{ users: number; calls: number; errors: number; demo: number }>(
      `SELECT count(DISTINCT CASE WHEN ${real} THEN c.user_id END) users, coalesce(sum(${real}), 0) calls,
         coalesce(sum(c.ok = 0), 0) errors, count(DISTINCT CASE WHEN c.ok = 1 AND c.customer_id = '${DEMO_CID}' THEN c.user_id END) demo
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.tool = ? AND c.at >= ?`, t.tool, t.tool, t.tool, since);
    // Since release, whatever the window: who ever used it, and who came back to it on another UTC day.
    const ever = one<{ users: number; repeat: number }>(
      `SELECT count(*) users, coalesce(sum(days > 1), 0) repeat FROM (SELECT c.user_id, count(DISTINCT c.at / 86400) days
         FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE ${real} GROUP BY 1)`, t.tool);
    // A Plus tool's stops on Free: who hit one, and who then opened the plans page or an upgrade link within a day.
    const stops = PLUS_TOOLS.has(t.tool) ? one<{ users: number; to_plans: number }>(
      `SELECT count(DISTINCT c.user_id) users, count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM plan_events p WHERE p.user_id = c.user_id
           AND p.kind IN ('plans_view', 'upgrade_click', 'paid') AND p.at BETWEEN c.at AND c.at + 86400) THEN c.user_id END) to_plans
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.tool = ? AND c.at >= ? AND c.error LIKE ?`, t.tool, since, `${PLUS_FEATURE_PREFIX}%`) : null;
    return { tool: t.tool, version: t.version, shipped: t.at, ...w, ever: ever.users, repeat: ever.repeat, stops };
  });
  // What the 0.45.0 tools were built to shrink: run_gaql's share of all calls in the window.
  const g = q<{ gaql: number; all: number }>(`SELECT coalesce(sum(c.tool = 'run_gaql'), 0) gaql, count(*) "all"
    FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ?`, since)[0]!;
  return { rows, gaqlShare: g.all ? g.gaql / g.all : null };
}
