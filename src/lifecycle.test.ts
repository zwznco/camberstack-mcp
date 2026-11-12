import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { openDb, now } from "./db.js";
import { Lifecycle } from "./lifecycle.js";
import { setChangeCap } from "./plans.js";

const DAY = 86400;
/** 10am in Chicago (the fallback zone), so the morning window is open unless a test says otherwise. */
const MORNING = new Date("2026-10-13T15:00:00Z");

function setup(clock = () => MORNING) {
  const db = openDb(":memory:");
  const sent: any[] = [];
  const lc = new Lifecycle({
    db, clock, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7),
    mail: { apiKey: "re_test", from: "Adam at Camberstack <adam@camberstack.io>", replyTo: "adam@camberstack.io" },
    internalEmails: new Set(["me@example.com"]),
    upgradeLink: (u) => `https://camberstack.io/upgrade?t=${u}.sig`,
    fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any,
  });
  const user = (id: string, email: string, ageDays: number, extra = "") =>
    db.prepare(`INSERT INTO users (id, google_sub, email, enc_refresh, created_at${extra ? ", plan" : ""}) VALUES (?, ?, ?, 'x', ?${extra ? ", ?" : ""})`)
      .run(...[id, `sub-${id}`, email, now() - ageDays * DAY, ...(extra ? [extra] : [])]);
  const call = (userId: string, tool: string) =>
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, ms, bytes) VALUES (?, ?, ?, 1, 10, 10)").run(now(), userId, tool);
  const applied = (userId: string, daysAgo: number, cid = "1112223333", undoOf: string | null = null) =>
    db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, undo_of, created_at, applied_at)
      VALUES (?, ?, ?, '[]', 's', 'applied', ?, ?, ?)`).run(`p${Math.random()}`, userId, cid, undoOf, now() - daysAgo * DAY, now() - daysAgo * DAY);
  return { db, lc, sent, user, call, applied };
}

describe("lifecycle emails", () => {
  it("sends first_steps once to someone who connected 2+ days ago and never asked anything", async () => {
    const { lc, sent, user, call } = setup();
    user("quiet", "quiet@example.com", 3);
    user("fresh", "fresh@example.com", 1);          // too soon
    user("active", "active@example.com", 3); call("active", "account_overview");
    user("listed", "listed@example.com", 3); call("listed", "list_accounts");  // listing accounts isn't using it
    user("ga4", "ga4@example.com", 3); call("ga4", "analytics_report");        // Analytics alone is using it (2026-10-30)
    user("me", "me@example.com", 3);                 // internal
    expect(await lc.run()).toBe(2);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["listed@example.com", "quiet@example.com"]);
    const m = sent[0];
    expect(m.subject).toBe("The first thing to ask Camberstack");
    expect(m.text).toContain("How did each of my Google Ads campaigns do last month?");
    expect(m.text).toContain("demo account");
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.reply_to).toBe("adam@camberstack.io");
    expect(await lc.run()).toBe(0);  // never twice
  });

  it("doesn't count a run_gaql field lookup as using Camberstack: it reads no account (0.14.0)", async () => {
    const { db, lc, sent, user } = setup();
    const gaql = (userId: string, cid: string | null) =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, ?, 'run_gaql', ?, 1, 10, 10)").run(now(), userId, cid);
    user("lookup", "lookup@example.com", 3); gaql("lookup", null);
    user("queried", "queried@example.com", 3); gaql("queried", "1112223333");
    expect(await lc.run()).toBe(1);
    expect(sent.map((m) => m.to[0])).toEqual(["lookup@example.com"]);
  });

  it("sends change_limit once, the morning after the change cap stopped an apply, even after an account-limit email", async () => {
    const { db, lc, sent, user, call } = setup();
    // Each has used Camberstack (so no first_steps), then been stopped.
    const stopped = (userId: string, daysAgo: number) => call(userId, "account_overview") &&
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'apply_changes', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days, "
          + "and this login has used them; the next opens on 2026-12-02. Proposal p1 stays open.");
    user("capped", "capped@example.com", 10); stopped("capped", 0.3);
    user("recent", "recent@example.com", 10); stopped("recent", 0.2);   // under 6 hours ago
    user("pro", "pro@example.com", 10, "pro"); stopped("pro", 0.3);
    // An earlier account-limit email doesn't hold this one back.
    user("had", "had@example.com", 10); stopped("had", 0.3);
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES ('had', 'limit_reached', ?)").run(now() - DAY);
    // Stopped by both gates by the same morning: one upgrade email, change_limit, not limit_reached too.
    user("both", "both@example.com", 10); stopped("both", 0.3);
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'both', 'account_overview', 1, ?, 10, 10)")
      .run(now() - 0.4 * DAY, "Plan limit: the Free plan covers 1 Google Ads account at a time. Another opens on 2026-12-01.");
    expect(await lc.run()).toBe(3);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["both@example.com", "capped@example.com", "had@example.com"]);
    expect(sent.find((x) => x.to[0] === "both@example.com").subject).toBe("Your free Camberstack changes for this month");
    const m = sent.find((x) => x.to[0] === "capped@example.com");
    expect(m.subject).toBe("Your free Camberstack changes for this month");
    expect(m.text).toContain("The next one opens on December 2. The proposal is still open");
    expect(m.text).toContain("https://camberstack.io/upgrade?t=capped.sig");
    // Once per user: another stop sends nothing.
    stopped("capped", 0.25);
    expect(await lc.run()).toBe(0);
  });

  it("pitches Plus in change_limit when it's sold, and welcomes a Plus subscriber with what Plus adds", async () => {
    const { db, lc, sent, user, call } = setup();
    (lc as any).d.plusLink = (u: string) => `https://camberstack.io/upgrade?t=${u}.sig&plan=plus`;
    setChangeCap(10);
    try {
      user("cap", "cap@example.com", 10); call("cap", "account_overview");
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'cap', 'apply_changes', 1, ?, 10, 10)").run(now() - 0.3 * DAY,
        "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days, and this login has used them; the next opens on 2026-12-02.");
      expect(await lc.run()).toBe(1);
      expect(sent[0].text).toContain("Camberstack Plus has unlimited changes on one Google Ads account, for $7/month; cancel any time. Pro ($15/month) does the same on up to 5 accounts.");
      expect(sent[0].text).toContain("https://camberstack.io/upgrade?t=cap.sig&plan=plus");
      expect(sent[0].html).toContain(">Get Plus</a>");
      db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_sub, created_at) VALUES ('pl', 'g-pl', 'pl@example.com', 'plus', 'sub_pl', ?)").run(now());
      expect(await lc.transactional()).toBe(1);
      expect(sent.at(-1).subject).toBe("You're on Camberstack Plus");
      expect(sent.at(-1).text).toContain("What Plus adds: unlimited applied changes on one Google Ads account, where Free stops at 10 every 30 days.");
      expect(sent.at(-1).text).toContain("$7/month, renewing monthly");
    } finally { setChangeCap(null); }
  });

  it("describes Free in the welcome with the change cap off and on", async () => {
    const welcomeText = async () => {
      const sent: any[] = [];
      const lc = new Lifecycle({ db: openDb(":memory:"), baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7), internalEmails: new Set(),
        mail: { apiKey: "re_test", from: "a <adam@camberstack.io>", replyTo: "adam@camberstack.io" }, upgradeLink: () => null,
        fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any });
      await lc.preview("me@example.com");
      return sent.find((m) => m.subject === "Welcome to Camberstack").text as string;
    };
    const off = await welcomeText();
    setChangeCap(10);
    let on: string;
    try { on = await welcomeText(); } finally { setChangeCap(null); }
    expect(off).toContain("Free covers one Google Ads account; Pro ($15/month) covers up to 5, and Agency ($49/month) up to 25.\n");
    expect(on).toContain("Free covers one Google Ads account, with 10 applied changes every 30 days; Plus ($7/month) has unlimited changes on it, Pro ($15/month) on up to 5 accounts, and Agency ($49/month) up to 25.\n");
    for (const t of [off, on]) expect(t).not.toMatch(/one Google service|November 1[56]/);
  });

  it("sends limit_reached once, the morning after the plan gate refused a second account, with when another account opens", async () => {
    const { db, lc, sent, user, call } = setup();
    const refused = (userId: string, daysAgo: number, error = "Plan limit: Camberstack has been used on 2 Google Ads accounts; "
      + "Pro ($15/month) covers up to 5, so 2223334444 works right away. On Free, another account opens on 2026-11-13, if 1112223333 isn't used again before then. "
      + "The Free plan covers 1 at a time (active: 1112223333), with no switching between them.") =>
      // A refusal is a notice: logged ok, with no account (tools.ts), so it's found by its text.
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'account_overview', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, error);
    user("capped", "capped@example.com", 10); call("capped", "propose_changes"); refused("capped", 0.3);
    user("recent", "recent@example.com", 10); call("recent", "propose_changes"); refused("recent", 0.2);  // under 6 hours ago
    user("other", "other@example.com", 10); call("other", "propose_changes"); refused("other", 0.3, "Google said no");  // not the gate
    user("pro", "pro@example.com", 10, "pro"); call("pro", "propose_changes"); refused("pro", 0.3);
    user("reset", "reset@example.com", 10); call("reset", "propose_changes"); refused("reset", 0.3);  // a reset by hand cancels it
    user("store", "store@example.com", 10); call("store", "propose_changes");  // a Merchant Center refusal isn't about Google Ads accounts
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'store', 'merchant_report', 1, ?, 10, 10)")
      .run(now() - 0.3 * DAY, "Plan limit: Camberstack has been used on 2 Merchant Center accounts");
    db.prepare("UPDATE users SET plan_reset_at = ? WHERE id = 'reset'").run(now() - 0.1 * DAY);
    expect(await lc.run()).toBe(1);
    expect(sent[0].to).toEqual(["capped@example.com"]);
    expect(sent[0].subject).toBe("Using Camberstack on more than one Google Ads account");
    expect(sent[0].text).toContain("https://camberstack.io/upgrade?t=capped.sig");
    expect(sent[0].text).toContain("up to 5 accounts");
    expect(sent[0].text).toContain("another opens once your current one has gone 30 days unused: on November 13, if you don't use it before then.");
    expect(sent[0].text).not.toMatch(/switch/i);
    expect(sent[0].html).toContain("on November 13");
    expect(await lc.run()).toBe(0);
  });

  it("sends nothing for an old switch notice (the switch is gone), and a switch_wanted already sent still counts as the upgrade email", async () => {
    const { db, lc, sent, user, call } = setup();
    // As 0.19.0–0.28.0 logged a switch notice: ok, no account, the notice's text in error.
    const notice = (userId: string, daysAgo: number) =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'account_overview', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, "Account switch: using 2223334444 spends this plan's one switch per 30 days. 1112223333 would lock until 2026-11-22.");
    user("asked", "asked@example.com", 1); call("asked", "account_overview"); notice("asked", 0.3);
    expect(await lc.run()).toBe(0);
    // Had switch_wanted, then refused: still one upgrade email per user.
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES ('asked', 'switch_wanted', ?)").run(now() - 2 * DAY);
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'asked', 'account_overview', 1, 'Plan limit: x; the next opens 2026-11-13, 30 days after', 10, 10)").run(now() - 0.3 * DAY);
    expect(await lc.run()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("sends check_in once, 2+ days after the first change applied to a real account", async () => {
    const { lc, sent, user, call, applied } = setup();
    const used = (id: string) => call(id, "account_overview");   // keeps first_steps out of the way
    user("acted", "acted@example.com", 5); used("acted"); applied("acted", 3); applied("acted", 1);
    user("today", "today@example.com", 5); used("today"); applied("today", 0.5);             // too soon
    user("demo", "demo@example.com", 5); used("demo"); applied("demo", 3, "0000000001");     // demo only
    user("undo", "undo@example.com", 5); used("undo"); applied("undo", 3, "1112223333", "p0"); // only an undo
    user("old", "old@example.com", 30); used("old"); applied("old", 20);                    // before this email existed
    user("pro", "pro@example.com", 5, "pro"); used("pro"); applied("pro", 3);               // Pro gets it too
    user("me", "me@example.com", 5); used("me"); applied("me", 3);                          // internal
    expect(await lc.run()).toBe(2);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["acted@example.com", "pro@example.com"]);
    expect(sent[0].subject).toBe("Camberstack: how did it go?");
    expect(sent[0].text).toContain("How did you find Camberstack?");
    expect(sent[0].text).not.toMatch(/first (user|customer)/i);
    expect(sent[0].reply_to).toBe("adam@camberstack.io");
    expect(await lc.run()).toBe(0);
  });

  it("waits for the user's morning, in their Google Ads time zone", async () => {
    let at = new Date("2026-10-13T07:12:00Z");  // 3:12am New York, 8:12am London, 6:12pm Sydney
    const { db, lc, sent, user, call, applied } = setup(() => at);
    const tz = (id: string, zone: string | null) => db.prepare("UPDATE users SET time_zone = ? WHERE id = ?").run(zone, id);
    for (const [id, zone] of [["ny", "America/New_York"], ["uk", "Europe/London"], ["none", null], ["bogus", "Not/AZone"]] as const) {
      user(id, `${id}@example.com`, 5); call(id, "account_overview"); applied(id, 2.5); tz(id, zone);
    }
    expect(await lc.run()).toBe(0);                                 // nobody's 9–12 yet
    at = new Date("2026-10-13T09:00:00Z");                          // 10am London
    expect(await lc.run()).toBe(1);
    expect(sent.map((m) => m.to[0])).toEqual(["uk@example.com"]);
    at = new Date("2026-10-13T14:00:00Z");                          // 10am New York, 9am Chicago (no zone, or a bad one)
    expect(await lc.run()).toBe(3);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["bogus@example.com", "none@example.com", "ny@example.com", "uk@example.com"]);
  });

  it("still sends check_in to someone whose morning comes after the nominal 14 days", async () => {
    const { lc, sent, user, call, applied } = setup();
    user("late", "late@example.com", 20); call("late", "account_overview"); applied("late", 14.5);
    expect(await lc.run()).toBe(1);
    expect(sent[0].to).toEqual(["late@example.com"]);
  });

  it("unsubscribes only on POST with a valid signature, and then sends nothing", async () => {
    const { db, lc, sent, user } = setup();
    user("quiet", "quiet@example.com", 3);
    const app = express();
    lc.mount(app, (t, b) => `<h1>${t}</h1>${b}`);
    const srv = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
    const url = lc.unsubscribeUrl("quiet").replace("https://camberstack.io", base);
    try {
      expect(await (await fetch(url)).text()).toContain("Unsubscribe");               // GET only asks
      expect(db.prepare("SELECT email_opt_out o FROM users").get()).toEqual({ o: 0 });
      expect((await fetch(url.replace(/s=.{4}/, "s=XXXX"), { method: "POST" })).status).toBe(400);
      expect((await fetch(url, { method: "POST", body: "List-Unsubscribe=One-Click",
        headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(200);
      expect(db.prepare("SELECT email_opt_out o FROM users").get()).toEqual({ o: 1 });
      expect(await lc.run()).toBe(0);
      expect(sent).toHaveLength(0);
    } finally { srv.close(); }
  });

  it("retries a failed send next run instead of marking it sent", async () => {
    const { db, user } = setup();
    let fail = true; const sent: any[] = [];
    const lc = new Lifecycle({ db, clock: () => MORNING, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32), internalEmails: new Set(),
      mail: { apiKey: "k", from: "f", replyTo: "r" }, upgradeLink: () => null,
      fetch: (async (_u: string, init: RequestInit) => { if (fail) return new Response("down", { status: 500 }); sent.push(init.body); return new Response("{}"); }) as any });
    user("quiet", "quiet@example.com", 3);
    const err = console.error; console.error = () => {};
    try { expect(await lc.run()).toBe(0); } finally { console.error = err; }
    fail = false;
    expect(await lc.run()).toBe(1);
  });
});

describe("pro_welcome (transactional)", () => {
  const pro = (db: any, id: string, email: string, sub: string | null, optOut = 0) =>
    db.prepare("INSERT INTO users (id, google_sub, email, enc_refresh, created_at, plan, stripe_sub, email_opt_out) VALUES (?, ?, ?, 'x', ?, 'pro', ?, ?)")
      .run(id, `sub-${id}`, email, now(), sub, optOut);

  it("goes once to each Stripe Pro user, at any hour, never to internal, PRO_EMAILS-only or opted-out users", async () => {
    const { db, lc, sent, user } = setup(() => new Date("2026-10-14T03:00:00Z"));  // 10pm in Chicago: no morning wait
    pro(db, "paid", "paid@example.com", "sub_1");
    pro(db, "comp", "comp@example.com", null);          // Pro through PRO_EMAILS, no subscription
    pro(db, "me", "me@example.com", "sub_2");           // internal
    pro(db, "quiet", "quiet@example.com", "sub_3", 1);  // unsubscribed
    user("free", "free@example.com", 3);              // signed up before welcome shipped
    expect(await lc.transactional()).toBe(1);
    expect(sent.map((m) => m.to[0])).toEqual(["paid@example.com"]);
    const m = sent[0];
    expect(m.subject).toBe("You're on Camberstack Pro");
    expect(m.text).toContain("up to 5 Google Ads accounts");
    expect(m.text).toContain("$15/month");
    expect(m.text).toContain("https://camberstack.io/account");
    expect(m.reply_to).toBe("adam@camberstack.io");
    expect(await lc.transactional()).toBe(0);  // never twice
    expect(await lc.run()).toBe(0);            // and the hourly run doesn't send it
  });

  it("retries a failed send on the next run", async () => {
    const { db, lc, sent } = setup();
    pro(db, "paid", "paid@example.com", "sub_1");
    const real = (lc as any).d.fetch;
    (lc as any).d.fetch = async () => new Response("down", { status: 500 });
    const err = console.error; console.error = () => {};
    try { expect(await lc.transactional()).toBe(0); } finally { console.error = err; }
    (lc as any).d.fetch = real;
    expect(await lc.transactional()).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("welcome (transactional)", () => {
  it("goes once to a Free user who just signed up, never to earlier signups, Pro, internal or disconnected users", async () => {
    const { db, lc, sent, user } = setup(() => new Date("2026-10-14T03:00:00Z"));  // any hour
    const token = (id: string) => db.prepare("INSERT INTO tokens (token_hash, kind, client_id, user_id, scopes, expires_at) VALUES (?, 'refresh', 'c', ?, '', ?)")
      .run(`h-${id}`, id, now() + DAY);
    user("new", "new@example.com", 0);
    user("old", "old@example.com", 3);                 // before welcome shipped: no backfill
    user("paid", "paid@example.com", 0, "pro");        // gets pro_welcome only if Stripe; never welcome
    user("me", "me@example.com", 0);                   // internal
    user("gone", "gone@example.com", 0);
    db.prepare("UPDATE users SET enc_refresh = NULL WHERE id = 'gone'").run();
    user("dropped", "dropped@example.com", 0);         // the app never swapped its code for a token: not connected
    for (const id of ["new", "old", "paid", "me", "gone"]) token(id);
    expect(await lc.transactional()).toBe(1);
    expect(sent.map((m) => m.to[0])).toEqual(["new@example.com"]);
    const m = sent[0];
    expect(m.subject).toBe("Welcome to Camberstack");
    expect(m.text).toContain("How did each of my Google Ads campaigns do last month?");
    expect(m.text).toContain("demo account");
    expect(m.text).toContain("https://camberstack.io/account");
    expect(m.text).toContain("$15/month");
    expect(await lc.transactional()).toBe(0);  // never twice
    token("dropped");                            // connected after all, later the same day
    expect(await lc.transactional()).toBe(1);
    expect(sent.at(-1).to).toEqual(["dropped@example.com"]);
  });

  it("a Free user who then upgrades gets both, welcome first", async () => {
    const { db, lc, sent, user } = setup();
    user("u", "u@example.com", 0);
    db.prepare("INSERT INTO tokens (token_hash, kind, client_id, user_id, scopes, expires_at) VALUES ('h-u', 'refresh', 'c', 'u', '', ?)").run(now() + DAY);
    expect(await lc.transactional()).toBe(1);
    db.prepare("UPDATE users SET plan = 'pro', stripe_sub = 'sub_1' WHERE id = 'u'").run();
    expect(await lc.transactional()).toBe(1);
    expect(sent.map((m) => m.subject)).toEqual(["Welcome to Camberstack", "You're on Camberstack Pro"]);
  });
});
