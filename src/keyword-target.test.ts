import { describe, expect, it } from "vitest";
import { CRITERIA_QUERY, campaignMarket, chooseTarget, describeTarget, resolveLanguage, resolveLocations, type Search } from "./keyword-target.js";

const crit = (campaign: string, status: string, type: "LOCATION" | "LANGUAGE", id: string, extra: object = {}) => ({
  campaign: { id: campaign, status },
  campaignCriterion: { type, negative: false, status: "ENABLED",
    ...(type === "LOCATION" ? { location: { geoTargetConstant: `geoTargetConstants/${id}` } } : { language: { languageConstant: `languageConstants/${id}` } }),
    ...extra },
});

// Rows as Google returned them for these queries on 2026-11-16 (trimmed to the fields read).
const g = (id: string, name: string, canonicalName: string, countryCode: string, targetType: string, status = "ENABLED") =>
  ({ geoTargetConstant: { id, name, canonicalName, countryCode, targetType, status } });
const COUNTRIES = [g("2040", "Austria", "Austria", "AT", "Country"), g("2826", "United Kingdom", "United Kingdom", "GB", "Country"),
  g("2840", "United States", "United States", "US", "Country"), g("2268", "Georgia", "Georgia", "GE", "Country")];
const PLACES: Record<string, any[]> = {
  Vienna: [g("20050", "Vienna", "Vienna,Austria", "AT", "State"), g("1000997", "Vienna", "Vienna,Vienna,Vienna,Austria", "AT", "City"),
    g("1027317", "Vienna", "Vienna,Virginia,United States", "US", "City"), g("9198853", "Vienna", "Vienna,Vienna,Austria", "AT", "Municipality")],
  Chicago: [g("1016367", "Chicago", "Chicago,Illinois,United States", "US", "City")],
  Bangkok: [g("1012873", "Bangkok", "Bangkok,Thailand", "TH", "City", "REMOVAL_PLANNED"), g("9112482", "Bangkok", "Bangkok,Thailand", "TH", "Province")],
};
const LANGS = [["1000", "English", "en"], ["1001", "German", "de"], ["1014", "Portuguese", "pt"], ["1017", "Chinese (simplified)", "zh_CN"]]
  .map(([id, name, code]) => ({ languageConstant: { id, name, code } }));

function fakeSearch() {
  const queries: string[] = [];
  const search: Search = async (q) => {
    queries.push(q);
    if (q.includes("target_type = 'Country'")) return COUNTRIES;
    const name = /geo_target_constant\.name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    if (name !== undefined) return PLACES[name] ?? [];
    if (q.includes("FROM language_constant")) return LANGS;
    throw new Error(`unexpected query ${q}`);
  };
  return { search, queries };
}

describe("campaignMarket", () => {
  it("ranks the enabled campaigns' locations by how many target them, then by id", () => {
    const m = campaignMarket([
      crit("1", "ENABLED", "LOCATION", "2840"), crit("1", "ENABLED", "LOCATION", "2826"), crit("1", "ENABLED", "LANGUAGE", "1000"),
      crit("2", "ENABLED", "LOCATION", "2826"), crit("2", "ENABLED", "LANGUAGE", "1001"), crit("2", "ENABLED", "LANGUAGE", "1000"),
      crit("3", "PAUSED", "LOCATION", "2040"), crit("3", "PAUSED", "LANGUAGE", "1001"),
      crit("4", "ENABLED", "LOCATION", "2124"),
    ]);
    expect(m.locations).toEqual(["2826", "2124", "2840"]);  // paused campaign 3's Austria left out
    expect(m.languages).toEqual(["1000", "1001"]);
  });

  it("falls back to paused campaigns only when no enabled campaign targets that kind", () => {
    const m = campaignMarket([crit("1", "PAUSED", "LOCATION", "2040"), crit("1", "PAUSED", "LANGUAGE", "1001"), crit("2", "ENABLED", "LANGUAGE", "1000")]);
    expect(m).toEqual({ locations: ["2040"], languages: ["1000"] });
  });

  it("ignores negatives, removed criteria, removed campaigns and other criterion types", () => {
    expect(campaignMarket([
      crit("1", "ENABLED", "LOCATION", "2840", { negative: true }), crit("1", "ENABLED", "LOCATION", "2826", { status: "REMOVED" }),
      crit("2", "REMOVED", "LOCATION", "2040"),
      { campaign: { id: "1", status: "ENABLED" }, campaignCriterion: { type: "KEYWORD", negative: true, keyword: { text: "free" } } },
    ])).toEqual({ locations: [], languages: [] });
  });

  it("asks Google only for positive location and language criteria on campaigns that aren't removed", () => {
    expect(CRITERIA_QUERY).toContain("campaign_criterion.type IN ('LOCATION', 'LANGUAGE')");
    expect(CRITERIA_QUERY).toContain("campaign_criterion.negative = FALSE");
    expect(CRITERIA_QUERY).toContain("campaign.status != 'REMOVED'");
  });
});

