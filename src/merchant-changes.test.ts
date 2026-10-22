import { describe, expect, it } from "vitest";
import { DEMO_MERCHANT, DemoMerchant, MerchantClient, OverrideStore, SOURCE_NAME, encodeKey, type Merchant } from "./merchant.js";
import { McChangeSchema, resolveMcChange, writeMc } from "./merchant-changes.js";
import { summarize } from "./changes.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const KEY = { offerId: "sku/1", contentLanguage: "en", feedLabel: "US" };
const PRIMARY = "accounts/5/dataSources/10";

/** A fake Merchant API with one primary feed and whatever data sources and inputs the calls leave behind. */
function fakeGoogle(o: { input?: string; rule?: object[] } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const sources: any[] = [{ name: PRIMARY, displayName: "Shop feed", input: o.input ?? "FILE",
    primaryProductDataSource: { defaultRule: { takeFromDataSources: o.rule ?? [{ self: true }] } } }];
  const f = (async (u: string, i?: RequestInit) => {
    const url = String(u).replace("https://merchantapi.googleapis.com/", ""), method = i?.method ?? "GET";
    const body = i?.body ? JSON.parse(String(i.body)) : undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.startsWith("datasources/v1/accounts/5/dataSources?")) return json({ dataSources: sources });
    if (method === "GET" && url === `datasources/v1/${PRIMARY}`) return json(sources[0]);
    if (method === "POST" && url === "datasources/v1/accounts/5/dataSources") {
      const s = { name: "accounts/5/dataSources/99", ...body, input: "API" };
      sources.push(s);
      return json(s);
    }
    if (method === "PATCH") { sources[0].primaryProductDataSource = body.primaryProductDataSource; return json(sources[0]); }
    if (url.startsWith("products/v1/accounts/5/products/")) return json({ dataSource: PRIMARY, productAttributes: { title: "Pump", price: { amountMicros: "10000000", currencyCode: "EUR" } } });
    if (url.startsWith("reports/v1/")) return json({ results: [{ productView: { offerId: "sku/1", languageCode: "en", feedLabel: "US" } },
      { productView: { offerId: "sku/1", languageCode: "en", feedLabel: "US" } }] });
    return json({});
  }) as typeof fetch;
  return { calls, sources, m: new MerchantClient(async () => "t", () => null, f, new OverrideStore()) };
}

