import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdConversions } from "./adconversions.js";
import { now, openDb } from "./db.js";

/** Operations, faked: every request it was handed. */
function ops() {
  const sent: { url: string; auth: string; body: any }[] = [];
  let status = 202;
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization, body: JSON.parse(String(init?.body)) });
    return new Response('{"queued":true}', { status });
  }) as typeof fetch;
  return { f, sent, fail: (s: number) => { status = s; } };
}
const cfg = { opsUrl: "http://ops/v1/conversions", opsKey: "crk_ours", actionId: "555", openaiUrl: "http://ops/v1/openai-conversions", siteUrl: "https://camberstack.io/" };
const res = () => { const h: string[] = []; return { h, append: (_: string, v: string) => { h.push(v); }, setHeader: (k: string, v: string) => { h.push(`${k}: ${v}`); } } as any; };
/** A user whose login holds `ads` Google Ads accounts (null: list_accounts hasn't recorded any yet). */
const user = (db: ReturnType<typeof openDb>, id: string, ads: number | null = 1) =>
  db.prepare("INSERT INTO users (id, email, google_sub, created_at, ads_accounts) VALUES (?, ?, ?, ?, ?)").run(id, `${id}@example.com`, `g-${id}`, now(), ads);
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("ChatGPT Ads conversions", () => {
  it("keeps OpenAI's click reference only from our own campaign links, exactly as it came", () => {
    const ac = new AdConversions(openDb(":memory:"), cfg, true);
    const ref = "oppref_Ab+c/9=:x";
    const r = res();
    ac.captureClick({ query: { utm_source: "openai", click_id: ref } } as any, r);
    expect(r.h[0]).toBe(`cs_click=oppref:${encodeURIComponent(ref)}; Path=/; Max-Age=${90 * 86400}; HttpOnly; SameSite=Lax; Secure`);
    expect(r.h[1]).toContain("private");
    // Another site's click_id, a blank one, or a value with spaces is not ours to keep.
    for (const q of [{ click_id: ref }, { utm_source: "newsletter", click_id: ref }, { utm_source: "openai", click_id: "a b c d e f" }, { utm_source: "openai", click_id: "" }]) {
      const none = res(); ac.captureClick({ query: q } as any, none); expect(none.h).toEqual([]);
    }
    // A Google click on the same link still wins, unchanged.
    const g = res(); ac.captureClick({ query: { gclid: "Cj0KCQtest_click_1234", utm_source: "openai", click_id: ref } } as any, g);
    expect(g.h[0]).toMatch(/^cs_click=gclid:Cj0KCQtest_click_1234;/);
  });

  it("reports the first connection, then a paid plan inside 30 days, with nothing about the user", async () => {
    const db = openDb(":memory:"); const o = ops();
    const ac = new AdConversions(db, cfg, true, o.f);
    user(db, "u1");
    const ref = "oppref_Ab+c/9=:x";
    const req = { headers: { cookie: `cs_click=oppref:${encodeURIComponent(ref)}` } } as any;
    ac.record(req, res(), "u1", true);
    await tick();
    expect(o.sent).toHaveLength(1);
    expect(o.sent[0]).toMatchObject({ url: cfg.openaiUrl, auth: "Bearer crk_ours",
      body: { event: "registration_completed", oppref: ref, source_url: "https://camberstack.io/google-ads-chatgpt" } });
    expect(o.sent[0]!.body.event_id).toMatch(/^connect_[0-9a-f]{40}$/);
    expect(o.sent[0]!.body.time).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(db.prepare("SELECT kind, uploaded_at FROM ad_conversions").get()).toMatchObject({ kind: "oppref", uploaded_at: expect.any(Number) });

    ac.paid("u1", "plus"); ac.paid("u1", "plus");  // told twice: sent once
    await tick();
    expect(o.sent).toHaveLength(2);
    expect(o.sent[1]!.body).toMatchObject({ event: "subscription_created", oppref: ref, plan_id: "plus", amount: 700, currency: "USD", source_url: "https://camberstack.io/plans" });
    expect(o.sent[1]!.body.event_id).toMatch(/^paid_[0-9a-f]{40}$/);
    const all = JSON.stringify(o.sent);
    expect(all).not.toContain("u1@example.com");
    expect(all).not.toContain('"u1"');

    // Not from a ChatGPT ad, or paying after the window: nothing goes out.
    user(db, "u2"); ac.paid("u2", "pro");
    user(db, "u3"); db.prepare("INSERT INTO ad_conversions (user_id, kind, click_id, at, uploaded_at) VALUES ('u3', 'oppref', 'oppref_old_click', ?, ?)").run(now() - 31 * 86400, now());
    ac.paid("u3", "pro");
    user(db, "u4"); db.prepare("INSERT INTO ad_conversions (user_id, kind, click_id, at, uploaded_at) VALUES ('u4', 'gclid', 'Cj0KCQtest_click_1234', ?, ?)").run(now(), now());
    ac.paid("u4", "pro");
    await tick();
    expect(o.sent).toHaveLength(2);
  });

  it("keeps a failed event and sends it on the next sweep; a returning user's click is dropped", async () => {
    const db = openDb(":memory:"); const o = ops();
    const ac = new AdConversions(db, cfg, true, o.f);
    user(db, "u1");
    o.fail(503);
    ac.record({ headers: { cookie: "cs_click=oppref:oppref_click_abc" } } as any, res(), "u1", true);
    await tick();
    expect(db.prepare("SELECT uploaded_at, attempts, error FROM ad_conversions").get()).toMatchObject({ uploaded_at: null, attempts: 1, error: expect.stringContaining("503") });
    o.fail(202);
    await ac.flush();
    expect(db.prepare("SELECT uploaded_at FROM ad_conversions").get()).toMatchObject({ uploaded_at: expect.any(Number) });
    user(db, "u2");
    const r = res();
    ac.record({ headers: { cookie: "cs_click=oppref:oppref_click_def" } } as any, r, "u2", false);
    expect(r.h[0]).toMatch(/^cs_click=; /);
    expect(db.prepare("SELECT count(*) n FROM ad_conversions").get()).toEqual({ n: 1 });
  });

  it("sends a ChatGPT Ads connect only once the login is known to hold a real Ads account", async () => {
    const db = openDb(":memory:"); const o = ops();
    const ac = new AdConversions(db, cfg, true, o.f);
    user(db, "none", null); user(db, "zero", 0); user(db, "later", null); user(db, "stale", null);
    for (const id of ["none", "zero", "later"]) ac.record({ headers: { cookie: `cs_click=oppref:oppref_${id}_click` } } as any, res(), id, true);
    db.prepare("INSERT INTO ad_conversions (user_id, kind, click_id, at) VALUES ('stale', 'oppref', 'oppref_stale_click', ?)").run(now() - 31 * 86400);
    await tick(); await ac.flush();
    expect(o.sent).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM ad_conversions WHERE attempts = 0 AND uploaded_at IS NULL").get()).toEqual({ n: 4 });
    // list_accounts reads a real account for two of them; the sweep sends only the one still inside OpenAI's window.
    db.prepare("UPDATE users SET ads_accounts = 2 WHERE id IN ('later', 'stale')").run();
    await ac.flush();
    expect(o.sent.map((s) => s.body.oppref)).toEqual(["oppref_later_click"]);
    // A Google click isn't held.
    user(db, "g", null);
    ac.record({ headers: { cookie: "cs_click=gclid:Cj0KCQtest_click_1234" } } as any, res(), "g", true);
    await tick();
    expect(o.sent.at(-1)!.body).toMatchObject({ gclid: "Cj0KCQtest_click_1234" });
  });

  it("holds ChatGPT Ads clicks when the OpenAI endpoint isn't configured, and still uploads Google's", async () => {
    const db = openDb(":memory:"); const o = ops();
    const ac = new AdConversions(db, { opsUrl: cfg.opsUrl, opsKey: cfg.opsKey, actionId: cfg.actionId }, true, o.f);
    user(db, "u1"); user(db, "u2");
    ac.record({ headers: { cookie: "cs_click=oppref:oppref_click_abc" } } as any, res(), "u1", true);
    ac.record({ headers: { cookie: "cs_click=gclid:Cj0KCQtest_click_1234" } } as any, res(), "u2", true);
    await tick(); await ac.flush();
    expect(o.sent.map((s) => s.url)).toEqual([cfg.opsUrl]);
    expect(o.sent[0]!.body).toMatchObject({ conversion_action_id: "555", gclid: "Cj0KCQtest_click_1234" });
    expect(db.prepare("SELECT attempts, uploaded_at FROM ad_conversions WHERE user_id = 'u1'").get()).toEqual({ attempts: 0, uploaded_at: null });
  });

  it("rebuilds an ad_conversions table made before ChatGPT Ads, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-adconv-"));
    const old = new Database(join(dir, "camberstack.sqlite"));
    old.exec(`CREATE TABLE ad_conversions (user_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('gclid','gbraid','wbraid')), click_id TEXT NOT NULL,
      at INTEGER NOT NULL, uploaded_at INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      INSERT INTO ad_conversions (user_id, kind, click_id, at, uploaded_at, attempts) VALUES ('old', 'gclid', 'Cj0KCQtest_click_1234', 100, 200, 1);`);
    old.close();
    const db = openDb(dir);
    expect(db.prepare("SELECT * FROM ad_conversions").all()).toEqual([{ user_id: "old", kind: "gclid", click_id: "Cj0KCQtest_click_1234", at: 100, uploaded_at: 200, error: null, attempts: 1 }]);
    db.prepare("INSERT INTO ad_conversions (user_id, kind, click_id, at) VALUES ('new', 'oppref', 'oppref_click_abc', 300)").run();
    expect(() => db.prepare("INSERT INTO ad_conversions (user_id, kind, click_id, at) VALUES ('bad', 'other', 'x', 1)").run()).toThrow(/CHECK/);
    openDb(dir);  // a second boot leaves it alone
  });
});

