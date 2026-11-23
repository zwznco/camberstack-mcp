/**
 * performance_trend (Plus and above, plans.ts PLUS_TOOLS): what changed in an account or one campaign against the
 * period before, which campaigns moved, on what day, and what was changed in the account around that day.
 *
 * Why this and not a daily table: the gap audit (~/scripts/gap-audit, 30 days to 2026-11-23) found results over time were
 * the largest read with no tool (70 of the 86 users who queried campaign metrics split them by segments.date). run_gaql
 * already answers a plain daily table, so the paid tool does what a query doesn't: it compares the two periods, finds the
 * day each mover shifted, and lines that day up against Google's change log (every change, made anywhere: Google Ads,
 * the API including Camberstack, rules, recommendations) and budget-lost share.
 *
 * It says "around then", never "caused": a shift and a change on the same day line up in time, nothing more.
 * Windows end yesterday (today is partial), as the other read tools' do. The change log covers only Google's last 30 days.
 */
import { micros } from "./google.js";
import { DAY, addMetrics, digits, done, isoDay, round, zero, type Read, type Totals } from "./reads.js";
import { changedBy, notableChange } from "./results.js";

export const MIN_DAYS = 7, MAX_DAYS = 90, DEFAULT_DAYS = 28;
const MOVERS_SHOWN = 5;
/** Days before a shift (and one after) whose changes are listed against it. */
const BEFORE_SHIFT = 3, AFTER_SHIFT = 1;
/** How far a split has to stand out (a t-like score) before it's called a shift rather than drift. */
const SHIFT_SCORE = 2.5;
const LOG_LIMIT = 1000;

/** A change Camberstack applied, from the proposals table (session.ts appliedIn). */
export interface Applied { date: string; summary: string }

