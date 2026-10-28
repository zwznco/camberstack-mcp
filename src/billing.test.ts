import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Billing } from "./billing.js";
import { openDb, now } from "./db.js";

const PRO = "price_pro", AGENCY = "price_agency";

/** A fake Stripe: checkout sessions and subscriptions, each subscription on one price. */
function fakeStripe() {
  const subs = new Map<string, { status: string; price: string }>();
  const sessions = new Map<string, any>();
  const created: Record<string, string>[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    const url = new URL(String(u)), path = url.pathname.replace("/v1/", "");
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === "checkout/sessions" && init?.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      created.push(form);
      return json({ id: "cs_new", url: `https://checkout.stripe.test/${form["line_items[0][price]"]}` });
    }
    if (path.startsWith("checkout/sessions/")) return json(sessions.get(path.split("/")[2]!) ?? {}, sessions.has(path.split("/")[2]!) ? 200 : 404);
    if (path === "checkout/sessions") return json({ data: [...sessions.values()] });
    if (path.startsWith("subscriptions/")) {
      const s = subs.get(path.split("/")[1]!);
      return s ? json({ status: s.status, items: { data: [{ price: { id: s.price } }] } }) : json({ error: { message: "No such subscription" } }, 404);
    }
    if (path === "billing_portal/configurations") return json({ data: [{ id: "bpc_1", is_default: true }] });
    if (path === "billing_portal/sessions") return json({ url: "https://billing.stripe.test/portal" });
    return json({ error: { message: `unexpected ${path}` } }, 400);
  }) as typeof fetch;
  return { f, subs, sessions, created };
}

