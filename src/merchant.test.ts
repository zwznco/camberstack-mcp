import { describe, expect, it } from "vitest";
import { NotGrantedError } from "./google.js";
import { DEMO_MERCHANT, DemoMerchant, MerchantClient, listMerchantAccounts, merchantReport, productIssues, type Merchant } from "./merchant.js";
import { toolCatalog } from "./tools.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const client = (f: (url: string, init?: RequestInit) => Response) =>
  new MerchantClient(async () => "t", () => "https://camberstack.io/connect/merchant-center?t=x", (async (u: string, i?: RequestInit) => f(String(u), i)) as typeof fetch);

describe("MerchantClient", () => {
  it("lists accounts across pages", async () => {
    const m = client((u) => (u.includes("pageToken=p2")
      ? json({ accounts: [{ name: "accounts/2", accountId: "2", accountName: "Shop B", testAccount: true }] })
      : json({ accounts: [{ name: "accounts/1", accountId: "1", accountName: "Shop A" }], nextPageToken: "p2" })));
    expect(await m.accounts()).toEqual([{ account_id: "1", name: "Shop A" }, { account_id: "2", name: "Shop B", test_account: true }]);
  });

  it("pages a report and unwraps each row's view", async () => {
    const sent: any[] = [];
    const m = client((u, i) => {
      const b = JSON.parse(String(i!.body));
      sent.push(b);
      expect(u).toBe("https://merchantapi.googleapis.com/reports/v1/accounts/5/reports:search");
      return b.pageToken ? json({ results: [{ productView: { offerId: "b" } }] }) : json({ results: [{ productView: { offerId: "a" } }], nextPageToken: "n" });
    });
    expect(await m.search("5", "SELECT id FROM product_view", 10)).toEqual({ rows: [{ offerId: "a" }, { offerId: "b" }], truncated: false });
    expect(sent.map((b) => b.pageToken)).toEqual([undefined, "n"]);
  });

  it("stops at maxRows and says so", async () => {
    const m = client(() => json({ results: [{ productView: { offerId: "a" } }, { productView: { offerId: "b" } }], nextPageToken: "n" }));
    expect(await m.search("5", "SELECT id FROM product_view", 2)).toEqual({ rows: [{ offerId: "a" }, { offerId: "b" }], truncated: true });
  });

  it("says Merchant Center isn't granted, with the grant link, instead of a raw 403", async () => {
    const m = client(() => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    await expect(m.accounts()).rejects.toBeInstanceOf(NotGrantedError);
    const out = await listMerchantAccounts(m);
    expect(out.accounts).toEqual([{ account_id: DEMO_MERCHANT, name: expect.stringContaining("DEMO") }]);
    expect(out.grant_url).toContain("/connect/merchant-center");
  });

  it("blames an unregistered Cloud project on Camberstack, not the user", async () => {
    const m = client(() => json({ error: { code: 401, status: "UNAUTHENTICATED",
      message: "GCP project with id x and number 1 is not registered with the merchant account." } }, 401));
    await expect(m.accounts()).rejects.toThrow(/Camberstack's to fix, not the user's/);
  });

  it("also blames a registration missing its API developer on Camberstack", async () => {
    const m = client(() => json({ error: { code: 401, message: "GCP project with id camberstack and number 1 is registered but it should have at least one user with 'API_DEVELOPER' role." } }, 401));
    await expect(m.accounts()).rejects.toThrow(/Camberstack's to fix, not the user's/);
  });

  it("points an account the login can't reach at merchant_accounts (Google answers 401)", async () => {
    const m = client(() => json({ error: { code: 401, message: "The caller does not have access to the accounts: [123456789]" } }, 401));
    await expect(m.accountIssues("123456789")).rejects.toThrow(/use an account_id from merchant_accounts/);
  });

  it("says an account without signed terms needs its admin to accept them (seen live on a new test account)", async () => {
    const m = client(() => json({ error: { code: 403, message: "Terms of Service is not signed for account 5." } }, 403));
    await expect(m.accountIssues("5")).rejects.toThrow(/accepts them\. Camberstack doesn't accept terms/);
  });

  it("points a report on an advanced account at its sub-accounts", async () => {
    const m = client(() => json({ error: { code: 400, message: "Reports are not available for advanced accounts." } }, 400));
    await expect(m.search("7", "SELECT id FROM product_view", 5)).rejects.toThrow(/sub-account's account_id from merchant_accounts/);
  });
});

describe("Merchant Center tools on the demo account", () => {
  const demo = new DemoMerchant();

  it("summarizes issues worst first, with counts and examples", async () => {
    const r = await productIssues(demo, DEMO_MERCHANT, { examples: 2 });
    expect(r.note).toMatch(/demo/i);
    expect(r.account_issues[0]).toMatchObject({ title: "Missing return policy", severity: "ERROR" });
    expect(r.status_counts).toEqual({ NOT_ELIGIBLE_OR_DISAPPROVED: 4, ELIGIBLE_LIMITED: 3, ELIGIBLE: 4, PENDING: 1 });
    expect(r.issues!.map((i) => [i.code, i.severity, i.products])).toEqual([
      ["price_mismatch", "DISAPPROVED", 2], ["image_too_small", "DISAPPROVED", 2], ["missing_gtin", "DEMOTED", 3], ["pending_initial_policy_review", "PENDING", 1]]);
    expect(r.issues![0]!.examples).toEqual([{ offer_id: "NW-TWH-50", title: expect.any(String) }, { offer_id: "NW-TWH-38", title: expect.any(String) }]);
  });

  it("gives one product's issues in full, and says when the offer_id doesn't exist", async () => {
    const r = await productIssues(demo, DEMO_MERCHANT, { offer_id: "NW-GD-34", examples: 5 });
    expect(r.products).toEqual([{ id: "online~en~US~NW-GD-34", offerId: "NW-GD-34", title: expect.any(String), aggregatedReportingContextStatus: "ELIGIBLE_LIMITED",
      itemIssues: [{ type: { code: "missing_gtin", canonicalAttribute: "gtin" }, severity: { aggregatedSeverity: "DEMOTED" }, resolution: "MERCHANT_ACTION" }] }]);
    await expect(productIssues(demo, DEMO_MERCHANT, { offer_id: "nope", examples: 5 })).rejects.toThrow(/No product with offer_id nope/);
  });

  it("shows the disapproved best sellers' ad clicks stopping (the story the demo tells)", async () => {
    const r = await merchantReport(demo, DEMO_MERCHANT, "SELECT offer_id, clicks FROM product_performance_view WHERE date DURING LAST_7_DAYS AND marketing_method = 'ADS' ORDER BY clicks DESC", 50);
    const clicks = Object.fromEntries(r.rows.map((x) => [x.offerId, x.clicks]));
    expect(clicks["NW-TWH-50"]).toBe(0);
    expect(clicks["NW-SP-12"]).toBeGreaterThan(0);
    expect(r.rows[0]!.offerId).toBe("NW-SP-12");
    const before = await merchantReport(demo, DEMO_MERCHANT,
      "SELECT offer_id, clicks FROM product_performance_view WHERE date BETWEEN '2026-01-01' AND '2026-01-07' AND offer_id = 'NW-TWH-50'", 50);
    expect(before.rows[0]!.clicks).toBeGreaterThan(0);
  });

  it("refuses what isn't a read, and performance queries without dates", async () => {
    await expect(merchantReport(demo, DEMO_MERCHANT, "DELETE FROM product_view", 10)).rejects.toThrow(/Only SELECT/);
    await expect(merchantReport(demo, DEMO_MERCHANT, "SELECT clicks FROM product_performance_view", 10)).rejects.toThrow(/date range/);
  });

  it("offers the demo account when the login has none", async () => {
    const none: Merchant = { accounts: async () => [], accountIssues: async () => [], search: async () => ({ rows: [], truncated: false }) };
    expect((await listMerchantAccounts(none)).accounts[0]!.account_id).toBe(DEMO_MERCHANT);
  });
});

describe("rollout", () => {
  it("lists the Merchant Center tools only when enabled", () => {
    const names = (o?: { merchant?: boolean }) => toolCatalog(o).map((t) => t.name).filter((n) => n.startsWith("merchant_"));
    expect(names()).toEqual([]);
    expect(names({ merchant: true })).toEqual(["merchant_accounts", "merchant_product_issues", "merchant_report", "merchant_ad_spend"]);
  });
});