describe("chooseTarget", () => {
  const market = { locations: ["2040", "2276"], languages: ["1001", "1000"] };
  it("uses the campaigns' locations and their top language", () => {
    expect(chooseTarget({}, market)).toEqual({ location_ids: ["2040", "2276"], language_id: "1001", locations_from: "campaigns", language_from: "campaigns", locations_left_out: 0 });
  });
  it("counts every language when the campaigns target none", () => {
    expect(chooseTarget({}, { locations: ["2040"], languages: [] })).toMatchObject({ language_id: null, language_from: "all" });
  });
  it("counts every language in a market the caller names, not the account's language", () => {
    expect(chooseTarget({ location_ids: ["2826"] }, null)).toEqual({ location_ids: ["2826"], language_id: null, locations_from: "given", language_from: "all", locations_left_out: 0 });
    expect(chooseTarget({ location_ids: ["2826"], language_id: "1000" }, null)).toMatchObject({ language_id: "1000", language_from: "given" });
  });
  it("keeps a named language with the campaigns' locations", () => {
    expect(chooseTarget({ language_id: "1000" }, market)).toMatchObject({ location_ids: ["2040", "2276"], language_id: "1000", locations_from: "campaigns", language_from: "given" });
  });
  it("keeps the old default, United States in English, when no campaign targets a location", () => {
    expect(chooseTarget({}, { locations: [], languages: ["1001"] })).toEqual({ location_ids: ["2840"], language_id: "1000", locations_from: "default", language_from: "default", locations_left_out: 0 });
    expect(chooseTarget({ language_id: "1003" }, null)).toMatchObject({ location_ids: ["2840"], language_id: "1003", language_from: "given" });
  });
  it("sends Keyword Planner's 10 at most, the most targeted, and counts the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) => String(1000 + i));
    const t = chooseTarget({}, { locations: many, languages: [] });
    expect(t.location_ids).toEqual(many.slice(0, 10));
    expect(t.locations_left_out).toBe(3);
  });
});

