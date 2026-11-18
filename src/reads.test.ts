import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { DEMO_CID, DemoAds } from "./demo.js";
import { adsReport, campaignDetails, conversionTracking, keywordsReport, searchTerms } from "./reads.js";

const demo = new DemoAds(openDb(":memory:"), "u1");
const read = (q: string) => demo.search(DEMO_CID, q);

describe("read tools on the demo account", () => {
  it("campaign_details: settings, targeting by name, ad groups with results", async () => {
    const r = await campaignDetails(read, "2001", 30);
    expect(r.campaign).toMatchObject({ campaign_id: "2001", name: "Emergency Plumbing – Search", daily_budget: 40, bidding: { strategy: "MAXIMIZE_CONVERSIONS" } });
    expect((r.targeting as any).languages).toEqual(["English"]);
    expect((r.targeting as any).locations[0].name).toBeTruthy();
    expect(r.ad_groups.map((g) => g.name)).toEqual(expect.arrayContaining(["Emergency Plumber", "Burst Pipes & Leaks"]));
    expect(r.performance.cost).toBeGreaterThan(0);
    expect(r.conversion_goals.length).toBeGreaterThan(0);
  });
  it("campaign_details: an unknown campaign says where the ids are", async () => {
    await expect(campaignDetails(read, "9999", 30)).rejects.toThrow(/account_overview/);
    await expect(campaignDetails(read, "20 01", 30)).rejects.toThrow(/digits/);
  });
  it("conversion_tracking: every action, primary first, no fake zero counts on the demo", async () => {
    const r = await conversionTracking(read, 30, true);
    expect(r.actions.map((a) => a.name)).toEqual(["Calls from ads", "Online booking", "Thank-you page view"]);
    expect(r.actions[0]).not.toHaveProperty("conversions");
    expect(r.note).toMatch(/demo/);
  });
  it("search_terms_report: merged per term and ad group, by cost, with spend that never converted", async () => {
    const r = await searchTerms(read, { days: 30, limit: 5 });
    expect(r.terms).toHaveLength(5);
    expect(r.terms[0]!.cost).toBeGreaterThanOrEqual(r.terms[1]!.cost);
    expect(r.totals.terms_without_conversions).toBeGreaterThan(0);
    expect(r.shown).toMatch(/top 5/);
    const one = await searchTerms(read, { campaign_id: "2003", days: 30 });
    expect(new Set(one.terms.map((t) => t.campaign_id))).toEqual(new Set(["2003"]));
  });
  it("ads_report: headlines and descriptions, filtered by ad group", async () => {
    const r = await adsReport(read, { ad_group_id: "3001", days: 30 });
    expect(r.ads).toHaveLength(1);
    expect(r.ads[0]!.headlines!.map((h) => h.text)).toContain("Northwind Plumbing");
    expect(r.ads[0]!.approval).toBe("APPROVED");
  });
  it("keywords_report: keywords by cost, scoped to a campaign", async () => {
    const r = await keywordsReport(read, { campaign_id: "2002", days: 30 });
    expect(r.keywords.map((k) => k.text).sort()).toEqual(["tankless water heater", "water heater installation", "water heater repair"]);
    expect(r.keywords[0]!.cost).toBeGreaterThanOrEqual(r.keywords.at(-1)!.cost);
  });
});

describe("campaign_details on a campaign with shared negative lists", () => {
  it("lists each list's keywords, capped across lists", async () => {
    const stub = async (q: string) => {
      if (/FROM campaign_shared_set/.test(q)) return [{ sharedSet: { id: "71", name: "Jobs", type: "NEGATIVE_KEYWORDS", memberCount: "2" } },
        { sharedSet: { id: "72", name: "Big", type: "NEGATIVE_KEYWORDS", memberCount: "250" } }];
      if (/FROM shared_criterion/.test(q)) {
        expect(q).toMatch(/shared_set\.id IN \(71, 72\)/);
        return [{ sharedSet: { id: "71" }, sharedCriterion: { keyword: { text: "jobs", matchType: "BROAD" } } },
          { sharedSet: { id: "71" }, sharedCriterion: { keyword: { text: "salary", matchType: "PHRASE" } } },
          ...Array.from({ length: 250 }, (_, i) => ({ sharedSet: { id: "72" }, sharedCriterion: { keyword: { text: `k${i}`, matchType: "EXACT" } } }))];
      }
      return read(q);
    };
    const lists = (await campaignDetails(stub, "2001", 30)).negative_keywords.shared_lists as any[];
    expect(lists[0]).toMatchObject({ name: "Jobs", count: 2, keywords: [{ text: "jobs", match_type: "BROAD" }, { text: "salary", match_type: "PHRASE" }] });
    expect(lists[1]).toMatchObject({ name: "Big", count: 250, shown: 198 });
    expect(lists[1].keywords).toHaveLength(198);
  });
});
