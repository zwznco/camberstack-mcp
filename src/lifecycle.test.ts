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
    agencyLink: (u) => `https://camberstack.io/agency?t=${u}.sig`,
    fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any,
  });
  const user = (id: string, email: string, ageDays: number, extra = "") =>
    db.prepare(`INSERT INTO users (id, google_sub, email, enc_refresh, created_at${extra ? ", plan" : ""}) VALUES (?, ?, ?, 'x', ?${extra ? ", ?" : ""})`)
      .run(...[id, `sub-${id}`, email, now() - ageDays * DAY, ...(extra ? [extra] : [])]);
  // Two hours ago: their session has ended (an upgrade email waits for that). `ago` in seconds.
  const call = (userId: string, tool: string, ago = 7200) =>
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, ms, bytes) VALUES (?, ?, ?, 1, 10, 10)").run(now() - ago, userId, tool);
  const applied = (userId: string, daysAgo: number, cid = "1112223333", undoOf: string | null = null) =>
    db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, undo_of, created_at, applied_at)
      VALUES (?, ?, ?, '[{"type":"pause_campaign"}]', 's', 'applied', ?, ?, ?)`).run(`p${Math.random()}`, userId, cid, undoOf, now() - daysAgo * DAY, now() - daysAgo * DAY);
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
    user("gtm", "gtm@example.com", 3); call("gtm", "tag_manager_setup");      // so is Tag Manager alone (2026-11-18)
    user("chatgpt", "chatgpt@example.com", 3); call("chatgpt", "propose_pause_keyword");  // ChatGPT's per-operation tools
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

  it("tells a first_steps user whose login has no Google Ads account so, instead of the campaign question (2026-11-16)", async () => {
    const { db, lc, sent, user } = setup();
    user("none", "none@example.com", 3); db.prepare("UPDATE users SET ads_accounts = 0, ads_managers = 0 WHERE id = 'none'").run();
    user("mcc", "mcc@example.com", 3); db.prepare("UPDATE users SET ads_accounts = 0, ads_managers = 1 WHERE id = 'mcc'").run();
    user("unknown", "unknown@example.com", 3);       // never listed: the usual email
    expect(await lc.run()).toBe(3);
    const by = Object.fromEntries(sent.map((m) => [m.to[0], m]));
    expect(by["none@example.com"].subject).toBe("Camberstack can't find a Google Ads account");
    expect(by["none@example.com"].text).toContain("different Google login");
    expect(by["none@example.com"].text).not.toContain("demo");
    expect(by["none@example.com"].text).not.toContain("last month");
    expect(by["mcc@example.com"].subject).toBe("The first thing to ask Camberstack");
    expect(by["unknown@example.com"].subject).toBe("The first thing to ask Camberstack");
    expect(db.prepare("SELECT kind FROM email_log WHERE user_id = 'none'").all()).toEqual([{ kind: "first_steps" }]);
    expect(await lc.run()).toBe(0);
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
    setChangeCap(10);
    try {
    // At the cap: 10 approvals, the oldest 20 days ago, so the next opens in 10 days.
    const atCap = (userId: string) => { for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at, applied_at)
        VALUES (?, ?, '1112223333', '[{"type":"pause_campaign"}]', 's', 'applied', ?, ?)`).run(`${userId}-${i}`, userId, now() - 20 * DAY, now() - (20 - i) * DAY);
      // Their check-in went long ago, so it isn't due here (its window reaches back 22 days).
      db.prepare("INSERT OR IGNORE INTO email_log (user_id, kind, sent_at) VALUES (?, 'check_in', ?)").run(userId, now() - 17 * DAY); };
    const opens = new Date((now() + 10 * DAY) * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    // Each has used Camberstack (so no first_steps), then been stopped.
    const stopped = (userId: string, daysAgo: number) => call(userId, "account_overview") &&
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'apply_changes', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days, "
          + "and this login has used them; the next opens on 2026-12-02. Proposal p1 stays open.");
    user("capped", "capped@example.com", 10); stopped("capped", 0.3); atCap("capped");
    user("recent", "recent@example.com", 10); stopped("recent", 0.3); atCap("recent"); call("recent", "account_overview", 1800);  // still in the session
    user("pro", "pro@example.com", 10, "pro"); stopped("pro", 0.3); atCap("pro");
    // No longer at the cap (the window rolled, or a paid plan ended since): nothing.
    user("rolled", "rolled@example.com", 10); stopped("rolled", 0.3);
    // An earlier account-limit email doesn't hold this one back.
    user("had", "had@example.com", 10); stopped("had", 0.3); atCap("had");
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES ('had', 'limit_reached', ?)").run(now() - 4 * DAY);
    // Stopped by both gates by the same morning: one upgrade email, change_limit, not limit_reached too.
    user("both", "both@example.com", 10); stopped("both", 0.3); atCap("both");
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'both', 'account_overview', 1, ?, 10, 10)")
      .run(now() - 0.4 * DAY, "Plan limit: the Free plan covers 1 Google Ads account at a time. Another opens on 2026-12-01.");
    expect(await lc.run()).toBe(3);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["both@example.com", "capped@example.com", "had@example.com"]);
    expect(sent.find((x) => x.to[0] === "both@example.com").subject).toBe("Your Google Ads change wasn't applied");
    // After the account-limit email, it says this is a different limit; without one, it doesn't.
    expect(sent.find((x) => x.to[0] === "had@example.com").text).toContain("This is a different limit from the one-account one I wrote about before. You approved");
    const m = sent.find((x) => x.to[0] === "capped@example.com");
    expect(m.text).not.toContain("different limit");
    // The stop named p1, which isn't in the db: the email falls back to "a change", still waiting.
    expect(m.text).toContain("You approved a change in Camberstack, but it wasn't applied: Free includes 10 applied changes every 30 days and you've used them. It's still waiting, ready to go.");
    // Against paying: no "nothing is lost", no "reading and proposing are never limited".
    expect(m.text).not.toMatch(/nothing is lost|never limited/);
    expect(m.subject).toBe("Your Google Ads change wasn't applied");
    expect(m.text).toContain(`If you'd rather wait, your next free change opens on ${opens}. Questions? Just reply.`);
    expect(m.text).toContain("https://camberstack.io/upgrade?t=capped.sig");
    // Once per user: another stop sends nothing.
    stopped("capped", 0.25);
    expect(await lc.run()).toBe(0);
    } finally { setChangeCap(null); }
  });

  it("pitches Plus in change_limit when it's sold, and welcomes a Plus subscriber with what Plus adds", async () => {
    const { db, lc, sent, user, call } = setup();
    (lc as any).d.plusLink = (u: string) => `https://camberstack.io/upgrade?t=${u}.sig&plan=plus`;
    setChangeCap(10);
    try {
      user("cap", "cap@example.com", 10); call("cap", "account_overview");
      for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at, applied_at)
        VALUES (?, 'cap', '1112223333', '[{"type":"pause_campaign"}]', 's', 'applied', ?, ?)`).run(`cap-${i}`, now() - DAY, now() - DAY);
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'cap', 'apply_changes', 1, ?, 10, 10)").run(now() - 0.3 * DAY,
        "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days, and this login has used them; the next opens on 2026-12-02.");
      expect(await lc.run()).toBe(1);
      expect(sent[0].text).toContain("Plus applies it now, with unlimited changes on one Google Ads account, for $7/month. Cancel any time.");
      expect(sent[0].text).toContain("https://camberstack.io/upgrade?t=cap.sig&plan=plus");
      expect(sent[0].html).toContain(">Apply it with Plus</a>");
      db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_sub, created_at) VALUES ('pl', 'g-pl', 'pl@example.com', 'plus', 'sub_pl', ?)").run(now());
      expect(await lc.transactional()).toBe(1);
      expect(sent.at(-1).subject).toBe("You're on Camberstack Plus");
      expect(sent.at(-1).text).toContain("What Plus adds: unlimited applied changes on one Google Ads account (Free stops at 10 every 30 days), and the trend report: ask what changed lately");
      expect(sent.at(-1).text).toContain("$7/month, renewing monthly");
    } finally { setChangeCap(null); }
  });

  it("names the stopped proposal in change_limit by count and change types only, never its summary", async () => {
    const { db, lc, sent, user, call } = setup();
    setChangeCap(10);
    try {
      const capped = (uid: string, stoppedId: string, status: string) => {
        user(uid, `${uid}@example.com`, 10); call(uid, "account_overview");
        for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at, applied_at)
          VALUES (?, ?, '1112223333', '[{"type":"pause_campaign"}]', 's', 'applied', ?, ?)`).run(`${uid}-${i}`, uid, now() - DAY, now() - DAY);
        db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at) VALUES (?, ?, '1112223333', ?, ?, ?, ?)`)
          .run(stoppedId, uid, JSON.stringify([{ type: "pause_keywords" }, { type: "pause_keywords" }, { type: "add_negative_keywords" }]),
            "Pause keyword 'secret plumber term' ($140/mo)", status, now() - DAY);
        db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'apply_changes', 1, ?, 10, 10)").run(now() - 0.3 * DAY, uid,
          `Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days, and this login has used them; the next opens on 2026-12-02. Proposal ${stoppedId} stays open.`);
      };
      capped("open", "p_open1", "proposed");
      capped("gone", "p_gone1", "discarded");
      // Merged proposals stopped together (0.33.0): "Proposals p_…, p_… stay open". Counts add up; one still open = waiting.
      capped("merged", "p_mrg1", "proposed");
      db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at) VALUES ('p_mrg2', 'merged', '1112223333', ?, 's', 'discarded', ?)`)
        .run(JSON.stringify([{ type: "update_campaign_budget" }]), now() - DAY);
      db.prepare("UPDATE tool_calls SET error = replace(error, 'Proposal p_mrg1 stays open', 'Proposals p_mrg1, p_mrg2 stay open') WHERE user_id = 'merged'").run();
      expect(await lc.run()).toBe(3);
      expect(sent.find((m) => m.to[0] === "merged@example.com").text)
        .toContain("You approved 4 changes (pause keywords, add negative keywords, update campaign budget) in Camberstack, but they weren't applied: Free includes 10 applied changes every 30 days and you've used them. They're still waiting");
      const open = sent.find((m) => m.to[0] === "open@example.com"), gone = sent.find((m) => m.to[0] === "gone@example.com");
      expect(open.text).toContain("You approved 3 changes (pause keywords, add negative keywords) in Camberstack, but they weren't applied");
      expect(open.text).toContain("They're still waiting, ready to go.");
      expect(open.html).toContain(">Apply them with Pro</a>");
      // Discarded since the stop: not "waiting", and no "applies it now".
      expect(gone.text).not.toContain("still waiting");
      expect(gone.text).toContain("Pro has unlimited changes on up to 5 Google Ads accounts");
      expect(gone.html).toContain(">Upgrade to Pro</a>");
      // The summary (Google Ads data) never reaches the email.
      for (const m of [open, gone]) expect(m.text + m.html).not.toMatch(/secret plumber|\$140/);
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
    user("recent", "recent@example.com", 10); call("recent", "propose_changes"); refused("recent", 0.3); call("recent", "account_overview", 1800);  // still in the session
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

  it("sends paid_limit once to a paying Plus or Pro user refused another account on that plan, offering the plan above", async () => {
    // Prod, 2026-11-12: a Pro user with 16 accounts was refused, clicked Agency twice, and no email reached them.
    const { db, lc, sent, user, call } = setup();
    const refused = (userId: string, daysAgo: number, plan: string, n: number) =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'switch_account', 1, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, `Plan limit: Camberstack has been used on ${n} Google Ads accounts in the last 30 days; ${plan} covers ${n} at a time `
          + "(active: 1112223333), with no switching between them. Another opens on 2026-12-06, if 2250112931 isn't used again before then.");
    const paying = (id: string, plan: string) => { user(id, `${id}@example.com`, 20, plan); call(id, "account_overview");
      db.prepare("UPDATE users SET stripe_sub = ? WHERE id = ?").run(`sub_${id}`, id); };
    paying("pro", "pro"); refused("pro", 0.3, "Pro", 5);
    paying("plus", "plus"); refused("plus", 0.4, "Plus", 1);
    paying("soon", "pro"); refused("soon", 0.3, "Pro", 5); call("soon", "account_overview", 1800);  // still in the session
    paying("upgraded", "pro"); refused("upgraded", 0.3, "Free", 1);        // refused on Free, before paying: not this email
    paying("agency", "agency"); refused("agency", 0.3, "Agency", 25);       // nothing above Agency
    user("comp", "comp@example.com", 20, "pro"); call("comp", "account_overview"); refused("comp", 0.3, "Pro", 5);  // complimentary
    expect(await lc.run()).toBe(2);
    const pro = sent.find((m) => m.to[0] === "pro@example.com"), plus = sent.find((m) => m.to[0] === "plus@example.com");
    expect(pro.subject).toBe("Using Camberstack on more Google Ads accounts");
    expect(pro.text).toContain("Your Pro plan covers 5 accounts at a time");
    expect(pro.text).toContain("on December 6, if it isn't used before then");
    expect(pro.text).toContain("Agency covers up to 25");
    expect(pro.text).toContain("https://camberstack.io/agency?t=pro.sig");
    expect(pro.html).toContain("Switch to Agency");
    expect(plus.text).toContain("Your Plus plan covers one account at a time");
    expect(plus.text).toContain("Pro covers up to 5");
    expect(plus.text).toContain("https://camberstack.io/upgrade?t=plus.sig");
    for (const m of sent) expect(m.text).not.toMatch(/On Free|Free plan/);
    expect(db.prepare("SELECT user_id FROM email_log WHERE kind = 'paid_limit' ORDER BY user_id").all()).toEqual([{ user_id: "plus" }, { user_id: "pro" }]);
    // Once per user, even after another refusal.
    refused("pro", 0.3, "Pro", 5);
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
    user("old", "old@example.com", 30); used("old"); applied("old", 25);                    // before this email existed
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

  it("sends an upgrade email an hour after the session ends, in the user's daytime, not their morning (2026-11-24)", async () => {
    const at = { now: new Date("2026-10-13T22:00:00Z") };  // 5pm in Chicago: daytime, not morning
    const { db, lc, sent, user, call, applied } = setup(() => at.now);
    setChangeCap(10);
    try {
    const capped = (id: string, stopAgo: number) => {
      for (let i = 0; i < 10; i++) applied(id, 3 - i * 0.1);
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'apply_changes', 1, ?, 10, 10)")
        .run(now() - stopAgo, id, "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days; the next opens on 2026-12-02.");
    };
    user("ended", "ended@example.com", 8); call("ended", "account_overview", 5000); capped("ended", 4000);   // quiet 66 minutes
    user("going", "going@example.com", 8); call("going", "account_overview", 5000); capped("going", 4000); call("going", "keywords_report", 600);
    user("quiet", "quiet@example.com", 3);   // first_steps is due, but only in their morning
    expect(await lc.run()).toBe(1);
    expect(sent.map((m) => `${m.to[0]} ${m.subject}`)).toEqual(["ended@example.com Your Google Ads change wasn't applied"]);
    // Night in Chicago: the session has ended, but it waits for 8am.
    db.prepare("DELETE FROM tool_calls WHERE user_id = 'going' AND tool = 'keywords_report'").run();
    at.now = new Date("2026-10-14T04:00:00Z");  // 11pm
    expect(await lc.run()).toBe(0);
    at.now = new Date("2026-10-14T13:00:00Z");  // 8am
    expect(await lc.run()).toBe(1);
    expect(sent.at(-1).to).toEqual(["going@example.com"]);
    } finally { setChangeCap(null); }
  });

  it("sendNow sends one user's due email at any hour and mid-session, once", async () => {
    const { db, lc, sent, user, call, applied } = setup(() => new Date("2026-10-13T05:00:00Z"));  // midnight in Chicago
    setChangeCap(10);
    try {
    const capped = (id: string) => {
      for (let i = 0; i < 10; i++) applied(id, 3 - i * 0.1);
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'apply_changes', 1, ?, 10, 10)")
        .run(now() - 3600, id, "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days; the next opens on 2026-12-02.");
    };
    user("now", "now@example.com", 8); call("now", "account_overview"); capped("now");
    user("other", "other@example.com", 8); call("other", "account_overview"); capped("other");
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES ('now', 'check_in', ?)").run(now() - 5 * DAY);
    expect(await lc.run()).toBe(0);  // not their morning, and the stop was an hour ago
    expect(lc.pending("now").map((d) => d.kind)).toEqual(["change_limit"]);
    expect(await lc.sendNow("now")).toBe(1);
    expect(sent.map((m) => m.to[0])).toEqual(["now@example.com"]);  // only that user
    expect(sent[0].subject).toBe("Your Google Ads change wasn't applied");
    expect(await lc.sendNow("now")).toBe(0);  // once
    expect(lc.pending("nobody")).toEqual([]);
    } finally { setChangeCap(null); }
  });

  it("sends one email per user per run, never within 3 days of another, and check_in not within 7 days of an upgrade email (2026-11-13)", async () => {
    const { db, lc, sent, user, call, applied } = setup();
    setChangeCap(10);
    try {
    const log = (id: string, kind: string, daysAgo: number) => db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES (?, ?, ?)").run(id, kind, now() - daysAgo * DAY);
    const capped = (id: string) => {
      for (let i = 0; i < 10; i++) applied(id, 3 - i * 0.1);
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'apply_changes', 1, ?, 10, 10)")
        .run(now() - 0.3 * DAY, id, "Change limit: nothing was applied. The Free plan includes 10 applied changes every 30 days; the next opens on 2026-12-02.");
    };
    // The 2026-11-13 case: change_limit and check_in both due → change_limit only.
    user("both", "both@example.com", 8); call("both", "account_overview"); capped("both");
    // Any recent email holds a lifecycle one, an announcement included; the transactional welcome doesn't.
    user("announced", "announced@example.com", 8); call("announced", "account_overview"); applied("announced", 3); log("announced", "announce:x", 2);
    user("welcomed", "welcomed@example.com", 3); call("welcomed", "account_overview"); applied("welcomed", 2.5); log("welcomed", "welcome", 2.9);
    // check_in waits a week after an upgrade email, but not after an older one.
    user("pitched", "pitched@example.com", 8); call("pitched", "account_overview"); applied("pitched", 6); log("pitched", "limit_reached", 5);
    user("pitchedLong", "long@example.com", 12); call("pitchedLong", "account_overview"); applied("pitchedLong", 10); log("pitchedLong", "limit_reached", 8);
    // change_limit answers the user's own stop, so a recent announcement doesn't hold it (2026-11-24: held 3 days by one sent after the stop).
    user("cappedAnnounced", "capann@example.com", 8); call("cappedAnnounced", "account_overview"); capped("cappedAnnounced"); log("cappedAnnounced", "announce:x", 1);
    expect(await lc.run()).toBe(4);
    expect(sent.map((m) => `${m.to[0]} ${m.subject}`).sort()).toEqual([
      "both@example.com Your Google Ads change wasn't applied",
      "capann@example.com Your Google Ads change wasn't applied",
      "long@example.com Camberstack: how did it go?",
      "welcomed@example.com Camberstack: how did it go?",
    ]);
    // The held check_in still goes once the gap has passed (its window runs to 22 days).
    db.prepare("UPDATE email_log SET sent_at = ? WHERE user_id = 'both'").run(now() - 4 * DAY);
    expect(await lc.run()).toBe(0);  // past the 3-day gap, still within 7 days of that upgrade email
    db.prepare("UPDATE email_log SET sent_at = ? WHERE user_id = 'both'").run(now() - 7.1 * DAY);
    expect(await lc.run()).toBe(1);
    expect(sent.at(-1).to).toEqual(["both@example.com"]);
    expect(sent.at(-1).subject).toBe("Camberstack: how did it go?");
    } finally { setChangeCap(null); }
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

describe("plan_switch (transactional)", () => {
  const paying = (db: any, id: string, email: string, plan: string) =>
    db.prepare("INSERT INTO users (id, google_sub, email, enc_refresh, created_at, plan, stripe_sub) VALUES (?, ?, ?, 'x', ?, ?, ?)")
      .run(id, `sub-${id}`, email, now() - 30 * DAY, plan, `sub_${id}`);
  const welcomed = (db: any, id: string, ago = 20 * DAY) =>
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES (?, 'pro_welcome', ?)").run(id, now() - ago);
  const switched = (db: any, id: string, src: string, ago = 60) =>
    db.prepare("INSERT INTO plan_events (user_id, kind, src, at) VALUES (?, 'switch', ?, ?)").run(id, src, now() - ago);

  it("tells a paying user who moved Pro → Agency in the portal, once per plan, at any hour, without holding back other email", async () => {
    const { db, lc, sent } = setup(() => new Date("2026-10-14T03:00:00Z"));
    paying(db, "up", "up@example.com", "agency"); welcomed(db, "up"); switched(db, "up", "pro>agency");
    paying(db, "down", "down@example.com", "pro"); welcomed(db, "down"); switched(db, "down", "agency>pro");
    paying(db, "stale", "stale@example.com", "agency"); welcomed(db, "stale"); switched(db, "stale", "pro>agency", 2 * DAY);  // mail down a day: dropped
    paying(db, "back", "back@example.com", "pro"); welcomed(db, "back"); switched(db, "back", "pro>agency");                  // switched back since
    paying(db, "me", "me@example.com", "agency"); welcomed(db, "me"); switched(db, "me", "pro>agency");                      // internal
    expect(await lc.transactional()).toBe(2);
    const up = sent.find((m) => m.to[0] === "up@example.com");
    expect(up.subject).toBe("You're now on Camberstack Agency");
    expect(up.text).toContain("changed from Pro to Agency");
    expect(up.text).toContain("up to 25 Google Ads accounts");
    expect(up.text).toContain("$49/month");
    expect(sent.find((m) => m.to[0] === "down@example.com").text).toContain("up to 5 Google Ads accounts");
    expect(await lc.transactional()).toBe(0);  // never twice
    // A transactional email doesn't hold a lifecycle email back (lastEmail ignores it).
    expect(db.prepare("SELECT kind FROM email_log WHERE user_id = 'up' AND kind LIKE 'plan_switch:%'").all()).toEqual([{ kind: "plan_switch:agency" }]);
  });

  it("waits for pro_welcome, and a switch that came before it is covered by it", async () => {
    const { db, lc, sent } = setup();
    paying(db, "new", "new@example.com", "agency"); switched(db, "new", "pro>agency", 120);
    expect(await lc.transactional()).toBe(1);  // pro_welcome, on Agency; no plan_switch too
    expect(sent.map((m) => m.subject)).toEqual(["You're on Camberstack Agency"]);
    expect(await lc.transactional()).toBe(0);
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
