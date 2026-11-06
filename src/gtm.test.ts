import { describe, expect, it } from "vitest";
import { DEMO_CONTAINER, DemoTagManager, GtmClient, listAll, listContainers, routedTagManager, tagManagerSetup } from "./gtm.js";
import { orderGtmChanges, resolveGtmChange, writeGtm, gtmInverseAfterApply } from "./gtm-changes.js";
import { GRANTS, NotGrantedError } from "./google.js";

/** A fake of the Tag Manager API's HTTP side: records calls, answers from `routes`. */
function fakeFetch(routes: Record<string, (body: any) => [number, unknown]>) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.replace("https://tagmanager.googleapis.com/tagmanager/v2/", "")}`;
    calls.push(key);
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
    const [status, body] = h(init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const client = (routes: Parameters<typeof fakeFetch>[0]) => {
  const { f, calls } = fakeFetch(routes);
  return { tm: new GtmClient(async () => "tok", () => "https://camberstack.io/connect/tag-manager?t=x", f), calls };
};
const insufficient: [number, unknown] = [403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }];

describe("Tag Manager", () => {
  it("asks Google for edit, version, publish and delete-container access (edit covers reads, so no readonly), and nothing that manages users, and nothing that deletes containers or manages users", () => {
    expect(GRANTS["tag-manager"].scopes.map((s) => s.split("/").at(-1))).toEqual(
      ["tagmanager.edit.containers", "tagmanager.edit.containerversions", "tagmanager.publish", "tagmanager.delete.containers"]);
  });

  it("turns a missing scope into the personal link that adds Tag Manager, and lists the demo meanwhile", async () => {
    const { tm } = client({ "GET accounts?includeGoogleTags=true": () => insufficient });
    await expect(tm.call("GET", "accounts?includeGoogleTags=true")).rejects.toBeInstanceOf(NotGrantedError);
    const r = await listContainers(routedTagManager(tm, new DemoTagManager())) as any;
    expect(r.grant_url).toContain("/connect/tag-manager");
    expect(r.accounts[0].containers[0].container).toBe(DEMO_CONTAINER);
  });

  it("lists web containers across accounts and pages", async () => {
    const { tm, calls } = client({
      "GET accounts?includeGoogleTags=true": () => [200, { account: [{ name: "Acme", path: "accounts/1" }] }],
      "GET accounts/1/containers": () => [200, { container: [{ name: "acme.test", path: "accounts/1/containers/2", publicId: "GTM-AAA", usageContext: ["web"] },
        { name: "app", path: "accounts/1/containers/3", publicId: "GTM-BBB", usageContext: ["android"] }], nextPageToken: "p2" }],
      "GET accounts/1/containers?pageToken=p2": () => [200, { container: [{ name: "shop.test", path: "accounts/1/containers/4", publicId: "GTM-CCC" }] }],
    });
    expect(await listContainers(tm)).toEqual({ accounts: [{ account: "Acme", account_id: "accounts/1", containers: [
      { container: "accounts/1/containers/2", name: "acme.test", public_id: "GTM-AAA" },
      { container: "accounts/1/containers/4", name: "shop.test", public_id: "GTM-CCC" }] }] });
    expect(calls).toContain("GET accounts/1/containers?pageToken=p2");
  });

  it("creates a new trigger before the tag that fires on it, and undo removes both", async () => {
    const ws = "accounts/1/containers/2/workspaces/5";
    const posted: any[] = [];
    const { tm } = client({
      "GET accounts/1/containers/2/workspaces": () => [200, { workspace: [{ workspaceId: "5", name: "Default Workspace", path: ws }] }],
      [`GET ${ws}/tags`]: () => [200, { tag: [] }],
      [`GET ${ws}/triggers`]: () => [200, {}],
      [`POST ${ws}/triggers`]: (b) => { posted.push(b); return [200, { ...b, triggerId: "40", path: `${ws}/triggers/40` }]; },
      [`POST ${ws}/tags`]: (b) => { posted.push(b); return [200, { ...b, tagId: "41", path: `${ws}/tags/41` }]; },
    });
    const r = await resolveGtmChange(tm, { type: "add_ga4_event_tag", container: "accounts/1/containers/2", name: "GA4 - lead",
      measurement_id: "G-ABC123", event_name: "generate_lead", fires_on: { kind: "custom_event", value: "generate_lead" } });
    expect(r.describe).toContain('on the dataLayer event "generate_lead" (a new trigger; the site must push it)');
    const res = await writeGtm(tm, r.operations);
    expect(posted[0]).toMatchObject({ name: "Event generate_lead", type: "customEvent" });
    expect(posted[1]).toMatchObject({ type: "gaawe", firingTriggerId: ["40"] });
    expect(gtmInverseAfterApply(r, res)).toEqual({ type: "remove_added_tag", container: "accounts/1/containers/2",
      tag_path: `${ws}/tags/41`, trigger_path: `${ws}/triggers/40`, name: "GA4 - lead" });
  });

  it("stops a publish when Tag Manager can't build the version", async () => {
    const { tm } = client({ "POST accounts/1/containers/2/workspaces/5:create_version": () => [200, { compilerError: true }] });
    await expect(writeGtm(tm, [{ method: "POST", path: "accounts/1/containers/2/workspaces/5:create_version", publish: { name: "v" } }]))
      .rejects.toThrow("compiler error");
  });

  it("puts publishes last, marked to run with the changes before them", () => {
    const C = "accounts/1/containers/2";
    expect(orderGtmChanges([{ type: "publish_container", container: C }, { type: "pause_tag", container: C, tag_id: "3" }]))
      .toEqual([{ type: "pause_tag", container: C, tag_id: "3", published_after: true }, { type: "publish_container", container: C, with_changes: true }]);
    expect(orderGtmChanges([{ type: "publish_container", container: C }])).toEqual([{ type: "publish_container", container: C }]);
  });

  it("says when a container was never published", async () => {
    const demo = new DemoTagManager();
    const real = { call: async (m: string, p: string, b?: object) => (p.endsWith("versions:live") ? Promise.reject(new Error("404")) : demo.call(m as "GET", p, b)) };
    const s = await tagManagerSetup(real, DEMO_CONTAINER);
    expect(s.live_version).toBeNull();
    expect(s.issues.map((i) => i.fix)).toContain("publish_container");
  });

  it("pages through list calls", async () => {
    const { tm } = client({ "GET x": () => [200, { tag: [1], nextPageToken: "a b" }], "GET x?pageToken=a%20b": () => [200, { tag: [2] }] });
    expect(await listAll(tm, "x", "tag")).toEqual([1, 2]);
  });

  it("creates a container (undo deletes it) and warns that deleting one can't be undone", async () => {
    const { resolveGtmChange, writeGtm, gtmInverseAfterApply, gtmNoteAfterApply } = await import("./gtm-changes.js");
    const tm = routedTagManager(client({ "GET accounts?includeGoogleTags=true": () => [200, {}] }).tm, new DemoTagManager());
    const r = await resolveGtmChange(tm, { type: "create_container", account: "accounts/000000001", name: "shop.example" });
    const res = await writeGtm(tm, r.operations);
    expect(res.publicId).toMatch(/^GTM-/);
    expect(gtmNoteAfterApply(r, res)).toContain(`'${res.publicId}'`);
    const inv = gtmInverseAfterApply(r, res)!;
    expect(inv).toEqual({ type: "delete_container", container: res.containerPath });
    expect((await listContainers(tm)).accounts.at(-1)!.containers.map((c: any) => c.name)).toContain("shop.example");
    const again = await resolveGtmChange(tm, { type: "create_container", account: "accounts/000000001", name: "shop.example" });
    expect(again.operations).toEqual([]);
    const del = await resolveGtmChange(tm, inv);
    expect(del.describe).toContain("⚠ Google can't restore");
    expect(del.inverse).toBeUndefined();
    await writeGtm(tm, del.operations);
    expect((await listContainers(tm)).accounts.at(-1)!.containers.map((c: any) => c.name)).not.toContain("shop.example");
    await expect(resolveGtmChange(tm, { type: "delete_container", container: DEMO_CONTAINER }).then((x) => writeGtm(tm, x.operations))).rejects.toThrow(/can't be deleted/);
  });

  it("two tags asking for the same new trigger share it, and only the first claims it for undo", async () => {
    const tm = new DemoTagManager();
    const fires = { kind: "page_url_contains" as const, value: "/booked" };
    const a = await resolveGtmChange(tm, { type: "add_ga4_event_tag", container: DEMO_CONTAINER, name: "GA4 booked", measurement_id: "G-NW0000DEMO", event_name: "booked", fires_on: fires });
    const b = await resolveGtmChange(tm, { type: "add_ads_conversion_tag", container: DEMO_CONTAINER, name: "Ads booked", conversion_id: "100000001", conversion_label: "Booked123", fires_on: fires });
    const ra = await writeGtm(tm, a.operations), rb = await writeGtm(tm, b.operations);
    expect(ra.triggerPath).toBeDefined();
    expect(rb.triggerPath).toBeUndefined();
    const tags = (await tm.call("GET", `${DEMO_CONTAINER}/workspaces/1/tags`)).tag;
    const fired = tags.filter((t: any) => ["GA4 booked", "Ads booked"].includes(t.name)).map((t: any) => t.firingTriggerId[0]);
    expect(new Set(fired).size).toBe(1);
  });

  it("waits out a 429 (the per-minute quota) and tries again", async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ account: [] }), { status: 200 }))) as unknown as typeof fetch;
    const tm = new GtmClient(async () => "tok", () => null, f, [0]);
    expect(await tm.call("GET", "accounts")).toEqual({ account: [] });
    expect(n).toBe(2);
  });

  it("treats Tag Manager's own destination for an ID as that ID's Google tag", async () => {
    const tm = new DemoTagManager();
    await tm.call("POST", `${DEMO_CONTAINER}/workspaces/1/tags`, { name: "Google Analytics G-ABCD1234", type: "dest_ga", parameter: [] });
    const r = await resolveGtmChange(tm, { type: "add_google_tag", container: DEMO_CONTAINER, tag_id: "G-ABCD1234" });
    expect(r.operations).toEqual([]);
  });
});
