import { describe, expect, it } from "vitest";
import { auditSite, normUrl, parsePage, parseRobots, parseSitemap, propertyScope, type PageFetcher } from "./site-audit.js";
import { DEMO_SITE, DemoSearchConsole, demoPageFetch } from "./demo.js";
import { checkPageUrl, type PageResponse } from "./fetch-safe.js";

const H = "https://northwind-plumbing.example";

describe("site audit parsers", () => {
  it("scopes domain and URL-prefix properties", () => {
    const d = propertyScope("sc-domain:example.com");
    expect(d.start).toBe("https://example.com/");
    expect(d.inScope(new URL("https://blog.example.com/x"))).toBe(true);
    expect(d.inScope(new URL("https://notexample.com/"))).toBe(false);
    const p = propertyScope("https://www.example.com/shop/");
    expect(p.inScope(new URL("https://www.example.com/shop/a"))).toBe(true);
    expect(p.inScope(new URL("http://www.example.com/shop/a"))).toBe(true);
    expect(p.inScope(new URL("https://www.example.com/blog"))).toBe(false);
  });

  it("normalizes URLs", () => {
    expect(normUrl("/a#top", "https://Example.com/x")).toBe("https://example.com/a");
    expect(normUrl("mailto:x@y.z")).toBeNull();
    expect(normUrl("https://example.com:443/?q=1")).toBe("https://example.com/?q=1");
  });

  it("reads robots.txt: our group over *, longest rule wins, wildcards, sitemaps", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: Googlebot\nDisallow: /\nSitemap: https://e.com/s.xml");
    expect(r.allowed("https://e.com/private/x")).toBe(false);
    expect(r.allowed("https://e.com/private/ok/x")).toBe(true);
    expect(r.allowed("https://e.com/a.pdf")).toBe(false);
    expect(r.allowed("https://e.com/a.pdf?x")).toBe(true);
    expect(r.allowed("https://e.com/")).toBe(true);
    expect(r.sitemaps).toEqual(["https://e.com/s.xml"]);
    expect(parseRobots("User-agent: Camberstack\nDisallow: /\nUser-agent: *\nDisallow:").allowed("https://e.com/x")).toBe(false);
  });

  it("reads urlsets and sitemap indexes", () => {
    expect(parseSitemap(`<urlset><url><loc> https://e.com/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://e.com/b]]></loc></url></urlset>`).urls)
      .toEqual(["https://e.com/a?x=1&y=2", "https://e.com/b"]);
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>`)).toEqual({ urls: [], sitemaps: ["https://e.com/s1.xml"] });
  });

  it("reads a page's title, meta, canonical, h1s and links, ignoring scripts and comments", () => {
    const f = parsePage(`<html><head><base href="/en/"><title> A &amp; B </title><meta content="Desc" name="Description">
      <meta name="robots" content="NOINDEX, follow"><link rel="canonical" href="page"></head><body>
      <!-- <a href="/hidden"> --><script>var a = '<a href="/js">';</script>
      <h1>x</h1><h1 class="y">y</h1><a href="next">n</a><a href='https://other.com/'>o</a><a href="mailto:a@b.c">m</a><a href="#top">t</a></body></html>`,
    "https://e.com/x");
    expect(f.title).toBe("A & B");
    expect(f.description).toBe("Desc");
    expect(f.robots).toBe("noindex, follow");
    expect(f.canonical).toBe("https://e.com/en/page");
    expect(f.h1).toBe(2);
    expect(f.links.sort()).toEqual(["https://e.com/en/", "https://e.com/en/next", "https://other.com/"]);
  });

  it("finds a title streamed into the body (Next.js), but not an inline svg's", () => {
    const html = `<html><head><meta charset="utf-8"></head><body><svg><title>Icon</title></svg><div>x</div><title>Real &amp; streamed</title></body></html>`;
    expect(parsePage(html, "https://e.com/").title).toBe("Real & streamed");
    expect(parsePage(`<head><title>Head</title></head><body><title>Body</title></body>`, "https://e.com/").title).toBe("Head");
  });

  it("refuses unsafe page URLs", () => {
    expect(() => checkPageUrl("ftp://e.com/")).toThrow();
    expect(() => checkPageUrl("http://127.0.0.1/")).toThrow();
    expect(() => checkPageUrl("https://e.com:8443/")).toThrow();
    expect(() => checkPageUrl("https://intranet.local/")).toThrow();
    expect(checkPageUrl("http://e.com/a#b").toString()).toBe("http://e.com/a");
  });
});

describe("auditSite", () => {
  const sc = new DemoSearchConsole();
  const demo = () => auditSite({ site: DEMO_SITE, fetch: demoPageFetch, sitemapPaths: [`${H}/sitemap.xml`], maxPages: 100, indexSample: 10, limit: 50,
    inspect: (u) => sc.inspect(DEMO_SITE, u) });

  it("finds each problem planted in the demo site", async () => {
    const r = await demo();
    expect(r.crawl.complete).toBe(true);
    expect(r.broken.map((b) => b.url)).toEqual([`${H}/drains/old-guide`]);
    expect(r.broken[0]!.linked_from).toEqual([`${H}/drains`]);
    const chain = r.redirects.find((x) => x.url === `${H}/specials`)!;
    expect(chain).toMatchObject({ to: `${H}/offers/`, hops: 2, codes: [301, 301] });
    expect(r.noindex).toEqual([{ url: `${H}/sewer/camera`, in_sitemap: true, linked_from_count: 1 }]);
    expect(r.canonical).toEqual([expect.objectContaining({ url: `${H}/reviews`, canonical: `${H}/specials` })]);
    expect(r.canonical[0]!.problem).toContain("redirects");
    expect(r.titles.duplicates).toEqual([expect.objectContaining({ text: "Water Heaters | Northwind Plumbing", count: 2 })]);
    expect(r.titles.too_long.map((x) => x.url)).toEqual([`${H}/blog/noisy-water-heater`]);
    expect(r.descriptions.missing).toEqual([`${H}/drains/hydro-jetting`]);
    expect(r.sitemap.orphans).toEqual([`${H}/blog/winterize-pipes`]);
    expect(r.sitemap.indexable_not_in_sitemap).toEqual([`${H}/offers/`]);
    expect((r.sitemap.problems_in_sitemap as { url: string }[]).map((x) => x.url)).toEqual([`${H}/reviews`, `${H}/sewer/camera`]);
    expect(r.counts.missing_h1).toBe(0);
    // The orphan is checked first, and Google hasn't indexed it.
    expect(r.index_sample!.checked).toBe(10);
    expect((r.index_sample!.not_indexed as { url: string; coverage_state: string }[])[0]).toEqual(expect.objectContaining({
      url: `${H}/blog/winterize-pipes`, coverage_state: "Discovered - currently not indexed" }));
  });

  it("stops at max_pages and doesn't claim orphans from a partial crawl", async () => {
    const r = await auditSite({ site: DEMO_SITE, fetch: demoPageFetch, sitemapPaths: [], maxPages: 10, indexSample: 0, limit: 5 });
    expect(r.crawl.pages_fetched).toBe(10);
    expect(r.crawl.complete).toBe(false);
    expect(r.crawl.stopped_at).toBe("max_pages (10)");
    expect(r.counts.orphans).toBeNull();
    expect(r.sitemap.orphans).toContain("not checked");
    expect(r.index_sample).toBeUndefined();
  });

  it("obeys robots.txt, stays inside the property, and stops redirects that leave it", async () => {
    const seen: string[] = [];
    const page = (body: string): PageResponse => ({ status: 200, contentType: "text/html", xRobots: "", body, truncated: false, ms: 5 });
    const f: PageFetcher = async (u) => {
      seen.push(u);
      if (u === "https://e.com/robots.txt") return { ...page("User-agent: *\nDisallow: /secret"), contentType: "text/plain" };
      if (u === "https://e.com/sitemap.xml") return { ...page(""), status: 404 };
      if (u === "https://e.com/") return page(`<title>Home</title><a href="/secret/x">s</a><a href="https://other.com/">o</a><a href="/out">out</a><a href="/logo.png">i</a>`);
      if (u === "https://e.com/out") return { status: 302, location: "https://other.com/landing", contentType: "", xRobots: "", body: "", truncated: false, ms: 5 };
      throw new Error(`unexpected fetch ${u}`);
    };
    const r = await auditSite({ site: "sc-domain:e.com", fetch: f, sitemapPaths: [], maxPages: 50, indexSample: 0, limit: 10 });
    expect(seen).not.toContain("https://e.com/secret/x");
    expect(seen.some((u) => u.startsWith("https://other.com"))).toBe(false);
    expect(seen).not.toContain("https://e.com/logo.png");
    expect(r.crawl.blocked_by_robots).toBe(1);
    expect(r.redirects).toEqual([expect.objectContaining({ url: "https://e.com/out", to: "https://other.com/landing", leaves_property: true })]);
    expect(r.sitemap.indexable_not_in_sitemap).toBe("no sitemap found");
    expect(r.sitemap.sitemap_files).toEqual([{ sitemap: "https://e.com/sitemap.xml", problem: "HTTP 404" }]);
  });

  it("reads X-Robots-Tag noindex and fails clearly when the home page is unreachable", async () => {
    const r = await auditSite({ site: "sc-domain:e.com", sitemapPaths: [], maxPages: 5, indexSample: 0, limit: 5,
      fetch: async (u) => (u.endsWith("robots.txt") || u.endsWith("sitemap.xml") ? { status: 404, contentType: "", xRobots: "", body: "", truncated: false, ms: 1 }
        : { status: 200, contentType: "text/html", xRobots: "noindex", body: "<title>t</title>", truncated: false, ms: 1 }) });
    expect(r.noindex.map((x) => x.url)).toEqual(["https://e.com/"]);
    await expect(auditSite({ site: "sc-domain:down.com", sitemapPaths: [], maxPages: 5, indexSample: 0, limit: 5,
      fetch: async () => { throw new Error("connect ECONNREFUSED"); } })).rejects.toThrow(/Could not fetch https:\/\/down.com\//);
  });

  it("doesn't call a canonicalised ?utm_ variant a duplicate title", async () => {
    const page = (canon: string) => `<title>Home</title><meta name="description" content="d"><link rel="canonical" href="${canon}"><h1>h</h1>`;
    const r = await auditSite({ site: "sc-domain:e.com", sitemapPaths: [], maxPages: 10, indexSample: 0, limit: 5,
      fetch: async (u) => (u.endsWith("robots.txt") || u.endsWith("sitemap.xml") ? { status: 404, contentType: "", xRobots: "", body: "", truncated: false, ms: 1 }
        : { status: 200, contentType: "text/html", xRobots: "", truncated: false, ms: 1,
          body: page("https://e.com/") + (u === "https://e.com/" ? `<a href="/?utm_source=x">u</a>` : "") }) });
    expect(r.crawl.pages_fetched).toBe(2);
    expect(r.titles.duplicates).toEqual([]);
    expect(r.counts.duplicate_descriptions).toBe(0);
  });

  it("stops at the time budget", async () => {
    let t = 0;
    const r = await auditSite({ site: DEMO_SITE, fetch: async (u) => { t += 3000; return demoPageFetch(u); }, sitemapPaths: [], maxPages: 100,
      indexSample: 0, limit: 5, budgetMs: 10_000, now: () => t });
    expect(r.crawl.complete).toBe(false);
    expect(r.crawl.stopped_at).toBe("time limit");
  });
});
