import { describe, expect, it } from "vitest";
import { adCopyOf, adWording, bidStrategyChanges, flaggedWording, keywordUrlOverrides, looksLegal, samePage, shortCalls, stoppedConversions } from "./checks.js";

const ad = (group: string, urls: string[], headlines: string[] = [], id = "9") =>
  ({ adGroup: { id: group, name: `AG ${group}` }, campaign: { name: "Search" },
    adGroupAd: { ad: { id, finalUrls: urls, responsiveSearchAd: { headlines: headlines.map((text) => ({ text })), descriptions: [] } } } });
const kw = (group: string, text: string, urls: string[]) =>
  ({ adGroup: { id: group, name: `AG ${group}` }, campaign: { name: "Search" }, adGroupCriterion: { criterionId: "5", keyword: { text }, finalUrls: urls } });

describe("keyword final URLs", () => {
  it("names a keyword whose own URL replaces its ads' page, and leaves alone one that matches", () => {
    const ads = [ad("1", ["https://www.firm.com/injury/"]), ad("2", ["https://firm.com/divorce"])];
    const out = keywordUrlOverrides([
      kw("1", "injury lawyer", ["https://firm.com/old-page"]),
      kw("1", "accident lawyer", ["https://firm.com/injury?utm_source=x"]),  // same page, tracking aside
      kw("2", "divorce lawyer", []),                                          // no URL of its own
      kw("3", "orphan", ["https://firm.com/x"]),                              // ad group without ads
    ], ads) as any;
    expect(out.keyword_urls_override_ads.count).toBe(1);
    expect(out.keyword_urls_override_ads.keywords[0]).toMatchObject({ keyword: "injury lawyer", keyword_url: "https://firm.com/old-page" });
  });
  it("adds nothing when there's nothing to say", () => {
    expect(keywordUrlOverrides([], [])).toEqual({});
    expect(samePage("https://WWW.Firm.com/A/?x=1#y")).toBe("firm.com/a");
  });
});

describe("bid strategy changes", () => {
  it("lists campaign bidding changes with who and from/to, and skips the rest", () => {
    const rows = [
      { campaign: { name: "Leads" }, changeEvent: { changeDateTime: "2026-11-02 10:11:12.1", changedFields: "biddingStrategyType,maximizeConversions.targetCpaMicros",
        clientType: "GOOGLE_ADS_WEB_CLIENT", userEmail: "a@firm.com",
        oldResource: { campaign: { biddingStrategyType: "MANUAL_CPC" } }, newResource: { campaign: { biddingStrategyType: "MAXIMIZE_CONVERSIONS" } } } },
      { campaign: { name: "Leads" }, changeEvent: { changeDateTime: "2026-11-03", changedFields: "status", clientType: "GOOGLE_ADS_API" } },
      { campaign: { name: "Leads" }, changeEvent: { changeDateTime: "2026-11-04", changedFields: "manualCpc.enhancedCpcEnabled", clientType: "GOOGLE_ADS_API" } },
    ];
    const out = bidStrategyChanges(rows) as any;
    expect(out.bid_strategy_changes_last_30_days).toEqual([{ date: "2026-11-02 10:11", campaign: "Leads", from: "manual cpc", to: "maximize conversions",
      changed: "biddingStrategyType, maximizeConversions.targetCpaMicros", by: "in Google Ads (a@firm.com)" }]);
  });
});

describe("conversions that stopped", () => {
  const action = (id: string, name: string, last: string | undefined, type = "LEAD_FORM_SUBMIT", primary = true) =>
    ({ conversionAction: { id, name, type, primaryForGoal: primary }, metrics: last ? { conversionLastConversionDate: last } : {} });
  const count = (id: string, n: number) => ({ segments: { conversionAction: `customers/1/conversionActions/${id}` }, metrics: { allConversions: n } });
  it("flags an action that was firing and went quiet, not a steady or a rare one", () => {
    const out = stoppedConversions([
      action("1", "Lead form", "2026-10-20"),          // 5 in 90 days, none for 28 days
      action("2", "Calls", "2026-11-15", "AD_CALL"),   // still firing
      action("3", "Rare", "2026-09-01"),               // 1 in 90 days: too few to call it stopped
    ], [count("1", 3), count("1", 2), count("2", 9), count("3", 1)], "2026-11-17");
    expect([...out.names]).toEqual(["Lead form"]);
    expect((out.out as any).conversions_stopped.actions[0]).toMatchObject({ type: "lead form submit", last_conversion: "2026-10-20", conversions_last_90_days: 5 });
  });
});

