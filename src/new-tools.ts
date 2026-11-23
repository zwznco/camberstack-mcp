/**
 * The admin overview's New tools card: is a tool we just shipped getting used? One row per tool that first booted here
 * in the last NEW_FOR_DAYS, from tool_releases, which recordReleases fills at every boot. Nothing to maintain: a tool
 * shows up the day the deploy that adds it goes live (whether or not anyone calls it), and drops off 30 days later.
 * Only the catalog /tools lists (tools.ts toolCatalog): ChatGPT's per-change propose_* tools stay out, or every new
 * change type would read as a tool used on ChatGPT alone. A renamed tool counts as new.
 *
 * Counts real use only: a call that ran on the user's own data (ok, no notice text, not the demo account). Demo calls,
 * plan stops (a Plus tool on Free: plans.ts PLUS_FEATURE_PREFIX, logged ok with the stop's text in `error`) and
 * errors are their own columns. The predictions these feed are in ~/scripts/gap-audit/README.md §Predictions.
 */
import type { DB, Q } from "./db.js";
import { now } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { PLUS_FEATURE_PREFIX, PLUS_TOOLS } from "./plans.js";

export const NEW_FOR_DAYS = 30;

/**
 * The tools shipped before tool_releases existed (2026-11-23), with their releases' dates: the first boot seeds these
 * and dates every other tool in the catalog at 0, so the table's first boot doesn't make the whole catalog look new.
 */
const SEED: Record<string, [version: string, date: string]> = {
  performance_trend: ["0.48.0", "2026-11-23"],
  search_console_site_audit: ["0.46.0", "2026-11-18"],
  campaign_details: ["0.45.0", "2026-11-18"],
  conversion_tracking: ["0.45.0", "2026-11-18"],
  search_terms_report: ["0.45.0", "2026-11-18"],
  ads_report: ["0.45.0", "2026-11-18"],
  keywords_report: ["0.45.0", "2026-11-18"],
};

/** At boot: date every tool in the catalog not seen before to now, with the version booting. Idempotent (both colors run it). */
export function recordReleases(db: DB, tools: string[], version: string, at = now()): void {
  const ins = db.prepare("INSERT OR IGNORE INTO tool_releases (tool, version, at) VALUES (?, ?, ?)");
  db.transaction(() => {
    const first = !(db.prepare("SELECT 1 FROM tool_releases LIMIT 1").get());
    for (const t of tools) {
      const seed = first ? SEED[t] : undefined;
      ins.run(t, seed?.[0] ?? (first ? "earlier" : version), seed ? Date.parse(`${seed[1]}T00:00:00Z`) / 1000 : first ? 0 : at);
    }
  })();
}

export function newToolsReport(q: Q, since: number, nowSec: number) {
  const tools = q<{ tool: string; version: string; at: number }>(
    "SELECT tool, version, at FROM tool_releases WHERE at > ? ORDER BY at DESC, tool", nowSec - NEW_FOR_DAYS * 86400);
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
  })
    // Most used in the window first (users, then calls); ties keep newest release first.
    .sort((a, b) => b.users - a.users || b.calls - a.calls);
  // What the 0.45.0 tools were built to shrink: run_gaql's share of all calls in the window.
  const g = q<{ gaql: number; all: number }>(`SELECT coalesce(sum(c.tool = 'run_gaql'), 0) gaql, count(*) "all"
    FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ?`, since)[0]!;
  return { rows, gaqlShare: g.all ? g.gaql / g.all : null };
}
