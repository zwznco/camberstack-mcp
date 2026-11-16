/**
 * Google Analytics setup changes: create a property with its web stream, mark or unmark key events (conversions), link
 * or unlink a Google Ads account, register a custom dimension or metric. They go through the same propose → approve → apply → undo cycle as Google Ads changes
 * (session.ts), stored as proposals whose customer_id is GA_TARGET. Each resolves against the live property first, so
 * something already in place is skipped, and records what undoes it. The GA4 Admin API has no dry run: re-resolving at
 * apply and rolling back on a failed write is what keeps a proposal all or nothing.
 */
import { z } from "zod";
import type { Analytics } from "./ga4.js";

/** proposals.customer_id for Google Analytics proposals. */
export const GA_TARGET = "ga4";

const digits = z.string().regex(/^\d+$/, "digits only");
const propertyId = digits.describe("GA4 property id (from analytics_properties)");
const eventName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "a GA4 event name: letters, digits and underscores, starting with a letter")
  .describe("GA4 event name, e.g. generate_lead, purchase, sign_up, or a custom event the site sends");
const adsCustomer = z.string().regex(/^\d{3}-?\d{3}-?\d{4}$/).transform((s) => s.replace(/-/g, "")).describe("Google Ads customer ID, with or without dashes");
const counting = z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]);
/** Admin API v1beta CustomDimension rules: parameterName starts with a letter, letters/digits/underscores, 40 at most (24 for USER). */
const parameterName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "letters, digits and underscores, starting with a letter, 40 at most");
const dimensionScope = z.enum(["EVENT", "USER", "ITEM"]);
type DimensionScope = z.infer<typeof dimensionScope>;
/** How the Data API names a custom dimension in reports (and the prefix fieldHint looks for). */
export const REPORT_PREFIX: Record<DimensionScope, string> = { EVENT: "customEvent", USER: "customUser", ITEM: "customItem" };
const SCOPE_LABEL: Record<DimensionScope, string> = { EVENT: "an event-scoped", USER: "a user-scoped", ITEM: "an item-scoped" };
/** Admin API v1beta CustomMetric.measurementUnit, less UNSPECIFIED. */
const metricUnit = z.enum(["STANDARD", "CURRENCY", "FEET", "METERS", "KILOMETERS", "MILES", "MILLISECONDS", "SECONDS", "MINUTES", "HOURS"]);
/** restrictedMetricType: required for a CURRENCY metric, empty otherwise. It hides the metric from users without access to that data. */
const restricted = z.enum(["REVENUE_DATA", "COST_DATA"]);
const RESTRICTED_LABEL = { REVENUE_DATA: "revenue", COST_DATA: "cost" } as const;

