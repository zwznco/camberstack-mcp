/**
 * Usage report over our own SQLite: the funnel the bet is judged on, per-user state, tool usage and
 * failures. Read-only. Shared by the CLI (funnel.ts) and the admin page (admin.ts) so the two can't
 * disagree about a number.
 */
import type { DB } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { now } from "./db.js";
import { ADS_SCOPE, ANALYTICS_EDIT_SCOPE, ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "./google.js";

export interface ReportOptions {
  days: number;
  /** Emails left out of every number (the operator's and testers' own accounts). */
  exclude: string[];
}

/**
 * Where a window of `days` starts: whole UTC days ending today, so 1 is today since 00:00 UTC and 7 is today plus the six
 * days before it. Every chart bar is then a whole day. A rolling 24h straddled two UTC days and drew two half bars.
 */
export function windowStart(days: number, t = now()): number {
  return t - (t % 86400) - (days - 1) * 86400;
}

export function buildReport(db: DB, o: ReportOptions) {
  const since = windowStart(o.days);
  const ex = o.exclude.map((e) => e.toLowerCase());
  // Every query joins through `u`, so the exclusion applies everywhere at once.
  const U = `(SELECT * FROM users WHERE lower(email) NOT IN (${ex.map(() => "?").join(",") || "''"}))`;
  const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql.replaceAll("{U}", U)).all(...bind(sql, ex, p)) as T[];
  const n = (sql: string, ...p: unknown[]) => (q<{ n: number }>(sql, ...p)[0]?.n ?? 0);

  const stage = (from: number) => ({
    connected:    n("SELECT count(*) n FROM {U} u WHERE created_at >= ?", from),
    used_a_tool:  n("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1", from),
    // Demo activity is its own stage; every stage after it counts real accounts only.
    tried_demo:   n(`SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1 AND c.customer_id = '${DEMO_CID}'`, from),
    used_real:    n(`SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1 AND c.customer_id IS NOT NULL AND c.customer_id != '${DEMO_CID}'`, from),
    proposed:     n(`SELECT count(DISTINCT p.user_id) n FROM proposals p JOIN {U} u ON u.id = p.user_id WHERE u.created_at >= ? AND p.customer_id != '${DEMO_CID}'`, from),
    applied:      n(`SELECT count(DISTINCT p.user_id) n FROM proposals p JOIN {U} u ON u.id = p.user_id WHERE u.created_at >= ? AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}'`, from),
    paid:         n("SELECT count(*) n FROM {U} u WHERE created_at >= ? AND plan != 'free'", from),
    disconnected: n("SELECT count(*) n FROM {U} u WHERE created_at >= ? AND enc_refresh IS NULL", from),
  });

  const client = "coalesce(json_extract(cl.info, '$.client_name'), c.client_id, 'unknown')";
  return {
    days: o.days,
    excluded: ex.length,
    funnel: { window: stage(since), all: stage(0) },
    activeInWindow: n("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 1", since),
    // Paid Pro, counted here rather than from `users` (capped at 200). billing.ts drops a lapsed subscription to
    // plan 'free' but keeps its stripe_sub, so a stripe_sub alone is not a paying customer.
    paying: n("SELECT count(*) n FROM {U} u WHERE plan IN ('pro', 'agency') AND coalesce(stripe_sub, '') != ''"),
    // Counted on its own: summing `errors` would stop at its 15 groups and undercount wide windows.
    errorsInWindow: n("SELECT count(*) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 0", since),
    users: q<{ id: string; email: string; plan: string; created_at: number; last_seen_at: number | null; connected: number;
               google_scopes: string | null; paying: number; calls: number; errors: number; applied: number; client: string | null;
               used_accounts: number; ads_accounts: number | null; ads_managers: number | null }>(
      `SELECT u.id, u.email, u.plan, u.created_at, u.last_seen_at, u.enc_refresh IS NOT NULL connected, u.google_scopes,
         u.plan IN ('pro', 'agency') AND coalesce(u.stripe_sub, '') != '' paying,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id) calls,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 0) errors,
         (SELECT count(*) FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied') applied,
         (SELECT count(DISTINCT customer_id) FROM tool_calls c WHERE c.user_id = u.id AND c.customer_id IS NOT NULL
            AND c.customer_id != '${DEMO_CID}') used_accounts, u.ads_accounts, u.ads_managers,
         (SELECT ${client} FROM tool_calls c LEFT JOIN clients cl ON cl.client_id = c.client_id
            WHERE c.user_id = u.id ORDER BY c.at DESC LIMIT 1) client
       FROM {U} u ORDER BY coalesce(u.last_seen_at, u.created_at) DESC LIMIT 200`),
    tools: q<{ tool: string; calls: number; users: number; errors: number; avg_ms: number; max_ms: number }>(
      `SELECT tool, count(*) calls, count(DISTINCT c.user_id) users, sum(ok = 0) errors, cast(avg(ms) AS int) avg_ms, max(ms) max_ms
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE at >= ? GROUP BY tool ORDER BY calls DESC`, since),
    clients: q<{ client: string; calls: number; users: number }>(
      `SELECT ${client} client, count(*) calls, count(DISTINCT c.user_id) users
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id
       WHERE at >= ? GROUP BY 1 ORDER BY calls DESC`, since),
    /** The 15 most recently seen error groups, newest first (by count, a wide window buried today's errors). */
    errors: q<{ tool: string; error: string; n: number; users: number; last: number }>(
      `SELECT tool, substr(error, 1, 300) error, count(*) n, count(DISTINCT c.user_id) users, max(at) last FROM tool_calls c JOIN {U} u ON u.id = c.user_id
       WHERE at >= ? AND ok = 0 GROUP BY 1, 2 ORDER BY last DESC LIMIT 15`, since),
    daily: q<{ day: string; calls: number; users: number; errors: number }>(
      `SELECT date(at, 'unixepoch') day, count(*) calls, count(DISTINCT c.user_id) users, sum(ok = 0) errors
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE at >= ? GROUP BY 1 ORDER BY 1`, since),
    /** Today's window only: one row per UTC hour with calls (a single daily bar says nothing). */
    hourly: o.days === 1 ? q<{ hour: number; calls: number; users: number; errors: number }>(
      `SELECT cast(strftime('%H', at, 'unixepoch') AS int) hour, count(*) calls, count(DISTINCT c.user_id) users, sum(ok = 0) errors
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE at >= ? GROUP BY 1 ORDER BY 1`, since) : [],
    emails: q<{ kind: string; sent: number; in_window: number }>(
      `SELECT e.kind, count(*) sent, sum(e.sent_at >= ?) in_window FROM email_log e JOIN {U} u ON u.id = e.user_id GROUP BY 1 ORDER BY 1`, since),
    /** Connects split by first-touch source (firsttouch.ts), so a paid test is read by its own users, not a date window.
     *  Real-account stages only, as in the funnel. Untagged = no utm/click id on the landing, or signed up before 2026-10-16. */
    sources: q<{ source: string; campaign: string | null; content: string | null; connected: number; in_window: number; used_real: number; applied: number }>(
      `SELECT coalesce(u.src_source, '(untagged)') source, u.src_campaign campaign, u.src_content content, count(*) connected,
         sum(u.created_at >= ?) in_window,
         sum(EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.customer_id IS NOT NULL AND c.customer_id != '${DEMO_CID}')) used_real,
         sum(EXISTS (SELECT 1 FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}')) applied
       FROM {U} u GROUP BY 1, 2, 3 ORDER BY u.src_source IS NULL, connected DESC`, since),
    adConversions: q<{ recorded: number; uploaded: number; failing: number; last_error: string | null }>(
      `SELECT count(*) recorded, count(a.uploaded_at) uploaded, sum(a.uploaded_at IS NULL AND a.error IS NOT NULL) failing,
         (SELECT f.error FROM ad_conversions f JOIN {U} fu ON fu.id = f.user_id WHERE f.uploaded_at IS NULL AND f.error IS NOT NULL
            ORDER BY f.at DESC LIMIT 1) last_error
       FROM ad_conversions a JOIN {U} u ON u.id = a.user_id`)[0],
    /** Connected users holding each Google service (as last reported by Google; NULL scopes = not seen yet). */
    permissions: Object.fromEntries(Object.entries(SCOPE_LABELS).map(([scope, label]) => [label,
      n("SELECT count(*) n FROM {U} u WHERE enc_refresh IS NOT NULL AND (' ' || google_scopes || ' ') LIKE ?", `% ${scope} %`)])) as Record<string, number>,
    permissionsUnknown: n("SELECT count(*) n FROM {U} u WHERE enc_refresh IS NOT NULL AND google_scopes IS NULL"),
    recent: q<{ at: number; email: string; tool: string; customer_id: string | null; ok: number; error: string | null; ms: number; client: string }>(
      `SELECT c.at, u.email, c.tool, c.customer_id, c.ok, substr(c.error, 1, 300) error, c.ms, ${client} client
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id
       ORDER BY c.id DESC LIMIT 50`),
  };
}

