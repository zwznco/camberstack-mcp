/**
 * Usage report over our own SQLite: the funnel the bet is judged on, per-user state, tool usage and
 * failures. Read-only. Shared by the CLI (funnel.ts) and the admin page (admin.ts) so the two can't
 * disagree about a number.
 */
import type { DB } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { GA_TARGET } from "./ga4-changes.js";
import { now } from "./db.js";
import { ADS_SCOPE, ANALYTICS_EDIT_SCOPE, ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "./google.js";
import { ACCOUNT_WINDOW_DAYS, AGENCY_PRICE_LABEL, PLAN_LIMIT_PREFIX, PLUS_PRICE_LABEL, PRO_ACCOUNTS, PRO_PRICE_LABEL, SWITCH_NOTICE_PREFIX } from "./plans.js";

/**
 * A paying customer: a paid plan with a live Stripe subscription. Complimentary plans (PRO_EMAILS, grandfathered Plus with no
 * subscription) aren't revenue. billing.ts drops a lapsed subscription to plan 'free' but keeps its stripe_sub, so a stripe_sub
 * alone isn't paying either. `u` is the users alias.
 */
const PAYING = "u.plan IN ('plus', 'pro', 'agency') AND coalesce(u.stripe_sub, '') != ''";
/** Monthly dollars per paid plan, from the labels the site shows, so the two can't drift. */
export const MONTHLY: Record<string, number> = Object.fromEntries(
  ([["plus", PLUS_PRICE_LABEL], ["pro", PRO_PRICE_LABEL], ["agency", AGENCY_PRICE_LABEL]] as const).map(([p, l]) => [p, Number(l.match(/\d+/)?.[0] ?? 0)]));

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

/**
 * The AI app a user connected from (alias `u`): their first tool call's client, else the client on a live token (they
 * connected but haven't called a tool), else the client they signed up through (users.signup_client_id, since 2026-10-23:
 * an app that dropped the sign-in before taking its token). Earlier users with none of these read NULL.
 */
const cameFrom = `coalesce(
  (SELECT json_extract(cl.info, '$.client_name') FROM tool_calls c JOIN clients cl ON cl.client_id = c.client_id
    WHERE c.user_id = u.id ORDER BY c.at LIMIT 1),
  (SELECT json_extract(cl.info, '$.client_name') FROM tokens t JOIN clients cl ON cl.client_id = t.client_id
    WHERE t.user_id = u.id LIMIT 1),
  (SELECT json_extract(cl.info, '$.client_name') FROM clients cl WHERE cl.client_id = u.signup_client_id))`;

/**
 * Connects by app, one row per app: "Claude Code (camberstack)" is Claude Code, the parenthesis being the server name
 * the user typed into it, so its rows merge with the bare name's.
 */
function byApp<R extends { app: string | null; connected: number; in_window: number; used_real: number; applied: number }>(rows: R[]): R[] {
  const out = new Map<string | null, R>();
  for (const r of rows) {
    const app = r.app?.replace(/\s*\(.*\)$/, "") || null, m = out.get(app);
    if (!m) { out.set(app, { ...r, app }); continue; }
    m.connected += r.connected; m.in_window += r.in_window; m.used_real += r.used_real; m.applied += r.applied;
  }
  return [...out.values()].sort((a, b) => Number(a.app === null) - Number(b.app === null) || b.connected - a.connected);
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
    paid:         n(`SELECT count(*) n FROM {U} u WHERE created_at >= ? AND ${PAYING}`, from),
    disconnected: n("SELECT count(*) n FROM {U} u WHERE created_at >= ? AND enc_refresh IS NULL", from),
  });

  const client = "coalesce(json_extract(cl.info, '$.client_name'), c.client_id, 'unknown')";
  return {
    days: o.days,
    excluded: ex.length,
    funnel: { window: stage(since), all: stage(0) },
    activeInWindow: n("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 1", since),
    // By when the change was applied, whenever the user signed up (the funnel's `applied` is by signup cohort). Real accounts only.
    appliedInWindow: q<{ users: number; changes: number }>(`SELECT count(DISTINCT p.user_id) users, count(*) changes FROM proposals p
        JOIN {U} u ON u.id = p.user_id WHERE p.status = 'applied' AND p.applied_at >= ? AND p.customer_id != '${DEMO_CID}'`, since)[0]!,
    // Paying customers, counted here rather than from `users` (capped at 200), and by plan for MRR.
    paying: n(`SELECT count(*) n FROM {U} u WHERE ${PAYING}`),
    payingByPlan: q<{ plan: string; n: number }>(`SELECT u.plan, count(*) n FROM {U} u WHERE ${PAYING} GROUP BY 1 ORDER BY 1`),
    // Counted on its own: summing `errors` would stop at its 15 groups and undercount wide windows.
    errorsInWindow: n("SELECT count(*) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 0", since),
    users: q<{ id: string; email: string; plan: string; created_at: number; last_seen_at: number | null; connected: number;
               google_scopes: string | null; paying: number; calls: number; errors: number; applied: number; client: string | null;
               used_accounts: number; ads_accounts: number | null; ads_managers: number | null }>(
      `SELECT u.id, u.email, u.plan, u.created_at, u.last_seen_at, u.enc_refresh IS NOT NULL connected, u.google_scopes,
         ${PAYING} paying,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id) calls,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 0) errors,
         (SELECT count(*) FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied') applied,
         -- Used as the plan counts it (session.ts usage): an account a call was stopped on, like a switch notice, isn't used.
         (SELECT count(DISTINCT customer_id) FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.customer_id IS NOT NULL
            AND c.customer_id NOT IN ('${DEMO_CID}', '${GA_TARGET}')) used_accounts, u.ads_accounts, u.ads_managers,
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
    /** Signups over the window, by UTC day, or by UTC hour for today (same shape as daily/hourly). */
    signupsDaily: q<{ day: string; n: number }>(
      `SELECT date(created_at, 'unixepoch') day, count(*) n FROM {U} u WHERE created_at >= ? GROUP BY 1 ORDER BY 1`, since),
    signupsHourly: o.days === 1 ? q<{ hour: number; n: number }>(
      `SELECT cast(strftime('%H', created_at, 'unixepoch') AS int) hour, count(*) n FROM {U} u WHERE created_at >= ? GROUP BY 1 ORDER BY 1`, since) : [],
    retention: retention(q),
    paywall: paywall(q),
    emails: q<{ kind: string; sent: number; in_window: number }>(
      `SELECT e.kind, count(*) sent, sum(e.sent_at >= ?) in_window FROM email_log e JOIN {U} u ON u.id = e.user_id GROUP BY 1 ORDER BY 1`, since),
    /** Connects split by the AI app they came from (each directory listing is a channel). Real-account stages only, as in the funnel. */
    sources: byApp(q<{ app: string | null; connected: number; in_window: number; used_real: number; applied: number }>(
      `SELECT ${cameFrom} app, count(*) connected,
         sum(u.created_at >= ?) in_window,
         sum(EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.customer_id IS NOT NULL AND c.customer_id != '${DEMO_CID}')) used_real,
         sum(EXISTS (SELECT 1 FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}')) applied
       FROM {U} u GROUP BY 1 ORDER BY app IS NULL, connected DESC`, since)),
    adConversions: q<{ recorded: number; uploaded: number; failing: number; last_error: string | null }>(
      `SELECT count(*) recorded, count(a.uploaded_at) uploaded, sum(a.uploaded_at IS NULL AND a.error IS NOT NULL) failing,
         (SELECT f.error FROM ad_conversions f JOIN {U} fu ON fu.id = f.user_id WHERE f.uploaded_at IS NULL AND f.error IS NOT NULL
            ORDER BY f.at DESC LIMIT 1) last_error
       FROM ad_conversions a JOIN {U} u ON u.id = a.user_id`)[0],
    /** Connected users holding each Google service (as last reported by Google; NULL scopes = not seen yet). */
    permissions: Object.fromEntries(Object.entries(SCOPE_LABELS).map(([scope, label]) => [label,
      n("SELECT count(*) n FROM {U} u WHERE enc_refresh IS NOT NULL AND (' ' || google_scopes || ' ') LIKE ?", `% ${scope} %`)])) as Record<string, number>,
    permissionsUnknown: n("SELECT count(*) n FROM {U} u WHERE enc_refresh IS NOT NULL AND google_scopes IS NULL"),
    /**
     * Free is one ad account per Google login, so several logins could multiply it. Flags an ad account more than one
     * user has run tools on, and a manager account more than one login can reach (an agency's staff, or one person's spare
     * logins). Both are often innocent: a colleague taking over, an owner and their agency. `users` is a JSON array.
     */
    sharing: q<{ kind: "ad account" | "manager"; customer_id: string; users: string; last: number | null }>(
      `SELECT 'ad account' kind, c.customer_id, json_group_array(DISTINCT json_object('id', u.id, 'email', u.email, 'plan', u.plan)) users, max(c.at) last
         FROM tool_calls c JOIN {U} u ON u.id = c.user_id
         WHERE c.ok = 1 AND c.customer_id IS NOT NULL AND c.customer_id NOT IN ('${DEMO_CID}', '${GA_TARGET}')
         GROUP BY c.customer_id HAVING count(DISTINCT c.user_id) > 1
       UNION ALL
       SELECT 'manager', m.value, json_group_array(DISTINCT json_object('id', u.id, 'email', u.email, 'plan', u.plan)), max(u.ads_accounts_at)
         FROM {U} u, json_each(u.ads_manager_ids) m
         GROUP BY m.value HAVING count(DISTINCT u.id) > 1
       ORDER BY last DESC`),
    /**
     * Who might need a bigger plan: reaches more ad accounts than Pro covers (Agency-sized), is using every account their
     * plan covers, or ran into the account gate. `active` (accounts that spent in the last 30 days) beats `reach`, since a
     * login often reaches dormant accounts (2026-10-26: of 4 users reaching 2, all used 1). Newest signal first.
     */
    opportunities: q<{ id: string; email: string; plan: string; reach: number | null; managers: number | null; active: number | null;
        used30: number; gate_hits: number; last_hit: number | null; last_seen: number | null }>(
      `SELECT u.id, u.email, u.plan, u.ads_accounts reach, u.ads_managers managers, u.ads_active active, u.last_seen_at last_seen,
         (SELECT count(DISTINCT c.customer_id) FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.customer_id IS NOT NULL
            AND c.customer_id NOT IN ('${DEMO_CID}', '${GA_TARGET}') AND c.at >= ?) used30,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id AND (c.error LIKE '${PLAN_LIMIT_PREFIX}%' OR c.error LIKE '${SWITCH_NOTICE_PREFIX}%')) gate_hits,
         (SELECT max(c.at) FROM tool_calls c WHERE c.user_id = u.id AND (c.error LIKE '${PLAN_LIMIT_PREFIX}%' OR c.error LIKE '${SWITCH_NOTICE_PREFIX}%')) last_hit
       FROM {U} u WHERE u.plan != 'agency'`, now() - ACCOUNT_WINDOW_DAYS * 86400)
      .map((o) => ({ ...o, why: [
        (o.active ?? o.reach ?? 0) > PRO_ACCOUNTS ? `Agency-sized: ${o.active !== null ? `${o.active} active` : `${o.reach} reachable`}` : "",
        o.plan === "pro" && o.used30 >= PRO_ACCOUNTS ? `at Pro's ${PRO_ACCOUNTS}` : "",
        o.gate_hits ? `hit the account gate ${o.gate_hits}×` : "",
      ].filter(Boolean) }))
      .filter((o) => o.why.length)
      .sort((a, b) => Math.max(b.last_hit ?? 0, b.last_seen ?? 0) - Math.max(a.last_hit ?? 0, a.last_seen ?? 0)),
    recent: q<{ at: number; email: string; tool: string; customer_id: string | null; ok: number; error: string | null; ms: number; client: string }>(
      `SELECT c.at, u.email, c.tool, c.customer_id, c.ok, substr(c.error, 1, 300) error, c.ms, ${client} client
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id
       ORDER BY c.id DESC LIMIT 50`),
  };
}

