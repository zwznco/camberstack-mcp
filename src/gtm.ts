/**
 * Google Tag Manager: which tags a site's container runs, and what's wrong with its conversion tracking (a Google Ads
 * conversion tag with no Conversion Linker, one firing on every page, a tag that never fires, retired Universal
 * Analytics). Changes go through gtm-changes.ts, written to the container's workspace and made live by publishing.
 *
 * Its scopes are asked for on first use, by a personal /connect/tag-manager link (grant.ts), not at sign-in: they're
 * sensitive, and most users never need them. The demo container (DEMO_CONTAINER) answers with sample data.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { NotGrantedError, googleMessage, scopeMissing } from "./google.js";

const API = "https://tagmanager.googleapis.com/tagmanager/v2";
export const DEMO_GTM_ACCOUNT = "accounts/000000001";
export const DEMO_CONTAINER = `${DEMO_GTM_ACCOUNT}/containers/000000001`;
const DEMO_NOTE = "Sample data from Camberstack's demo Tag Manager container (a fictional plumbing business), not a real container.";
/** GTM's built-in All Pages trigger: every page view. */
export const ALL_PAGES = "2147479553";
const BUILT_IN_TRIGGERS: Record<string, string> = { [ALL_PAGES]: "All Pages", "2147479572": "Consent Initialization - All Pages", "2147479573": "Initialization - All Pages" };

/** A container's path as the API names it, and as the tools take it. */
export const CONTAINER_PATH = /^accounts\/\d+\/containers\/\d+$/;
export const ACCOUNT_PATH = /^accounts\/\d+$/;

/** One call to the Tag Manager API by path under v2, e.g. GET accounts/1/containers. */
export type TagManager = { call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object): Promise<any> };

export class GtmClient implements TagManager {
  constructor(private accessToken: () => Promise<string>, private grantLink: () => string | null, private f: typeof fetch = fetch) {}

