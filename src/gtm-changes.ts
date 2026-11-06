/**
 * Tag Manager changes: create or delete a web container; add a Google tag, a Google Ads conversion tag, a GA4 event tag
 * or a Conversion Linker; pause, unpause or delete a tag; publish the workspace. The same propose → approve → apply → undo cycle as Google Ads changes
 * (session.ts), stored as proposals whose customer_id is GTM_TARGET. GTM has no dry run: each change resolves against
 * the live workspace at propose and again at apply.
 *
 * Tag changes land in the container's workspace (gtm.ts workspaceOf) and reach the site only when publish_container
 * makes a version and publishes it. Undoing a publish re-publishes the version that was live before.
 */
import { z } from "zod";
import { ACCOUNT_PATH, ALL_PAGES, CONTAINER_PATH, TAG_TYPES, listAll, param, triggerView, workspaceOf, type TagManager } from "./gtm.js";

/** proposals.customer_id for Tag Manager proposals. */
export const GTM_TARGET = "gtm";

const container = z.string().regex(CONTAINER_PATH, "accounts/<id>/containers/<id>").describe("From tag_manager_containers");
const tagId = z.string().regex(/^\d+$/, "digits only").describe("From tag_manager_setup");
const firesOn = z.object({
  kind: z.enum(["all_pages", "page_url_contains", "custom_event", "trigger_id"])
    .describe("custom_event is a dataLayer event; trigger_id an existing trigger"),
  value: z.string().min(1).max(200).optional().describe("URL text (/thank-you), event name or trigger_id"),
}).refine((f) => f.kind === "all_pages" || !!f.value, "value is required unless kind is all_pages").describe("When the tag fires");
type FiresOn = z.infer<typeof firesOn>;

export const PUBLIC_GTM_CHANGES = [
  z.object({ type: z.literal("create_container"),
    account: z.string().regex(ACCOUNT_PATH, "accounts/<id>").describe("account_id from tag_manager_containers"),
    name: z.string().min(1).max(100).describe("Usually the site's domain"),
    domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "a domain like example.com").optional() })
    .describe("Create an empty web container; its install snippet comes after applying. Undo deletes it"),
  z.object({ type: z.literal("delete_container"), container })
    .describe("Delete a container and everything in it; Google can't restore it"),
  z.object({ type: z.literal("add_google_tag"), container,
    tag_id: z.string().regex(/^(G|AW|GT|DC)-[A-Z0-9]{4,20}$/, "a Google tag ID, e.g. G-ABC123 or AW-123456789").describe("GA4 measurement ID (G-…) or Google Ads tag ID (AW-…)") })
    .describe("Add a Google tag that loads GA4 or Google Ads on every page"),
  z.object({ type: z.literal("add_ads_conversion_tag"), container, name: z.string().min(1).max(100).describe("Tag name"),
    conversion_id: z.string().regex(/^(AW-)?\d+$/).transform((s) => s.replace(/^AW-/, "")).describe("AW-123456789 or its digits, from the conversion action's tag_snippets"),
    conversion_label: z.string().regex(/^[\w-]{4,60}$/).describe("The <label> in send_to AW-123456789/<label>"),
    fires_on: firesOn })
    .describe("Add a Google Ads conversion tracking tag that fires on the conversion (a thank-you page or a lead event), never on every page"),
  z.object({ type: z.literal("add_ga4_event_tag"), container, name: z.string().min(1).max(100).describe("Tag name"),
    measurement_id: z.string().regex(/^G-[A-Z0-9]{4,20}$/).describe("G-…"),
    event_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).describe("e.g. generate_lead"),
    fires_on: firesOn })
    .describe("Add a GA4 event tag, e.g. to send generate_lead when a form is sent; mark it as a key event with propose_analytics_changes"),
  z.object({ type: z.literal("add_conversion_linker"), container })
    .describe("Add a Conversion Linker on every page, so Google Ads conversions from Safari and Firefox are counted"),
  z.object({ type: z.literal("pause_tag"), container, tag_id: tagId }).describe("Pause a tag so it stops firing (after publishing)"),
  z.object({ type: z.literal("unpause_tag"), container, tag_id: tagId }).describe("Unpause a paused tag"),
  z.object({ type: z.literal("delete_tag"), container, tag_id: tagId }).describe("Delete a tag from the workspace (after publishing, it's gone from the site)"),
  z.object({ type: z.literal("publish_container"), container,
    version_name: z.string().min(1).max(100).optional().describe("Version name") })
    .describe("Publish the workspace: every unpublished change in it goes live on the site, including any made in Tag Manager itself. Undo re-publishes the previous version"),
] as const;

