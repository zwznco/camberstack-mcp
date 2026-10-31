import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, now } from "./db.js";
import { buildReport, MONTHLY, userDetail, windowStart } from "./report.js";

describe("buildReport", () => {
  // The seeds sit 25-30 min back; between 00:00 and 00:30 UTC that is yesterday, outside a "today" window. Pin to noon.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date().setUTCHours(12, 0, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });
  const seed = () => {
    const db = openDb(":memory:");
    const user = db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    user.run("paid", "g1", "paid@example.com", "pro", "sub_live", now() - 86400);
    // billing.ts's sweep drops a lapsed subscription to free but leaves stripe_sub behind.
    user.run("lapsed", "g2", "lapsed@example.com", "free", "sub_gone", now() - 86400);
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'paid', ?, ?, ?, 5, 10)");
    // 20 distinct, older, repeated errors, then 2 one-off errors in the last hour: by count, the newest lose.
    for (let i = 0; i < 20; i++) for (let k = 0; k < 3; k++) call.run(now() - 3 * 86400 - i * 60, "run_gaql", 0, `old error ${i}`);
    call.run(now() - 1800, "run_gaql", 0, "UNRECOGNIZED_FIELD");
    call.run(now() - 1500, "run_gaql", 0, "PROHIBITED_METRIC");
    call.run(now() - 60, "account_overview", 1, null);
    return db;
  };

  it("counts only live subscriptions as paying, at each plan's price; complimentary plans and lapsed subscriptions aren't revenue", () => {
    const db = seed();  // "paid": Pro with sub_live; "lapsed": free with a leftover stripe_sub
    const u = db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    u.run("plus", "g3", "plus@example.com", "plus", "sub_plus", now() - 3600);
    u.run("agency", "g4", "agency@example.com", "agency", "sub_ag", now() - 3600);
    u.run("comp", "g5", "comp@example.com", "plus", null, now() - 3600);      // grandfathered: complimentary Plus
    u.run("comppro", "g6", "comppro@example.com", "pro", "", now() - 3600);  // complimentary Pro
    const r = buildReport(db, { days: 7, exclude: [] });
    expect(r.paying).toBe(3);
    expect(r.payingByPlan).toEqual([{ plan: "agency", n: 1 }, { plan: "plus", n: 1 }, { plan: "pro", n: 1 }]);
    expect(r.payingByPlan.reduce((a, p) => a + p.n * MONTHLY[p.plan]!, 0)).toBe(49 + 7 + 15);
    expect(r.funnel.all.paid).toBe(3);
    expect(Object.fromEntries(r.users.map((x) => [x.id, x.paying]))).toMatchObject({ paid: 1, plus: 1, agency: 1, comp: 0, comppro: 0, lapsed: 0 });
    expect(r.retention.reduce((a, c) => a + c.paid, 0)).toBe(3);
  });

  it("lists the newest error groups first, so a wide window still shows the latest ones", () => {
    const r = buildReport(seed(), { days: 7, exclude: [] });
    expect(r.errors).toHaveLength(15);
    expect(r.errors.slice(0, 2).map((e) => e.error)).toEqual(["PROHIBITED_METRIC", "UNRECOGNIZED_FIELD"]);
  });

  it("counts every error in the window, not just the groups it lists", () => {
    expect(buildReport(seed(), { days: 7, exclude: [] }).errorsInWindow).toBe(62);
    expect(buildReport(seed(), { days: 1, exclude: [] }).errorsInWindow).toBe(2);
  });

  it("flags plan opportunities by active accounts, Pro's cap and gate hits, not by reach alone", () => {
    const db = seed();
    const u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, ads_accounts, ads_managers, ads_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    u.run("agency", "g3", "a@x.com", "free", now(), 22, 1, null);   // reach only: still Agency-sized
    u.run("dormant", "g4", "d@x.com", "free", now(), 9, 0, 1);      // reaches 9, but 1 spends: not
    u.run("capped", "g5", "c@x.com", "pro", now(), 15, 1, 12);
    const c = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, error, ms, bytes) VALUES (?, ?, 'run_gaql', ?, ?, ?, 1, 1)");
    for (const cid of ["1", "2", "3", "4", "5"]) c.run(now() - 60, "capped", cid, 1, null);
    c.run(now() - 60, "agency", "9", 0, "Plan limit: Camberstack has been used on 2 Google Ads accounts");
    const o = buildReport(db, { days: 7, exclude: [] }).opportunities;
    expect(Object.fromEntries(o.map((x) => [x.id, x.why]))).toEqual({
      agency: ["Agency-sized: 22 reachable", "hit the account gate 1×"],
      capped: ["Agency-sized: 12 active", "at Pro's 5"],
    });
  });

  it("reads the one-service paywall from switch-on, by existing vs new signups and ChatGPT vs other apps", () => {
    const db = openDb(":memory:");
    const t = now(), on = t - 5 * 86400;
    expect(buildReport(db, { days: 7, exclude: [] }).paywall).toEqual({ since: null, rows: [] });
    db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES ('gpt', ?, 0), ('claude', ?, 0)")
      .run(JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector/oauth/x"] }), JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }));
    const u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, last_seen_at) VALUES (?, ?, ?, 'free', ?, ?)");
    u.run("old", "g1", "o@x.com", t - 20 * 86400, t);      // existing, Claude: stopped, clicked, paid
    u.run("gone", "g2", "g@x.com", t - 20 * 86400, t - 10 * 86400);  // idle since before switch-on: not in the read
    u.run("gptnew", "g3", "n@x.com", t - 86400, t);        // new, ChatGPT: stopped, emailed, viewed /plans
    const c = db.prepare("INSERT INTO tool_calls (at, user_id, client_id, tool, ok, error, ms, bytes) VALUES (?, ?, ?, 'run_gaql', 1, ?, 1, 1)");
    c.run(on, "old", "claude", "Service choice: The Free plan covers one Google service at a time");
    c.run(on + 60, "old", "claude", "Service limit: the Free plan covers one Google service at a time");
    c.run(t - 3600, "gptnew", "gpt", "Service limit: the Free plan covers one Google service at a time");
    db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES ('gptnew', 'service_limit', ?)").run(t);
    const e = db.prepare("INSERT INTO plan_events (user_id, kind, src, at) VALUES (?, ?, ?, ?)");
    e.run("old", "upgrade_click", "tool", on + 120); e.run("old", "paid", "sub_1", on + 180);
    e.run("old", "upgrade_click", "email", on - 86400);    // before switch-on: doesn't count
    e.run("gptnew", "plans_view", null, t - 60);
    const p = buildReport(db, { days: 7, exclude: [] }).paywall;
    expect(p.since).toBe(on);
    expect(p.rows).toEqual([
      { existing: 1, chatgpt: 0, merchant: 0, users: 1, stopped: 1, emailed: 0, viewed: 0, clicked: 1, paid: 1, offered: 1, offered_paid: 1, applied: 0 },
      { existing: 0, chatgpt: 1, merchant: 0, users: 1, stopped: 1, emailed: 1, viewed: 1, clicked: 0, paid: 0, offered: 1, offered_paid: 0, applied: 0 },
    ]);
    // A stop that asked for Merchant Center splits them out, a complimentary plan leaves the read, and the flag's date sets existing vs new.
    db.prepare("INSERT INTO tool_calls (at, user_id, client_id, tool, ok, error, ms, bytes, service_wanted) VALUES (?, 'gptnew', 'gpt', 'merchant_report', 1, 'Service limit: x', 1, 1, 'merchant')").run(t - 60);
    u.run("comp", "g4", "c@x.com", t - 20 * 86400, t);
    db.prepare("UPDATE users SET plan = 'plus' WHERE id = 'comp'").run();
    const split = buildReport(db, { days: 7, exclude: [], freeOneServiceFrom: t - 2 * 86400 }).paywall;
    expect(split.since).toBe(t - 2 * 86400);
    expect(split.rows.map((r) => [r.existing, r.chatgpt, r.merchant, r.users])).toEqual([[1, 0, 0, 1], [0, 1, 1, 1]]);
  });

  it("counts signups by hour today and by day otherwise, and retention by weeks since each user's own signup", () => {
    const db = openDb(":memory:");
    const t = now(), u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, 'free', ?)");
    u.run("old", "g1", "o@x.com", t - 15 * 86400);
    u.run("new", "g2", "n@x.com", t - 3600);
    const c = db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, ms, bytes) VALUES (?, ?, 'run_gaql', ?, 1, 1)");
    c.run(t - 15 * 86400 + 60, "old", 1);  // week 0
    c.run(t - 6 * 86400, "old", 1);        // week 1
    c.run(t - 86400, "old", 0);            // week 2, but failed
    expect(buildReport(db, { days: 1, exclude: [] }).signupsHourly).toEqual([{ hour: 11, n: 1 }]);
    expect(buildReport(db, { days: 30, exclude: [] }).signupsDaily.map((x) => x.n)).toEqual([1, 1]);
    const ret = buildReport(db, { days: 1, exclude: [] }).retention;
    // Weeks count from the signup, not the cohort's Monday: 15 days on is W2, still under way (done = 2). Tool calls alone
    // aren't retention any more: only applied changes are (the next test).
    expect(ret.find((r) => r.users === 1 && r.applied.length === 1)).toMatchObject({ applied: [0], done: 0, appliers: 0 });
    expect(ret.find((r) => r.applied.length > 1)).toMatchObject({ applied: [0, 0, 0], done: 2 });
  });

  it("counts, per cohort, who applied a real change in each week since signup, and who pays", () => {
    const db = openDb(":memory:");
    const t = now(), u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, ?, ?)");
    u.run("a", "g1", "a@x.com", "pro", t - 15 * 86400);
    db.prepare("UPDATE users SET stripe_sub = 'sub_a' WHERE id = 'a'").run();  // paying: a live subscription, not complimentary
    u.run("b", "g2", "b@x.com", "free", t - 15 * 86400 + 60);
    const p = db.prepare("INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at, applied_at) VALUES (?, ?, ?, '[]', '', ?, ?, ?)");
    p.run("p1", "a", "1", "applied", t - 15 * 86400 + 600, t - 15 * 86400 + 600);  // week 0
    p.run("p2", "a", "1", "applied", t - 86400, t - 86400);                         // week 2
    p.run("p3", "b", "0000000001", "applied", t - 86400, t - 86400);                // demo: not counted
    p.run("p4", "b", "1", "proposed", t - 86400, null);                             // never applied
    const c = buildReport(db, { days: 1, exclude: [] }).retention.find((r) => r.users === 2);
    expect(c).toMatchObject({ appliers: 1, paid: 1, applied: [1, 0, 1] });
  });

  it("counts applied changes by when they were applied, not by when the user signed up", () => {
    const db = seed();
    const p = db.prepare("INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at, applied_at) VALUES (?, 'paid', ?, '[]', '', ?, ?, ?)");
    p.run("old", "1", "applied", now() - 20 * 86400, now() - 20 * 86400);
    p.run("new", "1", "applied", now() - 60, now() - 60);
    p.run("new2", "2", "applied", now() - 30, now() - 30);
    p.run("open", "1", "proposed", now() - 30, null);
    expect(buildReport(db, { days: 1, exclude: [] }).appliedInWindow).toEqual({ users: 1, changes: 2 });
    expect(buildReport(db, { days: 30, exclude: [] }).appliedInWindow).toEqual({ users: 1, changes: 3 });
  });

  it("counts only live subscriptions as paying", () => {
    const r = buildReport(seed(), { days: 7, exclude: [] });
    expect(r.paying).toBe(1);
    expect(r.users.find((u) => u.id === "lapsed")?.paying).toBe(0);
  });
});

