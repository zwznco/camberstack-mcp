/**
 * GAQL against Google's own field catalog (GoogleAdsFieldService): every resource, attribute, metric and segment
 * of the API version we call, with what can be selected, filtered, and combined with what. The same metadata
 * Google's Query Validator is built on.
 *
 *   fieldQuery   run_gaql's field lookup: a SELECT with no FROM (or FROM google_ads_field) goes to the catalog itself,
 *                so every client can look names up through the tool it already has. (gaql_fields did this as its own
 *                tool, which most apps never listed or called; it stays callable, unlisted, for apps that hold it.)
 *   checkGaql    finds unknown fields (with the closest real ones), fields that can't be selected or filtered,
 *                and fields that can't be used FROM the query's resource. It never blocks a query on its own:
 *                run_gaql still sends it to Google, and attaches these findings only when Google rejects it.
 *                A finding on a query Google accepts is a checker bug, and is logged as one. Findings never send the AI
 *                to another tool: an app may not have it. They say the answer, or the field lookup to run.
 *
 * The catalog (~3,000 fields, ~2 MB) is fetched once per process and day, with any connected user's token.
 */

export interface FieldMeta {
  name: string;
  category: "RESOURCE" | "ATTRIBUTE" | "METRIC" | "SEGMENT";
  dataType?: string;
  selectable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  isRepeated?: boolean;
  /** ENUM fields: every value Google accepts. */
  enumValues?: string[];
  /**
   * RESOURCE only: resources whose attributes can be selected FROM this one, and the metrics and segments it takes.
   * `segments` also lists bare resource names ("campaign"): segmenting resources, whose attributes can be selected too.
   */
  attributeResources?: string[];
  metrics?: string[];
  segments?: string[];
}
export type Catalog = Map<string, FieldMeta>;

export const CATALOG_QUERY = "SELECT name, category, data_type, selectable, filterable, sortable, is_repeated, attribute_resources, metrics, segments, enum_values";
const TTL = 24 * 3600_000;
/** After a failed fetch, wait this long before trying again (a check is optional, so it mustn't hammer Google). */
const RETRY = 10 * 60_000;

let cached: { at: number; catalog: Catalog | null; loading?: Promise<Catalog | null> } | undefined;

/** The catalog, fetched with `fetchFields` when missing or stale. Null when it can't be had right now. */
export async function catalog(fetchFields: () => Promise<FieldMeta[]>): Promise<Catalog | null> {
  const now = Date.now();
  if (cached?.loading) return cached.loading;
  if (cached && now - cached.at < (cached.catalog ? TTL : RETRY)) return cached.catalog;
  const loading = fetchFields()
    .then((rows) => new Map(rows.map((f) => [f.name, f])) as Catalog)
    .catch((e) => { console.error(`gaql catalog: ${(e as Error).message}`); return null; })
    .then((c) => { cached = { at: Date.now(), catalog: c }; return c; });
  cached = { at: now, catalog: cached?.catalog ?? null, loading };
  return loading;
}

/** A quoted GAQL string. */
const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/**
 * A query with every value taken out, for the usage log: which fields and resources custom queries use, so the common
 * ones can become their own tools. GAQL quotes every string, so after blanking quoted strings and bare numbers what's
 * left is field names, keywords and Google's enum constants (LAST_30_DAYS, ENABLED): the schema, never the user's
 * data (campaign names, keywords, ids). The privacy policy promises exactly this; keep it so.
 */
export function queryShape(query: string): string {
  return query
    .replace(QUOTED, "?")
    .replace(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g, "?")
    .replace(/\?(?:\s*,\s*\?)+/g, "?")
    .replace(/\s+/g, " ").trim().slice(0, 1000);
}

/** What a field lookup can select: GoogleAdsField's columns (Google's query has no FROM). */
export const FIELD_COLUMNS = "name, category, data_type, selectable, filterable, sortable, is_repeated, selectable_with, attribute_resources, metrics, segments, enum_values";

