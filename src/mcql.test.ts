import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { checkMcql, mcqlCatalog, parseDiscovery, resetMcqlCatalog, snake } from "./mcql.js";
import { DEMO_MERCHANT, DemoMerchant, merchantReport, type Merchant } from "./merchant.js";
import { MerchantApiError } from "./google.js";
import { queryShape } from "./gaql.js";

// Google's reports_v1 discovery document (revision 20261118), trimmed to the schemas ReportRow reaches.
const doc = JSON.parse(readFileSync(new URL("./fixtures/merchant-reports-discovery.json", import.meta.url), "utf8"));
const cat = parseDiscovery(doc);
const check = (q: string) => checkMcql(q, cat);

describe("parseDiscovery", () => {
  it("reads every view with snake_case names and Google's own requirements", () => {
    expect([...cat.keys()]).toEqual(expect.arrayContaining(["product_view", "product_performance_view", "price_competitiveness_product_view",
      "price_insights_product_view", "best_sellers_product_cluster_view", "best_sellers_brand_view"]));
    expect(cat.get("product_performance_view")!.has("custom_label0")).toBe(true);
    expect(cat.get("product_view")!.get("id")!.requiredInSelect).toBe(true);
    expect(cat.get("product_performance_view")!.get("date")!.requiredInWhere).toBe(true);
    const g = cat.get("best_sellers_product_cluster_view")!.get("report_granularity")!;
    expect(g).toMatchObject({ requiredInSelect: true, requiredInWhere: true, enumValues: ["WEEKLY", "MONTHLY"] });
    // "If a WHERE condition on report_date is not specified…": optional, not required.
    expect(cat.get("best_sellers_product_cluster_view")!.get("report_date")!.requiredInWhere).toBe(false);
  });
  it("snake_cases like MCQL", () => {
    expect(["categoryL1", "customLabel0", "clickThroughRate", "id"].map(snake)).toEqual(["category_l1", "custom_label0", "click_through_rate", "id"]);
  });
});