describe("ref links", () => {
  const withCookie = (v: string) => ({ headers: { cookie: v } }) as any;
  it("keeps a ref slug and records it on the first connection only", () => {
    const db = openDb(":memory:");
    const ac = new AdConversions(db, undefined, true);
    const r = res(); ac.captureClick({ query: { ref: "YouTube-1" } } as any, r);
    expect(r.h[0]).toBe(`cs_ref=youtube-1; Path=/; Max-Age=${90 * 86400}; HttpOnly; SameSite=Lax; Secure`);
    for (const bad of ["x", "a b", "<script>", "y".repeat(41)]) { const n = res(); ac.captureClick({ query: { ref: bad } } as any, n); expect(n.h).toEqual([]); }
    user(db, "u1"); user(db, "u2");
    const done = res(); ac.record(withCookie("cs_ref=youtube-1"), done, "u1", true);
    expect(done.h[0]).toMatch(/^cs_ref=; Path=\/; Max-Age=0/);
    ac.record(withCookie("cs_ref=youtube-1"), res(), "u2", false);
    const ref = (id: string) => (db.prepare("SELECT signup_ref FROM users WHERE id = ?").get(id) as any).signup_ref;
    expect(ref("u1")).toBe("youtube-1");
    expect(ref("u2")).toBeNull();
  });
});