/** The field lookup to suggest for a name: every field whose name holds `part`. */
const lookupQuery = (part: string) => `SELECT name, category, selectable, filterable WHERE name LIKE '%${part}%'`;

/**
 * A query for Google's field catalog rather than an account: SELECT … [WHERE …] with no FROM, as GoogleAdsFieldService
 * takes it, or written FROM google_ads_field (the resource it describes), which is dropped. Null for an account query.
 */
export function fieldQuery(query: string): string | null {
  const blank = query.replace(QUOTED, "''");
  if (!/^\s*select\b/i.test(blank)) return null;
  const from = /\bFROM\s+([a-z_]+)/i.exec(blank);
  if (!from) return query.trim();
  if (from[1]!.toLowerCase() !== "google_ads_field") return null;
  return query.replace(/\s+FROM\s+google_ads_field\b/i, "").trim();
}

interface ParsedGaql { select: string[]; from: string; where: string[]; orderBy: string[] }

const FIELD = /\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\b/g;
/** SELECT … FROM … [WHERE …] [ORDER BY …] [LIMIT n] [PARAMETERS …]. Null for anything else (the check then stays out of the way). */
export function parseGaql(query: string): ParsedGaql | null {
  // Literals can hold anything, including dots and keywords: blank them before looking for field names.
  const q = query.replace(QUOTED, "''").replace(/\s+/g, " ").trim();
  const m = /^SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT \d+)?(?: PARAMETERS .+)?$/i.exec(q);
  if (!m) return null;
  const list = (s: string | undefined) => [...new Set((s ?? "").match(FIELD) ?? [])];
  const select = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  if (select.some((s) => !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(s))) return null;
  return { select, from: m[2]!.toLowerCase(), where: list(m[3]), orderBy: list(m[4]) };
}