  async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object): Promise<any> {
    const res = await this.f(`${API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      if (scopeMissing(res.status, text)) throw new NotGrantedError("tag-manager", this.grantLink(), method !== "GET");
      throw new Error(`Tag Manager API ${res.status}: ${googleMessage(text)}`);
    }
    return text ? JSON.parse(text) : {};
  }
}

/** Every page of a list call: GTM pages with nextPageToken. */
export async function listAll(tm: TagManager, path: string, key: string): Promise<any[]> {
  const out: any[] = [];
  let token: string | undefined;
  do {
    const r = await tm.call("GET", token ? `${path}${path.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(token)}` : path);
    out.push(...(r[key] ?? []));
    token = r.nextPageToken;
  } while (token);
  return out;
}

/**
 * The workspace Camberstack writes to: Default Workspace, else the oldest. A container always has at least one; a
 * user's own unpublished edits there go live with ours when publishing, which publish_container's summary lists.
 */
export async function workspaceOf(tm: TagManager, container: string): Promise<{ path: string; name: string }> {
  const ws = await listAll(tm, `${container}/workspaces`, "workspace");
  const w = ws.find((x) => x.name === "Default Workspace") ?? ws.sort((a, b) => Number(a.workspaceId) - Number(b.workspaceId))[0];
  if (!w) throw new Error(`Container ${container} has no workspace Camberstack can write to.`);
  return { path: w.path, name: w.name };
}

export const TAG_TYPES: Record<string, string> = {
  googtag: "Google tag", gaawe: "GA4 event", awct: "Google Ads conversion", gclidw: "Conversion Linker", sp: "Google Ads remarketing",
  awud: "Google Ads user-provided data", dest_mc: "Merchant Center destination", html: "Custom HTML", img: "Custom image", ua: "Universal Analytics (retired)", flc: "Floodlight counter", fls: "Floodlight sales",
};
const typeLabel = (t: string) => TAG_TYPES[t] ?? (t.startsWith("cvt_") ? "Community template" : t);
export const param = (tag: any, key: string): string | undefined => (tag.parameter ?? []).find((p: any) => p.key === key)?.value;

export async function listContainers(tm: TagManager) {
  const demo = { account: "Northwind Plumbing (sample data)", account_id: DEMO_GTM_ACCOUNT,
    containers: (await listAll(tm, `${DEMO_GTM_ACCOUNT}/containers`, "container").catch(() => [{ path: DEMO_CONTAINER, name: "northwind-plumbing.example", publicId: "GTM-DEMO01" }]))
      .map((c) => ({ container: c.path, name: c.name, public_id: c.publicId })) };
  try {
    // includeGoogleTags: an account made for a Google tag (Shopify's Google app makes one) is left out without it.
    const accounts = await listAll(tm, "accounts?includeGoogleTags=true", "account");
    const out = await Promise.all(accounts.map(async (a) => ({
      account: a.name, account_id: a.path,
      containers: (await listAll(tm, `${a.path}/containers`, "container"))
        .filter((c) => (c.usageContext ?? ["web"]).includes("web"))
        .map((c) => ({ container: c.path, name: c.name, public_id: c.publicId })),
    })));
    if (out.some((a) => a.containers.length)) return { accounts: out };
    if (out.length) return { accounts: [...out, demo], note: "This Google login's Tag Manager account has no web container yet: create_container makes one (in account_id). The demo container (sample data) is offered too. Say so plainly." };
    return { accounts: [demo], note: "This Google login has no web Tag Manager container, so only the demo container (sample data) is offered. Say so plainly." };
  } catch (e) {
    if (!(e instanceof NotGrantedError)) throw e;
    return { accounts: [demo], not_granted: e.message, ...(e.link ? { grant_url: e.link } : {}),
      note: "Only the demo container is available until the user adds Tag Manager. Say so plainly and give them grant_url." };
  }
}

/** One tag as the tools show it: what it is, what it sends where, and when it fires. */
function tagView(t: any, triggerName: (id: string) => string) {
  const ids: Record<string, string | undefined> = {
    googtag: param(t, "tagId"), gaawe: param(t, "measurementIdOverride") ?? param(t, "measurementId"),
    awct: param(t, "conversionId") && `AW-${param(t, "conversionId")}/${param(t, "conversionLabel") ?? ""}`, sp: param(t, "conversionId") && `AW-${param(t, "conversionId")}`,
  };
  return {
    tag_id: t.tagId, name: t.name, type: typeLabel(t.type),
    ...(ids[t.type] ? { sends_to: ids[t.type] } : {}),
    ...(t.type === "gaawe" && param(t, "eventName") ? { event: param(t, "eventName") } : {}),
    fires_on: (t.firingTriggerId ?? []).map(triggerName),
    ...(t.paused ? { paused: true } : {}),
  };
}

/** A trigger in words: All Pages, a page whose URL contains /thank-you, the custom event generate_lead. */
export function triggerView(tr: any): string {
  const arg = (f: any, k: string) => (f.parameter ?? []).find((p: any) => p.key === k)?.value;
  const conds = [...(tr.customEventFilter ?? []), ...(tr.filter ?? [])].map((f: any) => `${arg(f, "arg0")} ${f.type} "${arg(f, "arg1")}"`);
  const kind = ({ pageview: "Page view", customEvent: "Custom event", click: "All clicks", linkClick: "Link click", formSubmission: "Form submission",
    domReady: "DOM ready", windowLoaded: "Window loaded", historyChange: "History change", elementVisibility: "Element visibility" } as Record<string, string>)[tr.type] ?? tr.type;
  return `${tr.name} (${kind}${conds.length ? `: ${conds.join(" and ")}` : ""})`;
}

/**
 * tag_manager_setup: the container's tags and triggers as the workspace has them, what's not published yet, and the
 * tracking problems worth fixing, each with the change that fixes it. Read-only.
 */
export async function tagManagerSetup(tm: TagManager, container: string) {
  const ws = await workspaceOf(tm, container);
  const [tags, triggers, status, live] = await Promise.all([
    listAll(tm, `${ws.path}/tags`, "tag"), listAll(tm, `${ws.path}/triggers`, "trigger"),
    tm.call("GET", `${ws.path}/status`),
    tm.call("GET", `${container}/versions:live`).catch(() => null),
  ]);
  const byId = new Map(triggers.map((t) => [t.triggerId, t]));
  const triggerName = (id: string) => BUILT_IN_TRIGGERS[id] ?? (byId.has(id) ? triggerView(byId.get(id)) : `trigger ${id}`);
  const active = tags.filter((t) => !t.paused);
  const issues: { problem: string; fix: string }[] = [];
  const conv = active.filter((t) => t.type === "awct");
  if (conv.length && !active.some((t) => t.type === "gclidw")) {
    issues.push({ problem: `${conv.length} Google Ads conversion tag${conv.length > 1 ? "s" : ""} but no Conversion Linker, so conversions from Safari and Firefox, which block third-party cookies, go uncounted`,
      fix: "add_conversion_linker, then publish_container" });
  }
  for (const t of conv) if ((t.firingTriggerId ?? []).includes(ALL_PAGES)) {
    issues.push({ problem: `Google Ads conversion tag "${t.name}" fires on All Pages, so every page view counts as a conversion and Smart Bidding chases visits`,
      fix: "add a conversion tag that fires on the thank-you page or the lead event, then pause or delete this one" });
  }
  for (const t of active) if (!(t.firingTriggerId ?? []).length && !t.setupTag?.length && !t.teardownTag?.length) {
    issues.push({ problem: `Tag "${t.name}" has no trigger, so it never fires`, fix: "give it a trigger in Tag Manager, or delete_tag" });
  }
  for (const t of active) if (t.type === "ua") {
    issues.push({ problem: `Tag "${t.name}" is Universal Analytics, which Google stopped processing in 2024: it sends data nowhere`, fix: "delete_tag (GA4 uses a Google tag)" });
  }
  if (!active.some((t) => t.type === "googtag" || t.type === "gaawe")) {
    issues.push({ problem: "No Google tag: GA4 gets nothing from this container (the site may load it some other way)", fix: "add_google_tag with the GA4 measurement ID from analytics_setup" });
  }
  if (!live) issues.push({ problem: "This container has never been published, so none of its tags run on the site", fix: "publish_container" });
  const changes = (status.workspaceChange ?? []) as any[];
  return {
    container, workspace: ws.name,
    ...(container === DEMO_CONTAINER ? { note: DEMO_NOTE } : {}),
    live_version: live ? { version_id: live.containerVersionId, name: live.name || undefined } : null,
    tags: tags.map((t) => tagView(t, triggerName)),
    triggers: triggers.map((t) => ({ trigger_id: t.triggerId, trigger: triggerView(t) })),
    unpublished_changes: changes.map((c) => {
      const e = c.tag ?? c.trigger ?? c.variable ?? c.folder ?? c.client ?? c.transformation ?? {};
      return `${String(c.changeStatus ?? "changed").replace(/^(added|deleted|updated)$/, "$1")}: ${c.tag ? "tag" : c.trigger ? "trigger" : c.variable ? "variable" : "item"} "${e.name ?? "?"}"`;
    }),
    issues,
    how_to_use: "Workspace changes don't reach the site until publish_container makes them live. To check a conversion tag against Google Ads, "
      + "compare its sends_to with the account's conversion actions (run_gaql: SELECT conversion_action.name, conversion_action.tag_snippets FROM conversion_action).",
  };
}

/** Sends the demo container's calls to the demo, everything else to Google. */
export function routedTagManager(google: TagManager, demo: TagManager): TagManager {
  return {
    call: (method, path, body) => (path.startsWith(`${DEMO_GTM_ACCOUNT}/`) || path === DEMO_GTM_ACCOUNT ? demo.call(method, path, body) : google.call(method, path, body)),
  };
}

// ---------------------------------------------------------------- the demo container

interface DemoGtmState {
  nextId: number;
  /** The workspace's id: like GTM, publishing replaces the workspace with a new one, and the tags' paths move with it. */
  ws?: number;
  version: number;
  tags: any[];
  triggers: any[];
  /** The last published tags and triggers, to tell what's unpublished. */
  live: { id: string; tags: any[]; triggers: any[] } | null;
  versions: Record<string, { tags: any[]; triggers: any[] }>;
  /** Containers created in the demo account: listed and deletable, but empty and not editable. */
  created?: { path: string; name: string; publicId: string }[];
}

const P = (k: string, v: string) => ({ type: "template", key: k, value: v });
function freshGtm(): DemoGtmState {
  const ws = `${DEMO_CONTAINER}/workspaces/1`;
  const triggers = [
    { triggerId: "11", name: "Lead form sent", type: "customEvent", path: `${ws}/triggers/11`,
      customEventFilter: [{ type: "equals", parameter: [P("arg0", "{{_event}}"), P("arg1", "generate_lead")] }] },
    { triggerId: "12", name: "Thank-you page", type: "pageview", path: `${ws}/triggers/12`,
      filter: [{ type: "contains", parameter: [P("arg0", "{{Page URL}}"), P("arg1", "/thank-you")] }] },
  ];
  const tags = [
    { tagId: "21", name: "Google tag", type: "googtag", parameter: [P("tagId", "G-NW0000DEMO")], firingTriggerId: [ALL_PAGES], path: `${ws}/tags/21` },
    { tagId: "22", name: "Ads - Lead form", type: "awct", parameter: [P("conversionId", "100000001"), P("conversionLabel", "DemoLeadAbc")], firingTriggerId: ["11"], path: `${ws}/tags/22` },
    { tagId: "23", name: "Ads - Call clicks", type: "awct", parameter: [P("conversionId", "100000001"), P("conversionLabel", "DemoCallXyz")], firingTriggerId: [ALL_PAGES], path: `${ws}/tags/23` },
    { tagId: "24", name: "UA - pageviews (old)", type: "ua", parameter: [P("trackingId", "UA-0000000-1")], firingTriggerId: [ALL_PAGES], path: `${ws}/tags/24` },
  ];
  const snap = { tags: structuredClone(tags), triggers: structuredClone(triggers) };
  return { nextId: 100, version: 7, tags, triggers, live: { id: "7", ...snap }, versions: { "7": structuredClone(snap) } };
}

export class DemoTagManager implements TagManager {
  /** Without a db (tests, the tool catalog), changes last as long as this object. */
  private mem?: DemoGtmState;
  constructor(private db?: DB, private userId?: string) {}

  private load(): DemoGtmState {
    if (!this.db || !this.userId) return (this.mem ??= freshGtm());
    const row = this.db.prepare("SELECT state FROM demo_gtm_state WHERE user_id = ?").get(this.userId) as { state: string } | undefined;
    return row ? JSON.parse(row.state) as DemoGtmState : freshGtm();
  }
  private save(s: DemoGtmState): void {
    if (!this.db || !this.userId) { this.mem = s; return; }
    this.db.prepare(`INSERT INTO demo_gtm_state (user_id, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(this.userId, JSON.stringify(s), now());
  }

  async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: any): Promise<any> {
    const s = this.load(), ws = `${DEMO_CONTAINER}/workspaces/${s.ws ?? 1}`;
    const strip = (x: any) => JSON.stringify({ ...x, path: undefined });
    const main = { path: DEMO_CONTAINER, name: "northwind-plumbing.example", publicId: "GTM-DEMO01" };
    const created = s.created ?? [];
    if (path === `${DEMO_GTM_ACCOUNT}/containers` && method === "GET") return { container: [main, ...created] };
    if (path === `${DEMO_GTM_ACCOUNT}/containers` && method === "POST") {
      const id = String(s.nextId++), c = { path: `${DEMO_GTM_ACCOUNT}/containers/${id}`, name: String(body?.name), publicId: `GTM-DEMO${id}` };
      s.created = [...created, c];
      this.save(s);
      return c;
    }
    const mine = created.find((c) => c.path === path);
    if (mine && method === "GET") return mine;
    if (mine && method === "DELETE") { s.created = created.filter((c) => c !== mine); this.save(s); return {}; }
    if (path === DEMO_CONTAINER && method === "GET") return main;
    if (path === DEMO_CONTAINER && method === "DELETE") throw new Error("The demo container can't be deleted (it's sample data); a container created in the demo can.");
    if (created.some((c) => path.startsWith(`${c.path}/`))) {
      if (method === "GET" && path.endsWith("/versions:live")) throw new Error("Tag Manager API 404: Not found");
      throw new Error("Tag Manager API 400: a container created in the demo stays empty; try tag changes on the demo container itself.");
    }
    if (method === "GET") {
      if (path === `${DEMO_CONTAINER}/workspaces`) return { workspace: [{ workspaceId: String(s.ws ?? 1), name: "Default Workspace", path: ws }] };
      if (path === `${ws}/tags`) return { tag: s.tags };
      if (path === `${ws}/triggers`) return { trigger: s.triggers };
      if (path === `${DEMO_CONTAINER}/versions:live`) {
        if (!s.live) throw new Error("Tag Manager API 404: Not found");
        return { containerVersionId: s.live.id, path: `${DEMO_CONTAINER}/versions/${s.live.id}`, tag: s.live.tags, trigger: s.live.triggers };
      }
      if (path === `${ws}/status`) {
        const diff = (kind: "tag" | "trigger", cur: any[], was: any[], id: string) => [
          ...cur.filter((x) => !was.some((y) => y[id] === x[id])).map((x) => ({ [kind]: x, changeStatus: "added" })),
          ...was.filter((y) => !cur.some((x) => x[id] === y[id])).map((y) => ({ [kind]: y, changeStatus: "deleted" })),
          ...cur.filter((x) => was.some((y) => y[id] === x[id] && strip(y) !== strip(x))).map((x) => ({ [kind]: x, changeStatus: "updated" })),
        ];
        const live = s.live ?? { tags: [], triggers: [] };
        return { workspaceChange: [...diff("tag", s.tags, live.tags, "tagId"), ...diff("trigger", s.triggers, live.triggers, "triggerId")] };
      }
      const t = s.tags.find((x) => x.path === path) ?? s.triggers.find((x) => x.path === path);
      if (t) return t;
      throw new Error(`Tag Manager API 404: ${path} not found`);
    }
    if (method === "POST" && (path === `${ws}/tags` || path === `${ws}/triggers`)) {
      const id = String(s.nextId++), tag = path.endsWith("/tags");
      const x = { ...body, ...(tag ? { tagId: id } : { triggerId: id }), path: `${path}/${id}` };
      (tag ? s.tags : s.triggers).push(x);
      this.save(s);
      return x;
    }
    if (method === "PUT") {
      const i = s.tags.findIndex((x) => x.path === path);
      if (i < 0) throw new Error(`Tag Manager API 404: ${path} not found`);
      s.tags[i] = { ...body, tagId: s.tags[i].tagId, path };
      this.save(s);
      return s.tags[i];
    }
    if (method === "DELETE") {
      const before = s.tags.length + s.triggers.length;
      s.tags = s.tags.filter((x) => x.path !== path);
      s.triggers = s.triggers.filter((x) => x.path !== path);
      if (s.tags.length + s.triggers.length === before) throw new Error(`Tag Manager API 404: ${path} not found`);
      this.save(s);
      return {};
    }
    if (method === "POST" && path === `${ws}:create_version`) {
      const id = String(++s.version);
      s.versions[id] = { tags: structuredClone(s.tags), triggers: structuredClone(s.triggers) };
      s.ws = (s.ws ?? 1) + 1;
      const moved = (x: any) => ({ ...x, path: x.path.replace(/\/workspaces\/\d+\//, `/workspaces/${s.ws}/`) });
      s.tags = s.tags.map(moved);
      s.triggers = s.triggers.map(moved);
      this.save(s);
      return { containerVersion: { containerVersionId: id, path: `${DEMO_CONTAINER}/versions/${id}`, name: body?.name } };
    }
    const pub = /^accounts\/000000001\/containers\/000000001\/versions\/(\d+):publish$/.exec(path);
    if (method === "POST" && pub) {
      const v = s.versions[pub[1]!];
      if (!v) throw new Error(`Tag Manager API 404: version ${pub[1]} not found`);
      s.live = { id: pub[1]!, ...structuredClone(v) };
      // Publishing an older version doesn't touch the workspace in GTM either: the workspace stays as edited.
      this.save(s);
      return { containerVersion: { containerVersionId: pub[1] } };
    }
    throw new Error(`Tag Manager API 400: the demo container doesn't support ${method} ${path}`);
  }
}
