/**
 * Merchant Center Query Language (merchant_report) against Google's own field list: the Reports API's discovery
 * document, which has one schema per view with every field and, in each field's description, whether Google requires it
 * in SELECT ("Required in the `SELECT` clause.") or a condition on it in WHERE ("Condition on `x` is required in the
 * `WHERE` clause."). The Merchant API has no field service like Google Ads' GoogleAdsFieldService; this document is the
 * closest Google publishes, and it's public, so no account or token is involved.
 *
 *   checkMcql   finds an unknown view, unknown fields (with the view's real fields), nested names (MCQL selects `price`
 *               whole, not `price.amount_micros`), and SELECT fields or WHERE conditions the view requires but the query
 *               lacks. As with run_gaql's checkGaql it never blocks a query: merchant_report attaches its findings only
 *               when Google rejects one, since Google's own message names one missing requirement at a time.
 *
 * The document (~90 KB) is fetched once per process and day.
 */

export interface McqlField { name: string; requiredInSelect: boolean; requiredInWhere: boolean; enumValues?: string[]; parts?: string[] }
/** View name (snake_case, as MCQL spells it) → its fields by name. */
export type McqlCatalog = Map<string, Map<string, McqlField>>;

export const DISCOVERY_URL = "https://merchantapi.googleapis.com/$discovery/rest?version=reports_v1";
const TTL = 24 * 3600_000;
const RETRY = 10 * 60_000;

/** camelCase (the discovery document) → snake_case (MCQL): categoryL1 → category_l1, customLabel0 → custom_label0. */
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The catalog from a reports_v1 discovery document: every view ReportRow can hold. */
export function parseDiscovery(doc: any): McqlCatalog {
  const schemas = doc?.schemas ?? {};
  const out: McqlCatalog = new Map();
  for (const [key, ref] of Object.entries<any>(schemas.ReportRow?.properties ?? {})) {
    const props = schemas[ref?.$ref]?.properties;
    if (!props) continue;
    const fields = new Map<string, McqlField>();
    for (const [k, p] of Object.entries<any>(props).sort(([a], [b]) => snake(a).localeCompare(snake(b)))) {
      const name = snake(k), d = String(p.description ?? "");
      const enumValues = (p.enum as string[] | undefined)?.filter((v) => !/_UNSPECIFIED$|^UNSPECIFIED$/.test(v));
      const parts = p.$ref && schemas[p.$ref]?.properties ? Object.keys(schemas[p.$ref].properties).sort() : undefined;
      fields.set(name, {
        name,
        requiredInSelect: /Required in the `SELECT` clause/i.test(d),
        requiredInWhere: new RegExp(`Condition on \`${name}\` is required in the \`WHERE\` clause`, "i").test(d),
        ...(enumValues?.length ? { enumValues } : {}),
        ...(parts?.length ? { parts } : {}),
      });
    }
    out.set(snake(key), fields);
  }
  return out;
}

let cached: { at: number; catalog: McqlCatalog | null; loading?: Promise<McqlCatalog | null> } | undefined;

/** The catalog, fetched with `fetchDoc` when missing or stale. Null when it can't be had right now. */
export async function mcqlCatalog(fetchDoc: () => Promise<unknown>): Promise<McqlCatalog | null> {
  const now = Date.now();
  if (cached?.loading) return cached.loading;
  if (cached && now - cached.at < (cached.catalog ? TTL : RETRY)) return cached.catalog;
  const loading = fetchDoc()
    .then((doc) => { const c = parseDiscovery(doc); if (!c.size) throw new Error("no views in the discovery document"); return c; })
    .catch((e) => { console.error(`mcql catalog: ${(e as Error).message}`); return null; })
    .then((c) => { cached = { at: Date.now(), catalog: c }; return c; });
  cached = { at: now, catalog: cached?.catalog ?? null, loading };
  return loading;
}

/** Tests only: forget the cached catalog. */
export function resetMcqlCatalog() { cached = undefined; }

const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const list = (xs: string[]) => xs.join(", ");
const requirementOf = (f: McqlField) => f.enumValues ? `${f.name} (${f.enumValues.map((v) => `'${v}'`).join(" or ")})` : f.name;

/** What Google's field list finds wrong with a query: one sentence per finding, empty when nothing (or it can't be read). */
export function checkMcql(query: string, cat: McqlCatalog): string[] {
  const q = query.replace(QUOTED, "''");
  const m = /^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)\b(.*)$/is.exec(q);
  if (!m) return [];
  const view = m[2]!.toLowerCase();
  const fields = cat.get(view);
  if (!fields) return [`FROM ${view}: there is no such view. The views are ${list([...cat.keys()])}.`];
  const rest = m[3]!;
  const where = /\bWHERE\s+(.+?)(?=\bORDER\s+BY\b|\bLIMIT\b|$)/is.exec(rest)?.[1] ?? "";
  const bare = (s: string) => s.trim().toLowerCase().replace(new RegExp(`^${view}\\.`), "");
  const selected = m[1]!.split(",").map(bare).filter(Boolean);
  const out: string[] = [];

  const unknown: string[] = [];
  for (const s of selected) {
    if (fields.has(s) || !/^[\w.]+$/.test(s)) continue;
    const head = fields.get(s.split(".")[0]!);
    if (s.includes(".") && head) {
      out.push(`${s}: MCQL selects ${head.name} whole${head.parts ? ` (it returns ${list(head.parts)})` : ""}, not a part of it.`);
    } else unknown.push(s);
  }
  if (unknown.length) out.push(`${list(unknown)} ${unknown.length > 1 ? "aren't fields" : "isn't a field"} of ${view}. Its fields: ${list([...fields.keys()])}.`);

  const missingSelect = [...fields.values()].filter((f) => f.requiredInSelect && !selected.includes(f.name)).map((f) => f.name);
  if (missingSelect.length) out.push(`${view} needs ${list(missingSelect)} in SELECT.`);
  const named = (f: McqlField) => new RegExp(`(?<![\\w.])(?:${view}\\.)?${f.name}(?![\\w.])`, "i").test(where);
  const missingWhere = [...fields.values()].filter((f) => f.requiredInWhere && !named(f));
  if (missingWhere.length) out.push(`${view} needs a WHERE condition on ${list(missingWhere.map(requirementOf))}.`);
  return out;
}