export const PublicGtmChangeSchema = z.discriminatedUnion("type", [...PUBLIC_GTM_CHANGES]);
export const GtmChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_GTM_CHANGES,
  // Only undo creates these: remove what an add created (the tag, and a trigger made for it), put back a deleted tag,
  // and re-publish the version that was live before a publish.
  z.object({ type: z.literal("remove_added_tag"), container, tag_path: z.string(), trigger_path: z.string().optional(), name: z.string() }),
  z.object({ type: z.literal("restore_tag"), container, tag: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("publish_version"), container, version_id: z.string().regex(/^\d+$/), name: z.string() }),
]);
export type GtmChange = z.infer<typeof GtmChangeSchema>;

export interface GtmOp {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: any;
  /** add_*: a trigger to create first; the tag fires on it. */
  trigger?: any;
  /** publish_container: make a version of the workspace, then publish it. */
  publish?: { name: string };
}
export interface GtmResolved {
  change: GtmChange;
  service: "gtm";
  operations: GtmOp[];
  describe: string;
  /** Known before applying (pause, delete, publish); an add's comes from what Google returns (gtmInverseAfterApply). */
  inverse?: GtmChange;
}
export interface GtmWriteResult { tagPath?: string; triggerPath?: string; versionId?: string; containerPath?: string; publicId?: string }

const tmpl = (key: string, value: string) => ({ type: "template", key, value });
const bool = (key: string, value: boolean) => ({ type: "boolean", key, value: String(value) });

/** The trigger a tag should fire on: an existing one that already matches, or one to create. */
function resolveTrigger(f: FiresOn, triggers: any[]): { id?: string; create?: any; describe: string } {
  if (f.kind === "all_pages") return { id: ALL_PAGES, describe: "on every page" };
  if (f.kind === "trigger_id") {
    const t = triggers.find((x) => x.triggerId === f.value);
    if (!t) throw new Error(`Trigger ${f.value} isn't in this container (tag_manager_setup lists its triggers).`);
    return { id: t.triggerId, describe: `on ${triggerView(t)}` };
  }
  const arg = (x: any, k: string) => (x.parameter ?? []).find((p: any) => p.key === k)?.value;
  const value = f.value!;
  if (f.kind === "page_url_contains") {
    const same = triggers.find((t) => t.type === "pageview" && (t.filter ?? []).length === 1 && t.filter[0].type === "contains"
      && arg(t.filter[0], "arg0") === "{{Page URL}}" && arg(t.filter[0], "arg1") === value);
    if (same) return { id: same.triggerId, describe: `on ${triggerView(same)}` };
    return { create: { name: `Page URL contains ${value}`, type: "pageview",
      filter: [{ type: "contains", parameter: [tmpl("arg0", "{{Page URL}}"), tmpl("arg1", value)] }] },
      describe: `on pages whose URL contains "${value}" (a new trigger)` };
  }
  const same = triggers.find((t) => t.type === "customEvent" && (t.customEventFilter ?? []).some((c: any) => arg(c, "arg1") === value));
  if (same) return { id: same.triggerId, describe: `on ${triggerView(same)}` };
  return { create: { name: `Event ${value}`, type: "customEvent",
    customEventFilter: [{ type: "equals", parameter: [tmpl("arg0", "{{_event}}"), tmpl("arg1", value)] }] },
    describe: `on the dataLayer event "${value}" (a new trigger; the site must push it)` };
}