/** Plain-language problems with a query, by Google's catalog. Empty when it finds none (or can't parse the query). */
export function checkGaql(query: string, cat: Catalog): string[] {
  const p = parseGaql(query);
  if (!p) return [];
  const issues: string[] = [];
  const from = cat.get(p.from);
  if (!from || from.category !== "RESOURCE") {
    const near = closest(p.from, [...cat.values()].filter((f) => f.category === "RESOURCE").map((f) => f.name));
    return [`FROM ${p.from}: there is no such resource${near.length ? `. Closest: ${near.join(", ")}` : ""}.`];
  }
  const usable = (f: FieldMeta) => fromAllows(from, f);
  const unknown = new Set<string>();
  for (const [clause, names] of [["SELECT", p.select], ["WHERE", p.where], ["ORDER BY", p.orderBy]] as const) {
    for (const name of names) {
      const f = cat.get(name);
      if (!f) {
        // A parent of real fields (campaign_criterion.proximity): the catalog lists only what's under it, and calling it
        // nonexistent made the model drop the proximity data (prod, 2026-10-31). Shallowest first: .radius before .address.*.
        const kids = [...cat.values()].filter((x) => x.name.startsWith(`${name}.`) && x.selectable !== false)
          .sort((a, b) => a.name.split(".").length - b.name.split(".").length).map((x) => x.name);
        if (kids.length) {
          issues.push(`${name} isn't a field itself: select the fields under it, e.g. ${kids.slice(0, 8).join(", ")}${kids.length > 8 ? ", …" : ""}`
            + `${usable(cat.get(kids[0]!)!) ? "" : whereFrom(cat.get(kids[0]!)!, cat, p.from)}.`);
          continue;
        }
        // Another resource's real field written under this one (campaign.conversion_goal_campaign_config.goal_config_level):
        // name the field, and where it can be queried.
        const parts = name.split(".");
        const real = parts.slice(1, -1).map((_, i) => cat.get(parts.slice(i + 1).join("."))).find((x) => x && x.category !== "RESOURCE");
        if (real) {
          issues.push(`${name} doesn't exist: the field is ${real.name}`
            + `${usable(real) ? `, which can be selected FROM ${p.from}` : ` (its own resource, not part of ${p.from})${whereFrom(real, cat, p.from)}`}.`);
          continue;
        }
        // Prefer suggestions this FROM can use; fall back to any field; with none close, the lookup that finds it.
        const pool = [...cat.values()].filter((x) => x.category !== "RESOURCE");
        const near = closest(name, pool.filter(usable).map((x) => x.name));
        // Another resource's field only when it's the same field under another path (performance_label): a looser match
        // offered segments.webpage for conversion_action.webpage_code, and the model dropped the whole query (prod, 2026-10-26).
        const anywhere = near.length ? [] : closest(name, pool.map((x) => x.name)).filter((c) => sameLeaf(c, name));
        issues.push(`${name} doesn't exist${near.length ? `. Closest usable FROM ${p.from}: ${near.join(", ")}.`
          : anywhere.length ? `. Closest: ${anywhere.join(", ")} (not usable FROM ${p.from}).`
          : `. Drop it, or find the name with run_gaql: ${lookupQuery(keyWord(name))}`}`);
        unknown.add(issues.at(-1)!);
        continue;
      }
      if (f.category === "RESOURCE") {
        const own = [...cat.values()].filter((x) => x.category === "ATTRIBUTE" && x.name.startsWith(`${name}.`) && x.selectable !== false).map((x) => x.name);
        issues.push(`${name} is a resource, not a field: select its fields${own.length ? `, e.g. ${own.slice(0, 8).join(", ")}${own.length > 8 ? ", …" : ""}` : ""}.`);
        continue;
      }
      if (clause === "SELECT" && f.selectable === false) issues.push(`${name} can't be selected.`);
      if (clause === "WHERE" && f.filterable === false) issues.push(`${name} can't be used in WHERE.`);
      if (clause === "ORDER BY" && f.sortable === false) issues.push(`${name} can't be used in ORDER BY.`);
      if (!usable(f)) {
        // A field the FROM resource carries as its own (segments.search_term FROM campaign_search_term_view is
        // campaign_search_term_view.search_term; ad.final_urls FROM ad_group_ad is ad_group_ad.ad.final_urls): name that
        // field first. Pointing at the other resources sent one user to the insight views (2026-10-16), and another
        // to FROM ad, which can't filter by campaign, so it never got the URLs (prod, 2026-10-27).
        const own = cat.get(`${p.from}.${f.category === "SEGMENT" ? name.slice("segments.".length) : name}`);
        // A date segment FROM a resource with its own dates (segments.date FROM call_view): filter on those. Pointing at
        // campaign/customer instead would drop the per-call rows the query was after (prod, 2026-10-24).
        const dates = f.category === "SEGMENT" && f.dataType === "DATE" ? ownDates(cat, p.from) : [];
        issues.push(own && usable(own) && own.selectable !== false
          ? `${name} can't be used FROM ${p.from}: select ${own.name} instead, its own field.`
          : dates.length
            ? `${name} can't be used FROM ${p.from}: filter on its own date instead, ${dates.join(" or ")} `
              + `(${dates[0]} >= 'YYYY-MM-DD' AND ${dates[0]} <= 'YYYY-MM-DD').`
          : `${name} can't be used FROM ${p.from}${whereFrom(f, cat, p.from, [...p.select, ...p.where])}.`);
      }
    }
  }
  // The same field in SELECT and ORDER BY gave the same line twice.
  const all = [...new Set([...issues, ...enumIssues(query, cat)])];
  // One unknown field and nothing else: say the rest stands. The model dropped a valid query over one bad field (prod, 2026-10-26).
  if (all.length === 1 && unknown.has(all[0]!) && p.select.length > 1) {
    all[0] = all[0]!.replace(/\. (Drop it|Closest)/, (_, w: string) => `, and nothing else in this query is flagged: without it, the rest runs. ${w}`);
  }
  return all;
}