describe("sharing", () => {
  it("flags an ad account run by two users and a manager two logins reach, not the demo or one user's own", () => {
    const db = openDb(":memory:");
    const user = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, ads_manager_ids, ads_accounts_at) VALUES (?, ?, ?, 'free', 0, ?, ?)");
    user.run("a", "ga", "a@agency.com", '["9990001111"]', now() - 60);
    user.run("b", "gb", "b@agency.com", '["9990001111","8880002222"]', now() - 30);
    user.run("me", "gm", "me@op.com", '["8880002222"]', now());
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, ?, 'account_overview', ?, ?, 1, 1)");
    call.run(now() - 10, "a", "1112223333", 1);
    call.run(now() - 5, "b", "1112223333", 1);
    call.run(now(), "a", "4445556666", 1);
    call.run(now(), "b", "4445556666", 0);              // a refused call isn't use
    call.run(now(), "a", "0000000001", 1);              // the demo is everyone's
    call.run(now(), "b", "0000000001", 1);
    call.run(now(), "me", "1112223333", 1);             // the operator's own login is excluded

    const s = buildReport(db, { days: 7, exclude: ["me@op.com"] }).sharing;
    expect(s.map((x) => [x.kind, x.customer_id, JSON.parse(x.users).map((u: { id: string }) => u.id).sort()])).toEqual([
      ["ad account", "1112223333", ["a", "b"]],
      ["manager", "9990001111", ["a", "b"]],
    ]);
  });
});

