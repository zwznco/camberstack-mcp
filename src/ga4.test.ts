import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { NotGrantedError } from "./google.js";
import { AnalyticsClient, DEMO_PROPERTY, DemoAnalytics, landingPages, listProperties, report } from "./ga4.js";
import { toolCatalog } from "./tools.js";
import { gaInverseAfterApply, gaNoteAfterApply, gaSetup, resolveGaChange, writeGa } from "./ga4-changes.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const client = (f: (url: string, init?: RequestInit) => Response) =>
  new AnalyticsClient(async () => "t", () => "https://camberstack.io/connect/analytics?t=x", (async (u: string, i?: RequestInit) => f(String(u), i)) as typeof fetch);

describe("AnalyticsClient", () => {
  it("lists properties across pages of account summaries", async () => {
    const ga = client((u) => (u.includes("pageToken=p2")
      ? json({ accountSummaries: [{ account: "accounts/b2", displayName: "B", propertySummaries: [{ property: "properties/2", displayName: "Shop" }] }] })
      : json({ accountSummaries: [{ account: "accounts/a1", displayName: "A", propertySummaries: [{ property: "properties/1", displayName: "Site" }] }], nextPageToken: "p2" })));
    expect(await ga.summaries()).toEqual({
      accounts: [{ account_id: "a1", name: "A" }, { account_id: "b2", name: "B" }],
      properties: [{ property_id: "1", name: "Site", account: "A", account_id: "a1" }, { property_id: "2", name: "Shop", account: "B", account_id: "b2" }] });
  });

  it("turns GA4's string metrics into numbers and sends the filter and sort", async () => {
    let sent: any;
    const ga = client((_u, i) => {
      sent = JSON.parse(String(i!.body));
      return json({ dimensionHeaders: [{ name: "landingPage" }], metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "engagementRate", type: "TYPE_FLOAT" }],
        rows: [{ dimensionValues: [{ value: "/a" }], metricValues: [{ value: "12" }, { value: "0.583333333" }] }], rowCount: 1 });
    });
    const r = await ga.runReport("9", { startDate: "2026-10-01", endDate: "2026-10-07", dimensions: ["landingPage"], metrics: ["sessions", "engagementRate"],
      filter: { dimension: "sessionDefaultChannelGroup", value: "Paid Search" }, limit: 10 });
    expect(r).toEqual({ row_count: 1, rows: [{ landingPage: "/a", sessions: 12, engagementRate: 0.5833 }] });
    expect(sent.dimensionFilter.filter).toEqual({ fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "CONTAINS", value: "Paid Search", caseSensitive: false } });
    expect(sent.orderBys).toEqual([{ metric: { metricName: "sessions" }, desc: true }]);
    await ga.runReport("9", { startDate: "2026-10-01", endDate: "2026-10-07", dimensions: ["date"], metrics: ["sessions"], orderBy: "date", limit: 10 });
    expect(sent.orderBys).toEqual([{ dimension: { dimensionName: "date" }, desc: false }]);
  });

  it("says Analytics isn't granted, with the grant link, instead of a raw 403", async () => {
    const ga = client(() => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED",
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    const out = await listProperties(ga);
    expect(out.properties[0]!.property_id).toBe(DEMO_PROPERTY);
    expect(out).toMatchObject({ grant_url: "https://camberstack.io/connect/analytics?t=x" });
    await expect(ga.runReport("9", { startDate: "a", endDate: "b", dimensions: [], metrics: ["sessions"], limit: 1 })).rejects.toBeInstanceOf(NotGrantedError);
  });

  it("passes other API errors through readably (e.g. the API not enabled)", async () => {
    const ga = client(() => json({ error: { code: 403, message: "Google Analytics Data API has not been used in project 123 before or it is disabled." } }, 403));
    await expect(ga.summaries()).rejects.toThrow(/Google Analytics API 403: Google Analytics Data API has not been used/);
  });
});

describe("demo property", () => {
  const demo = new DemoAnalytics();

  it("shows paid traffic converting worse on the home page than on service pages", async () => {
    const r = await landingPages(demo, DEMO_PROPERTY, { days: 28, channel: "Paid Search", limit: 10 });
    expect(r.note).toContain("demo");
    const rate = (p: string) => r.landing_pages.find((x) => x.landing_page === p)!.key_event_rate!;
    expect(r.landing_pages[0]!.landing_page).toBe("/");
    expect(rate("/")).toBeLessThan(rate("/emergency-plumber"));
  });

  it("answers reports by date and channel, and names what it supports when asked for more", async () => {
    const r = await report(demo, DEMO_PROPERTY, { days: 7, start_date: "2026-10-01", end_date: "2026-10-07", dimensions: ["date"], metrics: ["sessions"], limit: 50 });
    expect(r.rows).toHaveLength(7);
    await expect(report(demo, DEMO_PROPERTY, { days: 7, dimensions: ["city"], metrics: ["sessions"], limit: 5 })).rejects.toThrow(/supports dimensions/);
    await expect(report(demo, DEMO_PROPERTY, { days: 7, dimensions: [], metrics: ["sessions"], order_by: "keyEvents", limit: 5 }))
      .rejects.toThrow('order_by "keyEvents" isn\'t in this report. Use one of its metrics (sessions), or add it to them.');
  });

  it("sorts by a requested dimension, dates oldest first", async () => {
    const r = await report(demo, DEMO_PROPERTY, { days: 7, start_date: "2026-10-01", end_date: "2026-10-07", dimensions: ["date"], metrics: ["sessions"],
      order_by: "date", limit: 50 });
    const dates = r.rows.map((x) => String(x.date));
    expect(dates).toEqual([...dates].sort());
  });
});