export const PUBLIC_GA_CHANGES = [
  z.object({ type: z.literal("create_ga4_property"), account_id: digits.describe("Google Analytics account id (from analytics_properties' accounts)"),
    name: z.string().min(1).max(100).describe("Property name, usually the business or site"),
    website_url: z.string().url().describe("The site's address, e.g. https://www.example.com"),
    time_zone: z.string().min(3).max(64).describe("IANA time zone reports use, e.g. America/New_York"),
    currency: z.string().regex(/^[A-Z]{3}$/).default("USD").describe("Currency for revenue, ISO 4217") })
    .describe("Create a GA4 property with a web data stream for the site; the result gives the measurement ID and the tag to add to every page"),
  z.object({ type: z.literal("mark_key_event"), property_id: propertyId, event_name: eventName,
    counting: counting.default("ONCE_PER_EVENT").describe("ONCE_PER_EVENT counts every time; ONCE_PER_SESSION counts one per visit (leads)") })
    .describe("Mark an event as a key event (GA4's conversion), so it is counted and can be imported into Google Ads"),
  z.object({ type: z.literal("unmark_key_event"), property_id: propertyId, event_name: eventName })
    .describe("Stop counting an event as a key event"),
  z.object({ type: z.literal("set_key_event_counting"), property_id: propertyId, event_name: eventName,
    counting: counting.describe("ONCE_PER_EVENT: every time; ONCE_PER_SESSION: one per visit") })
    .describe("Recount an existing key event; a Google Ads action imported from it follows (ONCE_PER_SESSION is Ads' one per click)"),
  z.object({ type: z.literal("link_google_ads"), property_id: propertyId, customer_id: adsCustomer })
    .describe("Link a GA4 property to a Google Ads account, so Ads can import its key events and GA4 shows ad clicks and cost (the user must be an admin of both)"),
  z.object({ type: z.literal("unlink_google_ads"), property_id: propertyId, customer_id: adsCustomer })
    .describe("Remove the link between a GA4 property and a Google Ads account"),
  z.object({ type: z.literal("register_custom_dimension"), property_id: propertyId,
    parameter_name: parameterName.describe("The parameter the site already sends, e.g. form_id"),
    scope: dimensionScope.default("EVENT").describe("EVENT: an event parameter; USER: a user property; ITEM: an ecommerce item parameter"),
    display_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_ ]{0,81}$/, "letters, digits, spaces and underscores, starting with a letter, 82 at most").optional()
      .describe("Name shown in GA4; defaults to parameter_name") })
    .describe("Register a parameter as a GA4 custom dimension so reports can use it (customEvent:<parameter_name>). Counted from registration on, in reports after 24-48 hours"),
  z.object({ type: z.literal("register_custom_metric"), property_id: propertyId,
    parameter_name: parameterName.describe("The numeric event parameter the site already sends, e.g. order_weight"),
    unit: metricUnit.default("STANDARD").describe("STANDARD for a plain number; CURRENCY for money; or a distance or time unit"),
    currency_data: restricted.optional().describe("CURRENCY only: REVENUE_DATA (default) or COST_DATA"),
    display_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_ ]{0,81}$/, "letters, digits, spaces and underscores, starting with a letter, 82 at most").optional()
      .describe("Name shown in GA4; defaults to parameter_name") })
    .describe("Register a numeric event parameter as a GA4 custom metric so reports can use it (customEvent:<parameter_name>). Counted from registration on, in reports after 24-48 hours"),
  z.object({ type: z.literal("set_custom_metric_unit"), property_id: propertyId, parameter_name: parameterName.describe("A registered custom metric's parameter"),
    unit: metricUnit, currency_data: restricted.optional().describe("CURRENCY only: REVENUE_DATA (default) or COST_DATA") })
    .describe("Change a registered custom metric's unit, or a money metric between revenue and cost data. Google fixes money at registration: to or from CURRENCY, archive and register again"),
  z.object({ type: z.literal("archive_custom_dimension"), property_id: propertyId, parameter_name: parameterName, scope: dimensionScope.default("EVENT"),
    resource_name: z.string().optional().describe("Leave out") })
    .describe("Archive a custom dimension (GA4 has no delete and can't restore it); the parameter can be registered again as a new one"),
  z.object({ type: z.literal("archive_custom_metric"), property_id: propertyId, parameter_name: parameterName,
    resource_name: z.string().optional().describe("Leave out") })
    .describe("Archive a custom metric (GA4 has no delete and can't restore it); the parameter can be registered again as a new one, e.g. to change it to or from money"),
] as const;

export const PublicGaChangeSchema = z.discriminatedUnion("type", [...PUBLIC_GA_CHANGES]);
export const GaChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_GA_CHANGES,
  // Only undo creates it: a property Camberstack created goes to Google Analytics' trash (restorable there for 35 days).
  z.object({ type: z.literal("delete_ga4_property"), property_id: propertyId, name: z.string() }),
]);
export type GaChange = z.infer<typeof GaChangeSchema>;

export interface GaOp {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: object;
  /** create_ga4_property: the web stream to add once the property exists (its path depends on the new property's id). */
  stream?: { displayName: string; defaultUri: string };
}
export interface GaResolved {
  change: GaChange;
  service: "ga4";
  operations: GaOp[];
  describe: string;
  /** Known before applying (unmark, unlink); a create's comes from what Google returns (gaInverseAfterApply). */
  inverse?: GaChange;
}