export type Report = ReturnType<typeof buildReport>;

export const RETENTION_WEEKS = 8;

/**
 * Weekly signup cohorts (UTC weeks from Monday) over the last RETENTION_WEEKS: `applied[n]` counts the cohort's users who
 * applied a real-account proposal 7n to 7n+7 days after their own signup (week 0 is the signup week itself), out of
 * `appliers` (those who ever applied one), and `paid` those now on a paid plan. Whether the users who make changes keep
 * making them is what pricing rests on (any tool call counted here until 2026-10-28, mostly reads that said little).
 * Ignores the admin's day window: a cohort needs weeks to say anything. Weeks count from each user's own signup, so
 * `applied` stops at the last week its earliest signup has begun, and only the first `done` have ended for its latest one.
 * Past `done` a cell is still filling in, not a drop.
 */
function retention(q: <T>(sql: string, ...p: unknown[]) => T[], t = now()) {
  // Day 0 of the epoch was a Thursday, so a day's Monday is (day + 3) % 7 days back.
  const monday = (col: string) => `(${col} - ${col} % 86400 - ((${col} / 86400 + 3) % 7) * 86400)`;
  const since = t - (t % 86400) - ((Math.floor(t / 86400) + 3) % 7) * 86400 - (RETENTION_WEEKS - 1) * 7 * 86400;
  const sizes = q<{ start: number; users: number; first: number; last: number; paid: number; appliers: number }>(
    `SELECT ${monday("u.created_at")} start, count(*) users, min(u.created_at) first, max(u.created_at) last, sum(${PAYING}) paid,
       sum(EXISTS (SELECT 1 FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}')) appliers
     FROM {U} u WHERE u.created_at >= ? GROUP BY 1 ORDER BY 1 DESC`, since);
  const applied = q<{ start: number; wk: number; users: number }>(
    `SELECT ${monday("u.created_at")} start, (p.applied_at - u.created_at) / 604800 wk, count(DISTINCT u.id) users
     FROM {U} u JOIN proposals p ON p.user_id = u.id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}' AND p.applied_at >= u.created_at
     WHERE u.created_at >= ? AND p.applied_at < u.created_at + ${RETENTION_WEEKS} * 604800 GROUP BY 1, 2`, since);
  return sizes.map((c) => {
    const begun = Math.min(RETENTION_WEEKS, Math.floor((t - c.first) / 604800) + 1);
    return {
      week: new Date(c.start * 1000).toISOString().slice(0, 10), users: c.users, done: Math.min(begun, Math.floor((t - c.last) / 604800)),
      appliers: c.appliers, paid: c.paid,
      applied: Array.from({ length: begun }, (_, n) => applied.find((b) => b.start === c.start && b.wk === n)?.users ?? 0),
    };
  });
}

