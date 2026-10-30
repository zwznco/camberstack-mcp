import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { openDb, now } from "./db.js";
import { Lifecycle } from "./lifecycle.js";

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

  it("sends service_limit once, the morning after the one-service gate stopped a second service, naming both and the open date", async () => {
    const { db, lc, sent, user, call } = setup();
    // A stop is a SwitchNotice: logged ok, its text in error (tools.ts).
    const stopped = (userId: string, daysAgo: number, error: string) =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'account_overview', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, error);
    const limit = "Service limit: the Free plan covers one Google service at a time (Google Ads, Search Console or Google Analytics), and this login "
      + "uses it for Search Console. Google Ads opens on Free on 2026-11-27, 30 days after Search Console was last used.";
    user("sc", "sc@example.com", 10); call("sc", "search_console_summary"); stopped("sc", 0.3, limit);
    user("both", "both@example.com", 10); stopped("both", 0.3, "Service limit: the Free plan covers one Google service at a time "
      + "(Google Ads, Search Console or Google Analytics), and Search Console and Google Ads together need more than one.");
    user("recent", "recent@example.com", 10); stopped("recent", 0.2, limit);                 // under 6 hours ago
    user("chose", "chose@example.com", 10); stopped("chose", 0.3, "Service choice: The Free plan covers one Google service");  // not a stop
    user("pro", "pro@example.com", 10, "pro"); stopped("pro", 0.3, limit);
    // One upgrade email per user: an account-limit email already sent rules this one out.
    user("had", "had@example.com", 10); stopped("had", 0.3, limit);
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES ('had', 'limit_reached', ?)").run(now() - DAY);
    expect(await lc.run()).toBe(2);
    const sc = sent.find((m) => m.to[0] === "sc@example.com"), both = sent.find((m) => m.to[0] === "both@example.com");
    expect(sc.subject).toBe("Using Google Ads, Search Console and Google Analytics together");
    expect(sc.text).toContain("stopped when your AI tried to use Google Ads. The Free plan covers one Google service at a time, "
      + "and you're using it for Search Console; Google Ads opens on Free on November 27.");
    expect(sc.text).toContain("https://camberstack.io/upgrade?t=sc.sig");
    expect(sc.text).toContain("every tool and unlimited changes keep working on Search Console");
    expect(both.text).toContain("tried to use Search Console and Google Ads. The Free plan covers one Google service at a time.");
    expect(await lc.run()).toBe(0);
    // ...and the other way: after service_limit, an account-limit refusal sends nothing.
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'sc', 'account_overview', 0, ?, 10, 10)")
      .run(now() - 0.3 * DAY, "Plan limit: Camberstack has been used on 2 Google Ads accounts; the next opens 2026-11-13.");
    expect(await lc.run()).toBe(0);
  });

  it("pitches Plus in service_limit when it's sold, and welcomes a Plus subscriber with what Plus adds", async () => {
    const { db, lc, sent, user } = setup();
    (lc as any).d.plusLink = (u: string) => `https://camberstack.io/upgrade?t=${u}.sig&plan=plus`;
    user("sc", "sc@example.com", 10);
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'sc', 'account_overview', 1, ?, 10, 10)").run(now() - 0.3 * DAY,
      "Service limit: the Free plan covers one Google service at a time (Google Ads, Search Console or Google Analytics), and this login "
      + "uses it for Search Console. Google Ads opens on Free on 2026-11-27, 30 days after Search Console was last used.");
    expect(await lc.run()).toBe(1);
    expect(sent[0].text).toContain("Camberstack Plus covers Google Ads, Search Console and Google Analytics together on one Google Ads account");
    expect(sent[0].text).toContain("for $7/month; cancel any time. Pro ($15/month) does the same on up to 5 accounts.");
    expect(sent[0].text).toContain("https://camberstack.io/upgrade?t=sc.sig&plan=plus");
    expect(sent[0].html).toContain(">Get Plus</a>");
    db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_sub, created_at) VALUES ('pl', 'g-pl', 'pl@example.com', 'plus', 'sub_pl', ?)").run(now());
    expect(await lc.transactional()).toBe(1);
    expect(sent.at(-1).subject).toBe("You're on Camberstack Plus");
    expect(sent.at(-1).text).toContain("What Plus adds: Google Ads, Search Console and Google Analytics together, on one Google Ads account.");
    expect(sent.at(-1).text).toContain("$7/month, renewing monthly");
  });

  it("describes whichever Free is live in the welcome: by account, announced with its date, or one service", async () => {
    const welcomeText = async (freeOneServiceFrom?: number) => {
      const sent: any[] = [];
      const lc = new Lifecycle({ db: openDb(":memory:"), baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7), internalEmails: new Set(),
        mail: { apiKey: "re_test", from: "a <adam@camberstack.io>", replyTo: "adam@camberstack.io" }, upgradeLink: () => null, freeOneServiceFrom,
        fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any });
      await lc.preview("me@example.com");
      return sent.find((m) => m.subject === "Welcome to Camberstack").text as string;
    };
    const off = await welcomeText(), soon = await welcomeText(Date.UTC(2099, 10, 16) / 1000), on = await welcomeText(0);
    expect(off).toContain("Free covers one Google Ads account; Pro ($15/month) covers up to 5, and Agency ($49/month) up to 25.\n");
    expect(soon).toContain("up to 25. From November 16, Free covers one Google service at a time: Google Ads (1 account), Search Console or Google Analytics; Plus ($7/month) covers all three together on 1 Google Ads account, and Pro and Agency on more.");
    expect(on).toContain("Free covers one Google service at a time: Google Ads (1 account), Search Console or Google Analytics; Plus ($7/month) covers Google Ads, Search Console and Google Analytics together on 1 Google Ads account, Pro ($15/month) on up to 5");
    expect(on).not.toContain("From November");
  });

  it("sends limit_reached once, the morning after the plan gate refused a second account, with when the next switch opens", async () => {
    const { db, lc, sent, user, call } = setup();
    const refused = (userId: string, daysAgo: number, error = "Plan limit: Camberstack has been used on 2 Google Ads accounts; "
      + "the Free plan covers 1 at a time (active: 1112223333), with one switch per 30 days, already used; the next opens 2026-11-13.") =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'account_overview', 0, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, error);
    user("capped", "capped@example.com", 10); call("capped", "propose_changes"); refused("capped", 0.3);
    user("recent", "recent@example.com", 10); call("recent", "propose_changes"); refused("recent", 0.2);  // under 6 hours ago
    user("other", "other@example.com", 10); call("other", "propose_changes"); refused("other", 0.3, "Google said no");  // not the gate
    user("pro", "pro@example.com", 10, "pro"); call("pro", "propose_changes"); refused("pro", 0.3);
    expect(await lc.run()).toBe(1);
    expect(sent[0].to).toEqual(["capped@example.com"]);
    expect(sent[0].subject).toBe("Using Camberstack on more than one Google Ads account");
    expect(sent[0].text).toContain("https://camberstack.io/upgrade?t=capped.sig");
    expect(sent[0].text).toContain("up to 5 accounts");
    expect(sent[0].text).toContain("yours was already used; the next one opens on November 13.");
    expect(sent[0].html).toContain("the next one opens on November 13");
    expect(await lc.run()).toBe(0);
  });

  it("sends switch_wanted once to a Free user stopped before a switch, with the plan that covers all their accounts", async () => {
    const { db, sent, user, call } = setup();
    const lc = new Lifecycle({ db, clock: () => MORNING, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7),
      mail: { apiKey: "re_test", from: "Adam at Camberstack <adam@camberstack.io>", replyTo: "adam@camberstack.io" },
      internalEmails: new Set(), upgradeLink: (u) => `https://camberstack.io/upgrade?t=${u}.sig`,
      agencyLink: (u) => `https://camberstack.io/upgrade?t=${u}.sig&plan=agency`,
      fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any });
    // As 0.19.0 logs it: ok, no account, the notice's text in error.
    const notice = (userId: string, daysAgo: number, cid = "2223334444") =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'account_overview', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, `Account switch: using ${cid} spends this plan's one switch per 30 days. 1112223333 would lock until 2026-11-22.`);
    const visible = (id: string, n: number) => db.prepare("UPDATE users SET ads_accounts = ? WHERE id = ?").run(n, id);
    user("few", "few@example.com", 1); call("few", "account_overview"); notice("few", 0.3); visible("few", 5);
    user("many", "many@example.com", 1); call("many", "account_overview"); notice("many", 0.3); visible("many", 12);
    user("soon", "soon@example.com", 1); notice("soon", 0.1);                                  // under 6 hours ago
    user("spent", "spent@example.com", 1); notice("spent", 0.5);                               // then said yes to the switch
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, 'spent', 'switch_account', '2223334444', 1, 10, 10)").run(now() - 0.4 * DAY);
    user("pro", "pro@example.com", 1, "pro"); notice("pro", 0.3);
    expect(await lc.run()).toBe(2);
    const by = Object.fromEntries(sent.map((m) => [m.to[0], m]));
    expect(Object.keys(by).sort()).toEqual(["few@example.com", "many@example.com"]);
    expect(by["few@example.com"].subject).toBe("Working on more than one Google Ads account?");
    expect(by["few@example.com"].text).toContain("You have 5 Google Ads accounts. If you want to manage all of them, try Camberstack Pro: up to 5 accounts");
    expect(by["few@example.com"].text).toContain("https://camberstack.io/upgrade?t=few.sig\n");
    expect(by["many@example.com"].text).toContain("try Camberstack Agency: up to 25 accounts");
    expect(by["many@example.com"].text).toContain("plan=agency");
    expect(by["few@example.com"].text).not.toContain("2223334444");  // counts, never account ids
    // One upgrade email per user: limit_reached later doesn't follow it.
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'few', 'account_overview', 0, 'Plan limit: x; the next opens 2026-11-13.', 10, 10)").run(now() - 0.3 * DAY);
    expect(await lc.run()).toBe(0);
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