const pct = (now: number, before: number) => (before > 0 ? round((100 * (now - before)) / before) : null);
const days = (a: string, b: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${a}T00:00:00Z`); t <= Date.parse(`${b}T00:00:00Z`); t += DAY) out.push(isoDay(t));
  return out;
};

type Day = { cost: number; clicks: number; conversions: number; budgetLost: number | null; rankLost: number | null };
type Camp = { id: string; name: string; status: string; type: string; budget: string | null; byDay: Map<string, Day> };

/**
 * The day a daily series shifted most, if it shifted at all: the split with the largest gap between the mean before and
 * after, scaled by how noisy the series is. At least 3 days either side. Null when no split stands out.
 */
export function findShift(dates: string[], values: number[]): { from: string; before: number; after: number; score: number } | null {
  const n = values.length;
  let best: { from: string; before: number; after: number; score: number } | null = null;
  for (let k = 3; k <= n - 3; k++) {
    const a = values.slice(0, k), b = values.slice(k);
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    const va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
    const sd = Math.sqrt((va + vb) / Math.max(1, n - 2));
    // A flat series has no noise to scale by: fall back to a share of its level, so a step from a constant still counts.
    const scale = sd > 0 ? sd : Math.max(1e-9, 0.05 * Math.max(Math.abs(ma), Math.abs(mb)));
    const score = (Math.abs(mb - ma) / scale) * Math.sqrt((k * (n - k)) / n);
    if (!best || score > best.score) best = { from: dates[k]!, before: round(ma), after: round(mb), score: round(score) };
  }
  return best && best.score >= SHIFT_SCORE ? best : null;
}

const OTHER: Record<string, string> = {
  AD_GROUP_CRITERION: "keyword or ad group targeting", AD_GROUP_AD: "ad", AD: "ad text", CAMPAIGN_CRITERION: "campaign targeting or negative",
  AD_GROUP: "ad group", CAMPAIGN: "campaign setting", CAMPAIGN_BUDGET: "budget", ASSET: "asset", CAMPAIGN_ASSET: "campaign asset",
  AD_GROUP_ASSET: "ad group asset", AD_GROUP_BID_MODIFIER: "bid adjustment", SHARED_SET: "shared list", CAMPAIGN_SHARED_SET: "shared list",
};

export async function performanceTrend(read: Read, o: { campaign_id?: string; days?: number }, ctx: { demo: boolean; applied?: Applied[]; now?: number }) {
  const n = Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(o.days ?? DEFAULT_DAYS)));
  const now = ctx.now ?? Date.now();
  const end = now - DAY;
  const cur: [string, string] = [isoDay(end - (n - 1) * DAY), isoDay(end)];
  const prev: [string, string] = [isoDay(end - (2 * n - 1) * DAY), isoDay(end - n * DAY)];
  const scope = o.campaign_id ? ` AND campaign.id = ${digits(o.campaign_id)}` : "";

  const rows = await read(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.campaign_budget,
      segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value,
      metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
      FROM campaign WHERE segments.date BETWEEN '${prev[0]}' AND '${cur[1]}'${scope}`);
  if (o.campaign_id && !rows.length) {
    const exists = await read(`SELECT campaign.id FROM campaign WHERE campaign.id = ${digits(o.campaign_id)}`).catch(() => [{}]);
    if (!exists.length) throw new Error(`Campaign ${o.campaign_id} isn't in this account. account_overview lists its campaigns with their ids.`);
  }

  const camps = new Map<string, Camp>();
  const share = (v: unknown) => (v == null ? null : Number(v));
  for (const r of rows) {
    const id = String(r.campaign?.id);
    const c = camps.get(id) ?? { id, name: r.campaign?.name, status: r.campaign?.status, type: r.campaign?.advertisingChannelType,
      budget: r.campaign?.campaignBudget ?? null, byDay: new Map<string, Day>() };
    const date = String(r.segments?.date ?? "");
    const d = c.byDay.get(date) ?? { cost: 0, clicks: 0, conversions: 0, budgetLost: null, rankLost: null };
    d.cost += micros(r.metrics?.costMicros);
    d.clicks += Number(r.metrics?.clicks ?? 0);
    d.conversions += Number(r.metrics?.conversions ?? 0);
    d.budgetLost = share(r.metrics?.searchBudgetLostImpressionShare) ?? d.budgetLost;
    d.rankLost = share(r.metrics?.searchRankLostImpressionShare) ?? d.rankLost;
    c.byDay.set(date, d);
    camps.set(id, c);
  }
  // Rows carry whole metrics; the totals need impressions and value too, so they're summed from the rows themselves.
  const periodOf = (date: string) => (date >= cur[0] ? "cur" : "prev");
  const totals = { cur: zero(), prev: zero() };
  const per = new Map<string, { cur: Totals; prev: Totals }>();
  for (const r of rows) {
    const p = periodOf(String(r.segments?.date ?? ""));
    addMetrics(totals[p], r.metrics);
    const id = String(r.campaign?.id);
    const t = per.get(id) ?? { cur: zero(), prev: zero() };
    addMetrics(t[p], r.metrics);
    per.set(id, t);
  }

  const allDays = days(prev[0], cur[1]);
  const series = (c: Camp, k: "cost" | "conversions") => allDays.map((d) => c.byDay.get(d)?.[k] ?? 0);
  const avgShare = (c: Camp, from: string, to: string, k: "budgetLost" | "rankLost") => {
    const xs = [...c.byDay.entries()].filter(([d, v]) => d >= from && d <= to && v[k] != null).map(([, v]) => v[k]!);
    return xs.length ? round((100 * xs.reduce((s, x) => s + x, 0)) / xs.length) : null;
  };

  // Which campaigns moved: enough of the account's spend or conversions to matter, not just a big percentage of little.
  const acct = { cost: Math.max(totals.prev.cost, totals.cur.cost, 1), conv: Math.max(totals.prev.conversions, totals.cur.conversions, 1) };
  const moved = [...camps.values()].map((c) => {
    const t = per.get(c.id)!;
    const dCost = t.cur.cost - t.prev.cost, dConv = t.cur.conversions - t.prev.conversions;
    const costMoved = Math.abs(dCost) >= Math.max(0.2 * t.prev.cost, 0.03 * acct.cost, 5);
    const convMoved = Math.abs(dConv) >= Math.max(0.25 * t.prev.conversions, 2);
    return { c, t, dCost, dConv, moved: costMoved || convMoved, weight: Math.abs(dCost) / acct.cost + Math.abs(dConv) / acct.conv };
  }).filter((m) => (o.campaign_id ? true : m.moved)).sort((a, b) => b.weight - a.weight);

  // Google's change log, for the part of both periods it still covers (its last 30 days).
  const logFrom = isoDay(now - 29 * DAY);
  const covers: [string, string] | null = cur[1] < logFrom ? null : [prev[0] < logFrom ? logFrom : prev[0], cur[1]];
  let log: any[] = [];
  let logNote: string | null = null;
  if (ctx.demo) logNote = "The demo account has no change log.";
  else if (covers) {
    log = await read(`SELECT change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name,
        change_event.resource_change_operation, change_event.changed_fields, change_event.client_type, change_event.campaign, change_event.new_resource
        FROM change_event WHERE change_event.change_date_time >= '${covers[0]}' AND change_event.change_date_time <= '${isoDay(now)}'
        ORDER BY change_event.change_date_time DESC LIMIT ${LOG_LIMIT}`).catch((e: Error) => {
      logNote = `Google's change log couldn't be read (${e.message.slice(0, 160)}), so no changes are listed.`;
      return [];
    });
    if (log.length >= LOG_LIMIT) logNote = `The change log had more than ${LOG_LIMIT} changes since ${covers[0]}; only the latest ${LOG_LIMIT} were read.`;
  }
  // A budget change names the budget, not the campaign: map it through the campaigns that use that budget.
  const byBudget = new Map<string, string[]>();
  for (const c of camps.values()) if (c.budget) byBudget.set(c.budget, [...(byBudget.get(c.budget) ?? []), c.id]);
  const changesOf = (campaignId: string, from: string, to: string) => {
    const notable: { date: string; what: string; by: string }[] = [];
    const other = new Map<string, number>();
    for (const r of log) {
      const e = r.changeEvent ?? {};
      const date = String(e.changeDateTime ?? "").slice(0, 10);
      if (date < from || date > to) continue;
      const ids = e.changeResourceType === "CAMPAIGN_BUDGET" ? byBudget.get(String(e.changeResourceName)) ?? [] : [String(e.campaign ?? "").split("/").at(-1)];
      if (!ids.includes(campaignId)) continue;
      const what = notableChange(e);
      if (what) notable.push({ date, what, by: changedBy(e) });
      else {
        const k = OTHER[e.changeResourceType] ?? String(e.changeResourceType ?? "other").toLowerCase().replace(/_/g, " ");
        other.set(k, (other.get(k) ?? 0) + 1);
      }
    }
    return { notable: notable.sort((a, b) => a.date.localeCompare(b.date)), other: Object.fromEntries(other) };
  };
  const shiftWindow = (from: string): [string, string] => [isoDay(Date.parse(`${from}T00:00:00Z`) - BEFORE_SHIFT * DAY), isoDay(Date.parse(`${from}T00:00:00Z`) + AFTER_SHIFT * DAY)];

  const movers = moved.slice(0, o.campaign_id ? 1 : MOVERS_SHOWN).map(({ c, t }) => {
    const costShift = findShift(allDays, series(c, "cost")), convShift = findShift(allDays, series(c, "conversions"));
    const shift = !costShift ? convShift && { metric: "conversions", ...convShift } : !convShift ? { metric: "cost", ...costShift }
      : convShift.score > costShift.score ? { metric: "conversions", ...convShift } : { metric: "cost", ...costShift };
    const near = shift ? changesOf(c.id, ...shiftWindow(shift.from)) : null;
    const budget = { previous: avgShare(c, prev[0], prev[1], "budgetLost"), current: avgShare(c, cur[0], cur[1], "budgetLost") };
    const rank = { previous: avgShare(c, prev[0], prev[1], "rankLost"), current: avgShare(c, cur[0], cur[1], "rankLost") };
    const before = shift ? { budget: avgShare(c, prev[0], isoDay(Date.parse(`${shift.from}T00:00:00Z`) - DAY), "budgetLost"),
      after: avgShare(c, shift.from, cur[1], "budgetLost") } : null;

    // What to look at next, only where the numbers point one way.
    const next: string[] = [];
    const paused = near?.notable.find((x) => /campaign paused/.test(x.what));
    if (paused) next.push(`The campaign was paused on ${paused.date} ${paused.by}.`);
    if (budget.current != null && budget.current >= 20 && budget.current - (budget.previous ?? 0) >= 10) {
      next.push(`Limited by budget: it lost ${budget.current}% of eligible search impressions to budget (was ${budget.previous ?? "n/a"}%). propose_set_daily_budget raises it.`);
    }
    if (shift?.metric === "conversions" && shift.after < shift.before && t.cur.cost >= 0.8 * t.prev.cost && near && !near.notable.length && !Object.keys(near.other).length && covers) {
      next.push("Conversions fell while spend held, with nothing in the change log around then: check conversion_tracking (a tag that stopped recording reads exactly like this).");
    }
    const started = t.prev.cost === 0 && t.cur.cost > 0, stopped = t.cur.cost === 0 && t.prev.cost > 0;
    return {
      campaign: c.name, campaign_id: c.id, status: String(c.status ?? "").toLowerCase(), type: c.type,
      ...(started ? { started: true } : stopped ? { stopped: true } : {}),
      previous: done(t.prev), current: done(t.cur),
      change: { cost_pct: pct(t.cur.cost, t.prev.cost), conversions_pct: pct(t.cur.conversions, t.prev.conversions),
        ...(t.prev.conversions > 0 && t.cur.conversions > 0 ? { cost_per_conversion_pct: pct(t.cur.cost / t.cur.conversions, t.prev.cost / t.prev.conversions) } : {}) },
      ...(budget.previous != null || budget.current != null ? { budget_lost_share_pct: budget, rank_lost_share_pct: rank } : {}),
      shift: shift ? { metric: shift.metric, from: shift.from, daily_before: shift.before, daily_after: shift.after,
        ...(before && (before.budget != null || before.after != null) ? { budget_lost_share_pct: { before: before.budget, after: before.after } } : {}) }
        : "no single day stands out: a gradual drift, or noise",
      ...(shift ? { changes_around_shift: near && covers && shift.from >= covers[0]
        ? { window: shiftWindow(shift.from), notable: near.notable, other: near.other }
        : "outside Google's 30-day change log" } : {}),
      ...(next.length ? { next } : {}),
    };
  });

  // The day-by-day line for what was asked: one campaign, or the whole account.
  const daily = days(cur[0], cur[1]).map((d) => {
    let cost = 0, clicks = 0, conv = 0;
    for (const c of camps.values()) { const v = c.byDay.get(d); if (v) { cost += v.cost; clicks += v.clicks; conv += v.conversions; } }
    return { date: d, cost: round(cost), clicks, conversions: round(conv) };
  });

  const applied = (ctx.applied ?? []).filter((a) => a.date >= prev[0] && a.date <= cur[1]).slice(0, 20);
  return {
    ...(o.campaign_id ? { campaign_id: o.campaign_id } : {}),
    window: { current: cur, previous: prev, days: n },
    totals: { previous: done(totals.prev), current: done(totals.cur),
      change: { cost_pct: pct(totals.cur.cost, totals.prev.cost), clicks_pct: pct(totals.cur.clicks, totals.prev.clicks),
        conversions_pct: pct(totals.cur.conversions, totals.prev.conversions),
        ...(totals.prev.conversions > 0 && totals.cur.conversions > 0
          ? { cost_per_conversion_pct: pct(totals.cur.cost / totals.cur.conversions, totals.prev.cost / totals.prev.conversions) } : {}) } },
    movers: movers.length ? movers : o.campaign_id ? movers : "No campaign moved enough to matter between the two periods.",
    daily,
    ...(applied.length ? { applied_through_camberstack: applied } : {}),
    change_log: covers && !ctx.demo ? { covers, changes_read: log.length, ...(logNote ? { note: logNote } : {}) } : { note: logNote ?? "Both periods are older than Google's 30-day change log." },
    note: "A shift and a change on the same days line up in time; that isn't proof one caused the other. Conversions can arrive days "
      + "after the click, so the last few days may still rise. Budget and rank lost share are search campaigns only, averaged over days.",
  };
}
