import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { NotGrantedError } from "./google.js";
import { AnalyticsClient, DEMO_PROPERTY, DemoAnalytics, PropertySlots, landingPages, listProperties, report } from "./ga4.js";
import { toolCatalog } from "./tools.js";
import { gaInverseAfterApply, gaNoteAfterApply, gaSetup, resolveGaChange, writeGa } from "./ga4-changes.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const client = (f: (url: string, init?: RequestInit) => Response) =>
  new AnalyticsClient(async () => "t", () => "https://camberstack.io/connect/analytics?t=x", (async (u: string, i?: RequestInit) => f(String(u), i)) as typeof fetch);

describe("AnalyticsClient", () => {
  it("retries a read through a transient 503, and never retries a write", async () => {
    const seen: string[] = [];
    let n = 0;
    const ga = client((u, i) => {
      seen.push(`${i?.method} ${u.split("/v1beta/")[1]}`);
      return u.includes("keyEvents") && n++ === 0 ? json({ error: { message: "The service is currently unavailable." } }, 503) : json({});
    });
    await gaSetup(ga, "1");
    expect(seen.filter((x) => x.includes("keyEvents"))).toHaveLength(2);
    let writes = 0;
    const w = client(() => (writes++, json({ error: { message: "The service is currently unavailable." } }, 503)));
    await expect(w.admin("POST", "properties/1/keyEvents", { eventName: "x" })).rejects.toThrow("503");
    expect(writes).toBe(1);
  });

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

  it("answers an unknown field with the property's own closest names, not only Google's spelling guess", async () => {
    const ga = client((u) => u.endsWith("/metadata")
      ? json({ dimensions: [{ apiName: "landingPage" }, { apiName: "customEvent:form_variant" }, { apiName: "googleAdsQuery" }],
        metrics: [{ apiName: "sessions" }, { apiName: "purchaserRate" }, { apiName: "ecommercePurchases" }, { apiName: "purchaseRevenue" }, { apiName: "transactions" }] })
      : json({ error: { code: 400, message: "Did you mean purchaserRate? Field purchases is not a valid metric. For a list of valid dimensions and metrics, see https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema" } }, 400));
    const e = await report(ga, "9", { days: 7, dimensions: [], metrics: ["purchases"], limit: 10 }).catch((x: Error) => x);
    expect((e as Error).message).toContain("Google Analytics API 400: Did you mean purchaserRate?");
    expect((e as Error).message).toContain("Closest real metrics: ecommercePurchases, purchaserRate, purchaseRevenue.");
    // Search Console's GA4 fields exist only on a linked property: say so, and where search queries are.
    const ga2 = client((u) => u.endsWith("/metadata") ? json({ dimensions: [{ apiName: "landingPage" }, { apiName: "googleAdsQuery" }], metrics: [{ apiName: "sessions" }] })
      : json({ error: { code: 400, message: "Did you mean googleAdsQuery? Field organicGoogleSearchQuery is not a valid dimension." } }, 400));
    const e2 = await report(ga2, "9", { days: 7, dimensions: ["organicGoogleSearchQuery"], metrics: ["sessions"], limit: 10 }).catch((x: Error) => x);
    expect((e2 as Error).message).toContain("only when Search Console is linked to the property. For search queries, use search_console_performance.");
    // A custom field: the property's registered ones, not word matches.
    const ga4 = client((u) => u.endsWith("/metadata") ? json({ dimensions: [{ apiName: "eventName" }, { apiName: "customEvent:form_variant" }], metrics: [{ apiName: "sessions" }] })
      : json({ error: { code: 400, message: "Did you mean customEvent:form_variant? Field customEvent:form_id is not a valid dimension." } }, 400));
    const e4 = await report(ga4, "9", { days: 7, dimensions: ["customEvent:form_id"], metrics: ["sessions"], limit: 10 }).catch((x: Error) => x);
    expect((e4 as Error).message).toContain("Its registered customEvent: dimensions are: customEvent:form_variant.");
    // ...and how to register it through Camberstack, with what GA4 won't do (2026-10-27: form_id, after form_variant was registered by hand).
    expect((e4 as Error).message).toContain("If the site sends form_id, register it: propose the Google Analytics change register_custom_dimension (parameter_name form_id, scope EVENT). "
      + "GA4 counts it from then on, not for earlier dates, and reports have it after 24-48 hours.");
    // A custom metric: register_custom_metric, with its unit.
    const ga5 = client((u) => u.endsWith("/metadata") ? json({ dimensions: [], metrics: [{ apiName: "sessions" }] })
      : json({ error: { code: 400, message: "Field customEvent:order_weight is not a valid metric." } }, 400));
    const e5 = await report(ga5, "9", { days: 7, dimensions: [], metrics: ["customEvent:order_weight"], limit: 10 }).catch((x: Error) => x);
    expect((e5 as Error).message).toContain("It has no customEvent: metrics registered. If the site sends order_weight as a number, register it: "
      + "propose the Google Analytics change register_custom_metric (parameter_name order_weight, unit STANDARD unless it's money, distance or time).");
    // Custom metrics are event-scoped only: a customUser: metric can't be registered, and the hint says so instead of proposing it.
    const ga6 = client((u) => u.endsWith("/metadata") ? json({ dimensions: [], metrics: [] })
      : json({ error: { code: 400, message: "Field customUser:ltv is not a valid metric." } }, 400));
    const e6 = await report(ga6, "9", { days: 7, dimensions: [], metrics: ["customUser:ltv"], limit: 10 }).catch((x: Error) => x);
    expect((e6 as Error).message).toContain("customUser:ltv can't be registered: custom metrics are customEvent: only");
    // Metadata unreadable: Google's message alone, unchanged.
    const ga3 = client((u) => u.endsWith("/metadata") ? json({ error: { code: 500, message: "x" } }, 500)
      : json({ error: { code: 400, message: "Field purchases is not a valid metric." } }, 400));
    await expect(report(ga3, "9", { days: 7, dimensions: [], metrics: ["purchases"], limit: 10 })).rejects.toThrow(/^Google Analytics API 400: Field purchases is not a valid metric\.$/);
  });

  it("runs at most four Data API calls at once per property; the rest queue (2026-11-13: nine at once hit 429)", async () => {
    let live = 0, peak = 0, other = 0;
    const releases: (() => void)[] = [];
    const ga = new AnalyticsClient(async () => "t", () => null, (async (u: string) => {
      if (String(u).includes("properties/2:")) { other++; return json({}); }
      live++; peak = Math.max(peak, live);
      await new Promise<void>((r) => releases.push(r));
      live--;
      return json({});
    }) as typeof fetch, [], new PropertySlots(4));
    const q = { startDate: "2026-11-01", endDate: "2026-11-07", dimensions: [], metrics: ["sessions"], limit: 10 };
    const all = Array.from({ length: 9 }, () => ga.runReport("1", q));
    await ga.runReport("2", q);  // another property isn't held up
    expect(other).toBe(1);
    while (releases.length || live) { await new Promise((r) => setTimeout(r, 0)); releases.shift()?.(); }
    await Promise.all(all);
    expect(peak).toBe(4);
  });

  it("waits and retries a 429, then says to slow down if it persists", async () => {
    let n = 0;
    const quota = () => json({ error: { code: 429, message: "Exhausted concurrent requests quota." } }, 429);
    const q = { startDate: "2026-11-01", endDate: "2026-11-07", dimensions: [], metrics: ["sessions"], limit: 10 };
    const mk = (f: () => Response) => new AnalyticsClient(async () => "t", () => null, (async () => f()) as typeof fetch, [1], new PropertySlots(4));
    await expect(mk(() => (n++ === 0 ? quota() : json({ rowCount: 0 }))).runReport("1", q)).resolves.toMatchObject({ row_count: 0 });
    expect(n).toBe(2);
    n = 0;
    await expect(mk(() => (n++, quota())).runReport("1", q)).rejects.toThrow(/^Google Analytics API 429: Exhausted concurrent requests quota\. → .*one at a time/);
    expect(n).toBe(2);
  });

  it("turns a slow Data API 502 (Google's HTML error page) into advice to narrow the report, without retrying it", async () => {
    let n = 0, now = 0;
    const realNow = Date.now;
    Date.now = () => (now += 30_000);  // every request appears to take ~60s
    try {
      const q = { startDate: "2026-11-01", endDate: "2026-11-07", dimensions: ["landingPage"], metrics: ["sessions"], limit: 10 };
      const ga = client(() => (n++, new Response("<!DOCTYPE html>\n<html lang=en><title>Error 502 (Server Error)!!1</title>", { status: 502 })));
      const err = await ga.runReport("1", q).catch((e) => e as Error);
      expect(err.message).toMatch(/^Google Analytics API 502: Google returned a server error page with no details\. → .*shorter date range/);
      expect(err.message).not.toContain("<");
      expect(n).toBe(1);
    } finally { Date.now = realNow; }
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

describe("register_custom_dimension", () => {
  const P = DEMO_PROPERTY;
  const reg = { type: "register_custom_dimension" as const, property_id: P, parameter_name: "form_id", scope: "EVENT" as const };

  it("registers a parameter, lists it in analytics_setup with the name reports take, and undo archives it", async () => {
    const ga = new DemoAnalytics();
    const r = await resolveGaChange(ga, reg);
    expect(r.operations).toEqual([{ method: "POST", path: `properties/${P}/customDimensions`, body: { parameterName: "form_id", displayName: "form_id", scope: "EVENT" } }]);
    expect(r.describe).toBe('Register "form_id" as an event-scoped custom dimension "form_id" in GA4 property "DEMO: Northwind Plumbing (sample data)", reported as customEvent:form_id. '
      + "GA4 counts it from registration on, not for earlier visits, and it reaches reports after 24-48 hours. Undoing it archives it, which GA4 can't reverse");
    const out = await writeGa(ga, r.operations);
    expect((await gaSetup(ga, P)).custom_dimensions).toEqual([{ parameter: "form_id", scope: "EVENT", display_name: "form_id", report_as: "customEvent:form_id" }]);

    // Proposing it again changes nothing.
    expect((await resolveGaChange(ga, reg)).operations).toEqual([]);
    expect((await resolveGaChange(ga, reg)).describe).toContain('(already registered as "form_id"; report it as customEvent:form_id)');

    const undo = gaInverseAfterApply(r, out)!;
    expect(undo).toEqual({ type: "archive_custom_dimension", property_id: P, resource_name: out[0]!.resourceName, parameter_name: "form_id", scope: "EVENT" });
    const u = await resolveGaChange(ga, undo);
    expect(u.operations).toEqual([{ method: "POST", path: `${out[0]!.resourceName}:archive`, body: {} }]);
    expect(u.describe).toContain("⚠ GA4 can't restore an archived custom dimension");
    expect(await writeGa(ga, u.operations)).toEqual([{ resourceName: out[0]!.resourceName }]);  // an archive answers {}
    expect((await gaSetup(ga, P)).custom_dimensions).toEqual([]);
    expect(gaInverseAfterApply(u, [])).toBeUndefined();  // nothing undoes an archive
    expect((await resolveGaChange(ga, undo)).describe).toContain("(already archived)");
  });

  it("names user and item scopes as reports do, and keeps GA4's limits", async () => {
    const ga = new DemoAnalytics();
    const user = await resolveGaChange(ga, { ...reg, parameter_name: "plan_tier", scope: "USER", display_name: "Plan tier" });
    expect(user.describe).toContain('a user-scoped custom dimension "Plan tier"');
    expect(user.describe).toContain("reported as customUser:plan_tier");
    await writeGa(ga, user.operations);
    await expect(resolveGaChange(ga, { ...reg, parameter_name: "a_user_property_name_too_long", scope: "USER" })).rejects.toThrow(/24 characters at most/);
    await expect(resolveGaChange(ga, { ...reg, parameter_name: "tier", display_name: "Plan tier" })).rejects.toThrow('already has a custom dimension named "Plan tier" (parameter plan_tier)');
    expect((await resolveGaChange(ga, { ...reg, parameter_name: "item_size", scope: "ITEM" })).describe).toContain("reported as customItem:item_size");
  });

  it("sends the Admin API v1beta requests Google documents", async () => {
    const seen: { m: string; u: string; b?: string }[] = [];
    const ga = client((u, i) => {
      seen.push({ m: String(i?.method), u: u.split("/v1beta/")[1]!, b: i?.body as string | undefined });
      if (u.endsWith("/properties/9")) return json({ displayName: "Site" });
      if (u.includes("customDimensions?pageSize=200")) return u.includes("pageToken=n2")
        ? json({ customDimensions: [{ name: "properties/9/customDimensions/2", parameterName: "b", displayName: "b", scope: "EVENT" }] })
        : json({ customDimensions: [{ name: "properties/9/customDimensions/1", parameterName: "a", displayName: "a", scope: "EVENT" }], nextPageToken: "n2" });
      if (u.endsWith("/customDimensions")) return json({ name: "properties/9/customDimensions/3" });
      return json({});
    });
    const r = await resolveGaChange(ga, { ...reg, property_id: "9", parameter_name: "b" });
    expect(r.operations).toEqual([]);  // found on the second page
    const r2 = await resolveGaChange(ga, { ...reg, property_id: "9" });
    const out = await writeGa(ga, r2.operations);
    expect(seen.at(-1)).toEqual({ m: "POST", u: "properties/9/customDimensions", b: JSON.stringify({ parameterName: "form_id", displayName: "form_id", scope: "EVENT" }) });
    const a = await resolveGaChange(ga, gaInverseAfterApply(r2, out)!);
    expect(a.operations).toEqual([]);  // the fake no longer lists /3, so it reads as archived already
    await writeGa(ga, [{ method: "POST", path: "properties/9/customDimensions/3:archive", body: {} }]);
    expect(seen.at(-1)).toEqual({ m: "POST", u: "properties/9/customDimensions/3:archive", b: "{}" });
  });
});

describe("register_custom_metric", () => {
  const P = DEMO_PROPERTY;
  const reg = { type: "register_custom_metric" as const, property_id: P, parameter_name: "order_weight", unit: "STANDARD" as const };

  it("registers a numeric parameter, lists it with its unit, and undo archives it", async () => {
    const ga = new DemoAnalytics();
    const r = await resolveGaChange(ga, reg);
    expect(r.operations).toEqual([{ method: "POST", path: `properties/${P}/customMetrics`,
      body: { parameterName: "order_weight", displayName: "order_weight", measurementUnit: "STANDARD", scope: "EVENT" } }]);
    expect(r.describe).toBe('Register "order_weight" as a custom metric "order_weight" (a plain number) in GA4 property "DEMO: Northwind Plumbing (sample data)", reported as customEvent:order_weight. '
      + "GA4 counts it from registration on, not for earlier visits, and it reaches reports after 24-48 hours. Undoing it archives it, which GA4 can't reverse");
    const out = await writeGa(ga, r.operations);
    expect((await gaSetup(ga, P)).custom_metrics).toEqual([{ parameter: "order_weight", display_name: "order_weight", unit: "STANDARD", report_as: "customEvent:order_weight" }]);
    expect((await resolveGaChange(ga, reg)).describe).toContain('(already registered as "order_weight", unit STANDARD; report it as customEvent:order_weight)');

    const undo = gaInverseAfterApply(r, out)!;
    expect(undo).toEqual({ type: "archive_custom_metric", property_id: P, resource_name: out[0]!.resourceName, parameter_name: "order_weight" });
    const u = await resolveGaChange(ga, undo);
    expect(u.operations).toEqual([{ method: "POST", path: `${out[0]!.resourceName}:archive`, body: {} }]);
    expect(u.describe).toContain("⚠ GA4 can't restore an archived custom metric");
    await writeGa(ga, u.operations);
    expect((await gaSetup(ga, P)).custom_metrics).toEqual([]);
    expect(gaInverseAfterApply(u, [])).toBeUndefined();
  });

  it("marks a money metric as revenue (or cost) data, as Google requires, and says who stops seeing it", async () => {
    const ga = new DemoAnalytics();
    const r = await resolveGaChange(ga, { ...reg, parameter_name: "tip_amount", unit: "CURRENCY" });
    expect((r.operations[0]!.body as any).restrictedMetricType).toEqual(["REVENUE_DATA"]);
    expect(r.describe).toContain("(unit CURRENCY)");
    expect(r.describe).toContain("It is marked as revenue data, so GA4 users without access to revenue data won't see it.");
    const cost = await resolveGaChange(ga, { ...reg, parameter_name: "shipping_cost", unit: "CURRENCY", currency_data: "COST_DATA" });
    expect((cost.operations[0]!.body as any).restrictedMetricType).toEqual(["COST_DATA"]);
    await expect(resolveGaChange(ga, { ...reg, currency_data: "COST_DATA" })).rejects.toThrow(/applies only to unit CURRENCY/);
    await writeGa(ga, r.operations);
    await expect(resolveGaChange(ga, { ...reg, parameter_name: "tip2", display_name: "tip_amount" })).rejects.toThrow('already has a custom metric named "tip_amount"');
  });
});
