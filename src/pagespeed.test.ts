import { describe, expect, it } from "vitest";
import { DAILY_PAGES, PageSpeedClient, isDemoUrl, summarize } from "./pagespeed.js";
import { openDb } from "./db.js";

/** The parts of a PageSpeed Insights v5 response pagespeed.ts reads (Lighthouse 12 shape). */
const psi = (o: { pageField?: boolean; runtimeError?: boolean } = {}) => ({
  loadingExperience: o.pageField === false
    ? { id: "https://shop.test", origin_fallback: true, metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100 }, INTERACTION_TO_NEXT_PAINT: { percentile: 150 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 } } }
    : { id: "https://shop.test/landing", metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4600, category: "SLOW" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 2000 },
    } },
  originLoadingExperience: { id: "https://shop.test", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1 } } },
  lighthouseResult: {
    finalDisplayedUrl: "https://shop.test/landing",
    ...(o.runtimeError ? { runtimeError: { code: "ERRORED_DOCUMENT_REQUEST", message: "Status code: 404" } } : {}),
    categories: { performance: { score: 0.42, auditRefs: [
      { id: "largest-contentful-paint", group: "metrics" },
      { id: "cumulative-layout-shift", group: "metrics" },
      { id: "total-blocking-time", group: "metrics" },
      { id: "render-blocking-insight", group: "insights" },
      { id: "image-delivery-insight", group: "insights" },
      { id: "cls-culprits-insight", group: "insights" },
      { id: "dom-size-insight", group: "insights" },
      { id: "cache-insight", group: "insights" },
      { id: "network-dependency-tree-insight", group: "insights" },
      { id: "uses-http2", group: "hidden" },
    ] } },
    audits: {
      "largest-contentful-paint": { numericValue: 5123.4, score: 0.1 },
      "cumulative-layout-shift": { numericValue: 0.13456, score: 0.7 },
      "total-blocking-time": { numericValue: 612.2, score: 0.4 },
      "render-blocking-insight": { title: "Render blocking requests", score: 0, scoreDisplayMode: "metricSavings", metricSavings: { FCP: 900, LCP: 900 } },
      "image-delivery-insight": { title: "Improve image delivery", score: 0, scoreDisplayMode: "metricSavings", displayValue: "Est savings of 820 KiB", metricSavings: { LCP: 2400 } },
      "cls-culprits-insight": { title: "Layout shift culprits", score: 0, scoreDisplayMode: "metricSavings", metricSavings: { CLS: 0.12 } },
      "cache-insight": { title: "Use efficient cache lifetimes", score: 0.5, scoreDisplayMode: "metricSavings", displayValue: "Est savings of 25 KiB", metricSavings: { LCP: 0 } },
      "dom-size-insight": { title: "Optimize DOM size", score: 1, scoreDisplayMode: "metricSavings", metricSavings: {} },
      "network-dependency-tree-insight": { title: "Network dependency tree", score: null, scoreDisplayMode: "informative" },
      "uses-http2": { title: "Use HTTP/2", score: 0, scoreDisplayMode: "metricSavings", metricSavings: { LCP: 9000 } },
    },
  },
});

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("landing page speed", () => {
  it("reads field data, rates it by Google's thresholds, and ranks fixes by saving", () => {
    const r = summarize("https://shop.test/landing", "mobile", psi(), 5);
    expect(r.field).toEqual({ scope: "page", passes_core_web_vitals: false, metrics: {
      lcp_ms: { value: 4600, rating: "poor" }, inp_ms: { value: 180, rating: "good" },
      cls: { value: 0.12, rating: "needs improvement" }, fcp_ms: { value: 2000, rating: "needs improvement" } } });
    expect(r.lab).toEqual({ performance_score: 42, metrics: { lcp_ms: 5123, cls: 0.135, tbt_ms: 612 } });
    // Hidden, passing, informative and no-time-saved audits are left out; CLS savings rank by weight, not as milliseconds.
    expect(r.fixes.map((f) => f.id)).toEqual(["image-delivery-insight", "render-blocking-insight", "cls-culprits-insight"]);
    expect(r.fixes[0]).toEqual({ id: "image-delivery-insight", title: "Improve image delivery", detail: "Est savings of 820 KiB", saves: "LCP 2.4s" });
    expect(r.fixes[2]!.saves).toBe("CLS 0.12");
    expect(summarize("https://shop.test/landing", "mobile", psi(), 1).fixes).toHaveLength(1);
  });

  it("says when the page has too little traffic and the whole site's data stands in", () => {
    const r = summarize("https://shop.test/landing", "mobile", psi({ pageField: false }), 5);
    expect(r.field?.scope).toBe("site");
    expect(r.field?.passes_core_web_vitals).toBe(true);
  });

  it("can't call Core Web Vitals passed or failed with a metric missing", () => {
    const r = summarize("https://a.test/", "mobile", { loadingExperience: { id: "https://a.test/", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1000 } } } }, 5);
    expect(r.field?.passes_core_web_vitals).toBeNull();
    expect(r.lab).toBeNull();
  });

  it("passes on Lighthouse's reason when the page wouldn't load", () => {
    const r = summarize("https://shop.test/landing", "mobile", psi({ runtimeError: true }), 5);
    expect(r.lab).toBeNull();
    expect(r.error).toContain("Status code: 404");
  });

  it("sends the key and strategy, and reports a failed page without failing the others", async () => {
    const seen: string[] = [];
    const f = (async (u: string) => {
      seen.push(u);
      return u.includes("bad.test") ? new Response(JSON.stringify({ error: { code: 400, message: "Unable to resolve host" } }), { status: 400 })
        : new Response(JSON.stringify(psi()), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await new PageSpeedClient("k1", f).check(["https://shop.test/landing", "https://bad.test/"], { strategy: "desktop", fixes: 5 });
    expect(seen[0]).toContain("key=k1");
    expect(seen[0]).toContain("strategy=desktop");
    expect(out.pages[0]!.lab?.performance_score).toBe(42);
    expect(out.pages[1]!.error).toContain("Unable to resolve host");
    expect(out.note).not.toContain("demo");
  });

  it("throws when every page fails, so the call logs as failed", async () => {
    await expect(new PageSpeedClient("k", reply(429, { error: { message: "Quota" } })).check(["https://a.test/"], { strategy: "mobile", fixes: 5 }))
      .rejects.toThrow(/over its quota/);
    await expect(new PageSpeedClient(undefined).check(["https://a.test/"], { strategy: "mobile", fixes: 5 })).rejects.toThrow(/connected Google account/);
  });

  it("uses the user's Google token when there is no API key", async () => {
    let auth: string | undefined, url = "";
    const f = (async (u: string, init: RequestInit) => { url = u; auth = (init.headers as Record<string, string>).Authorization; return new Response(JSON.stringify(psi())); }) as unknown as typeof fetch;
    await new PageSpeedClient(undefined, f).check(["https://shop.test/landing"], { strategy: "mobile", fixes: 5, token: async () => "tok" });
    expect(auth).toBe("Bearer tok");
    expect(url).not.toContain("key=");
  });

  it("caps real pages per user per day, counting none that were refused and no demo pages", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify(psi())); }) as unknown as typeof fetch;
    const c = new PageSpeedClient(undefined, f, db);
    const run = (urls: string[], userId = "u1") => c.check(urls, { strategy: "mobile", fixes: 1, token: async () => "t", userId });
    const five = Array.from({ length: 5 }, (_, i) => `https://shop.test/p${i}`);
    for (let i = 0; i < DAILY_PAGES / 5 - 1; i++) await run(five);
    await run(["https://shop.test/a", "https://shop.test/b", "https://northwind-plumbing.example/"]);
    await expect(run(five)).rejects.toThrow(`Daily page speed limit reached: ${DAILY_PAGES - 3} of ${DAILY_PAGES} pages tested today (UTC); 3 left`);
    await run(["https://shop.test/c", "https://shop.test/d", "https://shop.test/e"]);
    await expect(run(["https://shop.test/f"])).rejects.toThrow("resets at midnight UTC");
    await run(["https://northwind-plumbing.example/"]);  // the demo is never capped
    await run(["https://shop.test/x"], "u2");  // per user
    expect(calls).toBe(DAILY_PAGES + 1);
  });

  it("answers the demo site with sample data, without a key or a request", async () => {
    expect(isDemoUrl("https://www.northwind-plumbing.example/x")).toBe(true);
    expect(isDemoUrl("https://northwind-plumbing.example.evil.test/")).toBe(false);
    const f = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;
    const out = await new PageSpeedClient(undefined, f).check(["https://northwind-plumbing.example/", "https://northwind-plumbing.example/services/water-heaters"], { strategy: "mobile", fixes: 5 });
    expect(out.note).toContain("Sample results");
    expect(out.pages[0]!.field?.passes_core_web_vitals).toBe(true);
    expect(out.pages[1]!.field?.passes_core_web_vitals).toBe(false);
    expect(out.pages[1]!.lab!.performance_score).toBeLessThan(out.pages[0]!.lab!.performance_score!);
  });
});
