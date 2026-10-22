import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, now } from "./db.js";
import { buildReport, userDetail, windowStart } from "./report.js";

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

  it("lists the newest error groups first, so a wide window still shows the latest ones", () => {
    const r = buildReport(seed(), { days: 7, exclude: [] });
    expect(r.errors).toHaveLength(15);
    expect(r.errors.slice(0, 2).map((e) => e.error)).toEqual(["PROHIBITED_METRIC", "UNRECOGNIZED_FIELD"]);
  });

  it("counts every error in the window, not just the groups it lists", () => {
    expect(buildReport(seed(), { days: 7, exclude: [] }).errorsInWindow).toBe(62);
    expect(buildReport(seed(), { days: 1, exclude: [] }).errorsInWindow).toBe(2);
  });

  it("counts only live subscriptions as paying", () => {
    const r = buildReport(seed(), { days: 7, exclude: [] });
    expect(r.paying).toBe(1);
    expect(r.users.find((u) => u.id === "lapsed")?.paying).toBe(0);
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

describe("windowStart", () => {
  it("counts whole UTC days ending today", () => {
    const t = Date.parse("2026-10-20T00:52:00Z") / 1000;
    expect(new Date(windowStart(1, t) * 1000).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(new Date(windowStart(7, t) * 1000).toISOString()).toBe("2026-10-14T00:00:00.000Z");
  });
});