/** What one write returned: the resource names, and for a new property its stream's measurement ID. */
export interface GaWriteResult { resourceName: string; measurementId?: string }

const fmtCid = (c: string) => `${c.slice(0, 3)}-${c.slice(3, 6)}-${c.slice(6)}`;

export async function resolveGaChange(ga: Analytics, change: GaChange): Promise<GaResolved> {
  const base = { change, service: "ga4" as const };
  const propertyName = async (id: string) => (await ga.admin("GET", `properties/${id}`)).displayName as string;
  switch (change.type) {
    case "create_ga4_property": {
      const { accounts, properties } = await ga.summaries();
      const acct = accounts.find((a) => a.account_id === change.account_id);
      if (!acct) throw new Error(`Google Analytics account ${change.account_id} isn't one this login can see (analytics_properties lists them).`);
      const dup = properties.find((p) => p.account_id === change.account_id && p.name.toLowerCase() === change.name.toLowerCase());
      if (dup) throw new Error(`Account "${acct.name}" already has a property named "${change.name}" (id ${dup.property_id}). Pick another name.`);
      const host = new URL(change.website_url).host;
      return { ...base,
        operations: [{ method: "POST", path: "properties",
          body: { parent: `accounts/${change.account_id}`, displayName: change.name, timeZone: change.time_zone, currencyCode: change.currency },
          stream: { displayName: host, defaultUri: change.website_url } }],
        describe: `Create GA4 property "${change.name}" in account "${acct.name}" (${change.time_zone}, ${change.currency}) with a web stream for ${change.website_url}` };
    }
    case "mark_key_event":
    case "unmark_key_event": {
      const name = await propertyName(change.property_id);
      const have = ((await ga.admin("GET", `properties/${change.property_id}/keyEvents?pageSize=200`)).keyEvents ?? []) as
        { name: string; eventName: string; countingMethod: string; deletable?: boolean }[];
      const k = have.find((x) => x.eventName === change.event_name);
      if (change.type === "mark_key_event") {
        return { ...base,
          operations: k ? [] : [{ method: "POST", path: `properties/${change.property_id}/keyEvents`,
            body: { eventName: change.event_name, countingMethod: change.counting } }],
          describe: `Mark "${change.event_name}" as a key event in GA4 property "${name}" (counted ${change.counting === "ONCE_PER_SESSION" ? "once per session" : "every time"})`
            + (k ? " (already a key event)" : "")
            + ". To bid on it in Google Ads, import it there once this is applied (the import_ga4_key_event change; the property must be linked to the Ads account)" };
      }
      // GA4's built-in key events (purchase) refuse deletion at write, which would roll back everything proposed with them.
      // Google omits false booleans, so a built-in one comes back with no deletable field at all (seen live 2026-10-22).
      if (k && k.deletable !== true) {
        throw new Error(`"${change.event_name}" is a built-in key event in GA4 property "${name}" and Google Analytics won't remove it. `
          + `Leave it out; to keep it out of Google Ads bidding, make its conversion action secondary there instead (import_ga4_key_event with primary false).`);
      }
      return { ...base,
        operations: k ? [{ method: "DELETE", path: k.name }] : [],
        describe: `Stop counting "${change.event_name}" as a key event in GA4 property "${name}"` + (k ? "" : " (not a key event)")
          + (k ? " ⚠ Google Ads conversion actions imported from it stop receiving conversions" : ""),
        inverse: k ? { type: "mark_key_event", property_id: change.property_id, event_name: change.event_name,
          counting: k.countingMethod === "ONCE_PER_SESSION" ? "ONCE_PER_SESSION" : "ONCE_PER_EVENT" } : undefined };
    }
    case "set_key_event_counting": {
      // mark_key_event leaves an existing key event as it is, so recounting one needs its own change. The Ads side refuses
      // to recount a GA4 import (set_conversion_counting), and before this the user was sent to GA4's admin (prod, 2026-10-28).
      const name = await propertyName(change.property_id);
      const have = ((await ga.admin("GET", `properties/${change.property_id}/keyEvents?pageSize=200`)).keyEvents ?? []) as
        { name: string; eventName: string; countingMethod: string }[];
      const k = have.find((x) => x.eventName === change.event_name);
      if (!k) throw new Error(`"${change.event_name}" isn't a key event in GA4 property "${name}". Mark it with mark_key_event, which sets its counting.`);
      const before = k.countingMethod === "ONCE_PER_SESSION" ? "ONCE_PER_SESSION" : "ONCE_PER_EVENT";
      const label = (c: string) => (c === "ONCE_PER_SESSION" ? "once per session" : "every time");
      return { ...base,
        operations: before === change.counting ? [] : [{ method: "PATCH", path: `${k.name}?updateMask=counting_method`, body: { countingMethod: change.counting } }],
        describe: `Count key event "${change.event_name}" in GA4 property "${name}" ${label(change.counting)} (was ${label(before)}). `
          + "Google Ads conversion actions imported from it follow",
        inverse: before === change.counting ? undefined
          : { type: "set_key_event_counting", property_id: change.property_id, event_name: change.event_name, counting: before } };
    }
    case "link_google_ads":
    case "unlink_google_ads": {
      const name = await propertyName(change.property_id);
      const links = ((await ga.admin("GET", `properties/${change.property_id}/googleAdsLinks?pageSize=200`)).googleAdsLinks ?? []) as
        { name: string; customerId: string }[];
      const l = links.find((x) => x.customerId === change.customer_id);
      if (change.type === "link_google_ads") {
        return { ...base,
          operations: l ? [] : [{ method: "POST", path: `properties/${change.property_id}/googleAdsLinks`, body: { customerId: change.customer_id } }],
          describe: `Link GA4 property "${name}" to Google Ads account ${fmtCid(change.customer_id)}` + (l ? " (already linked)" : "") };
      }
      return { ...base,
        operations: l ? [{ method: "DELETE", path: l.name }] : [],
        describe: `Unlink GA4 property "${name}" from Google Ads account ${fmtCid(change.customer_id)}` + (l ? "" : " (not linked)"),
        inverse: l ? { type: "link_google_ads", property_id: change.property_id, customer_id: change.customer_id } : undefined };
    }
    case "register_custom_dimension": {
      // GA4 reports an event parameter only once it's registered. Before this, the AI could only send the user to GA4's admin:
      // one user registered form_variant there by hand, then hit the same wall with form_id (prod, 2026-10-26/27).
      const name = await propertyName(change.property_id);
      const have = await customDimensions(ga, change.property_id);
      if (change.scope === "USER" && change.parameter_name.length > 24) {
        throw new Error(`A user-scoped custom dimension's parameter_name can be 24 characters at most; "${change.parameter_name}" has ${change.parameter_name.length}.`);
      }
      const reportAs = `${REPORT_PREFIX[change.scope]}:${change.parameter_name}`;
      const same = have.find((d) => d.parameterName === change.parameter_name && d.scope === change.scope);
      if (same) {
        return { ...base, operations: [],
          describe: `Register "${change.parameter_name}" as ${SCOPE_LABEL[change.scope]} custom dimension in GA4 property "${name}" (already registered as "${same.displayName}"; report it as ${reportAs})` };
      }
      const display = change.display_name ?? change.parameter_name;
      const clash = have.find((d) => d.displayName === display);
      if (clash) {
        throw new Error(`GA4 property "${name}" already has a custom dimension named "${display}" (parameter ${clash.parameterName}). Pass another display_name.`);
      }
      return { ...base,
        operations: [{ method: "POST", path: `properties/${change.property_id}/customDimensions`,
          body: { parameterName: change.parameter_name, displayName: display, scope: change.scope } }],
        describe: `Register "${change.parameter_name}" as ${SCOPE_LABEL[change.scope]} custom dimension "${display}" in GA4 property "${name}", reported as ${reportAs}. `
          + "GA4 counts it from registration on, not for earlier visits, and it reaches reports after 24-48 hours. Undoing it archives it, which GA4 can't reverse" };
    }
    case "archive_custom_dimension": {
      // Undo names the registration it made (resource_name), so it never archives a later one of the same parameter.
      const name = await propertyName(change.property_id);
      const live = (await customDimensions(ga, change.property_id)).find((d) => change.resource_name
        ? d.name === change.resource_name : d.parameterName === change.parameter_name && d.scope === change.scope);
      const reportAs = `${REPORT_PREFIX[change.scope]}:${change.parameter_name}`;
      if (!live && !change.resource_name) throw new Error(`GA4 property "${name}" has no custom dimension ${reportAs}; analytics_setup lists the ones it has.`);
      return { ...base,
        operations: live ? [{ method: "POST", path: `${live.name}:archive`, body: {} }] : [],
        describe: `Archive custom dimension ${reportAs} in GA4 property "${name}"` + (live
          ? " ⚠ GA4 can't restore an archived custom dimension: reports, explorations and audiences using it stop getting it (it can be registered again, as a new one)"
          : " (already archived)") };
    }
    case "register_custom_metric": {
      const name = await propertyName(change.property_id);
      const have = await customMetrics(ga, change.property_id);
      if (change.currency_data && change.unit !== "CURRENCY") {
        throw new Error("currency_data applies only to unit CURRENCY: Google refuses it on any other unit. Leave it out.");
      }
      const reportAs = `customEvent:${change.parameter_name}`;
      const same = have.find((m) => m.parameterName === change.parameter_name);
      if (same) {
        return { ...base, operations: [],
          describe: `Register "${change.parameter_name}" as a custom metric in GA4 property "${name}" (already registered as "${same.displayName}", unit ${same.measurementUnit}; report it as ${reportAs})` };
      }
      const display = change.display_name ?? change.parameter_name;
      const clash = have.find((m) => m.displayName === display);
      if (clash) {
        throw new Error(`GA4 property "${name}" already has a custom metric named "${display}" (parameter ${clash.parameterName}). Pass another display_name.`);
      }
      const money = change.unit === "CURRENCY" ? change.currency_data ?? "REVENUE_DATA" : undefined;
      return { ...base,
        operations: [{ method: "POST", path: `properties/${change.property_id}/customMetrics`,
          body: { parameterName: change.parameter_name, displayName: display, measurementUnit: change.unit, scope: "EVENT",
            ...(money ? { restrictedMetricType: [money] } : {}) } }],
        describe: `Register "${change.parameter_name}" as a custom metric "${display}" (${change.unit === "STANDARD" ? "a plain number" : `unit ${change.unit}`}) in GA4 property "${name}", reported as ${reportAs}. `
          + (money ? `It is marked as ${RESTRICTED_LABEL[money]} data, so GA4 users without access to ${RESTRICTED_LABEL[money]} data won't see it. ` : "")
          + "GA4 counts it from registration on, not for earlier visits, and it reaches reports after 24-48 hours. "
          + "Undoing it archives it, which GA4 can't reverse" };
    }
    case "set_custom_metric_unit": {
      // measurementUnit isn't marked immutable in Admin API v1beta, and a PATCH does change it between non-money units. Google
      // refuses money either way (live, 2026-11-16): "measurement_unit may only be set to CURRENCY when the CustomMetric is
      // created" and "Custom metrics with measurement unit type CURRENCY may not have their measurement unit type changed".
      // The mask names only what changes: re-sending CURRENCY on a money metric is refused as "set to CURRENCY".
      const name = await propertyName(change.property_id);
      const m = (await customMetrics(ga, change.property_id)).find((x) => x.parameterName === change.parameter_name);
      if (!m) throw new Error(`"${change.parameter_name}" isn't a registered custom metric in GA4 property "${name}". Register it with register_custom_metric, which sets its unit.`);
      if (change.currency_data && change.unit !== "CURRENCY") {
        throw new Error("currency_data applies only to unit CURRENCY: Google refuses it on any other unit. Leave it out.");
      }
      const money = change.unit === "CURRENCY" ? change.currency_data ?? "REVENUE_DATA" : undefined;
      const before = { unit: m.measurementUnit, money: m.restrictedMetricType?.find((t) => t === "REVENUE_DATA" || t === "COST_DATA") as "REVENUE_DATA" | "COST_DATA" | undefined };
      const label = (unit: string, data?: "REVENUE_DATA" | "COST_DATA") => (unit === "STANDARD" ? "a plain number" : unit === "CURRENCY" ? `money (${RESTRICTED_LABEL[data ?? "REVENUE_DATA"]} data)` : unit);
      const same = before.unit === change.unit && before.money === money;
      if (before.unit !== change.unit && (before.unit === "CURRENCY" || change.unit === "CURRENCY")) {
        throw new Error(`Google sets a money unit only when a custom metric is registered and never changes it after (customEvent:${change.parameter_name} is ${label(before.unit, before.money)}). `
          + `To make it ${label(change.unit, money)}: propose archive_custom_metric, and once that's applied, register_custom_metric with unit ${change.unit} `
          + "(two proposals: a proposal is checked against the property as it is, where the metric still exists). What GA4 counted so far stays with the archived metric.");
      }
      const mask = [...(before.unit !== change.unit ? ["measurement_unit"] : []), ...(before.money !== money ? ["restricted_metric_type"] : [])];
      return { ...base,
        operations: same ? [] : [{ method: "PATCH", path: `${m.name}?updateMask=${mask.join(",")}`,
          body: { measurementUnit: change.unit, restrictedMetricType: money ? [money] : [] } }],
        describe: `Change custom metric customEvent:${change.parameter_name} in GA4 property "${name}" to ${label(change.unit, money)} (was ${label(before.unit, before.money)})`
          + (same ? " (already)" : money && before.money !== money ? `. GA4 users without access to ${RESTRICTED_LABEL[money]} data won't see it` : ""),
        inverse: same ? undefined : { type: "set_custom_metric_unit", property_id: change.property_id, parameter_name: change.parameter_name,
          unit: metricUnit.parse(before.unit), ...(before.money ? { currency_data: before.money } : {}) } };
    }
    case "archive_custom_metric": {
      const name = await propertyName(change.property_id);
      const live = (await customMetrics(ga, change.property_id)).find((m) => change.resource_name ? m.name === change.resource_name : m.parameterName === change.parameter_name);
      if (!live && !change.resource_name) throw new Error(`GA4 property "${name}" has no custom metric customEvent:${change.parameter_name}; analytics_setup lists the ones it has.`);
      return { ...base,
        operations: live ? [{ method: "POST", path: `${live.name}:archive`, body: {} }] : [],
        describe: `Archive custom metric customEvent:${change.parameter_name} in GA4 property "${name}"` + (live
          ? " ⚠ GA4 can't restore an archived custom metric: reports, explorations and audiences using it stop getting it (it can be registered again, as a new one)"
          : " (already archived)") };
    }
    case "delete_ga4_property":
      return { ...base, operations: [{ method: "DELETE", path: `properties/${change.property_id}` }],
        describe: `Delete GA4 property "${change.name}" (Camberstack created it; Google Analytics keeps it in its trash for 35 days)` };
  }
}

