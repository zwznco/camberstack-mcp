import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { DEMO_CID, DemoAds } from "./demo.js";
import { findShift, performanceTrend } from "./trend.js";

const demo = new DemoAds(openDb(":memory:"), "u1");
const read = (q: string) => demo.search(DEMO_CID, q);
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

describe("findShift", () => {
  const dates = Array.from({ length: 20 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
  it("finds the day a series steps", () => {
    const v = dates.map((_, i) => (i < 12 ? 10 + (i % 2) : 4 + (i % 2)));
    expect(findShift(dates, v)).toMatchObject({ from: "2026-11-13", before: 10.5, after: 4.5 });
  });
  it("calls noise noise", () => {
    const v = dates.map((_, i) => [10, 12, 9, 11, 10, 13, 9, 10, 12, 11][i % 10]!);
    expect(findShift(dates, v)).toBeNull();
  });
  it("needs three days either side", () => {
    expect(findShift(dates.slice(0, 5), [1, 1, 1, 9, 9])).toBeNull();
  });
});

describe("performance_trend on the demo account", () => {
  it("compares the periods, finds Drain Cleaning's step, and says there's no change log", async () => {
    const r = await performanceTrend(read, { days: 28 }, { demo: true });
    expect(r.window.days).toBe(28);
    expect(r.daily).toHaveLength(28);
    expect(Array.isArray(r.movers)).toBe(true);
    const drain = (r.movers as any[]).find((m) => m.campaign_id === "2003");
    expect(drain.change.cost_pct).toBeGreaterThan(10);
    // The step lands 9 days ago; the demo's lighter weekends can move the best split a day or two.
    const off = (Date.parse(drain.shift.from) - Date.parse(iso(Date.now() - 9 * DAY))) / DAY;
    expect(Math.abs(off)).toBeLessThanOrEqual(3);
    expect(r.change_log.note).toMatch(/demo/);
  });
  it("scopes to one campaign and refuses an unknown one", async () => {
    const r = await performanceTrend(read, { campaign_id: "2001", days: 14 }, { demo: true });
    expect((r.movers as any[]).map((m) => m.campaign_id)).toEqual(["2001"]);
    await expect(performanceTrend(read, { campaign_id: "9999", days: 14 }, { demo: true })).rejects.toThrow(/account_overview/);
  });
});

describe("performance_trend on an account with a change log", () => {
  // Campaign 11 spends $100 a day and converts 5, until a budget cut 6 days ago halves both; budget-lost share jumps.
  const now = Date.parse("2026-11-23T12:00:00Z");
  const cutDay = iso(now - 6 * DAY);
  const stub = async (q: string) => {
    if (/FROM change_event/.test(q)) return [
      { changeEvent: { changeDateTime: `${cutDay} 09:12:00`, changeResourceType: "CAMPAIGN_BUDGET", changeResourceName: "customers/1/campaignBudgets/77",
        resourceChangeOperation: "UPDATE", changedFields: "amountMicros", clientType: "GOOGLE_ADS_WEB_CLIENT" } },
      { changeEvent: { changeDateTime: `${cutDay} 10:00:00`, changeResourceType: "AD_GROUP_CRITERION", campaign: "customers/1/campaigns/11",
        resourceChangeOperation: "CREATE", changedFields: "", clientType: "GOOGLE_ADS_API" } },
    ];
    const m = /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(q)!;
    const out: any[] = [];
    for (let t = Date.parse(`${m[1]}T00:00:00Z`); t <= Date.parse(`${m[2]}T00:00:00Z`); t += DAY) {
      const after = iso(t) >= cutDay;
      out.push({ campaign: { id: "11", name: "Search", status: "ENABLED", advertisingChannelType: "SEARCH", campaignBudget: "customers/1/campaignBudgets/77" },
        segments: { date: iso(t) },
        metrics: { costMicros: String((after ? 50 : 100) * 1e6), clicks: "40", impressions: "900", conversions: after ? 2 : 5,
          searchBudgetLostImpressionShare: after ? 0.45 : 0.05, searchRankLostImpressionShare: 0.2 } });
    }
    return out;
  };
  it("names the shift day, the budget change around it and who made it, and points at the budget", async () => {
    const r = await performanceTrend(stub, { days: 14 }, { demo: false, now, applied: [{ date: iso(now - 3 * DAY), summary: "Add 4 negative keywords" }] });
    const m = (r.movers as any[])[0];
    expect(m.shift).toMatchObject({ from: cutDay, metric: expect.any(String) });
    expect(m.shift.budget_lost_share_pct).toEqual({ before: 5, after: 45 });
    expect(m.changes_around_shift.notable).toEqual([{ date: cutDay, what: "budget changed", by: "in Google Ads" }]);
    expect(m.changes_around_shift.other).toEqual({ "keyword or ad group targeting": 1 });
    expect(m.next.join(" ")).toMatch(/propose_set_daily_budget/);
    expect(r.applied_through_camberstack).toHaveLength(1);
    // 14 days each side: the log covers both periods, from the previous one's first day.
    expect(r.change_log).toMatchObject({ covers: [iso(now - 28 * DAY), iso(now - DAY)], changes_read: 2 });
  });
});
