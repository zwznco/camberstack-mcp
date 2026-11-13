/**
 * Usage report over our own SQLite: the funnel the bet is judged on, per-user state, tool usage and
 * failures. Read-only. Shared by the CLI (funnel.ts) and the admin page (admin.ts) so the two can't
 * disagree about a number.
 */
import { notesFunnel } from "./result-notes.js";
import type { DB } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { GA_TARGET } from "./ga4-changes.js";
import { now } from "./db.js";
import { capCounted } from "./session.js";
import { ADS_SCOPE, ANALYTICS_EDIT_SCOPE, ANALYTICS_SCOPE, MERCHANT_SCOPE, SEARCH_CONSOLE_READONLY_SCOPE, SEARCH_CONSOLE_SCOPE, TAG_MANAGER_SCOPES } from "./google.js";
import { ACCOUNT_WINDOW_DAYS, AGENCY_PRICE_LABEL, SERVICE_LABELS, listedServices, CHANGE_LIMIT_PREFIX, PLAN_LIMIT_PREFIX, PLUS_PRICE_LABEL, changeCap, changeCapFrom, PRO_PRICE_LABEL, SWITCH_NOTICE_PREFIX, payingSql } from "./plans.js";

/**
 * A paying customer: a paid plan with a live Stripe subscription. Complimentary plans (PRO_EMAILS, grandfathered Plus with no
 * subscription) aren't revenue. billing.ts drops a lapsed subscription to plan 'free' but keeps its stripe_sub, so a stripe_sub
 * alone isn't paying either. `u` is the users alias.
 */
const PAYING = payingSql("u.");
/** Monthly dollars per paid plan, from the labels the site shows, so the two can't drift. */
export const MONTHLY: Record<string, number> = Object.fromEntries(
  ([["plus", PLUS_PRICE_LABEL], ["pro", PRO_PRICE_LABEL], ["agency", AGENCY_PRICE_LABEL]] as const).map(([p, l]) => [p, Number(l.match(/\d+/)?.[0] ?? 0)]));

export interface ReportOptions {
  days: number;
  /** Emails left out of every number (the operator's and testers' own accounts). */
  exclude: string[];
  /** When the change cap went on, for the paywall read; unset = its first Change limit stop. */
  changeCapFrom?: number;
}

/** A tool_calls row on a real Google Ads account: not the demo, not the Google Analytics or Merchant Center markers. */
const ON_ADS = `c.customer_id NOT IN ('${DEMO_CID}', '${GA_TARGET}') AND c.customer_id NOT LIKE 'mc:%'`;
/**
 * A call that ran on the user's own Google data, not a demo: `service` names it for every service since 2026-10-28; before
 * that only a real Ads customer_id shows it (Search Console and Analytics calls then carried none). `c` is the alias.
 */
const realUse = (c: string) => `${c}.ok = 1 AND (coalesce(${c}.service, '') != '' OR (${c}.customer_id IS NOT NULL AND ${ON_ADS.replaceAll("c.", `${c}.`)}))`;

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

/** One user on the change cap (admin Cap tab): approvals counted now, when the window frees one, stops, the email, the plan. */
export interface CapRow {
  id: string; email: string; plan: string; paying: boolean; chatgpt: boolean;
  /** Approvals the cap counts right now (session.ts changesApplied). Paid plans: what it would be, for context. */
  used: number; cap: number; atCap: boolean;
  /** At the cap: when the next change opens. Below it: when the oldest counted approval rolls off (null with none). */
  windowEnds: number | null;
  stops: number; lastStop: number | null; emailed: number | null;
}

/**
 * The change cap (FREE_CHANGE_CAP) per user, counted by the gate's own count (session.ts capCounted). Users with a counted approval or a stop since
 * the start; internal accounts left out. At the cap first, then by approvals. Empty with the cap off.
 */
