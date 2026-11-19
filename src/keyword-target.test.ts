import { describe, expect, it } from "vitest";
import { CRITERIA_QUERY, campaignMarket, chooseTarget, closeVariantGroups, describeTarget, resolveLanguage, resolveLocations, type Search, type Suggest } from "./keyword-target.js";

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
  g("2840", "United States", "United States", "US", "Country"), g("2268", "Georgia", "Georgia", "GE", "Country"),
  g("2158", "Taiwan", "Taiwan", "TW", "Region"), g("2344", "Hong Kong", "Hong Kong", "HK", "Region")];
// SuggestGeoTargetConstants as Google answered these names on 2026-11-19 (dev probe; top 4 per name, reach left out).
const sg = (id: string, canonicalName: string, targetType: string, status = "ENABLED") => ({ id, canonicalName, targetType, status });
const SUGGESTED: Record<string, ReturnType<typeof sg>[]> = {
  "Las Palmas de Gran Canaria, Canary Islands, Spain": [sg("1005463", "Las Palmas de Gran Canaria,Las Palmas de Gran Canaria,Canary Islands,Spain", "City"),
    sg("9248572", "Las Palmas de Gran Canaria,Canary Islands,Spain", "Municipality"), sg("9217943", "35130,Canary Islands,Spain", "Postal Code"),
    sg("9047034", "Province of Las Palmas,Canary Islands,Spain", "Province")],
  "Vienna, Austria": [sg("20050", "Vienna,Austria", "State"), sg("1000997", "Vienna,Vienna,Vienna,Austria", "City"),
    sg("9062730", "Innere Stadt,Vienna,Austria", "District"), sg("9062727", "Donaustadt,Vienna,Austria", "District")],
  "Springfield, Illinois": [sg("1016864", "Springfield,Illinois,United States", "City")],
  "Nueva York": [sg("21167", "New York,United States", "State"), sg("1023191", "New York,New York,United States", "City")],
  chicago: [sg("1016367", "Chicago,Illinois,United States", "City")],
  Bangkok: [sg("1012873", "Bangkok,Thailand", "City", "REMOVAL_PLANNED"), sg("21025", "Bangkok,Thailand", "Province")],
  Worldwide: [sg("9198225", "Tai Wai,New Territories,Hong Kong", "Neighborhood")],
  Wordlwide: [sg("9198225", "Tai Wai,New Territories,Hong Kong", "Neighborhood")],  // made up: a typo landing on a fuzzy match, like "Worldwide"
};
const LANGS = [["1000", "English", "en"], ["1001", "German", "de"], ["1014", "Portuguese", "pt"], ["1017", "Chinese (simplified)", "zh_CN"],
  ["1018", "Chinese (traditional)", "zh_TW"]]
  .map(([id, name, code]) => ({ languageConstant: { id, name, code } }));

