/**
 * Merchant Center changes: product attribute overrides (fix a price, add a GTIN, retitle) and excluding or including
 * products in Shopping ads and free listings. They go through the same propose → approve → apply → undo cycle as Google
 * Ads changes (session.ts), stored as proposals whose customer_id is `mc:<account id>`.
 *
 * Products Camberstack creates (add_product) live in its own primary data source, "Camberstack products", and only
 * those can be updated in place or deleted; a product from the merchant's feed is changed by override only, since
 * the feed (a file, Shopify, …) would overwrite anything else on its next sync. Adding an offer_id another feed
 * already has is refused: Google would move that product into Camberstack's source ("offer stealing").
 *
 * Camberstack never edits the merchant's products in their own feed (a file, Shopify, the Content API). Every change is
 * an override in Camberstack's own supplemental data source, which Merchant Center layers on top of the feed: the feed
 * keeps its values, and clearing the override brings them back. Google applies a supplemental source only once it's in
 * the primary source's rules, so the first override on a feed's products also puts Camberstack's source first in that
 * feed's rules: a visible line in the summary, done once. Undo removes the overrides; the link stays and, with nothing
 * in it, changes nothing. Google can't read an override back, so Camberstack keeps a copy of what it holds per product
 * (merchant.ts OverrideStore), and undo restores exactly that.
 */
import { z } from "zod";
import { PRODUCTS_SOURCE_NAME, SOURCE_NAME, type Merchant, type Overrides, type ProductKey } from "./merchant.js";

export const MC_PREFIX = "mc:";
export const mcTarget = (accountId: string) => `${MC_PREFIX}${accountId}`;
export const isMcTarget = (target: string) => target.startsWith(MC_PREFIX);

/** Attributes Camberstack can override, as the tools name them → the Merchant API's productAttributes field. */
export const ATTRIBUTES = {
  title: "title", description: "description", link: "link", image_link: "imageLink", brand: "brand", gtin: "gtins", mpn: "mpn",
  price: "price", sale_price: "salePrice", availability: "availability", condition: "condition",
  google_product_category: "googleProductCategory", product_type: "productTypes", identifier_exists: "identifierExists",
  custom_label_0: "customLabel0", custom_label_1: "customLabel1", custom_label_2: "customLabel2", custom_label_3: "customLabel3",
  custom_label_4: "customLabel4", excluded_destinations: "excludedDestinations",
} as const;
export type Attr = keyof typeof ATTRIBUTES;