export async function resolveGtmChange(tm: TagManager, change: GtmChange): Promise<GtmResolved> {
  const base = { change, service: "gtm" as const };
  if (change.type === "create_container") {
    const have = (await listAll(tm, `${change.account}/containers`, "container")).find((c) => c.name === change.name);
    if (have) return { ...base, operations: [], describe: `Create container "${change.name}" (already there: ${have.publicId}, ${have.path})` };
    return { ...base, operations: [{ method: "POST", path: `${change.account}/containers`,
      body: { name: change.name, usageContext: ["web"], ...(change.domain ? { domainName: [change.domain] } : {}) } }],
      describe: `Create an empty web container "${change.name}" in ${change.account}. Its tags run only once the site has its snippet (given after creating) and it's published` };
  }
  if (change.type === "delete_container") {
    const c = await tm.call("GET", change.container);
    if (!String(c.publicId ?? "").startsWith("GTM-"))
      throw new Error(`${c.publicId} is a Google tag, not a Tag Manager container: deleting it would stop that tag's measurement. Camberstack only deletes GTM- containers.`);
    const live = await tm.call("GET", `${change.container}/versions:live`).catch(() => null);
    return { ...base, operations: [{ method: "DELETE", path: change.container }],
      describe: `Delete container "${c.name}" (${c.publicId}) with all its tags, triggers and versions`
        + (live ? `. Its published version ${live.containerVersionId} stops running on any site that loads ${c.publicId}` : "")
        + " ⚠ Google can't restore a deleted container, so undo can't bring it back" };
  }
  const ws = await workspaceOf(tm, change.container);
  const [tags, triggers] = await Promise.all([listAll(tm, `${ws.path}/tags`, "tag"), listAll(tm, `${ws.path}/triggers`, "trigger")]);
  const tagById = (id: string) => {
    const t = tags.find((x) => x.tagId === id);
    if (!t) throw new Error(`Tag ${id} isn't in ${change.container}'s workspace (tag_manager_setup lists its tags).`);
    return t;
  };
  const add = (tag: any, f: FiresOn | null, describe: string): GtmResolved => {
    const trig = f ? resolveTrigger(f, triggers) : { id: ALL_PAGES, describe: "on every page" };
    return { ...base,
      operations: [{ method: "POST", path: `${ws.path}/tags`, body: { ...tag, ...(trig.id ? { firingTriggerId: [trig.id] } : {}) }, ...(trig.create ? { trigger: trig.create } : {}) }],
      describe: `${describe}, firing ${trig.describe}${(change as { published_after?: boolean }).published_after ? "" : ". In the workspace until publish_container makes it live"}` };
  };
  switch (change.type) {
    case "add_google_tag": {
      // Tag Manager adds its own destination (dest_ga / dest_aw, named after the ID) once a tag sends to that ID, and a
      // Google tag for the same ID next to it fails to publish (a compiler error, seen 2026-11-06).
      const have = tags.find((t) => (t.type === "googtag" && param(t, "tagId") === change.tag_id)
        || (/^dest_/.test(t.type) && (param(t, "tagId") === change.tag_id || String(t.name ?? "").endsWith(change.tag_id))));
      if (have) return { ...base, operations: [], describe: `Add a Google tag for ${change.tag_id} (already there: "${have.name}")` };
      return add({ name: `Google tag ${change.tag_id}`, type: "googtag", parameter: [tmpl("tagId", change.tag_id)] }, null,
        `Add a Google tag for ${change.tag_id} to ${change.container}`);
    }
    case "add_ads_conversion_tag": {
      const have = tags.find((t) => t.type === "awct" && param(t, "conversionId") === change.conversion_id && param(t, "conversionLabel") === change.conversion_label);
      if (have) return { ...base, operations: [], describe: `Add Google Ads conversion tag "${change.name}" (already there: "${have.name}", tag ${have.tagId})` };
      if (change.fires_on.kind === "all_pages") throw new Error("A conversion tag on every page counts each page view as a conversion. Fire it on the thank-you page or the lead event instead.");
      const linker = tags.some((t) => t.type === "gclidw" && !t.paused);
      const r = add({ name: change.name, type: "awct", parameter: [tmpl("conversionId", change.conversion_id), tmpl("conversionLabel", change.conversion_label), bool("enableConversionLinker", true)] },
        change.fires_on, `Add Google Ads conversion tag "${change.name}" (AW-${change.conversion_id}/${change.conversion_label})`);
      return linker ? r : { ...r, describe: `${r.describe}. The container has no Conversion Linker: add_conversion_linker too` };
    }
    case "add_ga4_event_tag": {
      const have = tags.find((t) => t.type === "gaawe" && param(t, "eventName") === change.event_name && (param(t, "measurementIdOverride") ?? param(t, "measurementId")) === change.measurement_id);
      if (have) return { ...base, operations: [], describe: `Add GA4 event tag "${change.name}" (already there: "${have.name}", tag ${have.tagId})` };
      return add({ name: change.name, type: "gaawe", parameter: [tmpl("eventName", change.event_name), tmpl("measurementIdOverride", change.measurement_id)] },
        change.fires_on, `Add GA4 event tag "${change.name}" sending ${change.event_name} to ${change.measurement_id}`);
    }
    case "add_conversion_linker": {
      const have = tags.find((t) => t.type === "gclidw");
      if (have && !have.paused) return { ...base, operations: [], describe: `Add a Conversion Linker (already there: "${have.name}")` };
      if (have) throw new Error(`The Conversion Linker "${have.name}" (tag ${have.tagId}) is paused: unpause_tag it instead.`);
      return add({ name: "Conversion Linker", type: "gclidw", parameter: [] }, null, `Add a Conversion Linker to ${change.container}`);
    }
    case "pause_tag":
    case "unpause_tag": {
      const t = tagById(change.tag_id), pause = change.type === "pause_tag";
      const label = `${TAG_TYPES[t.type] ?? t.type} tag "${t.name}"`;
      if (!!t.paused === pause) return { ...base, operations: [], describe: `${pause ? "Pause" : "Unpause"} ${label} (already ${pause ? "paused" : "running"})` };
      const { path, ...rest } = t;
      return { ...base, operations: [{ method: "PUT", path, body: { ...rest, paused: pause } }],
        describe: `${pause ? "Pause" : "Unpause"} ${label}${(change as { published_after?: boolean }).published_after ? "" : ". In the workspace until publish_container makes it live"}`
          + (pause && t.type === "awct" ? " ⚠ Google Ads stops receiving this conversion once published" : ""),
        inverse: { type: pause ? "unpause_tag" : "pause_tag", container: change.container, tag_id: change.tag_id } };
    }
    case "delete_tag": {
      const t = tagById(change.tag_id);
      const { path, tagId: _, fingerprint: __, ...rest } = t;
      return { ...base, operations: [{ method: "DELETE", path }],
        describe: `Delete ${TAG_TYPES[t.type] ?? t.type} tag "${t.name}" from the workspace. Gone from the site once published`
          + (t.type === "awct" && !t.paused ? " ⚠ Google Ads stops receiving this conversion" : "") + ". Undo adds it back as a new tag",
        inverse: { type: "restore_tag", container: change.container, tag: rest } };
    }
    case "publish_container": {
      const status = await tm.call("GET", `${ws.path}/status`);
      const changes = (status.workspaceChange ?? []) as any[];
      if (status.mergeConflict?.length) throw new Error(`The workspace has merge conflicts; resolve them in Tag Manager first.`);
      const live = await tm.call("GET", `${change.container}/versions:live`).catch(() => null);
      const withChanges = (change as { with_changes?: boolean }).with_changes === true;
      if (!changes.length && live && !withChanges) return { ...base, operations: [], describe: `Publish ${change.container} (nothing unpublished)` };
      const list = [...(withChanges ? ["the changes above"] : []), ...changes.map((c) => `${c.changeStatus ?? "changed"} ${c.tag ? "tag" : c.trigger ? "trigger" : c.variable ? "variable" : "item"} "${(c.tag ?? c.trigger ?? c.variable ?? {}).name ?? "?"}"`)];
      const name = change.version_name ?? `Published by Camberstack`;
      return { ...base, operations: [{ method: "POST", path: `${ws.path}:create_version`, publish: { name } }],
        describe: `Publish ${change.container} as version "${name}": ${list.length ? list.join("; ") : "the whole workspace"} ⚠ these go live on the site at once, `
          + "including any change made in Tag Manager itself" + (live ? `. Undo re-publishes version ${live.containerVersionId}` : ". It has never been published, so undo can't take it back off the site"),
        inverse: live ? { type: "publish_version", container: change.container, version_id: live.containerVersionId, name: live.name || `version ${live.containerVersionId}` } : undefined };
    }
    case "remove_added_tag": {
      // Publishing replaces the workspace with a new one (seen live 2026-11-05: tag 7 moved from workspaces/2 to a new
      // workspace), so the paths stored at apply go stale; the ids carry over. Find each by id in today's workspace.
      const idOf = (p?: string) => p?.split("/").at(-1);
      const tag = tags.find((t) => t.tagId === idOf(change.tag_path)), trig = triggers.find((t) => t.triggerId === idOf(change.trigger_path));
      const ops: GtmOp[] = [tag?.path, trig?.path].filter((p): p is string => !!p).map((p) => ({ method: "DELETE", path: p }));
      return { ...base, operations: ops, describe: `Remove tag "${change.name}" that Camberstack added from the workspace${ops.length ? ", so a later publish doesn't bring it back" : " (already gone)"}` };
    }
    case "restore_tag": {
      const t = change.tag as any;
      return { ...base, operations: [{ method: "POST", path: `${ws.path}/tags`, body: t }],
        describe: `Add back deleted tag "${t.name}" (as a new tag). Publish to put it back on the site` };
    }
    case "publish_version": {
      const live = await tm.call("GET", `${change.container}/versions:live`).catch(() => null);
      if (live?.containerVersionId === change.version_id) return { ...base, operations: [], describe: `Re-publish ${change.name} (already live)` };
      return { ...base, operations: [{ method: "POST", path: `${change.container}/versions/${change.version_id}:publish` }],
        describe: `Re-publish ${change.name} of ${change.container}, putting the site back as it was`,
        inverse: live ? { type: "publish_version", container: change.container, version_id: live.containerVersionId, name: live.name || `version ${live.containerVersionId}` } : undefined };
    }
  }
}