export function capUsage(db: DB, exclude: string[], t = Math.floor(Date.now() / 1000)): CapRow[] {
  const cap = changeCap();
  if (!cap) return [];
  const from = changeCapFrom(), win = ACCOUNT_WINDOW_DAYS * 86400, ex = new Set(exclude.map((e) => e.toLowerCase()));
  const users = (db.prepare(`SELECT id, email, plan, coalesce(stripe_sub, '') != '' paying, plan_reset_at FROM users`).all() as
    { id: string; email: string; plan: string; paying: number; plan_reset_at: number | null }[]).filter((u) => !ex.has(u.email.toLowerCase()));
  const stops = db.prepare(`SELECT count(*) n, max(at) last FROM tool_calls WHERE user_id = ? AND error LIKE '${CHANGE_LIMIT_PREFIX}%' AND at >= ?`);
  const mailed = db.prepare(`SELECT sent_at FROM email_log WHERE user_id = ? AND kind = 'change_limit'`);
  const gpt = db.prepare(`SELECT 1 FROM tool_calls c JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = ?
      AND EXISTS (SELECT 1 FROM json_each(cl.info, '$.redirect_uris') WHERE value LIKE 'https://chatgpt.com/%') LIMIT 1`);
  const rows: CapRow[] = [];
  for (const u of users) {
    const counted = capCounted(db, u.id, u.plan_reset_at, t);
    const st = stops.get(u.id, from) as { n: number; last: number | null };
    if (!counted.length && !st.n) continue;
    const atCap = u.plan === "free" && counted.length >= cap;
    rows.push({ id: u.id, email: u.email, plan: u.plan, paying: Boolean(u.paying), chatgpt: Boolean(gpt.get(u.id)),
      used: counted.length, cap, atCap,
      windowEnds: atCap ? counted[counted.length - cap]! + win : counted.length ? counted[0]! + win : null,
      stops: st.n, lastStop: st.last, emailed: (mailed.get(u.id) as { sent_at: number } | undefined)?.sent_at ?? null });
  }
  return rows.sort((a, b) => Number(b.atCap) - Number(a.atCap) || b.stops - a.stops || b.used - a.used);
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
            AND ${ON_ADS}) used_accounts, u.ads_accounts, u.ads_managers,
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
    paywall: paywall(q, o.changeCapFrom || changeCapFrom() || undefined),
    /** Results-ready notes (result-notes.ts): raised, and followed by change_results within the hour. */
    resultNotes: notesFunnel(q, since),
    /** Connects split by the AI app they came from (each directory listing is a channel). Real-account stages only, as in the funnel. */
    sources: byApp(q<{ app: string | null; connected: number; in_window: number; used_real: number; applied: number }>(
      `SELECT ${cameFrom} app, count(*) connected,
         sum(u.created_at >= ?) in_window,
         sum(EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.customer_id IS NOT NULL AND c.customer_id != '${DEMO_CID}')) used_real,
         sum(EXISTS (SELECT 1 FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}')) applied
       FROM {U} u GROUP BY 1 ORDER BY app IS NULL, connected DESC`, since)),
    /** Connected users holding each Google service (as last reported by Google; NULL scopes = not seen yet). */
    permissions: Object.fromEntries(Object.entries(SCOPE_LABELS).map(([scope, label]) => [label,
      n("SELECT count(*) n FROM {U} u WHERE enc_refresh IS NOT NULL AND (' ' || google_scopes || ' ') LIKE ?", `% ${scope} %`)])) as Record<string, number>,
    /**
     * Calls on the user's own data, by Google service (tool_calls.service, set since 2026-10-28; demo calls carry none),
     * in the window and all time. A call joining two services (paid_organic_overlap) counts under both.
     */
    serviceUse: serviceUse(q, since),
    permissionsUnknown: n("SELECT count(*) n FROM {U} u WHERE enc_refresh IS NOT NULL AND google_scopes IS NULL"),
    /**
     * Free is one ad account per Google login, so several logins could multiply it. Flags an ad account more than one
     * user has run tools on, and a manager account more than one login can reach (an agency's staff, or one person's spare
     * logins). Both are often innocent: a colleague taking over, an owner and their agency. `users` is a JSON array.
     */
    sharing: q<{ kind: "ad account" | "manager"; customer_id: string; users: string; last: number | null }>(
      `SELECT 'ad account' kind, c.customer_id, json_group_array(DISTINCT json_object('id', u.id, 'email', u.email, 'plan', u.plan)) users, max(c.at) last
         FROM tool_calls c JOIN {U} u ON u.id = c.user_id
         WHERE c.ok = 1 AND c.customer_id IS NOT NULL AND ${ON_ADS}
         GROUP BY c.customer_id HAVING count(DISTINCT c.user_id) > 1
       UNION ALL
       SELECT 'manager', m.value, json_group_array(DISTINCT json_object('id', u.id, 'email', u.email, 'plan', u.plan)), max(u.ads_accounts_at)
         FROM {U} u, json_each(u.ads_manager_ids) m
         GROUP BY m.value HAVING count(DISTINCT u.id) > 1
       ORDER BY last DESC`),
    /**
     * Who tried to move to another Google Ads account after their first day, in the last SWITCH_DAYS: a switch_account (choose_account on ChatGPT) to
     * a different account than the one they last ran a call on in the plan's current window (ACCOUNT_WINDOW_DAYS, and since
     * plan_reset_at), or a stop by the account gate (Plan limit, and the old Account switch notice). Not a first pick after
     * the Account choice notice (2026-11-09: a pick after a reset by hand read as a switch), a re-pick of the current account, or
     * listing accounts (2026-11-09: listing marked users who simply reach more accounts than they use). Not filtered by
     * users.ads_accounts for switches: it is only as fresh as their last list, and read 1 for a user who did switch. A stop
     * counts only on a login that sees more than one account: on 2026-11-05 a login with one was stopped because an id
     * from another login took the slot in flight (fixed in d6aaa8e), which was the AI, not the user, reaching elsewhere.
     */
    switching: q<{ id: string; email: string; plan: string; switches: number; stops: number; used: number; last: number }>(
      `WITH f AS (SELECT user_id, min(at) first FROM tool_calls GROUP BY user_id),
       e AS (
         SELECT c.user_id, c.at, c.error,
           c.tool IN ('switch_account', 'choose_account') AND c.ok = 1 AND c.error IS NULL AND c.customer_id IS NOT NULL AND ${ON_ADS}
             AND c.customer_id != coalesce((SELECT p.customer_id FROM tool_calls p WHERE p.user_id = c.user_id AND p.id < c.id AND p.ok = 1
               AND p.error IS NULL AND p.customer_id IS NOT NULL AND ${ON_ADS.replaceAll("c.", "p.")}
               AND p.at >= max(c.at - ${ACCOUNT_WINDOW_DAYS * 86400}, coalesce(w.plan_reset_at, 0)) ORDER BY p.id DESC LIMIT 1), c.customer_id) switched,
           coalesce(c.error, '') LIKE '${PLAN_LIMIT_PREFIX}%' OR coalesce(c.error, '') LIKE '${SWITCH_NOTICE_PREFIX}%' stopped
         FROM tool_calls c JOIN f ON f.user_id = c.user_id JOIN users w ON w.id = c.user_id
         WHERE c.at >= ? AND c.at >= f.first + 86400 AND (c.tool IN ('switch_account', 'choose_account') OR c.error LIKE '${PLAN_LIMIT_PREFIX}%' OR c.error LIKE '${SWITCH_NOTICE_PREFIX}%'))
       SELECT u.id, u.email, u.plan, sum(e.switched) switches, sum(e.stopped AND coalesce(u.ads_accounts, 2) > 1) stops,
         (SELECT count(DISTINCT c.customer_id) FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.error IS NULL AND c.customer_id IS NOT NULL
            AND ${ON_ADS} AND c.at >= ?) used,
         max(CASE WHEN e.switched OR (e.stopped AND coalesce(u.ads_accounts, 2) > 1) THEN e.at END) last
       FROM {U} u JOIN e ON e.user_id = u.id
       GROUP BY u.id HAVING switches + stops > 0 ORDER BY last DESC`, now() - SWITCH_DAYS * 86400, now() - SWITCH_DAYS * 86400),
    churn: churn(q),
    recent: q<{ at: number; email: string; tool: string; customer_id: string | null; ok: number; error: string | null; ms: number; client: string }>(
      `SELECT c.at, u.email, c.tool, c.customer_id, c.ok, substr(c.error, 1, 300) error, c.ms, ${client} client
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id
       ORDER BY c.id DESC LIMIT 50`),
  };
}

