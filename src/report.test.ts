import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, now } from "./db.js";
import { buildReport, capUsage, MONTHLY, ON_REQUEST_GAP, userDetail, windowStart } from "./report.js";
import { setChangeCap } from "./plans.js";

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

  it("counts own-data calls by service, Tag Manager included, and Tag Manager connections by its scope", () => {
    const db = seed(), t = now(), D = 86400;
    db.prepare("UPDATE users SET enc_refresh = 'x', google_scopes = ? WHERE id = 'paid'")
      .run("openid email https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/tagmanager.edit.containers");
    const c = db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, service, ms, bytes) VALUES (?, ?, ?, ?, ?, 1, 1)");
    c.run(t - 60, "paid", "tag_manager_setup", 1, "tag_manager");
    c.run(t - 50, "lapsed", "propose_add_conversion_linker", 1, "tag_manager");
    c.run(t - 40, "paid", "paid_organic_overlap", 1, "ads,search_console");
    c.run(t - 10 * D, "lapsed", "tag_manager_setup", 1, "tag_manager");   // outside the week, inside all time
    c.run(t - 30, "paid", "tag_manager_setup", 1, null);                    // demo container: no service
    c.run(t - 20, "paid", "tag_manager_setup", 0, null);                    // failed
    const r = buildReport(db, { days: 7, exclude: [] });
    const by = Object.fromEntries(r.serviceUse.map((x) => [x.service, x]));
    expect(by["Tag Manager"]).toEqual({ service: "Tag Manager", calls: 2, users: 2, ever: 2 });
    expect(by["Google Ads"]).toMatchObject({ calls: 1, users: 1 });
    expect(by["Search Console"]).toMatchObject({ calls: 1, users: 1 });
    expect(by["Merchant Center"]).toMatchObject({ calls: 0, users: 0, ever: 0 });
    expect(r.permissions["Tag Manager"]).toBe(1);
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

  it("lists real switch attempts after the first day: a different account or a gate stop, not a first pick, a re-pick or listing", () => {
    const db = seed(), t = now(), D = 86400;
    const u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, ads_accounts) VALUES (?, ?, ?, 'free', ?, ?)");
    for (const id of ["mover", "stopped", "repick", "firstpick", "lister", "dayone", "old", "reset", "onlyone"]) u.run(id, id, `${id}@x.com`, t - 30 * D, id === "onlyone" ? 1 : 3);
    db.prepare("UPDATE users SET plan_reset_at = ? WHERE id = 'reset'").run(t - 10 * D);
    const c = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, error, ms, bytes) VALUES (?, ?, ?, ?, ?, ?, 1, 1)");
    const call = (id: string, ago: number, tool: string, cid: string | null, error: string | null = null) => c.run(t - ago, id, tool, cid, 1, error);
    for (const id of ["mover", "stopped", "repick", "firstpick", "lister", "old", "reset"]) call(id, 29 * D, "list_accounts", null);
    call("onlyone", 29 * D, "list_accounts", null);
    call("onlyone", 3 * D, "run_gaql", null, "Plan limit: Camberstack has been used on 2 Google Ads accounts");  // sees 1: not a switch
    call("reset", 20 * D, "run_gaql", "111"); call("reset", 2 * D, "switch_account", "222");             // first pick after a reset by hand
    call("mover", 5 * D, "run_gaql", "111"); call("mover", 2 * D, "switch_account", "222");               // to another account
    call("stopped", 3 * D, "run_gaql", null, "Plan limit: Camberstack has been used on 1 Google Ads account");
    call("repick", 5 * D, "run_gaql", "111"); call("repick", 2 * D, "switch_account", "111");             // the one it's on
    call("firstpick", 2 * D, "run_gaql", null, "Account choice: this plan covers 1 Google Ads account"); call("firstpick", 2 * D - 60, "switch_account", "111");
    call("lister", 3 * D, "list_accounts", null); call("lister", 60, "list_accounts", null);
    call("dayone", 3000, "run_gaql", "111"); call("dayone", 2000, "switch_account", "222");               // first day
    call("old", 25 * D, "run_gaql", "111"); call("old", 20 * D, "switch_account", "222");                 // weeks ago
    const s = buildReport(db, { days: 7, exclude: [] }).switching;
    expect(s.map((x) => [x.id, x.switches, x.stops, x.used])).toEqual([["mover", 1, 0, 2], ["stopped", 0, 1, 0]]);
  });

  it("flags regular users quiet past both the norm and their own longest break, and clears them when they come back", () => {
    const db = openDb(":memory:"), t = now(), today = Math.floor(t / 86400), D = 86400;
    const u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, 'free', ?)");
    const c = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, error, ms, bytes) VALUES (?, ?, 'run_gaql', ?, 1, NULL, 1, 1)");
    const on = (id: string, ...daysAgo: number[]) => daysAgo.forEach((n) => c.run((today - n) * D + 3600, id, "123"));
    for (const id of ["weekly", "fortnightly", "lapsed", "back", "once", "demo"]) u.run(id, id, `${id}@x.com`, t - 90 * D);
    on("weekly", 40, 37, 34, 31, 28, 25);               // returns every 3 days, silent 25: overdue
    on("fortnightly", 60, 46, 32, 18, 9);              // returns every 9-14 days, silent 9: within their own longest
    on("lapsed", 30, 29);                              // no returns of their own, silent 29: past the norm
    on("back", 50, 47, 44, 20, 0);                     // overdue for 24 days, then came back today
    on("once", 3);                                     // one active day: not watched
    const ap = db.prepare("INSERT INTO proposals (id, user_id, customer_id, summary, changes, status, created_at, applied_at) VALUES (?, ?, '123', 's', '[]', 'applied', 0, 0)");
    for (const id of ["weekly", "fortnightly", "back", "once"]) ap.run(`p-${id}`, id);  // lapsed: 2 calls, under the median (5), no change: not watched
    c.run(t - 20 * D, "demo", "0000000001"); c.run(t, "demo", "0000000001");  // never used own data: not watched
    const ch = buildReport(db, { days: 7, exclude: [] }).churn;
    // Returns: 3 x7, 9, 14 x3, 20, 24, so p90 is 20. Weekly is 5 days past it, lapsed 9: the fresher one first.
    expect([ch.p50, ch.p90, ch.longest]).toEqual([3, 20, 24]);
    expect(ch.overdue.map((o) => [o.id, o.silent, o.longest, o.limit])).toEqual([["weekly", 25, 3, 20]]);
    expect(ch.watched).toBe(3);
  });

  it("reads the one-service paywall from switch-on, by existing vs new signups and ChatGPT vs other apps", () => {
    const db = openDb(":memory:");
    const t = now(), on = t - 5 * 86400;
    expect(buildReport(db, { days: 7, exclude: [] }).paywall).toEqual({ since: null, gate: "service", rows: [] });
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
      { existing: 1, chatgpt: 0, merchant: 0, users: 1, stopped: 1, emailed: 0, viewed: 0, clicked: 1, paid: 1, offered: 1, offered_paid: 1,
        stopped_req: 1, offered_req: 1, offered_req_paid: 1, applied: 0 },
      { existing: 0, chatgpt: 1, merchant: 0, users: 1, stopped: 1, emailed: 1, viewed: 1, clicked: 0, paid: 0, offered: 1, offered_paid: 0,
        stopped_req: 1, offered_req: 1, offered_req_paid: 0, applied: 0 },
    ]);
    // A stop that asked for Merchant Center splits them out, a complimentary plan leaves the read, and the flag's date sets existing vs new.
    db.prepare("INSERT INTO tool_calls (at, user_id, client_id, tool, ok, error, ms, bytes, service_wanted) VALUES (?, 'gptnew', 'gpt', 'merchant_report', 1, 'Service limit: x', 1, 1, 'merchant')").run(t - 60);
    u.run("comp", "g4", "c@x.com", t - 20 * 86400, t);
    db.prepare("UPDATE users SET plan = 'plus' WHERE id = 'comp'").run();
    const split = buildReport(db, { days: 7, exclude: [], freeOneServiceFrom: t - 2 * 86400 }).paywall;
    expect(split.since).toBe(t - 2 * 86400);
    expect(split.rows.map((r) => [r.existing, r.chatgpt, r.merchant, r.users])).toEqual([[1, 0, 0, 1], [0, 1, 1, 1]]);
  });

  it("labels a stop on request only when it starts more than ON_REQUEST_GAP after the user's previous call ended (C3)", () => {
    const db = openDb(":memory:");
    const t = now(), on = t - 5 * 86400;
    const u = db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, last_seen_at) VALUES (?, ?, ?, 'free', ?, ?)");
    u.run("chain", "g1", "a@x.com", t - 86400, t);   // the AI reached for a second service mid-answer
    u.run("asked", "g2", "b@x.com", t - 86400, t);   // the user's next message asked for it
    u.run("par", "g3", "c@x.com", t - 86400, t);     // a stop in parallel with a covered call: same answer
    const c = db.prepare("INSERT INTO tool_calls (id, at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, ?, ?, 1, ?, ?, 1)");
    c.run(1, on, "chain", "run_gaql", "Service choice: x", 10);
    c.run(2, t - 600, "chain", "account_overview", null, 4000);       // ends at t-600
    c.run(3, t - 590, "chain", "analytics_report", "Service limit: x", 2000);   // starts t-592: 8 s later → in an answer
    c.run(4, t - 600, "asked", "account_overview", null, 4000);
    c.run(5, t - 500, "asked", "analytics_report", "Service limit: x", 2000);   // starts t-502: 98 s later → on request
    c.run(6, t - 400, "par", "account_overview", null, 20000);        // started t-420, ended t-400
    c.run(7, t - 419, "par", "analytics_report", "Service limit: x", 500);      // started t-419.5, while the covered call ran
    const byUser = (rows: { users: number; stopped: number; stopped_req: number }[]) => rows.reduce((a, r) => ({ s: a.s + r.stopped, q: a.q + r.stopped_req }), { s: 0, q: 0 });
    const p = buildReport(db, { days: 7, exclude: [] }).paywall;
    expect(byUser(p.rows)).toEqual({ s: 3, q: 1 });  // all three stopped; only "asked" on request
    expect(ON_REQUEST_GAP).toBe(45);
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

describe("capUsage", () => {
  it("lists who is at the change cap and when their window frees the next change, counted like the gate", () => {
    const db = openDb(":memory:"), t = now(), DAY = 86400;
    const user = db.prepare("INSERT INTO users (id, google_sub, email, plan, stripe_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const applied = db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, undo_of, created_at, applied_at)
      VALUES (?, ?, ?, '[]', 's', 'applied', ?, ?, ?)`);
    let n = 0;
    const apply = (u: string, daysAgo: number, cid = "1112223333", undo: string | null = null) => applied.run(`p${n++}`, u, cid, undo, t - daysAgo * DAY, t - daysAgo * DAY);
    user.run("full", "g1", "full@example.com", "free", null, t - 40 * DAY);
    for (const d of [20, 12, 5]) apply("full", d);           // 3 of 3: at the cap
    apply("full", 1, "0000000001"); apply("full", 1, "1112223333", "p0");  // the demo and an undo don't count
    apply("full", 31);                                       // out of the window
    user.run("some", "g2", "some@example.com", "free", null, t - 40 * DAY);
    apply("some", 10);
    user.run("payer", "g3", "payer@example.com", "plus", "sub_x", t - 40 * DAY);
    for (const d of [3, 2, 1]) apply("payer", d);
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, 'payer', 'apply_changes', 1, 'Change limit: nothing was applied.', 5, 10)").run(t - 4 * DAY);
    user.run("me", "g4", "me@example.com", "free", null, t - 40 * DAY);
    for (const d of [3, 2, 1]) apply("me", d);
    user.run("idle", "g5", "idle@example.com", "free", null, t - 40 * DAY);
    expect(capUsage(db, [], t)).toEqual([]);  // cap off
    setChangeCap(3, t - 25 * DAY);
    try {
      const rows = capUsage(db, ["ME@example.com"], t);
      expect(rows.map((r) => r.id)).toEqual(["full", "payer", "some"]);  // internal and idle left out; at the cap first, then stops
      expect(rows[0]).toMatchObject({ used: 3, atCap: true, windowEnds: t - 20 * DAY + 30 * DAY, stops: 0 });
      expect(rows[1]).toMatchObject({ plan: "plus", paying: true, atCap: false, stops: 1 });
      expect(rows[2]).toMatchObject({ used: 1, atCap: false, windowEnds: t - 10 * DAY + 30 * DAY });
      // The cap's start cuts the count: approvals before it don't count.
      setChangeCap(3, t - 15 * DAY);
      expect(capUsage(db, [], t).find((r) => r.id === "full")).toMatchObject({ used: 2, atCap: false });
    } finally { setChangeCap(null); }
  });
});