/** An enum literal in WHERE that isn't one of the field's values (Google only says BAD_ENUM_CONSTANT): name the values it takes. */
function enumIssues(query: string, cat: Catalog): string[] {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|\bPARAMETERS\b|$)/i.exec(query)?.[1] ?? "";
  const issues: string[] = [];
  const COND = /\b([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*(?:!=|=|NOT\s+IN|IN)\s*(\([^)]*\)|'[^']*'|"[^"]*"|[A-Z][A-Z0-9_]*)/gi;
  for (const [, name, rhs] of where.matchAll(COND)) {
    const values = cat.get(name!)?.enumValues;
    if (!values?.length) continue;
    const given = (rhs!.match(/'[^']*'|"[^"]*"|[A-Za-z][A-Za-z0-9_]*/g) ?? []).map((v) => v.replace(/^['"]|['"]$/g, ""));
    const bad = given.filter((v) => !values.includes(v));
    if (!bad.length) continue;
    const valid = values.filter((v) => v !== "UNKNOWN" && v !== "UNSPECIFIED");
    issues.push(`${bad.map((v) => `'${v}'`).join(", ")} ${bad.length > 1 ? "aren't values" : "isn't a value"} of ${name}. It takes: `
      + `${valid.slice(0, 40).join(", ")}${valid.length > 40 ? ", …" : ""}.`);
  }
  return issues;
}

/** Whether a query FROM `from` can use field `f`: its own attributes, its attribute resources', and its metrics and segments. */
function fromAllows(from: FieldMeta, f: FieldMeta): boolean {
  if (f.category === "METRIC") return (from.metrics ?? []).includes(f.name);
  if (f.category === "SEGMENT") return (from.segments ?? []).includes(f.name);
  const res = f.name.split(".")[0]!;
  return res === from.name || (from.attributeResources ?? []).includes(res) || (from.segments ?? []).includes(res);
}

/** A resource's own filterable DATE fields (call_view.start_call_date_time), not nested ones. */
function ownDates(cat: Catalog, from: string): string[] {
  return [...cat.values()].filter((x) => x.category === "ATTRIBUTE" && x.dataType === "DATE" && x.filterable !== false
    && x.name.split(".").length === 2 && x.name.startsWith(`${from}.`)).map((x) => x.name)
    .sort((a, b) => Number(b.includes("start")) - Number(a.includes("start")));
}