/**
 * Publishing goes last, so it publishes the tags proposed with it; and it's marked to run even if the workspace has
 * nothing unpublished yet, since those tags will be (stored with the proposal, so apply resolves it the same way).
 */
export function orderGtmChanges(changes: GtmChange[]): GtmChange[] {
  const pub = changes.filter((c) => c.type === "publish_container"), rest = changes.filter((c) => c.type !== "publish_container");
  const of = (c: GtmChange) => ("container" in c ? c.container : undefined);
  const published = (c: GtmChange) => pub.some((p) => of(p) === of(c) && c.type !== "delete_container");
  return [...rest.map((c) => (published(c) ? { ...c, published_after: true } as unknown as GtmChange : c)),
    ...pub.map((c) => (rest.some((r) => of(r) === of(c)) ? { ...c, with_changes: true } as GtmChange : c))];
}

/** Run one resolved change's writes, in order. */
export async function writeGtm(tm: TagManager, ops: GtmOp[]): Promise<GtmWriteResult> {
  const out: GtmWriteResult = {};
  for (let op of ops) {
    if (op.publish) {
      const v = await tm.call("POST", op.path, { name: op.publish.name, notes: "Approved by the user in their AI app, through Camberstack." });
      if (v.compilerError || !v.containerVersion) throw new Error("Tag Manager couldn't build a version from the workspace (a compiler error): open it in Tag Manager to see why.");
      await tm.call("POST", `${v.containerVersion.path}:publish`);
      out.versionId = v.containerVersion.containerVersionId;
      continue;
    }
    if (op.trigger) {
      const triggers = op.path.replace(/\/tags$/, "/triggers");
      // Two tags in one proposal can ask for the same new trigger: the first creates it, the second reuses it (and
      // doesn't claim it, so undoing the second leaves the first's trigger alone).
      const made = await tm.call("POST", triggers, op.trigger).catch(async (e: Error) => {
        if (!/duplicate name/i.test(e.message)) throw e;
        const same = (await listAll(tm, triggers, "trigger")).find((t) => t.name === op.trigger.name);
        if (!same) throw e;
        return { ...same, reused: true };
      });
      if (!made.reused) out.triggerPath = made.path;
      op = { ...op, body: { ...op.body, firingTriggerId: [made.triggerId] } };
    }
    const r = await tm.call(op.method, op.path, op.body);
    if (op.method === "POST" && op.path.endsWith("/tags")) out.tagPath = r.path;
    if (op.method === "POST" && op.path.endsWith("/containers")) { out.containerPath = r.path; out.publicId = r.publicId; }
  }
  return out;
}