describe("resolveLocations", () => {
  it("passes ids through without a lookup", async () => {
    const f = fakeSearch();
    expect(await resolveLocations(["2840", " 2826 "], f.search)).toEqual(["2840", "2826"]);
    expect(f.queries).toEqual([]);
  });

  it("takes a country by name or two-letter code, in any case, reading the country list once", async () => {
    const f = fakeSearch();
    expect(await resolveLocations(["austria", "AT", "us", "UK", "United Kingdom"], f.search)).toEqual(["2040", "2840", "2826"]);
    expect(f.queries.filter((q) => q.includes("'Country'"))).toHaveLength(1);
  });

  it("takes a place that matches one enabled location, retrying in Google's capitalisation", async () => {
    const f = fakeSearch();
    expect(await resolveLocations(["chicago"], f.search)).toEqual(["1016367"]);
    expect(f.queries.filter((q) => q.includes("geo_target_constant.name ="))).toHaveLength(2);
    expect(await resolveLocations(["Bangkok"], f.search)).toEqual(["9112482"]);  // the REMOVAL_PLANNED one doesn't count
  });

  it("narrows a place by what follows the comma", async () => {
    const f = fakeSearch();
    expect(await resolveLocations(["Vienna, Virginia"], f.search)).toEqual(["1027317"]);
    expect(await resolveLocations(["Vienna, US"], f.search)).toEqual(["1027317"]);
  });

  it("refuses an ambiguous or unknown name with the candidates' ids, all problems at once", async () => {
    const f = fakeSearch();
    const err = await resolveLocations(["Vienna, Austria", "Atlantis", "2840"], f.search).catch((e: Error) => e.message);
    expect(err).toContain(`"Vienna, Austria" matches 3 places: 20050 Vienna,Austria (State); 1000997 Vienna,Vienna,Vienna,Austria (City); 9198853 Vienna,Vienna,Austria (Municipality). Pass the id of the one meant`);
    expect(err).toContain(`no location named "Atlantis"`);
    expect(err).toContain("Nothing was looked up in Keyword Planner.");
  });

  it("escapes quotes in a name it queries", async () => {
    const f = fakeSearch();
    await resolveLocations(["O'Fallon"], f.search).catch(() => null);
    expect(f.queries.at(-2)).toContain("geo_target_constant.name = 'O\\'Fallon'");
  });

  it("prefers the country for a bare name that is also a place", async () => {
    expect(await resolveLocations(["Georgia"], fakeSearch().search)).toEqual(["2268"]);
  });
});

describe("resolveLanguage", () => {
  it("takes an id, a name or a code", async () => {
    const f = fakeSearch();
    expect(await resolveLanguage("1001", f.search)).toBe("1001");
    expect(f.queries).toEqual([]);
    expect(await resolveLanguage("german", f.search)).toBe("1001");
    expect(await resolveLanguage("DE", f.search)).toBe("1001");
    expect(await resolveLanguage("zh-CN", f.search)).toBe("1017");
    expect(await resolveLanguage("pt-BR", f.search)).toBe("1014");  // pt_BR isn't targetable; its base language is
  });
  it("refuses a language Keyword Planner doesn't take", async () => {
    await expect(resolveLanguage("Klingon", fakeSearch().search)).rejects.toThrow(`"Klingon" isn't a language Keyword Planner takes`);
  });
});

describe("describeTarget", () => {
  it("names the market and where it came from", () => {
    const t = chooseTarget({}, { locations: ["2040"], languages: ["1001"] });
    expect(describeTarget(t, new Map([["2040", "Austria"]]), "German")).toEqual({
      locations: [{ id: "2040", name: "Austria" }], language: { id: "1001", name: "German" },
      locations_from: "campaigns", language_from: "campaigns", note: "Locations are the ones this account's campaigns target.",
    });
  });
  it("says when it fell back to the default, and how to name a market", () => {
    const d = describeTarget(chooseTarget({}, null), new Map([["2840", "United States"]]), "English");
    expect(d.note).toContain("No campaign in this account targets a location, so these are United States numbers, Camberstack's default.");
    expect(d.note).toContain("pass location_ids");
  });
  it("says every language is counted, and keeps an id it couldn't name", () => {
    const d = describeTarget(chooseTarget({ location_ids: ["2826"] }, null), new Map(), null);
    expect(d.locations).toEqual([{ id: "2826", name: "2826" }]);
    expect(d.language).toBe("all languages");
    expect(d.note).toBe("Searches in every language are counted. Pass language_id to count one language only.");
  });
  it("says how many locations were left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => String(1000 + i));
    expect(describeTarget(chooseTarget({}, { locations: many, languages: [] }), new Map(), null).note)
      .toContain("(12 in all; Keyword Planner takes 10, so these are the ones most campaigns target)");
  });
});