describe("came from", () => {
  it("splits connects by the app of the first call, else of a live token", () => {
    const db = openDb(":memory:");
    const client = db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES (?, ?, 0)");
    client.run("gpt", JSON.stringify({ client_name: "ChatGPT" }));
    client.run("cl", JSON.stringify({ client_name: "Claude" }));
    const user = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, 'free', ?)");
    for (const id of ["called", "token", "none"]) user.run(id, id, `${id}@example.com`, now() - 60);
    // First call wins over later apps.
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, client_id, tool, ok, ms, bytes) VALUES (?, 'called', ?, 'list_accounts', 1, 5, 10)");
    call.run(now() - 50, "gpt");
    call.run(now() - 40, "cl");
    db.prepare("INSERT INTO tokens (token_hash, kind, client_id, user_id, scopes, expires_at) VALUES ('h', 'refresh', 'gpt', 'token', '', ?)").run(now() + 86400);
    const r = buildReport(db, { days: 7, exclude: [] });
    expect(r.sources.map((s) => [s.app, s.connected])).toEqual([["ChatGPT", 2], [null, 1]]);
    expect(userDetail(db, "called")!.user.came_from).toBe("ChatGPT");
    expect(userDetail(db, "none")!.user.came_from).toBeNull();
    // An app that dropped the sign-in before taking its token is still named, from the client it signed up through;
    // "Claude Code (camberstack)" counts as Claude Code.
    client.run("cx", JSON.stringify({ client_name: "Codex" }));
    client.run("cc1", JSON.stringify({ client_name: "Claude Code" }));
    client.run("cc2", JSON.stringify({ client_name: "Claude Code (camberstack)" }));
    for (const [id, c] of [["dropped", "cx"], ["cc-a", "cc1"], ["cc-b", "cc2"]]) {
      user.run(id, id, `${id}@example.com`, now() - 60);
      db.prepare("UPDATE users SET signup_client_id = ? WHERE id = ?").run(c, id);
    }
    expect(buildReport(db, { days: 7, exclude: [] }).sources.map((s) => [s.app, s.connected]))
      .toEqual([["ChatGPT", 2], ["Claude Code", 2], ["Codex", 1], [null, 1]]);
  });
});

