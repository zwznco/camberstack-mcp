/**
 * Search Console changes: submit, resubmit and delete sitemaps, add and remove properties. That is everything the
 * `webmasters` scope can write: requesting indexing has no API, and verifying a property takes Google's separate Site
 * Verification scope, so add_site leaves that to the user. They go through the same propose → approve → apply → undo cycle
 * as Google Ads changes (session.ts), stored as proposals whose customer_id is SC_TARGET. Search Console has no dry run:
 * each change resolves against the live property, at propose and again at apply.
 *
 * Sign-in asks for `webmasters`. Connections from before 0.25.0 hold `webmasters.readonly`, which still reads; their first
 * proposal returns the /connect/search-console link instead (session.ts propose).
 */
import { z } from "zod";
import { DEMO_SITE } from "./demo.js";
import type { SearchConsoleClient } from "./google.js";

/** proposals.customer_id for Search Console proposals. */
export const SC_TARGET = "search_console";

export type ScMethod = "PUT" | "DELETE";
type Sc = Pick<SearchConsoleClient, "sites" | "sitemaps" | "change">;

const siteUrl = z.string().regex(/^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+\/)$/i, "sc-domain:example.com, or a full URL ending in a slash")
  .describe("Search Console property exactly as search_console_sites lists it, e.g. sc-domain:example.com or https://www.example.com/");
const sitemapUrl = z.string().url().max(2000).regex(/^https?:\/\//i, "a full http(s) URL").describe("The sitemap's full URL, inside the property, e.g. https://www.example.com/sitemap.xml");

export const PUBLIC_SC_CHANGES = [
  z.object({ type: z.literal("submit_sitemap"), site_url: siteUrl, sitemap_url: sitemapUrl })
    .describe("Submit a sitemap to Search Console, or resubmit one so Google reads it again"),
  z.object({ type: z.literal("delete_sitemap"), site_url: siteUrl, sitemap_url: sitemapUrl })
    .describe("Remove a sitemap from Search Console's Sitemaps report. Google can keep crawling it, and its pages stay indexed"),
  z.object({ type: z.literal("add_site"), site_url: siteUrl.describe("The property to add: sc-domain:example.com for a whole domain, or a URL prefix such as https://www.example.com/") })
    .describe("Add a website to this Google login's Search Console. Unless the login already owns the domain, it stays unverified, with no data, until the user proves ownership in Search Console"),
  z.object({ type: z.literal("remove_site"), site_url: siteUrl })
    .describe("Remove a website from this Google login's Search Console. A verified property can't be restored by undo: it has to be added and verified again"),
] as const;

export const ScChangeSchema = z.discriminatedUnion("type", [...PUBLIC_SC_CHANGES]);
export type ScChange = z.infer<typeof ScChangeSchema>;

export interface ScOp { method: ScMethod; site: string; sitemap?: string }
export interface ScResolved {
  change: ScChange;
  service: "search_console";
  operations: ScOp[];
  describe: string;
  inverse?: ScChange;
}

/** Inside the property: sc-domain covers the domain and its subdomains, a URL prefix only what starts with it. */
function inProperty(site: string, url: string): boolean {
  if (!site.startsWith("sc-domain:")) return url.startsWith(site);
  const domain = site.slice("sc-domain:".length).toLowerCase(), host = new URL(url).hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

const notAdded = (site: string) => new Error(`${site} isn't a Search Console property of this login (search_console_sites lists them; `
  + "sc-domain:example.com and https://www.example.com/ are different properties).");

/** Sitemap writes need Owner or Full access, so a Restricted user hears it now, not after approving. */
async function requireEditor(sc: Sc, site: string): Promise<void> {
  if (site === DEMO_SITE) return;
  const p = (await sc.sites()).find((x) => x.siteUrl === site);
  if (!p) throw notAdded(site);
  if (p.permissionLevel !== "siteOwner" && p.permissionLevel !== "siteFullUser") {
    throw new Error(`This login has ${p.permissionLevel} access to ${site}. Changing its sitemaps takes Owner or Full access: an owner of the property can grant it in Search Console (Settings, Users and permissions).`);
  }
}

export async function resolveScChange(sc: Sc, change: ScChange): Promise<ScResolved> {
  const base = { change, service: "search_console" as const }, site = change.site_url;
  switch (change.type) {
    case "submit_sitemap":
    case "delete_sitemap": {
      if (!inProperty(site, change.sitemap_url)) throw new Error(`${change.sitemap_url} isn't inside property ${site}.`);
      await requireEditor(sc, site);
      const have = (await sc.sitemaps(site)).some((m) => m.path === change.sitemap_url);
      const op: ScOp = { method: change.type === "submit_sitemap" ? "PUT" : "DELETE", site, sitemap: change.sitemap_url };
      if (change.type === "submit_sitemap") {
        return { ...base, operations: [op],
          describe: `${have ? "Resubmit" : "Submit"} sitemap ${change.sitemap_url} to Search Console for ${site}${have ? ", so Google reads it again" : ""}`,
          inverse: have ? undefined : { type: "delete_sitemap", site_url: site, sitemap_url: change.sitemap_url } };
      }
      return { ...base, operations: have ? [op] : [],
        describe: `Remove sitemap ${change.sitemap_url} from Search Console for ${site}` + (have ? ". Google can keep crawling it, and its pages stay indexed" : " (not submitted)"),
        inverse: have ? { type: "submit_sitemap", site_url: site, sitemap_url: change.sitemap_url } : undefined };
    }
    case "add_site": {
      if (site === DEMO_SITE) throw new Error("The demo site can't be added or removed; its sitemaps can be changed.");
      const have = (await sc.sites()).some((x) => x.siteUrl === site);
      return { ...base, operations: have ? [] : [{ method: "PUT", site }],
        describe: `Add ${site} to this Google login's Search Console` + (have ? " (already there)" : ". Unless this login already owns the domain, it stays unverified, with no data, until ownership is verified in Search Console"),
        inverse: have ? undefined : { type: "remove_site", site_url: site } };
    }
    case "remove_site": {
      if (site === DEMO_SITE) throw new Error("The demo site can't be added or removed; its sitemaps can be changed.");
      const p = (await sc.sites()).find((x) => x.siteUrl === site);
      if (!p) return { ...base, operations: [], describe: `Remove ${site} from this Google login's Search Console (not there)` };
      return { ...base, operations: [{ method: "DELETE", site }],
        describe: `Remove ${site} from this Google login's Search Console` + (p.permissionLevel === "siteUnverifiedUser" ? " (unverified, so nothing is lost)"
          : " ⚠ this login loses access to the property and its data, and undo can't restore it: getting it back means adding and verifying the property again") };
    }
  }
}

/** Run one resolved change's writes, in order. */
export async function writeSc(sc: Pick<Sc, "change">, ops: ScOp[]): Promise<void> {
  for (const op of ops) await sc.change(op.method, op.site, op.sitemap);
}

/** What the user should do or expect next: Google answers these writes at once but acts on them later. */
export function scNoteAfterApply(r: ScResolved): string | undefined {
  if (r.change.type === "add_site") return `Search Console has ${r.change.site_url}. If this login already owns the domain, Google verifies it at once and it's in search_console_sites. `
    + "If it isn't listed there, it has no data until ownership is verified, which Camberstack can't do: the user verifies it in Search Console "
    + "(a DNS record for a domain property; a file, tag or Google Analytics for a URL prefix).";
  if (r.change.type === "submit_sitemap") return "Google reads it on its own schedule, sometimes within seconds: search_console_sitemaps shows the last download and any errors.";
  return undefined;
}