describe("Agency plan billing", () => {
  const db = openDb(":memory:");
  const stripe = fakeStripe();
  const billing = new Billing({ db, baseUrl: "http://x", signingKey: Buffer.alloc(32, 1), fetch: stripe.f,
    stripe: { secretKey: "sk", proPriceId: PRO, agencyPriceId: AGENCY, plusPriceId: "price_plus" } });
  let base = "";
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  const plan = (id: string) => (db.prepare("SELECT plan FROM users WHERE id = ?").get(id) as { plan: string }).plan;
  const user = (id: string, p = "free", sub: string | null = null) => db.prepare(
    "INSERT INTO users (id, google_sub, email, plan, stripe_customer, stripe_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, `g-${id}`, `${id}@example.com`, p, sub ? `cus_${id}` : null, sub, now());

  beforeAll(async () => {
    const app = express();
    billing.mount(app, (title, body) => `<h1>${title}</h1>${body}`);
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());
  const visit = (link: string) => fetch(link.replace("http://x", base), { redirect: "manual" });

  it("checks out Agency on its own price, and only links Agency when it's configured", async () => {
    user("a");
    const link = billing.link("agency", "a")!;
    expect(link).toContain("/upgrade?t=");
    expect(link).toMatch(/&plan=agency$/);
    expect((await visit(link)).headers.get("location")).toBe("https://checkout.stripe.test/price_agency");
    expect(stripe.created.at(-1)).toMatchObject({ "line_items[0][price]": AGENCY, "metadata[plan]": "agency" });
    expect((await visit(billing.link("upgrade", "a")!)).headers.get("location")).toBe("https://checkout.stripe.test/price_pro");
    const noAgency = new Billing({ db, baseUrl: "http://x", signingKey: Buffer.alloc(32, 1), stripe: { secretKey: "sk", proPriceId: PRO } });
    expect(noAgency.link("agency", "a")).toBeNull();
  });

  it("settles a paid checkout on the plan its subscription's price pays for", async () => {
    user("b");
    stripe.subs.set("sub_b", { status: "active", price: AGENCY });
    stripe.sessions.set("cs_b", { id: "cs_b", status: "complete", metadata: { app: "camberstack-mcp" }, client_reference_id: "b", customer: "cus_b", subscription: "sub_b" });
    const page = await visit(`${base}/upgraded?session_id=cs_b`);
    expect(await page.text()).toContain("you're on Camberstack Agency");
    expect(plan("b")).toBe("agency");
  });

  it("checks out Plus on its own price and settles a Plus subscription as plus; a paying Plus user moves to Pro in the portal", async () => {
    user("p");
    const link = billing.link("plus", "p", "tool")!;
    expect(link).toMatch(/&plan=plus&src=tool$/);
    expect((await visit(link)).headers.get("location")).toBe("https://checkout.stripe.test/price_plus");
    expect(stripe.created.at(-1)).toMatchObject({ "line_items[0][price]": "price_plus", "metadata[plan]": "plus" });
    stripe.subs.set("sub_p", { status: "active", price: "price_plus" });
    stripe.sessions.set("cs_p", { id: "cs_p", status: "complete", metadata: { app: "camberstack-mcp" }, client_reference_id: "p", customer: "cus_p", subscription: "sub_p" });
    const page = await (await visit(`${base}/upgraded?session_id=cs_p`)).text();
    expect(page).toContain("you're on Camberstack Plus");
    expect(page).toContain("Plus covers Google Ads, Search Console and Google Analytics together on 1 Google Ads account.");
    expect(plan("p")).toBe("plus");
    // The sweep keeps Plus as Plus, follows a portal switch to Pro, and drops it when it ends.
    await billing.sweep();
    expect(plan("p")).toBe("plus");
    stripe.subs.set("sub_p", { status: "active", price: PRO });
    await billing.sweep();
    expect(plan("p")).toBe("pro");
    // Paying already: Pro goes to the billing portal, never a second checkout.
    db.prepare("UPDATE users SET plan = 'plus' WHERE id = 'p'").run();
    expect((await visit(billing.link("upgrade", "p")!)).headers.get("location")).toBe("https://billing.stripe.test/portal");
    const noPlus = new Billing({ db, baseUrl: "http://x", signingKey: Buffer.alloc(32, 1), stripe: { secretKey: "sk", proPriceId: PRO } });
    expect(noPlus.link("plus", "p")).toBeNull();
  });

  it("tracks the paywall funnel: upgrade clicks by where the link came from, one paid event per subscription, /plans links", async () => {
    user("f");
    const events = (kind: string) => db.prepare("SELECT src FROM plan_events WHERE user_id = 'f' AND kind = ?").all(kind).map((r: any) => r.src);
    expect(billing.link("upgrade", "f", "email")).toMatch(/&src=email$/);
    expect(billing.link("billing", "f", "tool")).not.toContain("src=");
    await visit(billing.link("upgrade", "f", "email")!);
    await visit(billing.link("upgrade", "f")!);
    await visit(`${billing.link("upgrade", "f")!}&src=bogus`);
    expect(events("upgrade_click")).toEqual(["email", null, null]);
    // A forged or expired token is no click.
    await visit("http://x/upgrade?t=f.9999999999.bad&src=tool");
    expect(events("upgrade_click")).toHaveLength(3);
    stripe.subs.set("sub_f", { status: "active", price: PRO });
    stripe.sessions.set("cs_f", { id: "cs_f", status: "complete", metadata: { app: "camberstack-mcp" }, client_reference_id: "f", customer: "cus_f", subscription: "sub_f" });
    await visit(`${base}/upgraded?session_id=cs_f`);
    await visit(`${base}/upgraded?session_id=cs_f`);
    await billing.sweep();
    expect(events("paid")).toEqual(["sub_f"]);
    const t = new URL(billing.plansLink("f")).searchParams.get("t");
    expect(billing.verify("plans", t)).toBe("f");
    expect(billing.verify("upgrade", t)).toBeNull();
  });

  it("follows a switch between Pro and Agency made in the billing portal, and drops either when it ends", async () => {
    user("c", "pro", "sub_c");
    stripe.subs.set("sub_c", { status: "active", price: AGENCY });
    await billing.sweep();
    expect(plan("c")).toBe("agency");
    stripe.subs.set("sub_c", { status: "active", price: PRO });
    await billing.sweep();
    expect(plan("c")).toBe("pro");
    stripe.subs.set("sub_c", { status: "canceled", price: PRO });
    await billing.sweep();
    expect(plan("c")).toBe("free");
  });

  it("sends a paying user who wants the other plan to the billing portal, never a second checkout", async () => {
    user("d", "pro", "sub_d");
    const before = stripe.created.length;
    expect((await visit(billing.link("agency", "d")!)).headers.get("location")).toBe("https://billing.stripe.test/portal");
    expect(stripe.created.length).toBe(before);
    expect(await (await visit(billing.link("upgrade", "d")!)).text()).toContain("already on Camberstack Pro");
  });
});

describe("Agency plan in a session", () => {
  const db = openDb(":memory:");
  const links = (kind: string, id: string) => `http://x/${kind}/${id}`;
  const session = async (id: string, plan: string, sub: string | null) => {
    db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_customer, stripe_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, `g-${id}`, `${id}@example.com`, plan, sub ? `cus_${id}` : null, sub, now());
    const { UserSession } = await import("./session.js");
    return UserSession.load({ db, baseUrl: "http://x", google: { clientId: "c", clientSecret: "s" }, encryptionKey: Buffer.alloc(32, 2),
      freeAccounts: 1, proAccounts: 5, agencyAccounts: 25, proEmails: new Set(), billingLink: links } as never, id);
  };

  it("covers 25 accounts on Agency; Pro is offered the switch, Free sees both plans", async () => {
    const agency = await session("s1", "agency", "sub_1");
    expect([agency.planName, agency.accountLimit]).toEqual(["agency", 25]);
    expect(agency.plan()).toMatchObject({ plan: "agency", accounts_included: 25, manage_billing: "http://x/billing/s1" });
    expect(agency.plan()).not.toHaveProperty("agency_upgrade_url");
    const pro = await session("s2", "pro", "sub_2");
    expect(pro.plan()).toMatchObject({ plan: "pro", accounts_included: 5, agency_upgrade_url: "http://x/agency/s2" });
    const free = await session("s3", "free", null);
    expect(free.plan()).toMatchObject({ plan: "free", upgrade_url: "http://x/upgrade/s3", agency_upgrade_url: "http://x/agency/s3" });
  });
});
