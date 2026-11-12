import { describe, expect, it } from "vitest";
import { blocks, changeLogQuery, changeLogWindow, localDay, overlapNote, overlaps, reading, targets, windows } from "./results.js";

describe("change_results", () => {
  it("matches negatives the way Google does: exact, phrase in order, broad any order, no close variants", () => {
    expect(blocks("free invoice template", { text: "free", match_type: "PHRASE" })).toBe(true);
    expect(blocks("invoice template free", { text: "free invoice", match_type: "PHRASE" })).toBe(false);
    expect(blocks("invoice template free", { text: "free invoice", match_type: "BROAD" })).toBe(true);
    expect(blocks("freelance invoice", { text: "free", match_type: "PHRASE" })).toBe(false);
    expect(blocks("plumber jobs", { text: "plumber jobs", match_type: "EXACT" })).toBe(true);
    expect(blocks("plumber jobs near me", { text: "plumber jobs", match_type: "EXACT" })).toBe(false);
    expect(blocks("Plumber   JOBS", { text: "plumber jobs", match_type: "EXACT" })).toBe(true);
    expect(blocks("plumber job", { text: "jobs", match_type: "BROAD" })).toBe(false);
  });

  it("waits 7 full days after the apply day, then compares equal windows either side, at most 30", () => {
    expect(windows("2026-11-10", "2026-11-12")).toEqual({ readyOn: "2026-11-18" });
    expect(windows("2026-11-10", "2026-11-18")).toEqual({ days: 7, before: ["2026-11-03", "2026-11-09"], after: ["2026-11-11", "2026-11-17"] });
    const long = windows("2026-08-01", "2026-11-12");
    expect(long).toEqual({ days: 30, before: ["2026-07-02", "2026-07-31"], after: ["2026-08-02", "2026-08-31"] });
  });

  it("dates the apply in the account's time zone", () => {
    const t = Date.parse("2026-11-12T03:00:00Z") / 1000;
    expect(localDay(t, "UTC")).toBe("2026-11-12");
    expect(localDay(t, "America/Chicago")).toBe("2026-11-11");
  });

  it("measures only changes that applied and have an honest figure; new things by what they created", () => {
    const t = targets([
      { type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "free", match_type: "PHRASE" }] },
      { type: "edit_responsive_search_ad", ad_id: "1" },
      { type: "create_campaign", name: "New" },
      { type: "add_keywords", ad_group_id: "5", keywords: [{ text: "a", match_type: "EXACT" }] },
      { type: "set_daily_budget", campaign_id: "10", amount: 20 },
    ] as any, [
      { describe: "neg", ok: true },
      { describe: "ad edit", ok: true },
      { describe: "camp", ok: true, inverse: { type: "remove_campaign", resource_name: "customers/1/campaigns/77" } as any },
      { describe: "kws", ok: true, inverse: { type: "remove_keywords", resource_names: ["customers/1/adGroupCriteria/5~88"] } as any },
      { describe: "budget", ok: false },
    ]);
    expect(t.measured.map((m) => m.kind)).toEqual(["blocked", "new", "new"]);
    expect(t.measured[1]).toMatchObject({ level: "campaign", ids: ["77"] });
    expect(t.measured[2]).toMatchObject({ level: "keyword", ids: ["5~88"] });
    expect(t.notMeasured).toEqual(["ad edit"]);
  });

  it("reads before vs after in plain words, never as cause", () => {
    const r = reading({ kind: "blocked", describe: "", negatives: [] }, 14, "USD",
      { cost: 84.2, clicks: 31, conversions: 0 }, { cost: 0, clicks: 0, conversions: 0 });
    expect(r).toBe("Searches these negatives block cost $84.20 (31 clicks, 0 conversions) in the 14 days before; $0.00 (0 clicks) in the 14 days after.");
    expect(reading({ kind: "new", describe: "", level: "campaign", ids: [] }, 9, "EUR", { cost: 0, clicks: 0, conversions: 0 }, { cost: 0, clicks: 0, conversions: 0 }))
      .toContain("No spend");
    expect(reading({ kind: "campaign", describe: "", campaign: "1" }, 7, "EUR", { cost: 10, clicks: 1, conversions: 2 }, { cost: 30, clicks: 3, conversions: 3 }))
      .toBe("The campaign: 2 conversions for 10.00 EUR, 5.00 EUR each in the 7 days before; 3 conversions for 30.00 EUR, 10.00 EUR each in the 7 days after.");
  });
});

describe("other changes in the after window", () => {
  // Shaped like the real change_event rows read from 386-283-8095 on 2026-11-12.
  const ev = (date: string, type: string, fields: string, campaign: string, newResource: object = {}, clientType = "GOOGLE_ADS_API") =>
    ({ changeEvent: { changeDateTime: `${date} 10:00:00.1`, changeResourceType: type, resourceChangeOperation: "UPDATE", changedFields: fields,
      clientType, campaign: `customers/1/campaigns/${campaign}`, newResource } });

  it("spells out pauses, budgets and bid strategy changes to the same campaigns, counts the rest, ignores other campaigns", () => {
    const rows = [
      ev("2026-10-18", "CAMPAIGN", "status", "24316536904", { campaign: { status: "PAUSED" } }),
      ev("2026-10-19", "CAMPAIGN_BUDGET", "amountMicros", "24316536904", {}, "GOOGLE_ADS_WEB_CLIENT"),
      ev("2026-10-20", "CAMPAIGN", "accessibleBiddingStrategy,biddingStrategy", "24316536904"),
      ev("2026-10-20", "CAMPAIGN", "manualCpc.enhancedCpcEnabled", "24316536904"),
      ev("2026-10-21", "CAMPAIGN_CRITERION", "campaign,keyword.text,negative", "24316536904"),
      ev("2026-10-17", "CAMPAIGN", "status", "24319547906", { campaign: { status: "PAUSED" } }),
      ev("2026-11-30", "CAMPAIGN", "status", "24316536904", { campaign: { status: "ENABLED" } }),
    ];
    const o = overlaps(rows, new Set(["24316536904"]), ["2026-10-15", "2026-11-11"]);
    expect(o.notable).toEqual([
      { date: "2026-10-18", what: "campaign paused", by: "through the API (Camberstack or another tool)" },
      { date: "2026-10-19", what: "budget changed", by: "in Google Ads" },
      { date: "2026-10-20", what: "bid strategy changed", by: "through the API (Camberstack or another tool)" },
    ]);
    expect(o.other).toBe(2);
    expect(overlapNote(o)).toBe(" Also in the after window: campaign paused on 2026-10-18 through the API (Camberstack or another tool); "
      + "budget changed on 2026-10-19 in Google Ads; bid strategy changed on 2026-10-20 through the API (Camberstack or another tool); "
      + "2 other changes to the campaign, so the after figures aren't this change alone.");
    expect(overlapNote({ notable: [], other: 0 })).toBe("");
  });

  it("checks only what Google's change log still covers: 30 days, starting a day inside", () => {
    expect(changeLogWindow(["2026-10-15", "2026-11-11"], "2026-11-12")).toEqual(["2026-10-15", "2026-11-11"]);
    expect(changeLogWindow(["2026-10-01", "2026-10-30"], "2026-11-12")).toEqual(["2026-10-14", "2026-10-30"]);
    expect(changeLogWindow(["2026-09-01", "2026-09-30"], "2026-11-12")).toBeNull();
    expect(changeLogQuery(["2026-10-14", "2026-10-30"])).toContain("change_event.change_date_time >= '2026-10-14' AND change_event.change_date_time <= '2026-10-31'");
  });
});
