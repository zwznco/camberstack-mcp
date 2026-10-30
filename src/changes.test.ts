import { describe, expect, it } from "vitest";
import { resolveChange } from "./changes.js";

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