describe("checkMcql", () => {
  it("names every best-sellers requirement at once (#47570–#47573 found them one per error)", () => {
    const f = check("SELECT title, brand, rank FROM best_sellers_product_cluster_view ORDER BY rank");
    expect(f).toEqual([
      "best_sellers_product_cluster_view needs report_category_id, report_country_code, report_date, report_granularity in SELECT.",
      "best_sellers_product_cluster_view needs a WHERE condition on report_country_code, report_granularity ('WEEKLY' or 'MONTHLY').",
    ]);
  });
  it("finds nothing in a query Google accepts (checked on dev, 2026-11-25)", () => {
    expect(check("SELECT report_date, report_granularity, report_country_code, report_category_id, title, brand, rank, relative_demand "
      + "FROM best_sellers_product_cluster_view WHERE report_granularity = 'WEEKLY' AND report_country_code = 'US' ORDER BY rank")).toEqual([]);
    expect(check("SELECT report_date, report_granularity, report_country_code, report_category_id, brand, rank FROM best_sellers_brand_view "
      + "WHERE report_granularity = 'MONTHLY' AND report_country_code = 'US' ORDER BY rank")).toEqual([]);
    expect(check("SELECT id, report_country_code, title, price, benchmark_price FROM price_competitiveness_product_view")).toEqual([]);
    expect(check("SELECT id, title, price, suggested_price, effectiveness, predicted_clicks_change_fraction FROM price_insights_product_view")).toEqual([]);
    expect(check("SELECT product_view.id, price FROM product_view")).toEqual([]);
    expect(check("SELECT offer_id, title, clicks, impressions FROM product_performance_view WHERE date DURING LAST_30_DAYS AND marketing_method = 'ADS' ORDER BY clicks DESC LIMIT 50")).toEqual([]);
  });
  it("lists the view's real fields for an unknown name (#39172 mpn, #47501 price_micros)", () => {
    const [f] = check("SELECT id, title, mpn, price_micros FROM product_view");
    expect(f).toMatch(/^mpn, price_micros aren't fields of product_view\. Its fields: /);
    expect(f).toContain("gtin");
    expect(f).toContain("offer_id");
  });
  it("says a nested name is selected whole (price.amount_micros, rejected on dev)", () => {
    expect(check("SELECT id, price.amount_micros FROM product_view")).toEqual([expect.stringMatching(/price\.amount_micros: MCQL selects price whole \(it returns amountMicros, currencyCode\)/)]);
  });
  it("names the price views' required fields (#47174)", () => {
    expect(check("SELECT title, price, benchmark_price FROM price_competitiveness_product_view")).toEqual(["price_competitiveness_product_view needs id, report_country_code in SELECT."]);
  });
  it("names the views for an unknown one, and doesn't count a quoted value as a field or condition", () => {
    expect(check("SELECT id FROM products")[0]).toMatch(/^FROM products: there is no such view\. The views are .*product_view/);
    expect(check("SELECT offer_id, clicks FROM product_performance_view WHERE title = 'date'")).toEqual(["product_performance_view needs a WHERE condition on date."]);
  });
});

describe("merchantReport with the field list", () => {
  beforeEach(() => resetMcqlCatalog());
  const failing = (err: Error): Merchant => ({ search: async () => { throw err; } } as unknown as Merchant);
  const findings = async (q: string) => checkMcql(q, cat);

  it("adds every finding to Google's 400, which names only one", async () => {
    const err = new MerchantApiError("Merchant API 400: [query] Error in query: query from table 'best_sellers_product_cluster_view' is expected to have 'best_sellers_product_cluster_view.report_category_id' field in SELECT clause", 400);
    await expect(merchantReport(failing(err), "5", "SELECT title, rank FROM best_sellers_product_cluster_view", 10, findings))
      .rejects.toThrow(/expected to have[\s\S]*\nGoogle's Merchant field list: .*report_granularity in SELECT\. .*WHERE condition on .*report_granularity/);
  });
  it("leaves other errors alone, and a 400 when the list finds nothing or can't be had", async () => {
    const auth = new MerchantApiError("Merchant API 403: no access", 403);
    await expect(merchantReport(failing(auth), "5", "SELECT title FROM best_sellers_product_cluster_view", 10, findings)).rejects.toThrow(/^Merchant API 403: no access$/);
    const bad = () => new MerchantApiError("Merchant API 400: something else", 400);
    await expect(merchantReport(failing(bad()), "5", "SELECT product_view.id, price FROM product_view", 10, findings)).rejects.toThrow(/^Merchant API 400: something else$/);
    await expect(merchantReport(failing(bad()), "5", "SELECT mpn FROM product_view", 10, async () => { throw new Error("down"); })).rejects.toThrow(/^Merchant API 400: something else$/);
  });
  it("checks a query Google ran without showing findings (a finding there is a checker bug), never on the demo account", async () => {
    const seen: string[] = [];
    const spy = async (q: string) => { seen.push(q); return ["a finding"]; };
    const ok: Merchant = { search: async () => ({ rows: [{ id: "x" }], truncated: false }) } as unknown as Merchant;
    const r = await merchantReport(ok, "5", "SELECT id FROM product_view", 10, spy);
    expect(r).toEqual({ account_id: "5", row_count: 1, rows: [{ id: "x" }] });
    expect(seen).toEqual(["SELECT id FROM product_view"]);
    await merchantReport(new DemoMerchant(), DEMO_MERCHANT, "SELECT id, title FROM product_view", 10, spy);
    expect(seen).toHaveLength(1);
  });
  it("caches the catalog, and retries a failed fetch only after a while", async () => {
    let calls = 0;
    const ok = async () => { calls++; return doc; };
    expect((await mcqlCatalog(ok))!.size).toBeGreaterThan(5);
    await mcqlCatalog(ok);
    expect(calls).toBe(1);
    resetMcqlCatalog();
    let fails = 0;
    expect(await mcqlCatalog(async () => { fails++; throw new Error("x"); })).toBeNull();
    expect(await mcqlCatalog(async () => { fails++; return doc; })).toBeNull();
    expect(fails).toBe(1);
  });
});

describe("merchant_report's usage-log shape (gaql.ts queryShape)", () => {
  it("keeps field and view names and drops every value", () => {
    expect(queryShape("SELECT offer_id, title, custom_label0, category_l1, clicks FROM product_performance_view "
      + "WHERE date BETWEEN '2026-11-01' AND '2026-11-24' AND offer_id = 'SKU-123' AND brand = 'Bob\\'s' AND clicks > 5 ORDER BY clicks DESC LIMIT 50"))
      .toBe("SELECT offer_id, title, custom_label0, category_l1, clicks FROM product_performance_view WHERE date BETWEEN ? AND ? AND offer_id = ? AND brand = ? AND clicks > ? ORDER BY clicks DESC LIMIT ?");
    expect(queryShape("SELECT report_date, rank FROM best_sellers_brand_view WHERE report_granularity = 'WEEKLY' AND report_category_id = 166"))
      .toBe("SELECT report_date, rank FROM best_sellers_brand_view WHERE report_granularity = ? AND report_category_id = ?");
  });
});