/** Where a product can show, as Merchant Center names it. */
const DESTINATIONS = ["SHOPPING_ADS", "DISPLAY_ADS", "LOCAL_INVENTORY_ADS", "FREE_LISTINGS", "FREE_LOCAL_LISTINGS", "YOUTUBE_SHOPPING"] as const;
const destination = z.enum(DESTINATIONS);
const offerId = z.string().min(1).max(150).regex(/^[^'\\]+$/, "no quotes or backslashes").describe("The product's ID as in the feed (offer_id)");
const money = z.number().positive().max(1_000_000).describe("Amount in the product's currency, e.g. 1099.99");

const attributesShape = {
  title: z.string().min(1).max(150).optional(),
  description: z.string().min(1).max(5000).optional(),
  link: z.string().url().max(2000).optional().describe("Product page URL"),
  image_link: z.string().url().max(2000).optional().describe("Main image URL"),
  brand: z.string().min(1).max(70).optional(),
  gtin: z.string().regex(/^\d{8,14}$/, "8 to 14 digits").optional().describe("UPC, EAN, JAN, ISBN or ITF-14, digits only"),
  mpn: z.string().min(1).max(70).optional(),
  price: money.optional(),
  sale_price: money.optional(),
  availability: z.enum(["IN_STOCK", "OUT_OF_STOCK", "PREORDER", "LIMITED_AVAILABILITY", "BACKORDER"]).optional(),
  condition: z.enum(["NEW", "REFURBISHED", "USED"]).optional(),
  google_product_category: z.string().min(1).max(750).optional().describe("Google's category ID or path"),
  product_type: z.string().min(1).max(750).optional().describe("Your own category, e.g. Water Heaters > Tankless"),
  identifier_exists: z.boolean().optional().describe("false for custom or handmade products with no GTIN or MPN"),
  custom_label_0: z.string().max(100).optional(), custom_label_1: z.string().max(100).optional(), custom_label_2: z.string().max(100).optional(),
  custom_label_3: z.string().max(100).optional(), custom_label_4: z.string().max(100).optional(),
};

/** What a new product must have for Google to show it; the rest of attributesShape is optional. */
const newProduct = z.object({ ...attributesShape,
  title: z.string().min(1).max(150), link: z.string().url().max(2000).describe("Product page URL, on the account's verified website"),
  image_link: z.string().url().max(2000).describe("Main image URL"), price: money,
  availability: z.enum(["IN_STOCK", "OUT_OF_STOCK", "PREORDER", "LIMITED_AVAILABILITY", "BACKORDER"]),
}).strict();
const language = z.string().regex(/^[a-z]{2}$/).default("en").describe("Two-letter language of the title and description");
const feedLabel = z.string().regex(/^[A-Z0-9_-]{1,20}$/).default("US").describe("Feed label, usually the country the product sells in, e.g. US");

export const PUBLIC_MC_CHANGES = [
  z.object({ type: z.literal("set_product_attributes"), offer_id: offerId,
    attributes: z.object(attributesShape).strict().refine((a) => Object.keys(a).length > 0, "set at least one attribute")
      .describe("The attributes to override, e.g. { \"price\": 1099.99 } or { \"gtin\": \"0012345678905\" }") })
    .describe("Override a product's attributes, such as a price that doesn't match the site or a missing GTIN, on top of the feed. The feed itself is untouched"),
  z.object({ type: z.literal("exclude_products"), offer_ids: z.array(offerId).min(1).max(100),
    destinations: z.array(destination).min(1).default(["SHOPPING_ADS"]).describe("Where to stop showing them; SHOPPING_ADS covers Shopping and Performance Max") })
    .describe("Stop products showing in Shopping ads (or free listings, …), e.g. ones out of stock or with no margin"),
  z.object({ type: z.literal("include_products"), offer_ids: z.array(offerId).min(1).max(100),
    destinations: z.array(destination).min(1).default(["SHOPPING_ADS"]) })
    .describe("Show products excluded through Camberstack again"),
  z.object({ type: z.literal("clear_product_overrides"), offer_id: offerId })
    .describe("Remove every override Camberstack holds for a product, so the feed's own values apply again"),
  z.object({ type: z.literal("add_product"), offer_id: offerId.describe("A new, unique product ID"), content_language: language, feed_label: feedLabel,
    currency: z.string().regex(/^[A-Z]{3}$/).default("USD").describe("Currency of price and sale_price, ISO 4217"), attributes: newProduct })
    .describe(`Create a product in Camberstack's own "${PRODUCTS_SOURCE_NAME}" data source (needs title, link, image_link, price and availability)`),
  z.object({ type: z.literal("update_product"), offer_id: offerId,
    attributes: z.object(attributesShape).strict().refine((a) => Object.keys(a).length > 0, "set at least one attribute") })
    .describe("Change a product Camberstack created (add_product). For a product from the merchant's own feed, use set_product_attributes"),
  z.object({ type: z.literal("delete_product"), offer_id: offerId })
    .describe("Delete a product Camberstack created (add_product); undo re-creates it. Products from the merchant's own feed can't be deleted here"),
] as const;

export const PublicMcChangeSchema = z.discriminatedUnion("type", [...PUBLIC_MC_CHANGES]);
const snapshot = z.object({ key: z.object({ offerId: z.string(), contentLanguage: z.string(), feedLabel: z.string() }),
  primary: z.string(), overrides: z.record(z.string(), z.unknown()).nullable() });
export const McChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_MC_CHANGES,
  // Only undo creates it: puts back exactly the overrides each product had (null: none).
  z.object({ type: z.literal("restore_product_overrides"), products: z.array(snapshot).min(1) }),
  // Only undo creates it: puts Camberstack's own products back as they were (null: didn't exist).
  z.object({ type: z.literal("restore_own_products"), products: z.array(z.object({ key: snapshot.shape.key,
    attributes: z.record(z.string(), z.unknown()).nullable() })).min(1) }),
]);
export type McChange = z.infer<typeof McChangeSchema>;
type Snapshot = z.infer<typeof snapshot>;

/**
 * One product's overrides as they'll be after the change (null: none, the input is deleted), and as they were. `primary`: its feed.
 * With `own`, it's one of Camberstack's own products instead, and `overrides` is its whole set of attributes (null: deleted).
 */
export interface McOp { key: ProductKey; primary: string; overrides: Overrides | null; before: Overrides | null; own?: true }
export interface McResolved {
  change: McChange;
  service: "merchant";
  operations: McOp[];
  describe: string;
  inverse?: McChange;
}

