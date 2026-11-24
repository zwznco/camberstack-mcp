import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { DEMO_CID, DemoAds } from "./demo.js";
import { adsReport, campaignDetails, conversionFixes, conversionTracking, keywordsReport, searchTerms, sendToOf } from "./reads.js";

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
  it("conversion_tracking: a silent site-tag action gets fix steps with its send_to, read only when needed", async () => {
    const queries: string[] = [];
    const fake = async (q: string): Promise<any[]> => {
      queries.push(q);
      if (/tag_snippets/.test(q)) return [{ conversionAction: { id: "7", tagSnippets: [{ eventSnippet: "gtag('event', 'conversion', {'send_to': 'AW-123456/AbC-9x'});" }] } }];
      if (/FROM conversion_action/.test(q)) return [
        { conversionAction: { id: "7", name: "Lead form", status: "ENABLED", type: "WEBPAGE", primaryForGoal: true, includeInConversionsMetric: true } },
        { conversionAction: { id: "8", name: "GA4 lead", status: "ENABLED", type: "GOOGLE_ANALYTICS_4_CUSTOM", primaryForGoal: true,
          googleAnalytics4Settings: { eventName: "generate_lead", propertyId: "99" } } },
        { conversionAction: { id: "9", name: "Calls", status: "ENABLED", type: "AD_CALL", primaryForGoal: true }, metrics: {} },
      ];
      if (/segments.conversion_action/.test(q)) return [{ segments: { conversionAction: "customers/1/conversionActions/9" }, metrics: { allConversions: 4, conversions: 4 } }];
      if (/FROM customer\b/.test(q) && /auto_tagging/.test(q)) return [{ customer: { autoTaggingEnabled: true } }];
      return [];
    };
    const r = await conversionTracking(fake, 30, false);
    expect(r.fix!.map((f) => f.problem)).toEqual([expect.stringMatching(/"Lead form" is a site tag/), expect.stringMatching(/"GA4 lead" is imported from GA4 \(event generate_lead\)/)]);
    expect(r.fix![0]!.steps.join(" ")).toMatch(/conversion_id AW-123456 and conversion_label AbC-9x/);
    expect(r.fix![1]!.steps[0]).toMatch(/property 99/);
    expect(r.how_to_use_fix).toMatch(/propose/);
    expect(queries.filter((q) => /tag_snippets/.test(q))[0]).toMatch(/IN \(7\)/);
  });
  it("conversion_tracking: no fix and no snippet read when every primary action records", async () => {
    const queries: string[] = [];
    const fake = async (q: string): Promise<any[]> => {
      queries.push(q);
      if (/FROM conversion_action/.test(q)) return [{ conversionAction: { id: "7", name: "Lead form", status: "ENABLED", type: "WEBPAGE", primaryForGoal: true } }];
      if (/segments.conversion_action/.test(q)) return [{ segments: { conversionAction: "customers/1/conversionActions/7" }, metrics: { allConversions: 3 } }];
      return [];
    };
    const r = await conversionTracking(fake, 30, false);
    expect(r).not.toHaveProperty("fix");
    expect(queries.some((q) => /tag_snippets/.test(q))).toBe(false);
  });
  it("conversionFixes: no primary action, imports and auto-tagging each get their own steps", () => {
    const f = conversionFixes({ autoTaggingOff: true, noPrimary: true,
      silent: [{ id: "1", name: "CRM leads", type: "UPLOAD_CLICKS", send_to: null }] });
    expect(f.map((x) => x.problem)).toEqual([expect.stringMatching(/No enabled primary/), expect.stringMatching(/import \(upload clicks\)/), "Auto-tagging is off"]);
    expect(f[0]!.steps.join(" ")).toMatch(/create_conversion_action/);
    const call = conversionFixes({ autoTaggingOff: false, noPrimary: false, silent: [{ id: "2", name: "Smart calls", type: "SMART_CAMPAIGN_TRACKED_CALLS", send_to: null }] });
    expect(call[0]!.problem).toMatch(/counts calls/);
    expect(call[0]!.steps.at(-1)).toMatch(/remove_conversion_action/);
  });
  it("sendToOf: reads send_to from the event snippet, null without one", () => {
    expect(sendToOf([{ eventSnippet: "{'send_to': 'AW-42/lbl_1'}" }])).toEqual({ conversion_id: "AW-42", conversion_label: "lbl_1" });
    expect(sendToOf([{ globalSiteTag: "x" }])).toBeNull();
    expect(sendToOf(undefined)).toBeNull();
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

describe("campaign_details conversions by action", () => {
  it("lists each action's conversions and all conversions, secondary ones too, and none on the demo", async () => {
    const stub = async (q: string) => {
      if (/segments\.conversion_action_name/.test(q)) return [
        { segments: { conversionActionName: "Calls" }, metrics: { conversions: 4, allConversions: 6, conversionsValue: 0 } },
        { segments: { conversionActionName: "14 day trial" }, metrics: { conversions: 0, allConversions: 28, conversionsValue: 0 } },
        { segments: { conversionActionName: "Nothing" }, metrics: { conversions: 0, allConversions: 0 } }];
      return read(q);
    };
    const r = await campaignDetails(stub, "2001", 30);
    expect(r.conversions_by_action).toEqual([{ action: "14 day trial", conversions: 0, all_conversions: 28 }, { action: "Calls", conversions: 4, all_conversions: 6 }]);
    expect((await campaignDetails(read, "2001", 30, true)).conversions_by_action).toBeUndefined();
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