describe("short calls", () => {
  const call = (s: number, status = "RECEIVED") => ({ callView: { callDurationSeconds: String(s), callStatus: status } });
  const action = { conversionAction: { id: "71", name: "Calls from ads", type: "AD_CALL", phoneCallDurationSeconds: "60" } };
  it("counts answered calls under the action's call length, and what each shorter length would count", () => {
    const r = shortCalls([action], [call(20), call(59), call(61), call(5, "MISSED")]) as any;
    expect(r.short_calls_not_counted.actions).toEqual([{ conversion_action: "Calls from ads", conversion_action_id: "71", counts_calls_of_at_least_seconds: 60,
      answered_calls_last_30_days: 3, shorter_so_not_counted: 2, would_count_at: { "10s": 3, "20s": 3, "30s": 2, "45s": 2 } }]);
    expect(r.short_calls_not_counted.note).toMatch(/set_conversion_settings with call_min_seconds/);
  });
  it("says nothing without call conversions or short calls", () => {
    expect(shortCalls([], [call(5)])).toEqual({});
    expect(shortCalls([action], [call(90)])).toEqual({});
  });
});

describe("attorney advertising wording", () => {
  it("knows a law firm by what it says, not by Lex or P.C.", () => {
    expect(looksLegal(["Forum & Lex, P.C."])).toBe(false);
    expect(looksLegal(["Immigration Attorney in Austin"])).toBe(true);
    expect(looksLegal(["https://example.com/injury-lawyer"])).toBe(true);
  });
  it("flags expert, specialist, superlatives and guarantees", () => {
    const f = flaggedWording(["Top-Rated Injury Lawyers", "Expert Legal Help", "We Specialize in DUI", "Results Guaranteed", "#1 Firm", "Free Consultation"]);
    expect(f.map((x) => x.flagged)).toEqual(["Top-Rated", "Expert", "Specialize", "Guaranteed", "#1"]);
  });
  it("checks live ads only on a law firm's account", () => {
    const ads = [ad("1", ["https://firm.com"], ["Injury Attorneys", "Expert Help"])];
    expect((adWording("Forum & Lex, P.C.", ads) as any).attorney_advertising_wording.items[0]).toMatchObject({ text: "Expert Help", flagged: "Expert" });
    expect(adWording("Plumbing Co", [ad("1", ["https://pipes.com"], ["Expert Plumbers"])])).toEqual({});
  });
  it("finds ad text anywhere in a change, and only ad text", () => {
    expect(adCopyOf({ type: "create_campaign", name: "Best campaign", final_url: "https://best.com",
      ad: { headlines: ["A", "B"], descriptions: ["C"] }, sitelinks: [{ link_text: "D", description1: "E", final_url: "https://x.com" }], callouts: ["F"] }))
      .toEqual(["A", "B", "C", "D", "E", "F"]);
  });
});

describe("flagsOf (tools.ts)", () => {
  it("logs check keys, a preview's account, wording_review and Local Services data, never the values", async () => {
    const { flagsOf } = await import("./tools.js");
    expect(flagsOf("account_overview", { attention: { conversions_stopped: {}, ads_with_policy_problems: [], more_ads_with_policy_problems: 3, recommendations_page: "u" } }, "333"))
      .toBe("preview:333,conversions_stopped,ads_with_policy_problems");
    expect(flagsOf("propose_changes", { proposal_id: "p_1", wording_review: { items: [] } }, null)).toBe("wording_review");
    expect(flagsOf("local_services_report", { none: "…" }, null)).toBe("lsa_empty");
    expect(flagsOf("local_services_report", { campaigns: [] }, null)).toBe("lsa_data");
    expect(flagsOf("run_gaql", { rows: [] }, null)).toBeNull();
  });
});
