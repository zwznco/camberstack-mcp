/**
 * Which market Keyword Planner counts searches in, for keyword_ideas and keyword_metrics.
 *
 * Until 0.36.0 the tools defaulted to the United States in English, and models had to look the market up themselves:
 * after a keyword call, 58 of the next run_gaql queries (prod, 2026-10-10 → 11-16) read geo_target_constant,
 * campaign_criterion or language_constant, five calls failed on a bad location or language id, and most keyword users
 * are outside the US. Now a call that names no locations uses the ones the account's campaigns target, a place can be
 * named instead of looked up, and every result says which market it counted and where that came from.
 */

/** Runs a GAQL query against the account. */
export type Search = (query: string) => Promise<any[]>;

/** Camberstack's market when the account's campaigns target no location (as before 0.36.0). */
export const DEFAULT_LOCATION = "2840";  // United States
export const DEFAULT_LANGUAGE = "1000";  // English
/** Keyword Planner takes at most 10 geo targets. */
export const MAX_PLAN_LOCATIONS = 10;

export type From = "given" | "campaigns" | "default";
export interface PlanTarget {
  location_ids: string[];
  /** null: every language (Keyword Planner's own default when none is sent). */
  language_id: string | null;
  locations_from: From;
  language_from: From | "all";
  /** Locations the campaigns target beyond the 10 Keyword Planner takes. */
  locations_left_out: number;
}

/** Positive location and language criteria on campaigns that aren't removed. Verified against Google 2026-11-16. */
export const CRITERIA_QUERY = `SELECT campaign.id, campaign.status, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.status,
  campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant
  FROM campaign_criterion WHERE campaign_criterion.type IN ('LOCATION', 'LANGUAGE') AND campaign_criterion.negative = FALSE
  AND campaign.status != 'REMOVED' AND campaign_criterion.status != 'REMOVED'`;

const COUNTRIES_QUERY = `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code
  FROM geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'`;
const LANGUAGES_QUERY = `SELECT language_constant.id, language_constant.name, language_constant.code
  FROM language_constant WHERE language_constant.targetable = TRUE`;

/**
 * The account's market from its campaigns' criteria rows (CRITERIA_QUERY): locations and languages ranked by how many
 * campaigns target them, most first, then by id. Enabled campaigns count; paused ones only when no enabled campaign
 * targets that kind of criterion, so an account that's all paused still has a market.
 */
export function campaignMarket(rows: any[]): { locations: string[]; languages: string[] } {
  const rank = (type: "LOCATION" | "LANGUAGE", constOf: (c: any) => string | undefined) => {
    const hits = rows.flatMap((r) => {
      const c = r.campaignCriterion;
      const k = c?.type === type && !c.negative && c.status !== "REMOVED" ? constOf(c)?.split("/").pop() : undefined;
      return k && r.campaign?.id && r.campaign.status !== "REMOVED" ? [{ k, campaign: String(r.campaign.id), enabled: r.campaign.status === "ENABLED" }] : [];
    });
    const pool = hits.some((h) => h.enabled) ? hits.filter((h) => h.enabled) : hits;
    const campaigns = new Map<string, Set<string>>();
    for (const h of pool) campaigns.set(h.k, (campaigns.get(h.k) ?? new Set()).add(h.campaign));
    return [...campaigns].sort(([a, x], [b, y]) => y.size - x.size || Number(a) - Number(b)).map(([k]) => k);
  };
  return {
    locations: rank("LOCATION", (c) => c.location?.geoTargetConstant),
    languages: rank("LANGUAGE", (c) => c.language?.languageConstant),
  };
}

/**
 * The market to send: what the caller named, else the campaigns', else the default. A language is taken from the
 * campaigns only along with their locations: a caller who names another market gets every language there, not the
 * account's own (an English-language account researching Austria shouldn't count only English searches).
 */
export function chooseTarget(given: { location_ids?: string[]; language_id?: string }, market: { locations: string[]; languages: string[] } | null): PlanTarget {
  if (given.location_ids?.length) {
    return { location_ids: given.location_ids, language_id: given.language_id ?? null, locations_from: "given",
      language_from: given.language_id ? "given" : "all", locations_left_out: 0 };
  }
  const locs = market?.locations ?? [];
  if (!locs.length) {
    return { location_ids: [DEFAULT_LOCATION], language_id: given.language_id ?? DEFAULT_LANGUAGE, locations_from: "default",
      language_from: given.language_id ? "given" : "default", locations_left_out: 0 };
  }
  const lang = given.language_id ?? market!.languages[0] ?? null;
  return {
    location_ids: locs.slice(0, MAX_PLAN_LOCATIONS), language_id: lang, locations_from: "campaigns",
    language_from: given.language_id ? "given" : lang ? "campaigns" : "all",
    locations_left_out: Math.max(0, locs.length - MAX_PLAN_LOCATIONS),
  };
}