/** The most telling word of a field's last part (url_expansion_opt_out → expansion), to look it up by. */
function keyWord(name: string): string {
  return name.split(".").at(-1)!.split("_").reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** Account-wide resources first: they answer "per X" questions without splitting by ad group too. */
const BROAD = ["customer", "campaign"];

/**
 * ": query it FROM x" — the resources that can use this field, the field's own resource first. When the query's FROM
 * is also a segment (segments.conversion_action), the resources that take both come first, since splitting by it is
 * what that query wanted: `metrics.conversions FROM conversion_action` was pointed at ad_group (catalog order), not
 * at customer or campaign with segments.conversion_action (2026-10-15).
 */
function whereFrom(f: FieldMeta, cat: Catalog, from: string, fields: string[] = []): string {
  const own = f.category === "ATTRIBUTE" ? f.name.split(".")[0]! : null;
  const ok = [...cat.values()].filter((r) => r.category === "RESOURCE" && fromAllows(r, f)).map((r) => r.name);
  // A view that carries the FROM resource keeps its rows: metrics FROM ad_group_criterion belong FROM keyword_view, and
  // campaign/ad_group (the generic list) drop the per-keyword split the query was after (prod, 2026-10-22). Which view
  // fits is named by the query's own fields: ad_group_criterion.keyword.text → keyword_view.
  const grain = f.category !== "ATTRIBUTE"
    ? ok.filter((r) => r.endsWith("_view") && (cat.get(r)!.attributeResources ?? []).includes(from)) : [];
  if (grain.length) {
    const parts = new Set(fields.filter((n) => n.startsWith(`${from}.`)).map((n) => n.split(".")[1]!));
    const stem = (r: string) => r.replace(/_view$/, "");
    // An exact name first: ad_group_criterion.keyword is keyword_view, and display_keyword_view only after it. With none
    // named, keyword_view leads: catalog order left it out of the first four (dev, 2026-10-22).
    const exact = grain.filter((r) => parts.has(stem(r)));
    const near = grain.filter((r) => !exact.includes(r) && [...parts].some((x) => stem(r).endsWith(`_${x}`) || x.endsWith(`_${stem(r)}`)));
    const named = [...exact, ...near];
    const rest = ["keyword_view"].filter((r) => grain.includes(r) && !named.includes(r));
    const pick = [...named, ...rest, ...grain.filter((r) => !named.includes(r) && !rest.includes(r))].slice(0, named.length || 4);
    return `; query it FROM ${pick.join(" or FROM ")}, ${pick.length > 1 ? "each keeping" : "which keeps"} one row per ${from}, with its fields`;
  }
  const seg = cat.get(`segments.${from}`)?.category === "SEGMENT" ? `segments.${from}` : null;
  const split = seg ? ok.filter((r) => (cat.get(r)!.segments ?? []).includes(seg)) : [];
  if (split.length) {
    const broad = BROAD.filter((r) => split.includes(r));
    const pick = broad.length ? broad : split.slice(0, 4);
    return `; to split it by ${from}, query it FROM ${pick.join(" or FROM ")} with ${seg} in SELECT`;
  }
  // The field's own resource, then campaign and customer, then the rest: catalog order alone led with niche views
  // (ad_group_ad_asset_view) ahead of campaign.
  const lead = [...(own && ok.includes(own) ? [own] : []), ...["campaign", "customer"].filter((r) => r !== own && ok.includes(r))];
  const pick = [...lead, ...ok.filter((r) => !lead.includes(r))].slice(0, 4);
  return pick.length ? `; query it FROM ${pick.join(" or FROM ")}` : "";
}

/**
 * The real names closest to `name`: every one sharing its last part (up to 8), else up to three near misses. A shared last part (e.g. "cpc_bid_ceiling_micros") counts most, since
 * that's what a model usually gets right while guessing the path to it; then edit distance on the whole name.
 */
export function closest(name: string, pool: string[]): string[] {
  const parts = name.split(".");
  const leaf = parts.at(-1)!;
  const scored = pool.map((c) => {
    const cp = c.split(".");
    let s = levenshtein(name, c);
    if (sameLeaf(c, name)) s -= 100;
    else if (cp.at(-1)!.includes(leaf) || leaf.includes(cp.at(-1)!)) s -= 20;
    if (cp[0] === parts[0]) s -= 10;
    return { c, s };
  }).sort((a, b) => a.s - b.s);
  const best = scored[0];
  if (!best) return [];
  // Same last part (e.g. every *.cpc_bid_ceiling_micros): offer them all, since the path is what was guessed wrong and
  // names alone can't tell which (maximize clicks is target_spend in the API, say).
  const leafMatches = scored.filter((x) => sameLeaf(x.c, name));
  // The resource's own name prefixed to the leaf: experiment.id is experiment.experiment_id, and the same-leaf rule alone
  // offered only customer.id for it (2026-10-23).
  const own = parts.length > 1 ? `${parts.slice(0, -1).join(".")}.${parts.at(-2)}_${leaf}` : "";
  if (pool.includes(own)) return [own, ...leafMatches.map((x) => x.c)].slice(0, 8);
  if (leafMatches.length) return leafMatches.slice(0, 8).map((x) => x.c);
  // Otherwise only names that are plausibly what was meant, judged on the last part: sharing the resource prefix alone
  // offered campaign.campaign_group for campaign.url_expansion_opt_out (2026-10-15), and a wrong guess costs a retry.
  const flat = name.replace(/\./g, "_");
  const plausible = (c: string) => {
    const cl = c.split(".").at(-1)!;
    return c.replace(/\./g, "_") === flat                                  // ad_group_criterion.keyword_text → keyword.text
      || (leaf.length >= 4 && cl.includes(leaf))                           // metrics.cost → cost_micros, impression_share → search_impression_share
      || (cl.length >= 4 && leaf.startsWith(`${cl}_`))                      // segments.device_type → segments.device
      // but not a word inside a longer name: "conversions" isn't what "all_conversions_settings" meant
      || levenshtein(leaf, cl) <= Math.max(2, Math.floor(leaf.length / 3));
  };
  const near = scored.filter((x) => x.s <= best.s + 3 && plausible(x.c)).slice(0, 3).map((x) => x.c);
  if (near.length) return near;
  // The right words in the wrong order: metrics.search_lost_is_rank is search_rank_lost_impression_share, which edit
  // distance can't see, so the model dropped impression share (prod, 2026-10-31). Two words at least: one alone is too loose.
  const wanted = words(name);
  return wanted.length < 2 ? [] : scored.filter((x) => wanted.every((w) => words(x.c).includes(w))).slice(0, 3).map((x) => x.c);
}

/** The words of a field's last part, without the short ones ("is", "ad") that say little. */
const words = (name: string) => name.split(".").at(-1)!.split("_").filter((w) => w.length >= 3);

/**
 * Same last part, numbering aside: dynamic_search_ad.description1 is expanded_dynamic_search_ad.description, and an
 * exact match alone offered only text_ad.description1 and in_feed.description1 (prod, 2026-10-30).
 */
function sameLeaf(a: string, b: string): boolean {
  const stem = (n: string) => n.split(".").at(-1)!.replace(/\d+$/, "");
  return stem(a) === stem(b);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * gaql_fields: a resource's own fields, the resources it can also select from, and its metrics and segments; or,
 * with only `search`, matching names across the whole catalog. `search` filters by substring (any of its words).
 */
export function lookupFields(cat: Catalog, o: { resource?: string; search?: string }) {
  const words = (o.search ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  const hit = (n: string) => !words.length || words.some((w) => n.includes(w));
  const CAP = 200;
  const capped = (xs: string[]) => ({ names: xs.slice(0, CAP), ...(xs.length > CAP ? { more: xs.length - CAP } : {}) });
  if (!o.resource) {
    if (!words.length) throw new Error("Give a resource (e.g. campaign) or search words (e.g. bid ceiling).");
    const all = [...cat.values()].filter((f) => f.category !== "RESOURCE" && f.selectable !== false && hit(f.name));
    return { matches: capped(all.map((f) => `${f.name} (${f.category.toLowerCase()}${f.dataType ? `, ${f.dataType}` : ""})`)),
      tip: "Pass resource to see what one FROM can use; attributes belong to the resource named before their first dot." };
  }
  const r = cat.get(o.resource.toLowerCase());
  if (!r || r.category !== "RESOURCE") {
    const near = closest(o.resource, [...cat.values()].filter((f) => f.category === "RESOURCE").map((f) => f.name));
    throw new Error(`No resource "${o.resource}"${near.length ? `. Closest: ${near.join(", ")}` : ""}.`);
  }
  const own = [...cat.values()].filter((f) => f.category === "ATTRIBUTE" && f.name.startsWith(`${r.name}.`) && hit(f.name));
  return {
    resource: r.name,
    fields: capped(own.map((f) => `${f.name} ${f.dataType ?? ""}${f.isRepeated ? "[]" : ""}${f.filterable === false ? " (not filterable)" : ""}`.trim())),
    also_select_from: [...(r.attributeResources ?? []), ...(r.segments ?? []).filter((s) => !s.includes("."))],
    metrics: capped((r.metrics ?? []).filter(hit)),
    segments: capped((r.segments ?? []).filter((s) => s.includes(".") && hit(s))),
  };
}