const fmtMoney = (v: unknown) => {
  const p = v as { amountMicros?: string; currencyCode?: string } | undefined;
  if (!p?.amountMicros) return "(none)";
  return `${(Number(p.amountMicros) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${p.currencyCode ?? ""}`.trim();
};
/** An attribute's value as a summary shows it. */
function show(attr: Attr, v: unknown): string {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return "(none)";
  if (attr === "price" || attr === "sale_price") return fmtMoney(v);
  if (Array.isArray(v)) return v.join(", ");
  const s = String(v);
  return s.length > 60 ? `"${s.slice(0, 57)}…"` : typeof v === "string" ? `"${s}"` : s;
}

/** The tool's value → the API's (money in the product's currency, single values into the API's lists). */
function apiValue(attr: Attr, v: unknown, currency: string): unknown {
  if (attr === "price" || attr === "sale_price") return { amountMicros: String(Math.round(Number(v) * 1e6)), currencyCode: currency };
  if (attr === "gtin" || attr === "product_type") return [v];
  return v;
}

async function findProduct(m: Merchant, accountId: string, offer: string) {
  const keys = await m.productKeys(accountId, offer);
  if (!keys.length) throw new Error(`No product with offer_id ${offer} in Merchant Center account ${accountId} (offer_id is the product's ID in the feed).`);
  if (keys.length > 1) {
    throw new Error(`offer_id ${offer} is in ${keys.length} feeds (${keys.map((k) => `${k.contentLanguage}/${k.feedLabel}`).join(", ")}); `
      + "Camberstack changes one product at a time and can't tell which is meant. Change it in Merchant Center.");
  }
  const key = keys[0]!;
  const product = await m.product(accountId, key);
  return { key, primary: product.dataSource, attributes: product.attributes, title: String(product.attributes.title ?? offer),
    current: await m.overrides(accountId, key) };
}

/**
 * The feeds whose rules the first override must change: a summary line each, so the user approves that too. A feed
 * whose rules the API can't change (made in the Merchant Center UI, or autofeed) stops the proposal here, not at apply.
 */
