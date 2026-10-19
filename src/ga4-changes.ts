/**
 * Google Analytics setup changes: create a property with its web stream, mark or unmark key events (conversions), link
 * or unlink a Google Ads account. They go through the same propose → approve → apply → undo cycle as Google Ads changes
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
  z.object({ type: z.literal("link_google_ads"), property_id: propertyId, customer_id: adsCustomer })
    .describe("Link a GA4 property to a Google Ads account, so Ads can import its key events and GA4 shows ad clicks and cost (the user must be an admin of both)"),
  z.object({ type: z.literal("unlink_google_ads"), property_id: propertyId, customer_id: adsCustomer })
    .describe("Remove the link between a GA4 property and a Google Ads account"),
] as const;

export const PublicGaChangeSchema = z.discriminatedUnion("type", [...PUBLIC_GA_CHANGES]);
export const GaChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_GA_CHANGES,
  // Only undo creates it: a property Camberstack created goes to Google Analytics' trash (restorable there for 35 days).
  z.object({ type: z.literal("delete_ga4_property"), property_id: propertyId, name: z.string() }),
]);
export type GaChange = z.infer<typeof GaChangeSchema>;

export interface GaOp {
  method: "POST" | "DELETE";
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
        { name: string; eventName: string; countingMethod: string }[];
      const k = have.find((x) => x.eventName === change.event_name);
      if (change.type === "mark_key_event") {
        return { ...base,
          operations: k ? [] : [{ method: "POST", path: `properties/${change.property_id}/keyEvents`,
            body: { eventName: change.event_name, countingMethod: change.counting } }],
          describe: `Mark "${change.event_name}" as a key event in GA4 property "${name}" (counted ${change.counting === "ONCE_PER_SESSION" ? "once per session" : "every time"})`
            + (k ? " (already a key event)" : "")
            + ". To bid on it in Google Ads, import it there next (the import_ga4_key_event change; the property must be linked to the Ads account)" };
      }
      return { ...base,
        operations: k ? [{ method: "DELETE", path: k.name }] : [],
        describe: `Stop counting "${change.event_name}" as a key event in GA4 property "${name}"` + (k ? "" : " (not a key event)")
          + (k ? " ⚠ Google Ads conversion actions imported from it stop receiving conversions" : ""),
        inverse: k ? { type: "mark_key_event", property_id: change.property_id, event_name: change.event_name,
          counting: k.countingMethod === "ONCE_PER_SESSION" ? "ONCE_PER_SESSION" : "ONCE_PER_EVENT" } : undefined };
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
    out.push({ resourceName: r.name });
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

/** analytics_setup: the property's web streams (measurement IDs), key events and Google Ads links. Read-only. */
export async function gaSetup(ga: Analytics, propertyId: string) {
  const p = `properties/${propertyId}`;
  const [prop, streams, keys, links] = await Promise.all([ga.admin("GET", p), ga.admin("GET", `${p}/dataStreams?pageSize=200`),
    ga.admin("GET", `${p}/keyEvents?pageSize=200`), ga.admin("GET", `${p}/googleAdsLinks?pageSize=200`)]);
  return {
    property_id: propertyId, name: prop.displayName, time_zone: prop.timeZone, currency: prop.currencyCode,
    web_streams: (streams.dataStreams ?? []).filter((s: any) => s.type === "WEB_DATA_STREAM")
      .map((s: any) => ({ name: s.displayName, measurement_id: s.webStreamData?.measurementId, url: s.webStreamData?.defaultUri })),
    key_events: (keys.keyEvents ?? []).map((k: any) => ({ event_name: k.eventName, counting: k.countingMethod })),
    google_ads_links: (links.googleAdsLinks ?? []).map((l: any) => ({ customer_id: fmtCid(String(l.customerId)) })),
  };
}