describe("rollout", () => {
  it("lists the Google Analytics tools for everyone", () => {
    const names = toolCatalog().map((t) => t.name).filter((n) => n.startsWith("analytics_"));
    expect(names).toEqual(["analytics_properties", "analytics_setup", "analytics_landing_pages", "analytics_report"]);
  });
});

describe("create_ga4_property", () => {
  const made: string[] = [];
  const ga = {
    async summaries() { return { accounts: [{ account_id: "77", name: "Example Inc" }],
      properties: [{ property_id: "1", name: "Old site", account: "Example Inc", account_id: "77" }] }; },
    async runReport() { return { row_count: 0, rows: [] }; },
    async admin(method: string, path: string, body?: any) {
      made.push(`${method} ${path}`);
      if (path === "properties") return { name: "properties/555", ...body };
      if (path === "properties/555/dataStreams") return { name: "properties/555/dataStreams/9", webStreamData: { measurementId: "G-ABC123", defaultUri: body.webStreamData.defaultUri } };
      return {};
    },
  };
  const change = { type: "create_ga4_property" as const, account_id: "77", name: "New site", website_url: "https://www.example.com", time_zone: "America/New_York", currency: "USD" };

  it("creates the property and its web stream, hands back the tag, and undoes by deleting the property", async () => {
    const r = await resolveGaChange(ga, change);
    expect(r.describe).toBe('Create GA4 property "New site" in account "Example Inc" (America/New_York, USD) with a web stream for https://www.example.com');
    const res = await writeGa(ga, r.operations);
    expect(made).toEqual(["POST properties", "POST properties/555/dataStreams"]);
    expect(gaNoteAfterApply(res)).toContain("gtag/js?id=G-ABC123");
    expect(gaInverseAfterApply(r, res)).toEqual({ type: "delete_ga4_property", property_id: "555", name: "New site" });
  });

  it("refuses a name the account already uses, or an account the login can't see", async () => {
    await expect(resolveGaChange(ga, { ...change, name: "old SITE" })).rejects.toThrow(/already has a property named/);
    await expect(resolveGaChange(ga, { ...change, account_id: "88" })).rejects.toThrow(/isn't one this login can see/);
  });
});

describe("analytics_setup", () => {
  it("shows the demo property's stream, key events and links", async () => {
    expect(await gaSetup(new DemoAnalytics(), DEMO_PROPERTY)).toMatchObject({
      web_streams: [{ measurement_id: "G-DEMO000001" }], key_events: [{ event_name: "generate_lead" }], google_ads_links: [] });
  });

  it("keeps each user's demo changes, so undo finds what it reverses (2026-10-17: applies were forgotten and undo said nothing to change)", async () => {
    const db = openDb(":memory:");
    const mark = { type: "mark_key_event" as const, property_id: DEMO_PROPERTY, event_name: "phone_call", counting: "ONCE_PER_SESSION" as const };
    const link = { type: "link_google_ads" as const, property_id: DEMO_PROPERTY, customer_id: "0000000001" };
    const results = [];
    for (const c of [mark, link]) {
      const r = await resolveGaChange(new DemoAnalytics(db, "u1"), c);
      results.push({ r, out: await writeGa(new DemoAnalytics(db, "u1"), r.operations) });
    }
    expect(await gaSetup(new DemoAnalytics(db, "u1"), DEMO_PROPERTY)).toMatchObject({
      key_events: [{ event_name: "generate_lead" }, { event_name: "phone_call", counting: "ONCE_PER_SESSION" }], google_ads_links: [{ customer_id: "000-000-0001" }] });
    expect((await gaSetup(new DemoAnalytics(db, "u2"), DEMO_PROPERTY)).key_events).toHaveLength(1);  // another user's demo is untouched

    for (const { r, out } of results) {
      const undo = await resolveGaChange(new DemoAnalytics(db, "u1"), gaInverseAfterApply(r, out)!);
      expect(undo.operations).toHaveLength(1);
      await writeGa(new DemoAnalytics(db, "u1"), undo.operations);
    }
    expect(await gaSetup(new DemoAnalytics(db, "u1"), DEMO_PROPERTY)).toMatchObject({ key_events: [{ event_name: "generate_lead" }], google_ads_links: [] });
  });

  it("recounts an existing key event, and undo restores it (2026-10-28: mark_key_event left it as it was)", async () => {
    const ga = new DemoAnalytics();
    const set = { type: "set_key_event_counting" as const, property_id: DEMO_PROPERTY, event_name: "generate_lead", counting: "ONCE_PER_SESSION" as const };
    const r = await resolveGaChange(ga, set);
    expect(r.describe).toContain('Count key event "generate_lead" in GA4 property "DEMO: Northwind Plumbing (sample data)" once per session (was every time)');
    expect(r.operations).toEqual([{ method: "PATCH", path: `properties/${DEMO_PROPERTY}/keyEvents/1?updateMask=counting_method`, body: { countingMethod: "ONCE_PER_SESSION" } }]);
    const out = await writeGa(ga, r.operations);
    expect((await gaSetup(ga, DEMO_PROPERTY)).key_events).toEqual([{ event_name: "generate_lead", counting: "ONCE_PER_SESSION" }]);
    expect((await resolveGaChange(ga, set)).operations).toEqual([]);  // already counted that way
    await writeGa(ga, (await resolveGaChange(ga, gaInverseAfterApply(r, out)!)).operations);
    expect((await gaSetup(ga, DEMO_PROPERTY)).key_events).toEqual([{ event_name: "generate_lead", counting: "ONCE_PER_EVENT" }]);
    await expect(resolveGaChange(ga, { ...set, event_name: "phone_call" })).rejects.toThrow(/isn't a key event.*mark_key_event/);
  });
});