function fakeSearch() {
  const queries: string[] = [];
  const search: Search = async (q) => {
    queries.push(q);
    if (q.includes("parent_geo_target IS NULL")) return COUNTRIES;
    const name = /geo_target_constant\.name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    if (name !== undefined) return PLACES[name] ?? [];
    if (q.includes("FROM language_constant")) return LANGS;
    throw new Error(`unexpected query ${q}`);
  };
  const suggested: string[][] = [];
  const suggest: Suggest = async (names) => {
    suggested.push(names);
    return names.flatMap((term) => (SUGGESTED[term] ?? []).map((x) => ({ term, ...x })));
  };
  return { search, queries, suggest, suggested };
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
  const resolve = (inputs: string[], f = fakeSearch(), notes: string[] = []) => resolveLocations(inputs, f.search, f.suggest, notes);

  it("passes ids through without a lookup", async () => {
    const f = fakeSearch();
    expect(await resolve(["2840", " 2826 "], f)).toEqual(["2840", "2826"]);
    expect(f.queries).toEqual([]);
    expect(f.suggested).toEqual([]);
  });

  it("takes a country by name or two-letter code, in any case, reading the country list once", async () => {
    const f = fakeSearch();
    expect(await resolve(["austria", "AT", "us", "UK", "United Kingdom"], f)).toEqual(["2040", "2840", "2826"]);
    expect(f.queries.filter((q) => q.includes("parent_geo_target IS NULL"))).toHaveLength(1);
    expect(f.suggested).toEqual([]);
  });

  it("takes the places Google types as a Region with no parent, like Taiwan and Hong Kong, from our list (Google's lookup reads \"TW\" as UK postcodes)", async () => {
    const f = fakeSearch();
    expect(await resolve(["TW", "tw", "Hong Kong", "HK"], f)).toEqual(["2158", "2344"]);
    expect(f.suggested).toEqual([]);
  });

  it("asks Google's lookup for every other place in one call and takes its best enabled match", async () => {
    const f = fakeSearch(), notes: string[] = [];
    expect(await resolve(["chicago", "Springfield, Illinois", "Bangkok"], f, notes)).toEqual(["1016367", "1016864", "21025"]);
    expect(f.suggested).toEqual([["chicago", "Springfield, Illinois", "Bangkok"]]);
    expect(notes).toEqual([]);  // one enabled match each: nothing to say
  });

  it("picks the best match where several share a name, and says which and what else (prod #31320)", async () => {
    const notes: string[] = [];
    expect(await resolve(["Las Palmas de Gran Canaria, Canary Islands, Spain"], fakeSearch(), notes)).toEqual(["1005463"]);
    expect(notes).toEqual([`"Las Palmas de Gran Canaria, Canary Islands, Spain" was counted as 1005463 Las Palmas de Gran Canaria,Las Palmas de Gran Canaria,Canary Islands,Spain (City), `
      + "Google's best match; others: 9248572 Las Palmas de Gran Canaria,Canary Islands,Spain (Municipality); 9217943 35130,Canary Islands,Spain (Postal Code); "
      + "9047034 Province of Las Palmas,Canary Islands,Spain (Province). Pass an id in location_ids to count another."]);
    expect(await resolve(["Vienna, Austria"], fakeSearch())).toEqual(["20050"]);
  });

  it("takes a name in another language", async () => {
    const notes: string[] = [];
    expect(await resolve(["Nueva York"], fakeSearch(), notes)).toEqual(["21167"]);
    expect(notes[0]).not.toContain("shares no word");
  });

  it("flags a match that shares no word with the name, even with nothing else to choose from", async () => {
    const notes: string[] = [];
    expect(await resolve(["Wordlwide"], fakeSearch(), notes)).toEqual(["9198225"]);
    expect(notes).toEqual([`"Wordlwide" was counted as 9198225 Tai Wai,New Territories,Hong Kong (Neighborhood), Google's best match. `
      + `It shares no word with "Wordlwide", so check it's the place meant. Pass an id in location_ids to count another.`]);
  });

  it("refuses a name Google has no match for, all problems at once", async () => {
    const err = await resolve(["Atlantis", "Nowhere, Narnia", "2840"]).catch((e: Error) => e.message);
    expect(err).toContain(`no location named "Atlantis". no location named "Nowhere, Narnia"`);
    expect(err).toContain("Nothing was looked up in Keyword Planner.");
  });

  it("takes \"worldwide\" and its synonyms alone as every location, without a lookup (prod #30593; Google's lookup reads it as Tai Wai)", async () => {
    const f = fakeSearch();
    for (const w of ["Worldwide", " global ", "ALL", "all countries"]) expect(await resolve([w], f)).toEqual([]);
    expect(f.queries).toEqual([]);
    expect(f.suggested).toEqual([]);
  });

  it("refuses worldwide combined with other locations", async () => {
    const err = await resolve(["Austria", "Worldwide"]).catch((e: Error) => e.message);
    expect(err).toContain(`"Worldwide" counts every location, so it can't be combined with other locations.`);
    expect(err).toContain("Nothing was looked up in Keyword Planner.");
  });

  it("prefers the country for a bare name that is also a place", async () => {
    expect(await resolve(["Georgia"])).toEqual(["2268"]);
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
  it("names the variants when Keyword Planner takes a language only by variant", async () => {
    const err = await resolveLanguage("zh", fakeSearch().search).catch((e: Error) => e.message);
    expect(err).toContain(`Keyword Planner takes "zh" only as one of: 1017 Chinese (simplified) (zh_CN), 1018 Chinese (traditional) (zh_TW).`);
    await expect(resolveLanguage("Chinese", fakeSearch().search)).rejects.toThrow("1017 Chinese (simplified)");
    expect(await resolveLanguage("zh-TW", fakeSearch().search)).toBe("1018");
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
  it("names a worldwide market and counts it as given, not the campaigns' or the default", () => {
    const t = chooseTarget({ location_ids: [] }, { locations: ["2040"], languages: ["1001"] });
    expect(t).toEqual({ location_ids: [], language_id: null, locations_from: "given", language_from: "all", locations_left_out: 0 });
    const d = describeTarget(t, new Map(), null);
    expect(d.locations).toBe("worldwide");
    expect(d.note).toBe("Searches in every location are counted (worldwide). Searches in every language are counted. Pass language_id to count one language only.");
  });
  it("carries how named places were picked into the note", () => {
    const t = { ...chooseTarget({ location_ids: ["1005463"] }, null), location_notes: ["\"Las Palmas\" was counted as 1005463 …"] };
    expect(describeTarget(t, new Map(), null).note).toBe("\"Las Palmas\" was counted as 1005463 … Searches in every language are counted. Pass language_id to count one language only.");
  });
  it("says how many locations were left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => String(1000 + i));
    expect(describeTarget(chooseTarget({}, { locations: many, languages: [] }), new Map(), null).note)
      .toContain("(12 in all; Keyword Planner takes 10, so these are the ones most campaigns target)");
  });
});

describe("closeVariantGroups", () => {
  // Google's generateKeywordHistoricalMetrics answers, United States, dev probe 2026-11-19.
  const m = { avgMonthlySearches: "14800" };
  const named = (results: any[]) => results.flatMap((r) => r.keywordMetrics ? [[r.text, closeVariantGroups(results).get(r) ?? []]] : []);

  it("puts the group's other keywords on the row with the numbers, wherever Google listed them", () => {
    expect(named([{ text: "surf lessons", keywordMetrics: m }, { text: "surf school", closeVariants: ["surf schools", "surfing school"] },
      { text: "surf schools", keywordMetrics: m }, { text: "surfing school" }, { text: "qxzv surf zzkq" }]))
      .toEqual([["surf lessons", []], ["surf schools", ["surf school", "surfing school"]]]);
  });
  it("keeps a variant Google named but sent no row for", () => {
    expect(named([{ text: "hotel", closeVariants: ["hotels"], keywordMetrics: m }, { text: "hotel near me", keywordMetrics: m }]))
      .toEqual([["hotel", ["hotels"]], ["hotel near me", []]]);
  });
  it("leaves a keyword with no data out of every group", () => {
    expect(named([{ text: "surf school" }])).toEqual([]);
  });
});