describe("MerchantClient writes", () => {
  it("names products with unpadded base64url, so any offer id works", () => {
    expect(encodeKey({ offerId: "sku/123", contentLanguage: "en", feedLabel: "US" })).toBe("ZW5-VVN-c2t1LzEyMw");
  });

  it("creates its source once, puts it first in the feed's rule keeping what was there, then inserts the override", async () => {
    const g = fakeGoogle({ rule: [{ self: true }, { supplementalDataSourceName: "accounts/5/dataSources/7" }] });
    expect(await g.m.linkState("5", PRIMARY)).toEqual({ state: "will_link", label: "Shop feed" });
    await g.m.setOverrides("5", KEY, PRIMARY, { title: "Pump 2" });
    expect(g.calls.find((c) => c.method === "POST" && c.url === "datasources/v1/accounts/5/dataSources")!.body)
      .toEqual({ displayName: SOURCE_NAME, supplementalProductDataSource: {} });
    expect(g.calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", url: `datasources/v1/${PRIMARY}?updateMask=primaryProductDataSource.defaultRule`,
      body: { name: PRIMARY, primaryProductDataSource: { defaultRule: { takeFromDataSources: [
        { supplementalDataSourceName: "accounts/5/dataSources/99" }, { self: true }, { supplementalDataSourceName: "accounts/5/dataSources/7" }] } } } });
    const insert = g.calls.find((c) => c.url.includes("productInputs:insert"))!;
    expect(insert.url).toBe(`products/v1/accounts/5/productInputs:insert?dataSource=${encodeURIComponent("accounts/5/dataSources/99")}`);
    expect(insert.body).toEqual({ offerId: "sku/1", contentLanguage: "en", feedLabel: "US", productAttributes: { title: "Pump 2" } });
    expect(await g.m.overrides("5", KEY)).toEqual({ title: "Pump 2" });
    expect(await g.m.linkState("5", PRIMARY)).toMatchObject({ state: "linked" });

    // Second write: no new source, no second patch. Clearing deletes only Camberstack's input.
    g.calls.length = 0;
    await g.m.setOverrides("5", KEY, PRIMARY, null);
    expect(g.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(g.calls[1]!.url).toBe(`products/v1/accounts/5/productInputs/${encodeKey(KEY)}?dataSource=${encodeURIComponent("accounts/5/dataSources/99")}`);
    expect(await g.m.overrides("5", KEY)).toBeNull();
  });

  it("creates its own products in its own primary source, and deletes only from there", async () => {
    const g = fakeGoogle();
    await g.m.setOwnProduct("5", KEY, { title: "New" });
    expect(g.calls.find((c) => c.method === "POST" && c.url === "datasources/v1/accounts/5/dataSources")!.body)
      .toEqual({ displayName: "Camberstack products", primaryProductDataSource: {
        destinations: [{ destination: "SHOPPING_ADS", state: "ENABLED" }, { destination: "FREE_LISTINGS", state: "ENABLED" }] } });
    expect(g.calls.find((c) => c.url.includes("productInputs:insert"))!.url).toContain(encodeURIComponent("accounts/5/dataSources/99"));
    expect(await g.m.ownProducts("5")).toEqual([{ key: KEY, attrs: { title: "New" } }]);
    g.calls.length = 0;
    await g.m.setOwnProduct("5", KEY, null);
    expect(g.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(await g.m.ownProducts("5")).toEqual([]);
  });

  it("refuses feeds made in the Merchant Center UI or by autofeed, at propose", async () => {
    const g = fakeGoogle({ input: "UI" });
    expect((await g.m.linkState("5", PRIMARY)).state).toBe("cannot");
    await expect(resolveMcChange(g.m, "5", McChangeSchema.parse({ type: "set_product_attributes", offer_id: "sku/1", attributes: { title: "X" } })))
      .rejects.toThrow(/can't take Camberstack's overrides: it was made in the Merchant Center interface/);
  });

  it("prices in the product's own currency, and finds one product across its channels", async () => {
    const g = fakeGoogle();
    const r = await resolveMcChange(g.m, "5", McChangeSchema.parse({ type: "set_product_attributes", offer_id: "sku/1", attributes: { price: 9.5 } }));
    expect(r.describe).toContain("price 10.00 EUR → 9.50 EUR");
    expect(r.operations[0]!.overrides).toEqual({ price: { amountMicros: "9500000", currencyCode: "EUR" } });
  });
});

describe("Merchant Center changes (demo)", () => {
  const fresh = (): Merchant => new DemoMerchant();
  const resolve = (m: Merchant, c: object) => resolveMcChange(m, DEMO_MERCHANT, McChangeSchema.parse(c));

  it("keeps earlier overrides when adding one, and undo restores exactly the earlier set", async () => {
    const m = fresh();
    const a = await resolve(m, { type: "set_product_attributes", offer_id: "NW-GD-34", attributes: { gtin: "0012345678905" } });
    await writeMc(m, DEMO_MERCHANT, a.operations);
    const b = await resolve(m, { type: "set_product_attributes", offer_id: "NW-GD-34", attributes: { title: "Garbage Disposal 3/4 HP, Quiet" } });
    expect(b.operations[0]!.overrides).toEqual({ gtins: ["0012345678905"], title: "Garbage Disposal 3/4 HP, Quiet" });
    await writeMc(m, DEMO_MERCHANT, b.operations);
    const undo = await resolve(m, b.inverse!);
    await writeMc(m, DEMO_MERCHANT, undo.operations);
    expect(await m.overrides(DEMO_MERCHANT, { offerId: "NW-GD-34", contentLanguage: "en", feedLabel: "US" })).toEqual({ gtins: ["0012345678905"] });
  });

  it("includes again only what Camberstack excluded, and keeps the product's other overrides", async () => {
    const m = fresh();
    await writeMc(m, DEMO_MERCHANT, (await resolve(m, { type: "set_product_attributes", offer_id: "NW-SP-12", attributes: { brand: "Zoeller Co" } })).operations);
    const ex = await resolve(m, { type: "exclude_products", offer_ids: ["NW-SP-12"], destinations: ["SHOPPING_ADS", "FREE_LISTINGS"] });
    await writeMc(m, DEMO_MERCHANT, ex.operations);
    const inc = await resolve(m, { type: "include_products", offer_ids: ["NW-SP-12", "NW-FV-01"], destinations: ["SHOPPING_ADS"] });
    expect(inc.describe).toContain("Include again 1 product in shopping ads: NW-SP-12 (1 already not excluded by Camberstack: NW-FV-01)");
    expect(inc.operations[0]!.overrides).toEqual({ brand: "Zoeller Co", excludedDestinations: ["FREE_LISTINGS"] });
  });

  it("says the one-time feed link once per proposal, not once per product", async () => {
    const m = fresh();
    const rs = [await resolve(m, { type: "set_product_attributes", offer_id: "NW-TWH-50", attributes: { price: 1099 } }),
      await resolve(m, { type: "set_product_attributes", offer_id: "NW-TWH-38", attributes: { price: 499 } })];
    expect(summarize(rs).match(/ahead of feed/g)).toHaveLength(1);
  });

  it("clears every override, and says when there's nothing to clear", async () => {
    const m = fresh();
    expect((await resolve(m, { type: "clear_product_overrides", offer_id: "NW-SP-12" })).operations).toEqual([]);
    await writeMc(m, DEMO_MERCHANT, (await resolve(m, { type: "set_product_attributes", offer_id: "NW-SP-12", attributes: { brand: "Z" } })).operations);
    const c = await resolve(m, { type: "clear_product_overrides", offer_id: "NW-SP-12" });
    expect(c.describe).toContain("remove Camberstack's overrides (brand)");
    expect(c.operations[0]!.overrides).toBeNull();
  });

  it("creates, updates and deletes Camberstack's own products, each undoable, and won't take one from the feed", async () => {
    const m = fresh();
    const attrs = { title: "Shutoff Valve", link: "https://northwind-plumbing.example/p/sv", image_link: "https://northwind-plumbing.example/sv.jpg",
      price: 12.5, availability: "IN_STOCK" };
    await expect(resolve(m, { type: "add_product", offer_id: "NW-SP-12", attributes: attrs })).rejects.toThrow(/already in this account's feed/);
    const add = await resolve(m, { type: "add_product", offer_id: "NW-NEW-1", attributes: attrs });
    expect(add.describe).toContain('Add product NW-NEW-1 ("Shutoff Valve") to Merchant Center, 12.50 USD, in stock');
    await writeMc(m, DEMO_MERCHANT, add.operations);
    await expect(resolve(m, { type: "add_product", offer_id: "NW-NEW-1", attributes: attrs })).rejects.toThrow(/use update_product/);
    await expect(resolve(m, { type: "set_product_attributes", offer_id: "NW-NEW-1", attributes: { brand: "X" } })).rejects.toThrow(/use update_product/);

    const upd = await resolve(m, { type: "update_product", offer_id: "NW-NEW-1", attributes: { price: 11 } });
    expect(upd.describe).toContain("price 12.50 USD → 11.00 USD");
    await writeMc(m, DEMO_MERCHANT, upd.operations);
    // Undoing an update puts the product back (seen live: a key-order mismatch read it as missing, so undoing that undo would have deleted it).
    const putBack = await resolve(m, upd.inverse!);
    expect(putBack.describe).toBe('Put back product NW-NEW-1 ("Shutoff Valve") as it was: price');
    expect(putBack.inverse).toMatchObject({ products: [{ attributes: { price: { amountMicros: "11000000" } } }] });
    const del = await resolve(m, { type: "delete_product", offer_id: "NW-NEW-1" });
    await writeMc(m, DEMO_MERCHANT, del.operations);
    expect(await m.ownProducts(DEMO_MERCHANT)).toEqual([]);
    const back = await resolve(m, del.inverse!);
    expect(back.describe).toContain('Re-create product NW-NEW-1 ("Shutoff Valve") as it was');
    await writeMc(m, DEMO_MERCHANT, back.operations);
    expect((await m.ownProducts(DEMO_MERCHANT))[0]!.attrs.price).toEqual({ amountMicros: "11000000", currencyCode: "USD" });
    // And the product shows up like any other.
    expect((await m.search(DEMO_MERCHANT, "SELECT id, offer_id FROM product_view WHERE offer_id = 'NW-NEW-1'", 5)).rows).toHaveLength(1);

    await expect(resolve(m, { type: "delete_product", offer_id: "NW-SP-12" })).rejects.toThrow(/isn't a product Camberstack created/);
  });
});