describe("userDetail", () => {
  it("counts calls from the window's start, but keeps proposals all-time", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES ('u', 'g', 'u@example.com', 'free', ?)").run(now() - 60 * 86400);
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, 'u', ?, ?, 1, 5, 10)");
    call.run(now() - 30 * 86400, "run_gaql", "1111111111");
    call.run(windowStart(1) + 1, "account_overview", "2222222222");
    db.prepare("INSERT INTO proposals (id, user_id, customer_id, summary, changes, status, created_at) VALUES ('p', 'u', '1111111111', 's', '[]', 'applied', ?)").run(now() - 30 * 86400);
    const all = userDetail(db, "u")!, today = userDetail(db, "u", windowStart(1))!;
    expect(all.totals.calls).toBe(2);
    expect(today.totals.calls).toBe(1);
    expect(today.accounts.map((a) => a.customer_id)).toEqual(["2222222222"]);
    expect(today.tools.map((t) => t.tool)).toEqual(["account_overview"]);
    expect(today.recent).toHaveLength(1);
    expect(today.proposals).toHaveLength(1);
  });
});

describe("userDetail tool lists", () => {
  it("gives a ChatGPT app user the app's newest fetch, since ChatGPT fetches once for everyone", () => {
    const db = openDb(":memory:");
    const client = db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES (?, ?, 0)");
    client.run("gpt", JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/x"] }));
    client.run("claude", JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }));
    const user = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, 'free', 0)");
    for (const u of ["reviewer", "user", "other"]) user.run(u, u, `${u}@example.com`);
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, client_id, tool, ok, ms, bytes) VALUES (1, ?, ?, 'list_accounts', 1, 5, 10)");
    call.run("user", "gpt"); call.run("user", "claude");
    const list = db.prepare("INSERT INTO client_tools (user_id, client_id, version, fetched_at) VALUES (?, ?, ?, ?)");
    list.run("reviewer", "gpt", "0.18.0", 100);
    list.run("reviewer2", "gpt", "0.19.0", 200);
    list.run("other", "claude", "0.19.0", 300);  // Claude fetches per user: another user's list says nothing about this one's
    const x = userDetail(db, "user")!;
    expect(x.toolLists).toEqual([]);
    expect(x.appToolLists).toEqual([{ client: "ChatGPT", version: "0.19.0", fetched_at: 200 }]);
  });
});

describe("windowStart", () => {
  it("counts whole UTC days ending today", () => {
    const t = Date.parse("2026-10-20T00:52:00Z") / 1000;
    expect(new Date(windowStart(1, t) * 1000).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(new Date(windowStart(7, t) * 1000).toISOString()).toBe("2026-10-14T00:00:00.000Z");
  });
});