/** What undoes an applied change, once Google has said what it created. */
export function gtmInverseAfterApply(r: GtmResolved, res: GtmWriteResult): GtmChange | undefined {
  const c = r.change;
  if (res.containerPath) return { type: "delete_container", container: res.containerPath };
  if (res.tagPath && "container" in c && (c.type.startsWith("add_") || c.type === "restore_tag")) {
    const name = c.type === "restore_tag" ? String((c.tag as any).name) : "name" in c ? c.name : c.type === "add_google_tag" ? `Google tag ${c.tag_id}` : "Conversion Linker";
    return { type: "remove_added_tag", container: c.container, tag_path: res.tagPath, ...(res.triggerPath ? { trigger_path: res.triggerPath } : {}), name };
  }
  return r.inverse;
}

/** The install snippet Tag Manager shows for a container (the <head> part; the <noscript> part is optional). */
export const gtmSnippet = (publicId: string) => `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});`
  + `var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;`
  + `f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${publicId}');</script>`;

export function gtmNoteAfterApply(r: GtmResolved, res: GtmWriteResult): string | undefined {
  if (res.containerPath) return `Container ${res.publicId} (${res.containerPath}) is created and empty. Give the user this snippet to paste as high in every page's <head> as possible `
    + `(or the site platform's Google Tag Manager setting, which takes just ${res.publicId}): ${gtmSnippet(res.publicId ?? "")} . Then add tags and publish_container.`;
  if (r.change.type === "delete_container") return "The container is deleted. If the site still loads its snippet, remove it: it now loads nothing.";
  if (res.versionId) return `Version ${res.versionId} is live. Tag Assistant (tagassistant.google.com) shows each tag firing on the site; Google Ads shows a conversion tag as recording within a few hours of its first conversion.`;
  if (r.change.type === "publish_version") return "The earlier version is live again. Changes still in the workspace go live at the next publish_container.";
  if (r.change.type === "remove_added_tag") return "Removed from the workspace. If it's still on the site, a publish_container takes it off.";
  if ((r.change as { published_after?: boolean }).published_after) return undefined;
  return "Not live yet: it's in the Tag Manager workspace. publish_container makes it live (show the user what that publishes first).";
}
