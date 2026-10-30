import { describe, expect, it } from "vitest";
import { inverseAfterApply, resolveChange } from "./changes.js";

/** A campaign that targets the United States and English only. */
const ads = {
  async search(_cid: string, q: string): Promise<any[]> {
    if (q.includes("FROM campaign_criterion")) return [
      { campaignCriterion: { resourceName: "customers/1/campaignCriteria/10~1", type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/2840" } } },
      { campaignCriterion: { resourceName: "customers/1/campaignCriteria/10~2", type: "LANGUAGE", language: { languageConstant: "languageConstants/1000" } } },
    ];
    if (q.includes("FROM campaign")) return [{ campaign: { name: "Search", status: "ENABLED" } }];
    return [];
  },
};

describe("remove_campaign_targeting", () => {
  it("undoes only what it removed, not every id it was asked to remove", async () => {
    const r = await resolveChange(ads, "1", null, { type: "remove_campaign_targeting", campaign_id: "10",
      location_ids: ["2840", "2826"], language_ids: ["1000", "1003"] });
    expect(r.operations).toEqual([{ remove: "customers/1/campaignCriteria/10~1" }, { remove: "customers/1/campaignCriteria/10~2" }]);
    expect(r.inverse).toEqual({ type: "add_campaign_targeting", campaign_id: "10", location_ids: ["2840"], language_ids: ["1000"] });
  });

  it("has no undo when nothing it names is targeted", async () => {
    const r = await resolveChange(ads, "1", null, { type: "remove_campaign_targeting", campaign_id: "10", location_ids: ["2826"], language_ids: [] });
    expect(r.operations).toEqual([]);
    expect(r.inverse).toBeUndefined();
  });
});

describe("keyword lists", () => {
  it("skip what's already there and repeats within the request, case-insensitively", async () => {
    const ads = { async search(_c: string, q: string): Promise<any[]> {
      if (q.includes("FROM campaign_criterion")) return [{ campaignCriterion: { keyword: { text: "jobs", matchType: "PHRASE" } } }];
      return [{ campaign: { id: "10", name: "Search", advertisingChannelType: "SEARCH", status: "ENABLED" } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "add_negative_keywords", campaign_id: "10", keywords: [
      { text: "jobs", match_type: "PHRASE" }, { text: "Free", match_type: "PHRASE" }, { text: "free", match_type: "PHRASE" }, { text: "free", match_type: "EXACT" }] });
    expect(r.operations.map((o: any) => [o.create.keyword.text, o.create.keyword.matchType])).toEqual([["Free", "PHRASE"], ["free", "EXACT"]]);
    expect(r.describe).toContain("(2 already present or repeated, skipped)");
  });
});

describe("set_daily_budget", () => {
  it("writes nothing and offers no undo when the budget is already that amount", async () => {
    const ads = { async search(): Promise<any[]> {
      return [{ campaign: { name: "Search" }, campaignBudget: { resourceName: "customers/1/campaignBudgets/9", amountMicros: "40000000", explicitlyShared: false } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "set_daily_budget", campaign_id: "10", amount: 40 });
    expect(r.operations).toEqual([]);
    expect(r.inverse).toBeUndefined();
  });
});

describe("delete changes", () => {
  it("delete_keyword undoes as a new keyword, keeping its bid", async () => {
    const ads = { async search(): Promise<any[]> {
      return [{ adGroup: { name: "Drains" }, campaign: { name: "Search" }, adGroupCriterion: { status: "ENABLED", cpcBidMicros: "2500000", keyword: { text: "drain repair", matchType: "PHRASE" } } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "delete_keyword", ad_group_id: "5", criterion_id: "7" });
    expect(r.operations).toEqual([{ remove: "customers/1/adGroupCriteria/5~7" }]);
    expect(r.inverse).toEqual({ type: "add_keywords", ad_group_id: "5", keywords: [{ text: "drain repair", match_type: "PHRASE", max_cpc: 2.5 }] });
  });

  it("delete_keyword has no undo for a paused keyword: adding it back would start it spending", async () => {
    const ads = { async search(): Promise<any[]> {
      return [{ adGroup: { name: "Drains" }, campaign: { name: "Search" }, adGroupCriterion: { status: "PAUSED", keyword: { text: "drain repair", matchType: "PHRASE" } } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "delete_keyword", ad_group_id: "5", criterion_id: "7" });
    expect(r.inverse).toBeUndefined();
    expect(r.describe).toContain("⚠");
  });

  it("delete_ad warns on the ad group's last enabled ad, and has no undo", async () => {
    const ads = { async search(_c: string, q: string): Promise<any[]> {
      if (q.includes("ad_group_ad.status = 'ENABLED'")) return [{ adGroupAd: { ad: { id: "9" } } }];
      return [{ adGroup: { name: "Drains" }, campaign: { name: "Search" }, adGroupAd: { status: "ENABLED", ad: { finalUrls: ["https://a.example"] } } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "delete_ad", ad_group_id: "5", ad_id: "9" });
    expect(r.operations).toEqual([{ remove: "customers/1/adGroupAds/5~9" }]);
    expect(r.describe).toContain("last enabled ad");
    expect(r.describe).toContain("can't be undone");
    expect(r.inverse).toBeUndefined();
  });

  it("delete_campaign says it's permanent, and writes nothing for one already removed", async () => {
    const live = { async search(_c: string, q: string): Promise<any[]> {
      return q.includes("FROM ad_group") ? [{ adGroup: { id: "5" } }] : [{ campaign: { name: "Search", status: "PAUSED" } }];
    } };
    const r = await resolveChange(live, "1", null, { type: "delete_campaign", campaign_id: "10" });
    expect(r.operations).toEqual([{ remove: "customers/1/campaigns/10" }]);
    expect(r.describe).toContain("can't be undone");
    expect(r.inverse).toBeUndefined();
    const gone = { async search(): Promise<any[]> { return [{ campaign: { name: "Search", status: "REMOVED" } }]; } };
    expect((await resolveChange(gone, "1", null, { type: "delete_campaign", campaign_id: "10" })).operations).toEqual([]);
  });

  it("delete_negative_keywords removes only the named ones, and undo adds them back", async () => {
    const row = (id: string, text: string) => ({ campaign: { name: "Search" }, campaignCriterion: { resourceName: `customers/1/campaignCriteria/10~${id}`, keyword: { text, matchType: "PHRASE" } } });
    const ads = { async search(): Promise<any[]> { return [row("1", "free"), row("2", "jobs")]; } };
    const r = await resolveChange(ads, "1", null, { type: "delete_negative_keywords", campaign_id: "10", criterion_ids: ["2"] });
    expect(r.operations).toEqual([{ remove: "customers/1/campaignCriteria/10~2" }]);
    expect(r.inverse).toEqual({ type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "jobs", match_type: "PHRASE" }] });
    await expect(resolveChange(ads, "1", null, { type: "delete_negative_keywords", campaign_id: "10", criterion_ids: ["3"] })).rejects.toThrow("No negative keyword 3");
  });

  it("delete_sitelinks unlinks from the campaign, and undo adds the same link back", async () => {
    const ads = { async search(): Promise<any[]> {
      return [{ campaign: { name: "Search" }, campaignAsset: { resourceName: "customers/1/campaignAssets/10~44~SITELINK" }, asset: { id: "44", finalUrls: ["https://a.example/p"], sitelinkAsset: { linkText: "Pricing" } } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "delete_sitelinks", campaign_id: "10", asset_ids: ["44"] });
    expect(r.operations).toEqual([{ campaignAssetOperation: { remove: "customers/1/campaignAssets/10~44~SITELINK" } }]);
    expect(r.inverse).toEqual({ type: "add_sitelinks", campaign_id: "10", sitelinks: [{ text: "Pricing", url: "https://a.example/p" }] });
  });
});

describe("negatives beyond the campaign", () => {
  const list = { async search(_c: string, q: string): Promise<any[]> {
    if (q.includes("FROM campaign_shared_set")) return [{ campaign: { id: "10", name: "Search" }, campaignSharedSet: { resourceName: "customers/1/campaignSharedSets/10~8" } }];
    if (q.includes("FROM shared_criterion")) return [{ sharedCriterion: { resourceName: "customers/1/sharedCriteria/8~3", keyword: { text: "jobs", matchType: "PHRASE" } } }];
    if (q.includes("FROM shared_set")) return [{ sharedSet: { id: "8", name: "Junk", type: "NEGATIVE_KEYWORDS", status: "ENABLED" } }];
    return [{ campaign: { id: "11", name: "Other" } }];
  } };

  it("add_ad_group_negatives skips what's there and undoes what it added", async () => {
    const ads = { async search(_c: string, q: string): Promise<any[]> {
      return q.includes("FROM ad_group_criterion") ? [{ adGroupCriterion: { keyword: { text: "jobs", matchType: "PHRASE" } } }] : [{ adGroup: { name: "Drains" }, campaign: { name: "Search" } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "add_ad_group_negatives", ad_group_id: "5", keywords: [{ text: "Jobs", match_type: "PHRASE" }, { text: "free", match_type: "EXACT" }] });
    expect(r.operations).toEqual([{ create: { adGroup: "customers/1/adGroups/5", negative: true, keyword: { text: "free", matchType: "EXACT" } } }]);
    expect(inverseAfterApply(r, ["customers/1/adGroupCriteria/5~9"])).toMatchObject({ type: "remove_keywords", resource_names: ["customers/1/adGroupCriteria/5~9"] });
  });

  it("edit_negative_list names the campaigns it changes, and undo swaps what it added and removed", async () => {
    const r = await resolveChange(list, "1", null, { type: "edit_negative_list", shared_set_id: "8", add: [{ text: "free", match_type: "PHRASE" }], remove_criterion_ids: ["3"] });
    expect(r.describe).toContain('used by "Search"');
    expect(inverseAfterApply(r, ["customers/1/sharedCriteria/8~3", "customers/1/sharedCriteria/8~4"]))
      .toEqual({ type: "edit_negative_list", shared_set_id: "8", add: [{ text: "jobs", match_type: "PHRASE" }], remove_criterion_ids: ["4"] });
  });

  it("apply_negative_list adds and removes only what differs, and undo swaps them", async () => {
    const r = await resolveChange(list, "1", null, { type: "apply_negative_list", shared_set_id: "8", add_campaign_ids: ["10", "11"], remove_campaign_ids: ["10"] });
    expect(r.operations).toEqual([{ campaignSharedSetOperation: { create: { campaign: "customers/1/campaigns/11", sharedSet: "customers/1/sharedSets/8" } } },
      { campaignSharedSetOperation: { remove: "customers/1/campaignSharedSets/10~8" } }]);
    expect(r.inverse).toEqual({ type: "apply_negative_list", shared_set_id: "8", add_campaign_ids: ["10"], remove_campaign_ids: ["11"] });
  });

  it("create_negative_list undoes by deleting the list", async () => {
    const none = { async search(_c: string, q: string): Promise<any[]> { return q.includes("FROM shared_set") ? [] : [{ campaign: { id: "10", name: "Search" } }]; } };
    const r = await resolveChange(none, "1", null, { type: "create_negative_list", name: "Junk", keywords: [{ text: "free", match_type: "PHRASE" }], campaign_ids: ["10"] });
    expect(r.operations).toHaveLength(3);
    expect(inverseAfterApply(r, ["customers/1/sharedSets/77", "customers/1/sharedCriteria/77~1", "customers/1/campaignSharedSets/10~77"])).toEqual({ type: "delete_negative_list", shared_set_id: "77" });
  });
});

describe("edit_responsive_search_ad", () => {
  const ads = { async search(): Promise<any[]> {
    return [{ adGroup: { name: "Drains" }, campaign: { name: "Search" }, adGroupAd: { ad: { type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://a.example"], responsiveSearchAd: {
      headlines: [{ text: "One", pinnedField: "HEADLINE_1", assetPerformanceLabel: "GOOD" }, { text: "Two" }, { text: "Three" }], descriptions: [{ text: "D1" }, { text: "D2" }] } } } }];
  } };

  it("updates only what changed, warns about pins, and undo restores text and pins without read-only fields", async () => {
    const r = await resolveChange(ads, "1", null, { type: "edit_responsive_search_ad", ad_id: "9", headlines: ["One", "Two", "Four"], descriptions: ["D1", "D2"], final_url: "https://b.example" });
    expect(r.operations).toEqual([{ update: { resourceName: "customers/1/ads/9", responsiveSearchAd: { headlines: [{ text: "One" }, { text: "Two" }, { text: "Four" }] }, finalUrls: ["https://b.example"] },
      updateMask: "responsive_search_ad.headlines,final_urls" }]);
    expect(r.describe).toContain("pins");
    expect(r.inverse).toEqual({ type: "restore_responsive_search_ad", ad_id: "9", mask: "responsive_search_ad.headlines,final_urls",
      fields: { responsiveSearchAd: { headlines: [{ text: "One", pinnedField: "HEADLINE_1" }, { text: "Two" }, { text: "Three" }] }, finalUrls: ["https://a.example"] } });
  });

  it("writes nothing when nothing changes", async () => {
    const r = await resolveChange(ads, "1", null, { type: "edit_responsive_search_ad", ad_id: "9", final_url: "https://a.example" });
    expect(r.operations).toEqual([]);
  });
});

describe("schedules, devices, assets, AI Max, conversion settings", () => {
  it("set_ad_schedule replaces the old schedule, warns, and undo puts it back", async () => {
    const ads = { async search(_c: string, q: string): Promise<any[]> {
      return q.includes("FROM campaign_criterion") ? [{ campaignCriterion: { resourceName: "customers/1/campaignCriteria/10~5", bidModifier: 1.2,
        adSchedule: { dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO", endHour: 17, endMinute: "ZERO" } } }] : [{ campaign: { name: "Search" } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "set_ad_schedule", campaign_id: "10", schedule: [{ day: "TUESDAY", start_hour: 8, end_hour: 18 }] });
    expect(r.operations[0]).toEqual({ remove: "customers/1/campaignCriteria/10~5" });
    expect(r.describe).toContain("⚠");
    expect(r.inverse).toEqual({ type: "set_ad_schedule", campaign_id: "10", schedule: [{ day: "MONDAY", start_hour: 9, end_hour: 17, bid_percent: 20 }] });
  });

  it("set_device_bid warns when smart bidding would ignore it", async () => {
    const ads = { async search(_c: string, q: string): Promise<any[]> {
      return q.includes("FROM campaign_criterion") ? [{ campaignCriterion: { resourceName: "customers/1/campaignCriteria/10~30001", device: { type: "MOBILE" } } }]
        : [{ campaign: { name: "Search", biddingStrategyType: "MAXIMIZE_CONVERSIONS" } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "set_device_bid", campaign_id: "10", device: "MOBILE", percent: -20 });
    expect(r.operations).toEqual([{ update: { resourceName: "customers/1/campaignCriteria/10~30001", bidModifier: 0.8 }, updateMask: "bid_modifier" }]);
    expect(r.describe).toContain("smart bidding ignores");
    expect(r.inverse).toEqual({ type: "set_device_bid", campaign_id: "10", device: "MOBILE", percent: 0 });
  });

  it("add_campaign_assets links each asset, and undo unlinks what it added", async () => {
    const ads = { async search(): Promise<any[]> { return [{ campaign: { name: "Search" } }]; } };
    const r = await resolveChange(ads, "1", null, { type: "add_campaign_assets", campaign_id: "10", callouts: ["Free trial"], snippets: [], logos: [], images: [] });
    expect(r.operations).toHaveLength(2);
    expect(inverseAfterApply(r, ["customers/1/assets/5", "customers/1/campaignAssets/10~5~CALLOUT"])).toMatchObject({ type: "remove_campaign_assets", resource_names: ["customers/1/campaignAssets/10~5~CALLOUT"] });
  });

  it("set_ai_max changes only what differs, keeps other settings, and undo restores them", async () => {
    const ads = { async search(): Promise<any[]> { return [{ campaign: { name: "Search", assetAutomationSettings: [{ assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_OUT" }] } }]; } };
    const r = await resolveChange(ads, "1", null, { type: "set_ai_max", campaign_id: "10", ai_max: true, text_automation: false });
    expect(r.operations).toEqual([{ update: { resourceName: "customers/1/campaigns/10", aiMaxSetting: { enableAiMax: true } }, updateMask: "ai_max_setting.enable_ai_max" }]);
    expect(r.inverse).toEqual({ type: "restore_campaign_fields", campaign_id: "10", fields: { aiMaxSetting: { enableAiMax: false } }, mask: "ai_max_setting.enable_ai_max" });
  });

  it("set_ai_max explains that Google-written text needs AI Max", async () => {
    const ads = { async search(): Promise<any[]> { return [{ campaign: { name: "Search" } }]; } };
    await expect(resolveChange(ads, "1", null, { type: "set_ai_max", campaign_id: "10", text_automation: true })).rejects.toThrow("with AI Max on");
  });

  it("set_conversion_settings refuses an import, and undoes only what it changed", async () => {
    const row = (type: string) => ({ async search(): Promise<any[]> { return [{ conversionAction: { name: "Lead", type, valueSettings: { defaultValue: 5 }, clickThroughLookbackWindowDays: "30",
      attributionModelSettings: { attributionModel: "GOOGLE_ADS_LAST_CLICK" } } }]; } });
    await expect(resolveChange(row("GOOGLE_ANALYTICS_4_CUSTOM"), "1", null, { type: "set_conversion_settings", conversion_action_id: "7", default_value: 9 })).rejects.toThrow("imported");
    const r = await resolveChange(row("WEBPAGE"), "1", null, { type: "set_conversion_settings", conversion_action_id: "7", default_value: 9, click_window_days: 30 });
    expect(r.operations).toEqual([{ update: { resourceName: "customers/1/conversionActions/7", valueSettings: { defaultValue: 9 } }, updateMask: "value_settings.default_value" }]);
    expect(r.inverse).toEqual({ type: "set_conversion_settings", conversion_action_id: "7", default_value: 5 });
  });
});