const gaqlStr = (v: string) => v.replace(/[\\']/g, "\\$&");
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
/** Names people use that aren't Google's country code. */
const CODE_ALIASES: Record<string, string> = { UK: "GB" };

/**
 * Location ids for what the caller named: ids pass through (Google validates them, and keywordPlan names a bad one),
 * a country by name or two-letter code, or any other place by Google's name for it, optionally narrowed by what follows
 * a comma ("Vienna, Austria", "Springfield, Illinois"). A name that matches no place, or several, is refused with the
 * candidates' ids. Every problem is reported at once.
 */
export async function resolveLocations(inputs: string[], search: Search): Promise<string[]> {
  let countries: { id: string; name: string; code: string }[] | undefined;
  const countryList = async () => (countries ??= (await search(COUNTRIES_QUERY)).map((r) => ({
    id: String(r.geoTargetConstant.id), name: String(r.geoTargetConstant.name), code: String(r.geoTargetConstant.countryCode ?? "") })));
  const out: string[] = [];
  const problems: string[] = [];
  for (const raw of inputs) {
    const input = raw.trim();
    if (/^\d+$/.test(input)) { out.push(input); continue; }
    const [head = "", ...quals] = input.split(",").map((p) => p.trim()).filter(Boolean);
    if (!quals.length) {
      const code = CODE_ALIASES[input.toUpperCase()] ?? input.toUpperCase();
      const c = (await countryList()).find((x) => x.name.toLowerCase() === input.toLowerCase() || (/^[A-Z]{2}$/.test(code) && x.code === code));
      if (c) { out.push(c.id); continue; }
    }
    const byName = (name: string) => search(`SELECT geo_target_constant.id, geo_target_constant.canonical_name, geo_target_constant.target_type,
        geo_target_constant.country_code, geo_target_constant.status FROM geo_target_constant WHERE geo_target_constant.name = '${gaqlStr(name)}'`);
    let rows = await byName(head);
    if (!rows.length && titleCase(head) !== head) rows = await byName(titleCase(head));  // Google's names are case-sensitive
    const want = quals.map((q) => q.toLowerCase());
    const places = rows.map((r) => r.geoTargetConstant).filter((g) => g?.status === "ENABLED").filter((g) => {
      const parts = String(g.canonicalName).split(",").slice(1).map((p) => p.trim().toLowerCase());
      return want.every((q) => parts.includes(q) || q === String(g.countryCode ?? "").toLowerCase());
    });
    if (places.length === 1) { out.push(String(places[0].id)); continue; }
    if (!places.length) {
      problems.push(`no location named "${input}"`);
      continue;
    }
    const shown = places.slice(0, 12).map((g) => `${g.id} ${g.canonicalName} (${g.targetType})`).join("; ");
    problems.push(`"${input}" matches ${places.length} places: ${shown}${places.length > 12 ? "; …" : ""}. Pass the id of the one meant`);
  }
  if (problems.length) {
    throw new Error(`Couldn't tell which location: ${problems.join(". ")}. `
      + "location_ids takes a Google geo target id, a country name or two-letter code (\"Austria\", \"AT\"), or a place name, "
      + "narrowed after a comma when needed (\"Springfield, Illinois\"). Nothing was looked up in Keyword Planner.");
  }
  return [...new Set(out)];
}

/** A language id for an id, a name ("German") or a code ("de", "pt-BR" falls back to "pt"); Keyword Planner's languages only. */
export async function resolveLanguage(input: string, search: Search): Promise<string> {
  const v = input.trim();
  if (/^\d+$/.test(v)) return v;
  const langs = (await search(LANGUAGES_QUERY)).map((r) => r.languageConstant);
  const code = v.toLowerCase().replace("-", "_");
  const hit = langs.find((l) => String(l.name).toLowerCase() === v.toLowerCase() || String(l.code).toLowerCase() === code)
    ?? langs.find((l) => String(l.code).toLowerCase() === code.split("_")[0]);
  if (hit) return String(hit.id);
  throw new Error(`"${input}" isn't a language Keyword Planner takes. Pass a language id (1000 English, 1001 German, 1003 Spanish), `
    + "its English name (\"German\") or its code (\"de\"). Leave language_id out to count every language. Nothing was looked up in Keyword Planner.");
}

/** What the result says about the market it counted. Names are looked up by the caller; an id stands in for one it couldn't get. */
export function describeTarget(t: PlanTarget, geoNames: Map<string, string>, languageName: string | null) {
  const places = t.location_ids.map((id) => geoNames.get(id) ?? id);
  const notes: string[] = [];
  if (t.locations_from === "campaigns") {
    notes.push(`Locations are the ones this account's campaigns target${t.locations_left_out
      ? ` (${t.locations_left_out + t.location_ids.length} in all; Keyword Planner takes 10, so these are the ones most campaigns target)` : ""}.`);
  }
  if (t.locations_from === "default") {
    notes.push(`No campaign in this account targets a location, so these are ${places.join(", ")} numbers, Camberstack's default. `
      + "If the business sells elsewhere, pass location_ids: a country (\"Austria\" or \"AT\"), a place, or an id.");
  }
  if (t.language_from === "all") {
    notes.push(t.locations_from === "given" ? "Searches in every language are counted. Pass language_id to count one language only."
      : "The campaigns don't target a language, so searches in every language are counted.");
  }
  return {
    locations: t.location_ids.map((id, i) => ({ id, name: places[i] })),
    language: t.language_id ? { id: t.language_id, name: languageName ?? t.language_id } : "all languages",
    locations_from: t.locations_from,
    language_from: t.language_from,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