async function linkLines(m: Merchant, accountId: string, ops: McOp[]): Promise<string> {
  const lines: string[] = [];
  for (const primary of new Set(ops.filter((o) => o.overrides && !o.own).map((o) => o.primary))) {
    const l = await m.linkState(accountId, primary);
    if (l.state === "cannot") {
      throw new Error(`Products in feed "${l.label}" can't take Camberstack's overrides: ${l.why}. Change them in Merchant Center or in the feed itself.`);
    }
    if (l.state === "will_link") lines.push(`⚠ first, puts Camberstack's "${SOURCE_NAME}" source ahead of feed "${l.label}" in its rules, so overrides win `
      + "(once per feed; the feed's own products and values are untouched, and with no overrides it changes nothing)");
  }
  return lines.length ? `; ${lines.join("; ")}` : "";
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Field by field: keys come back from storage with their fields in another order than a proposal's snapshot. */
const sameKey = (a: ProductKey, b: ProductKey) => a.offerId === b.offerId && a.contentLanguage === b.contentLanguage && a.feedLabel === b.feedLabel;
const cleaned = (o: Overrides) => (Object.keys(o).length ? o : null);

/** One of Camberstack's own products by offer_id, or null. */
async function ownProduct(m: Merchant, accountId: string, offer: string) {
  const mine = (await m.ownProducts(accountId)).filter((x) => x.key.offerId === offer);
  if (mine.length > 1) throw new Error(`Camberstack holds offer_id ${offer} in ${mine.length} languages or feed labels; change it in Merchant Center.`);
  return mine[0] ?? null;
}
const notOwn = (offer: string) => new Error(`${offer} isn't a product Camberstack created, so it can't be changed or deleted in place: it comes from the `
  + "merchant's own feed, which would overwrite that on its next sync. Use set_product_attributes or exclude_products (overrides), or change it in the feed.");
/** The tool's attributes in the API's names and shapes. */
const toApi = (attrs: Record<string, unknown>, currency: string) =>
  Object.fromEntries(Object.entries(attrs).map(([k, v]) => [ATTRIBUTES[k as Attr], apiValue(k as Attr, v, currency)]));
const fieldToAttr = Object.fromEntries(Object.entries(ATTRIBUTES).map(([k, v]) => [v, k as Attr]));

export async function resolveMcChange(m: Merchant, accountId: string, change: McChange): Promise<McResolved> {
  const base = { change, service: "merchant" as const };
  switch (change.type) {
    case "add_product": {
      const key = { offerId: change.offer_id, contentLanguage: change.content_language, feedLabel: change.feed_label };
      if (await ownProduct(m, accountId, change.offer_id)) throw new Error(`${change.offer_id} is already a Camberstack product: use update_product to change it.`);
      const elsewhere = await m.productKeys(accountId, change.offer_id);
      // Inserting it would move that product out of the merchant's feed into Camberstack's source.
      if (elsewhere.length) throw new Error(`offer_id ${change.offer_id} is already in this account's feed. Pick another offer_id for a new product, `
        + "or use set_product_attributes to change that one.");
      const attrs = toApi(change.attributes, change.currency);
      return { ...base, operations: [{ key, primary: "", overrides: attrs, before: null, own: true }],
        describe: `Add product ${change.offer_id} ("${change.attributes.title}") to Merchant Center, ${show("price", attrs.price)}, `
          + `${change.attributes.availability.toLowerCase().replace(/_/g, " ")}, in Camberstack's "${PRODUCTS_SOURCE_NAME}" source (${key.contentLanguage}, ${key.feedLabel}). `
          + "⚠ once Google approves it (usually within a few days) it can show in Shopping ads and free listings",
        inverse: { type: "restore_own_products", products: [{ key, attributes: null }] } };
    }
    case "update_product": {
      const p = await ownProduct(m, accountId, change.offer_id);
      if (!p) throw notOwn(change.offer_id);
      const currency = (p.attrs.price as { currencyCode?: string } | undefined)?.currencyCode ?? "USD";
      const next: Overrides = { ...p.attrs }, diffs: string[] = [];
      for (const [k, v] of Object.entries(change.attributes) as [Attr, unknown][]) {
        const field = ATTRIBUTES[k], value = apiValue(k, v, currency);
        if (sameJson(p.attrs[field], value)) continue;
        diffs.push(`${k} ${show(k, p.attrs[field])} → ${show(k, value)}`);
        next[field] = value;
      }
      return { ...base, operations: diffs.length ? [{ key: p.key, primary: "", overrides: next, before: p.attrs, own: true }] : [],
        describe: `Product ${change.offer_id} ("${String(p.attrs.title ?? change.offer_id)}"): ${diffs.length ? diffs.join("; ") : "already has those values"}`,
        inverse: diffs.length ? { type: "restore_own_products", products: [{ key: p.key, attributes: p.attrs }] } : undefined };
    }
    case "delete_product": {
      const p = await ownProduct(m, accountId, change.offer_id);
      if (!p) throw notOwn(change.offer_id);
      return { ...base, operations: [{ key: p.key, primary: "", overrides: null, before: p.attrs, own: true }],
        describe: `Delete product ${change.offer_id} ("${String(p.attrs.title ?? change.offer_id)}") from Merchant Center ⚠ it stops showing in ads and free listings`,
        inverse: { type: "restore_own_products", products: [{ key: p.key, attributes: p.attrs }] } };
    }
    case "restore_own_products": {
      const mine = await m.ownProducts(accountId);
      const ops: McOp[] = [];
      for (const x of change.products) {
        const current = mine.find((y) => sameKey(y.key, x.key))?.attrs ?? null;
        if (sameJson(current, x.attributes)) continue;
        ops.push({ key: x.key, primary: "", overrides: x.attributes as Overrides | null, before: current, own: true });
      }
      return { ...base, operations: ops,
        describe: ops.map((o) => (o.overrides ? `${o.before ? "Put back" : "Re-create"} product ${o.key.offerId} ("${String(o.overrides.title ?? o.key.offerId)}") as it was`
          + (o.before ? `: ${Object.keys(o.overrides).filter((f) => !sameJson(o.overrides![f], o.before![f])).map((f) => fieldToAttr[f] ?? f).join(", ")}` : "")
          : `Delete product ${o.key.offerId} ("${String(o.before?.title ?? o.key.offerId)}"), which Camberstack created`)).join("; "),
        inverse: ops.length ? { type: "restore_own_products", products: ops.map((o) => ({ key: o.key, attributes: o.before })) } : undefined };
    }
    case "set_product_attributes": {
      if (await ownProduct(m, accountId, change.offer_id)) throw new Error(`${change.offer_id} is a Camberstack product: use update_product to change it.`);
      const p = await findProduct(m, accountId, change.offer_id);
      const currency = (p.attributes.price as { currencyCode?: string } | undefined)?.currencyCode ?? "USD";
      const next: Overrides = { ...(p.current ?? {}) };
      const diffs: string[] = [];
      for (const [k, v] of Object.entries(change.attributes) as [Attr, unknown][]) {
        const field = ATTRIBUTES[k], value = apiValue(k, v, currency);
        if (sameJson(p.attributes[field], value)) continue;
        diffs.push(`${k} ${show(k, p.attributes[field])} → ${show(k, value)}`);
        next[field] = value;
      }
      const ops: McOp[] = diffs.length ? [{ key: p.key, primary: p.primary, overrides: next, before: p.current }] : [];
      return { ...base, operations: ops,
        describe: `Product ${change.offer_id} ("${p.title}"): ${diffs.length ? diffs.join("; ") : "already has those values"}${await linkLines(m, accountId, ops)}`,
        inverse: diffs.length ? { type: "restore_product_overrides", products: [{ key: p.key, primary: p.primary, overrides: p.current }] } : undefined };
    }
    case "exclude_products":
    case "include_products": {
      const exclude = change.type === "exclude_products";
      const ops: McOp[] = [], already: string[] = [];
      for (const offer of [...new Set(change.offer_ids)]) {
        const p = await findProduct(m, accountId, offer);
        const have = new Set((p.attributes.excludedDestinations as string[] | undefined) ?? []);
        const ours = new Set((p.current?.excludedDestinations as string[] | undefined) ?? []);
        const todo = change.destinations.filter((d) => (exclude ? !have.has(d) : ours.has(d)));
        if (!todo.length) { already.push(offer); continue; }
        for (const d of todo) (exclude ? ours.add(d) : ours.delete(d));
        const { excludedDestinations: _, ...rest } = p.current ?? {};
        ops.push({ key: p.key, primary: p.primary, before: p.current, overrides: cleaned(ours.size ? { ...rest, excludedDestinations: [...ours] } : rest) });
      }
      const where = change.destinations.map((d) => d.toLowerCase().replace(/_/g, " ")).join(", ");
      // Only Camberstack's own exclusions can be lifted here; one set in the feed stays.
      const skipped = already.length ? ` (${already.length} already ${exclude ? "excluded" : "not excluded by Camberstack"}: ${already.slice(0, 5).join(", ")}${already.length > 5 ? ", …" : ""})` : "";
      return { ...base, operations: ops,
        describe: `${exclude ? "Exclude" : "Include again"} ${ops.length} product${ops.length === 1 ? "" : "s"} ${exclude ? "from" : "in"} ${where}: `
          + `${ops.map((o) => o.key.offerId).slice(0, 10).join(", ")}${ops.length > 10 ? ", …" : ""}${skipped}`
          + (exclude && change.destinations.includes("SHOPPING_ADS") ? " ⚠ they stop showing in Shopping and Performance Max ads" : "")
          + await linkLines(m, accountId, ops),
        inverse: ops.length ? { type: "restore_product_overrides", products: ops.map((o) => ({ key: o.key, primary: o.primary, overrides: o.before })) } : undefined };
    }
    case "clear_product_overrides": {
      const p = await findProduct(m, accountId, change.offer_id);
      return { ...base, operations: p.current ? [{ key: p.key, primary: p.primary, overrides: null, before: p.current }] : [],
        describe: `Product ${change.offer_id} ("${p.title}"): remove Camberstack's overrides`
          + (p.current ? ` (${Object.keys(p.current).join(", ")}), so the feed's values apply` : " (it has none)"),
        inverse: p.current ? { type: "restore_product_overrides", products: [{ key: p.key, primary: p.primary, overrides: p.current }] } : undefined };
    }
    case "restore_product_overrides": {
      const ops: McOp[] = [];
      for (const s of change.products as Snapshot[]) {
        const current = await m.overrides(accountId, s.key);
        if (sameJson(current, s.overrides)) continue;
        ops.push({ key: s.key, primary: s.primary, overrides: s.overrides as Overrides | null, before: current });
      }
      return { ...base, operations: ops,
        describe: `Restore the overrides Camberstack held before on ${ops.length} product${ops.length === 1 ? "" : "s"}: `
          + ops.map((o) => `${o.key.offerId} (${o.overrides ? Object.keys(o.overrides).join(", ") : "none: the feed's values"})`).join(", ")
          + await linkLines(m, accountId, ops),
        inverse: ops.length ? { type: "restore_product_overrides", products: ops.map((o) => ({ key: o.key, primary: o.primary, overrides: o.before })) } : undefined };
    }
  }
}

/** Write one resolved change: each product's override set, or its removal. Merchant Center has no dry run. */
export async function writeMc(m: Merchant, accountId: string, ops: McOp[]): Promise<void> {
  for (const op of ops) await (op.own ? m.setOwnProduct(accountId, op.key, op.overrides) : m.setOverrides(accountId, op.key, op.primary, op.overrides));
}