export type Report = ReturnType<typeof buildReport>;

export const RETENTION_WEEKS = 8;
/** The switching card (report.ts switching): how far back it looks. */
export const SWITCH_DAYS = 14;

/** A return: active again after at least this many UTC days (1 is the next day, which is ongoing use, not a return). */
export const RETURN_MIN_DAYS = 2;

/**
 * The churn watcher, with no fixed window: nobody knows yet how often a normal user comes back. Active days are UTC days
 * with any call that ran. Only established users are watched: active on two days or more, and either applied a real change
 * or made more real requests than the median user with any (live, so the bar moves with the user base); on 2026-11-09 the
 * rest were mostly one-day trials of 1-40 calls. Every gap of RETURN_MIN_DAYS+ between active days is a return; together
 * they set the norm (`p50`, `p90`). A user is overdue once silent longer than both p90 and their own longest return, so
 * someone who always comes back fortnightly isn't flagged at day 8. Coming back clears them.
 */
function churn(q: <T>(sql: string, ...p: unknown[]) => T[]) {
  const today = Math.floor(now() / 86400);
  const days = q<{ id: string; d: number }>(
    `SELECT c.user_id id, cast(c.at / 86400 AS int) d FROM tool_calls c JOIN {U} u ON u.id = c.user_id
     WHERE c.ok = 1 AND EXISTS (SELECT 1 FROM tool_calls r WHERE r.user_id = u.id AND ${realUse("r")}) GROUP BY 1, 2 ORDER BY 1, 2`);
  // Real requests and applied changes per user with any real use: the bar for being watched.
  const use = q<{ id: string; calls: number; applied: number }>(
    `SELECT c.user_id id, count(*) calls,
       (SELECT count(*) FROM proposals p WHERE p.user_id = c.user_id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}') applied
     FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE ${realUse("c")} GROUP BY 1`);
  const sorted = use.map((x) => x.calls).sort((a, b) => a - b);
  const medianCalls = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
  const usage = new Map(use.map((x) => [x.id, x]));
  const established = (id: string, activeDays: number) => {
    const x = usage.get(id);
    return activeDays >= 2 && !!x && (x.applied > 0 || x.calls > medianCalls);
  };
  const by = new Map<string, number[]>();
  for (const r of days) { const l = by.get(r.id); if (l) l.push(r.d); else by.set(r.id, [r.d]); }
  const gapsOf = (ds: number[]) => ds.slice(1).map((d, i) => d - ds[i]!).filter((g) => g >= RETURN_MIN_DAYS);
  const all = [...by.values()].flatMap(gapsOf).sort((a, b) => a - b);
  const pct = (p: number) => (all.length ? all[Math.min(all.length - 1, Math.ceil(p * all.length) - 1)]! : 0);
  const p50 = pct(0.5), p90 = pct(0.9);
  const overdue: { id: string; silent: number; longest: number; limit: number }[] = [];
  for (const [id, ds] of by) {
    if (!established(id, ds.length)) continue;
    const longest = Math.max(0, ...gapsOf(ds));
    const silent = today - ds.at(-1)!, limit = Math.max(p90, longest);
    if (all.length && silent > limit) overdue.push({ id, silent, longest, limit });
  }
  overdue.sort((a, b) => a.silent - a.limit - (b.silent - b.limit));  // the freshly overdue first: the ones still easy to win back
  const who = new Map(q<{ id: string; email: string; plan: string }>("SELECT u.id, u.email, u.plan FROM {U} u").map((u) => [u.id, u]));
  const named = <T extends { id: string }>(xs: T[]) => xs.filter((x) => who.has(x.id)).map((x) => ({ ...x, email: who.get(x.id)!.email, plan: who.get(x.id)!.plan }));
  return { returns: all.length, p50, p90, longest: all.at(-1) ?? 0, watched: [...by].filter(([id, d]) => established(id, d.length)).length, medianCalls, overdue: named(overdue) };
}