/** Run one resolved change's writes, in order. */
export async function writeGa(ga: Analytics, ops: GaOp[]): Promise<GaWriteResult[]> {
  const out: GaWriteResult[] = [];
  for (const op of ops) {
    const r = await ga.admin(op.method, op.path, op.body);
    if (op.method === "DELETE") { out.push({ resourceName: op.path }); continue; }
    out.push({ resourceName: r?.name ?? op.path.replace(/:archive$/, "") });  // an archive answers {}
    if (op.stream) {
      const s = await ga.admin("POST", `${r.name}/dataStreams`,
        { type: "WEB_DATA_STREAM", displayName: op.stream.displayName, webStreamData: { defaultUri: op.stream.defaultUri } });
      out.push({ resourceName: s.name, measurementId: s.webStreamData?.measurementId });
    }
  }
  return out;
}

/** What undoes an applied change, once Google has said what it created. */
export function gaInverseAfterApply(r: GaResolved, results: GaWriteResult[]): GaChange | undefined {
  const c = r.change;
  if (c.type === "create_ga4_property" && results[0]) {
    return { type: "delete_ga4_property", property_id: results[0].resourceName.replace("properties/", ""), name: c.name };
  }
  if (c.type === "mark_key_event" && results.length) return { type: "unmark_key_event", property_id: c.property_id, event_name: c.event_name };
  if (c.type === "link_google_ads" && results.length) return { type: "unlink_google_ads", property_id: c.property_id, customer_id: c.customer_id };
  if (c.type === "register_custom_dimension" && results[0]) {
    return { type: "archive_custom_dimension", property_id: c.property_id, resource_name: results[0].resourceName, parameter_name: c.parameter_name, scope: c.scope };
  }
  if (c.type === "register_custom_metric" && results[0]) {
    return { type: "archive_custom_metric", property_id: c.property_id, resource_name: results[0].resourceName, parameter_name: c.parameter_name };
  }
  return r.inverse;
}