export type Report = ReturnType<typeof buildReport>;

/** Google scope → the service it is, in the order the admin shows them. openid/email are left out. */
export const SCOPE_LABELS: Record<string, string> = {
  [ADS_SCOPE]: "Google Ads",
  [SEARCH_CONSOLE_SCOPE]: "Search Console",
  [ANALYTICS_SCOPE]: "GA4 read",
  [ANALYTICS_EDIT_SCOPE]: "GA4 edit",
};
export const permissionLabels = (scopes: string | null | undefined): string[] | null => {
  if (scopes == null) return null;
  const have = new Set(scopes.split(" "));
  return Object.entries(SCOPE_LABELS).filter(([s]) => have.has(s)).map(([, l]) => l);
};

/**
 * Everything about one user for the admin's user page. Null when there's no such user. Call-derived parts (totals, accounts,
 * apps, tools, recent calls) count from `since`; proposals, emails and tool-list versions are the account's whole history.
 */
export function userDetail(db: DB, id: string, since = 0) {
  const user = db.prepare(`SELECT id, email, plan, created_at, last_seen_at, enc_refresh IS NOT NULL connected, google_scopes,
    stripe_customer, stripe_sub, time_zone, email_opt_out, src_source, src_campaign, src_content, ads_accounts, ads_managers, ads_accounts_at
    FROM users WHERE id = ?`).get(id) as {
      id: string; email: string; plan: string; created_at: number; last_seen_at: number | null; connected: number; google_scopes: string | null;
      stripe_customer: string | null; stripe_sub: string | null; time_zone: string | null; email_opt_out: number;
      src_source: string | null; src_campaign: string | null; src_content: string | null;
      ads_accounts: number | null; ads_managers: number | null; ads_accounts_at: number | null } | undefined;
  if (!user) return null;
  const all = <T>(sql: string) => db.prepare(sql).all(id) as T[];
  const calls = <T>(sql: string) => db.prepare(sql).all(id, since) as T[];
  const client = "coalesce(json_extract(cl.info, '$.client_name'), c.client_id, 'unknown')";
  return {
    user,
    totals: db.prepare("SELECT count(*) calls, coalesce(sum(ok = 0), 0) errors, cast(coalesce(avg(ms), 0) AS int) avg_ms FROM tool_calls WHERE user_id = ? AND at >= ?").get(id, since) as
      { calls: number; errors: number; avg_ms: number },
    accounts: calls<{ customer_id: string; calls: number; first: number; last: number }>(
      `SELECT customer_id, count(*) calls, min(at) first, max(at) last FROM tool_calls WHERE user_id = ? AND at >= ? AND customer_id IS NOT NULL
       GROUP BY 1 ORDER BY last DESC`),
    clients: calls<{ client: string; calls: number; last: number }>(
      `SELECT ${client} client, count(*) calls, max(c.at) last FROM tool_calls c LEFT JOIN clients cl ON cl.client_id = c.client_id
       WHERE c.user_id = ? AND c.at >= ? GROUP BY 1 ORDER BY calls DESC`),
    /** Each app's latest tool-list fetch and our version then (client_tools; recorded from 2026-10-15). */
    toolLists: all<{ client: string; version: string; fetched_at: number }>(
      `SELECT ${client.replaceAll("c.client_id", "ct.client_id")} client, ct.version, ct.fetched_at
       FROM client_tools ct LEFT JOIN clients cl ON cl.client_id = ct.client_id WHERE ct.user_id = ? ORDER BY ct.fetched_at DESC`),
    tools: calls<{ tool: string; calls: number; errors: number }>(
      "SELECT tool, count(*) calls, sum(ok = 0) errors FROM tool_calls WHERE user_id = ? AND at >= ? GROUP BY 1 ORDER BY calls DESC"),
    proposals: all<{ id: string; customer_id: string; summary: string; status: string; undo_of: string | null; created_at: number; applied_at: number | null }>(
      "SELECT id, customer_id, summary, status, undo_of, created_at, applied_at FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"),
    emails: all<{ kind: string; sent_at: number }>("SELECT kind, sent_at FROM email_log WHERE user_id = ? ORDER BY sent_at"),
    recent: calls<{ at: number; tool: string; customer_id: string | null; ok: number; error: string | null; ms: number; client: string }>(
      `SELECT c.at, c.tool, c.customer_id, c.ok, substr(c.error, 1, 300) error, c.ms, ${client} client
       FROM tool_calls c LEFT JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = ? AND c.at >= ? ORDER BY c.id DESC LIMIT 100`),
  };
}
export type UserDetail = NonNullable<ReturnType<typeof userDetail>>;

/** {U} expands to a subquery with one placeholder per excluded email; bind those in order. No literal "?" in the SQL. */
function bind(sql: string, ex: string[], params: unknown[]): unknown[] {
  const out: unknown[] = [];
  let pi = 0;
  for (const m of sql.matchAll(/\{U\}|\?/g)) out.push(...(m[0] === "{U}" ? ex : [params[pi++]]));
  return out;
}