/**
 * Weekly signup cohorts (UTC weeks from Monday) over the last RETENTION_WEEKS: `applied[n]` counts the cohort's users who
 * applied a real-account proposal 7n to 7n+7 days after their own signup (week 0 is the signup week itself), out of
 * `appliers` (those who ever applied one), and `paid` those now on a paid plan. Whether the users who make changes keep
 * making them is what pricing rests on (any tool call counted here until 2026-10-28, mostly reads that said little).
 * Ignores the admin's day window: a cohort needs weeks to say anything. Weeks count from each user's own signup, so
 * `applied` stops at the last week its earliest signup has begun, and only the first `done` have ended for its latest one.
 * Past `done` a cell is still filling in, not a drop.
 */
function retention(q: <T>(sql: string, ...p: unknown[]) => T[]) {
  const t = now();
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
 * The change-cap paywall (FREE_CHANGE_CAP; projects/camberstack/PRICING-TEST.md), from switch-on: the cap's start, or its
 * first Change limit stop. Users split into those who signed up before it and after, and by whether they use ChatGPT,
 * whose connections get /plans instead of an upgrade link. Each step counts users since the switch-on: stopped by
 * `Change limit:`, emailed about it (change_limit), viewed /plans through their personal link, clicked a personal upgrade
 * link (any source), and paid. `offered` and `offered_paid` are the test's bar: stopped and reached the offer, and of those,
 * paid. `applied` is its guardrail. Complimentary plans are left out: they can't be stopped. Empty until the cap stops someone.
 */
function paywall(q: <T>(sql: string, ...p: unknown[]) => T[], from?: number) {
  const first = q<{ at: number | null }>(
    `SELECT min(at) at FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.error LIKE '${CHANGE_LIMIT_PREFIX}%'`)[0]?.at;
  if (!first) return { since: null, rows: [] };
  const on = from || first;
  const chatgpt = `EXISTS (SELECT 1 FROM tool_calls c JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = u.id
    AND EXISTS (SELECT 1 FROM json_each(cl.info, '$.redirect_uris') WHERE value LIKE 'https://chatgpt.com/%'))`;
  const ev = (kind: string) => `EXISTS (SELECT 1 FROM plan_events e WHERE e.user_id = u.id AND e.kind = '${kind}' AND e.at >= ${on})`;
  const stopped = `EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.at >= ${on} AND c.error LIKE '${CHANGE_LIMIT_PREFIX}%')`;
  const emailed = `EXISTS (SELECT 1 FROM email_log m WHERE m.user_id = u.id AND m.kind = 'change_limit')`;
  const offered = `(${stopped} AND (${emailed} OR ${ev("plans_view")} OR ${ev("upgrade_click")}))`;
  const rows = q<{ existing: number; chatgpt: number; users: number; stopped: number; emailed: number; viewed: number; clicked: number; paid: number;
      offered: number; offered_paid: number; applied: number }>(
    `SELECT u.created_at < ${on} existing, ${chatgpt} chatgpt, count(*) users,
       sum(${stopped}) stopped, sum(${emailed}) emailed,
       sum(${ev("plans_view")}) viewed, sum(${ev("upgrade_click")}) clicked, sum(${ev("paid")}) paid,
       sum(${offered}) offered, sum(${offered} AND ${ev("paid")}) offered_paid,
       sum(EXISTS (SELECT 1 FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}' AND p.applied_at >= ${on})) applied
     FROM {U} u WHERE coalesce(u.last_seen_at, u.created_at) >= ${on} AND (u.plan = 'free' OR coalesce(u.stripe_sub, '') != '')
     GROUP BY 1, 2 ORDER BY 1 DESC, 2 DESC`);
  return { since: on, rows };
}

function serviceUse(q: <T>(sql: string, ...p: unknown[]) => T[], since: number) {
  const has = (svc: string) => `(',' || c.service || ',') LIKE '%,${svc},%'`;
  const cols = listedServices().map((svc, i) => `sum(c.at >= ? AND ${has(svc)}) calls${i},
      count(DISTINCT CASE WHEN c.at >= ? AND ${has(svc)} THEN c.user_id END) users${i},
      count(DISTINCT CASE WHEN ${has(svc)} THEN c.user_id END) ever${i}`).join(",\n      ");
  const row = q<Record<string, number | null>>(`SELECT ${cols} FROM tool_calls c JOIN {U} u ON u.id = c.user_id
    WHERE c.ok = 1 AND c.service IS NOT NULL`, ...listedServices().flatMap(() => [since, since]))[0] ?? {};
  return listedServices().map((svc, i) => ({ service: SERVICE_LABELS[svc], calls: row[`calls${i}`] ?? 0, users: row[`users${i}`] ?? 0, ever: row[`ever${i}`] ?? 0 }));
}

/** Google scope → the service it is, in the order the admin shows them. openid/email are left out. */
export const SCOPE_LABELS: Record<string, string> = {
  [ADS_SCOPE]: "Google Ads",
  [SEARCH_CONSOLE_SCOPE]: "Search Console",
  [SEARCH_CONSOLE_READONLY_SCOPE]: "Search Console read-only",
  [ANALYTICS_SCOPE]: "GA4 read",
  [ANALYTICS_EDIT_SCOPE]: "GA4 edit",
  [MERCHANT_SCOPE]: "Merchant Center",
  // Tag Manager's four scopes are granted together (sign-in box or grant link), so edit.containers stands for them.
  [TAG_MANAGER_SCOPES[0]!]: "Tag Manager",
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