/**
 * The one-service paywall (FREE_ONE_SERVICE; projects/camberstack/PRICING-TEST.md), from the first Service notice on, which is
 * when the flag went on. Users split into those who signed up before it (they lost all three) and after (Free was always one
 * service), and by whether they use ChatGPT, whose connections get /plans instead of an upgrade link. Each step counts users
 * since the switch-on: stopped by `Service limit:`, emailed about it, viewed /plans through their personal link, clicked a
 * personal upgrade link (any source), and paid. Empty until the flag has stopped someone.
 */
function paywall(q: <T>(sql: string, ...p: unknown[]) => T[]) {
  const on = q<{ at: number | null }>(
    `SELECT min(at) at FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.error LIKE 'Service limit:%' OR c.error LIKE 'Service choice:%'`)[0]?.at;
  if (!on) return { since: null, rows: [] };
  const chatgpt = `EXISTS (SELECT 1 FROM tool_calls c JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = u.id
    AND EXISTS (SELECT 1 FROM json_each(cl.info, '$.redirect_uris') WHERE value LIKE 'https://chatgpt.com/%'))`;
  const ev = (kind: string) => `EXISTS (SELECT 1 FROM plan_events e WHERE e.user_id = u.id AND e.kind = '${kind}' AND e.at >= ${on})`;
  const rows = q<{ existing: number; chatgpt: number; users: number; stopped: number; emailed: number; viewed: number; clicked: number; paid: number }>(
    `SELECT u.created_at < ${on} existing, ${chatgpt} chatgpt, count(*) users,
       sum(EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.at >= ${on} AND c.error LIKE 'Service limit:%')) stopped,
       sum(EXISTS (SELECT 1 FROM email_log m WHERE m.user_id = u.id AND m.kind = 'service_limit')) emailed,
       sum(${ev("plans_view")}) viewed, sum(${ev("upgrade_click")}) clicked, sum(${ev("paid")}) paid
     FROM {U} u WHERE coalesce(u.last_seen_at, u.created_at) >= ${on} GROUP BY 1, 2 ORDER BY 1 DESC, 2 DESC`);
  return { since: on, rows };
}

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
    stripe_customer, stripe_sub, time_zone, email_opt_out, ${cameFrom} came_from, ads_accounts, ads_managers, ads_accounts_at
    FROM users u WHERE id = ?`).get(id) as {
      id: string; email: string; plan: string; created_at: number; last_seen_at: number | null; connected: number; google_scopes: string | null;
      stripe_customer: string | null; stripe_sub: string | null; time_zone: string | null; email_opt_out: number;
      came_from: string | null;
      ads_accounts: number | null; ads_managers: number | null; ads_accounts_at: number | null } | undefined;
  if (!user) return null;
  const all = <T>(sql: string) => db.prepare(sql).all(id) as T[];
  const calls = <T>(sql: string) => db.prepare(sql).all(id, since) as T[];
  const client = "coalesce(json_extract(cl.info, '$.client_name'), c.client_id, 'unknown')";
  return {
    user,
    totals: db.prepare("SELECT count(*) calls, coalesce(sum(ok = 0), 0) errors, cast(coalesce(avg(ms), 0) AS int) avg_ms FROM tool_calls WHERE user_id = ? AND at >= ?").get(id, since) as
      { calls: number; errors: number; avg_ms: number },
    // ok_calls = 0: only ever stopped (a switch notice before 0.19.0, a plan refusal) or failed, so not used.
    accounts: calls<{ customer_id: string; calls: number; ok_calls: number; first: number; last: number }>(
      `SELECT customer_id, count(*) calls, sum(ok) ok_calls, min(at) first, max(at) last FROM tool_calls WHERE user_id = ? AND at >= ? AND customer_id IS NOT NULL
       GROUP BY 1 ORDER BY last DESC`),
    clients: calls<{ client: string; calls: number; last: number }>(
      `SELECT ${client} client, count(*) calls, max(c.at) last FROM tool_calls c LEFT JOIN clients cl ON cl.client_id = c.client_id
       WHERE c.user_id = ? AND c.at >= ? GROUP BY 1 ORDER BY calls DESC`),
    /** Each app's latest tool-list fetch and our version then (client_tools; recorded from 2026-10-15). */
    toolLists: all<{ client: string; version: string; fetched_at: number }>(
      `SELECT ${client.replaceAll("c.client_id", "ct.client_id")} client, ct.version, ct.fetched_at
       FROM client_tools ct LEFT JOIN clients cl ON cl.client_id = ct.client_id WHERE ct.user_id = ? ORDER BY ct.fetched_at DESC`),
    /**
     * ChatGPT's published app fetches the tool list once, under the account that publishes or refreshes it, and serves
     * that copy to every user, so its users never get a toolLists row (2026-10-23: 1 row across 23 users). For each
     * ChatGPT client this user has, the newest fetch on that client by anyone stands in.
     */
    appToolLists: db.prepare(`SELECT ${client.replaceAll("c.client_id", "ct.client_id")} client, ct.version, ct.fetched_at
       FROM client_tools ct JOIN clients cl ON cl.client_id = ct.client_id
       WHERE ct.client_id IN (SELECT client_id FROM tool_calls WHERE user_id = ? UNION SELECT client_id FROM tokens WHERE user_id = ?)
         AND EXISTS (SELECT 1 FROM json_each(cl.info, '$.redirect_uris') WHERE value LIKE 'https://chatgpt.com/%')
         AND ct.fetched_at = (SELECT max(fetched_at) FROM client_tools WHERE client_id = ct.client_id)
       ORDER BY ct.fetched_at DESC`).all(id, id) as { client: string; version: string; fetched_at: number }[],
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