/** For a new property: the measurement ID and the tag the site needs, which Camberstack can't install itself. */
export function gaNoteAfterApply(results: GaWriteResult[]): string | undefined {
  const id = results.find((x) => x.measurementId)?.measurementId;
  if (!id) return undefined;
  return `Measurement ID ${id}. Data starts once this tag is on every page of the site, in <head> (or add ${id} in the site builder's `
    + `Google Analytics setting, or as a Google tag in Tag Manager): <script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`
    + `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`;
}

interface CustomDimension { name: string; parameterName: string; displayName: string; scope: DimensionScope }
interface CustomMetric { name: string; parameterName: string; displayName: string; measurementUnit: string; restrictedMetricType?: string[] }
/** A property's active custom definitions of one kind (archived ones aren't listed), every page. */
async function definitions<T>(ga: Analytics, propertyId: string, kind: "customDimensions" | "customMetrics"): Promise<T[]> {
  const out: T[] = [];
  let page = "";
  do {
    const r = await ga.admin("GET", `properties/${propertyId}/${kind}?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
    out.push(...(r[kind] ?? []));
    page = r.nextPageToken ?? "";
  } while (page);
  return out;
}
const customDimensions = (ga: Analytics, id: string) => definitions<CustomDimension>(ga, id, "customDimensions");
const customMetrics = (ga: Analytics, id: string) => definitions<CustomMetric>(ga, id, "customMetrics");

/** analytics_setup: the property's web streams (measurement IDs), key events, Google Ads links and custom definitions. Read-only. */
export async function gaSetup(ga: Analytics, propertyId: string) {
  const p = `properties/${propertyId}`;
  const [prop, streams, keys, links, dims, metrics] = await Promise.all([ga.admin("GET", p), ga.admin("GET", `${p}/dataStreams?pageSize=200`),
    ga.admin("GET", `${p}/keyEvents?pageSize=200`), ga.admin("GET", `${p}/googleAdsLinks?pageSize=200`),
    customDimensions(ga, propertyId), customMetrics(ga, propertyId)]);
  return {
    property_id: propertyId, name: prop.displayName, time_zone: prop.timeZone, currency: prop.currencyCode,
    web_streams: (streams.dataStreams ?? []).filter((s: any) => s.type === "WEB_DATA_STREAM")
      .map((s: any) => ({ name: s.displayName, measurement_id: s.webStreamData?.measurementId, url: s.webStreamData?.defaultUri })),
    key_events: (keys.keyEvents ?? []).map((k: any) => ({ event_name: k.eventName, counting: k.countingMethod })),
    google_ads_links: (links.googleAdsLinks ?? []).map((l: any) => ({ customer_id: fmtCid(String(l.customerId)) })),
    // report_as is the name analytics_report takes. A parameter the site sends but isn't listed here can't be reported on yet.
    custom_dimensions: dims.map((d) => ({ parameter: d.parameterName, scope: d.scope, display_name: d.displayName,
      report_as: `${REPORT_PREFIX[d.scope] ?? "customEvent"}:${d.parameterName}` })),
    custom_metrics: metrics.map((m) => ({ parameter: m.parameterName, display_name: m.displayName, unit: m.measurementUnit,
      report_as: `customEvent:${m.parameterName}` })),
  };
}
