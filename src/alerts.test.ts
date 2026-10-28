import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { ErrorAlerts, errorCode, findStuck, stuckNow, verdict } from "./alerts.js";

const T = 2_000_000_000;
const BAD_FIELD = "Google Ads API 400: UNRECOGNIZED_FIELD Unrecognized field in the query: 'x'.";
const EU = "Google Ads API 400: EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED Mutates are generally not allowed.";

function setup() {
  const db = openDb(":memory:");
  const user = (id: string, email: string, plan = "free") =>
    db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, ?, ?)").run(id, `s-${id}`, email, plan, T - 86400 * 9);
  const call = (userId: string, ago: number, tool: string, error: string | null = null) =>
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, ?, ?, ?, 1, 1)").run(T - ago, userId, tool, error ? 0 : 1, error);
  const sent: any[] = [];
  const alerts = (mail = true) => new ErrorAlerts({
    db, internalEmails: new Set(["me@x.com"]), to: "op@x.com", clock: () => T, adminUrl: "https://admin.x",
    mail: mail ? { apiKey: "re_test", from: "C <c@x.com>" } : undefined,
    fetch: (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}"); }) as any,
  });
  return { db, user, call, sent, alerts };
}

describe("errorCode", () => {
  it("takes Google's code, the status, or our message's start", () => {
    expect(errorCode(BAD_FIELD)).toBe("UNRECOGNIZED_FIELD");
    expect(errorCode("Google Analytics API 503: The service is currently unavailable.")).toBe("HTTP_503");
    expect(errorCode("Plan limit: Free covers 1 account.")).toBe("Plan limit");
  });
});

describe("findStuck", () => {
  it("skips an error the same tool recovered from within 10 minutes, even for a paying user", () => {
    const s = setup();
    s.user("p", "p@x.com", "pro");
    s.call("p", 3000, "run_gaql", BAD_FIELD);
    s.call("p", 2996, "run_gaql");
    expect(findStuck(s.db, new Set(), T)).toEqual([]);
  });

  it("flags one unrecovered error from a paying user", () => {
    const s = setup();
    s.user("p", "p@x.com", "pro");
    s.call("p", 3000, "run_gaql", BAD_FIELD);
    s.call("p", 2990, "account_overview");
    const [e] = findStuck(s.db, new Set(), T);
    expect(e).toMatchObject({ email: "p@x.com", tool: "run_gaql", code: "UNRECOGNIZED_FIELD", verdict: { act: true } });
    expect(e.after.map((c) => c.tool)).toEqual(["account_overview"]);
  });

  it("needs MIN_REPEATS of the same error for a free user, across the propose_* tools", () => {
    const s = setup();
    s.user("f", "f@x.com");
    s.call("f", 5000, "propose_add_negative_keywords", EU);
    s.call("f", 4000, "propose_create_conversion_action", EU);
    expect(findStuck(s.db, new Set(), T)).toEqual([]);
    s.call("f", 3000, "propose_changes", EU);
    const [e] = findStuck(s.db, new Set(), T);
    expect(e).toMatchObject({ tool: "propose_*", errors: { length: 3 } });
    expect(e.verdict.why).toMatch(/fix it in Google Ads/);
  });

  it("waits out the recovery window, and leaves internal accounts out", () => {
    const s = setup();
    s.user("p", "p@x.com", "pro");
    s.user("me", "me@x.com", "pro");
    s.call("p", 60, "run_gaql", BAD_FIELD);
    s.call("me", 3000, "run_gaql", BAD_FIELD);
    expect(findStuck(s.db, new Set(["me@x.com"]), T)).toEqual([]);
  });
});

describe("verdict", () => {
  it("calls Google outages and recovered errors FYI", () => {
    expect(verdict("HTTP_503", "", false).act).toBe(false);
    expect(verdict("UNRECOGNIZED_FIELD", BAD_FIELD, true).act).toBe(false);
    expect(verdict("METRIC_ACCESS_DENIED", "", false).act).toBe(false);
  });
  it("points a crash at Bugsink", () => {
    expect(verdict("TypeError", "TypeError: Cannot read properties of undefined", false).why).toMatch(/Bugsink/);
  });
});

describe("ErrorAlerts.run", () => {
  it("mails one digest, then not again for the same episode", async () => {
    const s = setup();
    s.user("p", "p@x.com", "pro");
    s.call("p", 3000, "run_gaql", BAD_FIELD);
    expect(await s.alerts().run()).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ to: ["op@x.com"], subject: "Camberstack: p@x.com stuck on run_gaql (paying)" });
    expect(s.sent[0].text).toContain("https://admin.x/users/p");
    expect(await s.alerts().run()).toEqual([]);
    expect(s.sent).toHaveLength(1);
  });

  it("mails a wall again only once it's hit again past the rule, never the same errors twice", async () => {
    const s = setup();
    s.user("f", "f@x.com");
    for (const ago of [9000, 8000, 7000]) s.call("f", ago, "propose_changes", EU);
    expect(await s.alerts().run()).toHaveLength(1);
    s.call("f", 6000, "propose_changes", EU);
    s.call("f", 5000, "propose_changes", EU);
    expect(await s.alerts().run()).toEqual([]);     // 2 new: under MIN_REPEATS
    s.call("f", 4000, "propose_changes", EU);
    const [e] = await s.alerts().run();
    expect(e.errors).toHaveLength(3);               // only the 3 after the first mail
    expect(s.sent).toHaveLength(2);
  });

  it("unclaims when the mail fails, so the next run retries", async () => {
    const s = setup();
    s.user("p", "p@x.com", "pro");
    s.call("p", 3000, "run_gaql", BAD_FIELD);
    const failing = new ErrorAlerts({ db: s.db, internalEmails: new Set(), to: "op@x.com", clock: () => T,
      mail: { apiKey: "k", from: "f" }, fetch: (async () => new Response("no", { status: 500 })) as any });
    await expect(failing.run()).rejects.toThrow(/Resend 500/);
    expect(await s.alerts().run()).toHaveLength(1);
  });
});

describe("stuckNow", () => {
  it("is true only on the third same error in a row with no success of that tool between", () => {
    const s = setup();
    s.user("u", "u@x.com");
    s.call("u", 60, "run_gaql", BAD_FIELD);
    expect(stuckNow(s.db, "u", "run_gaql", BAD_FIELD, T)).toBe(false);
    s.call("u", 40, "list_accounts");             // another tool's success doesn't reset it
    s.call("u", 30, "run_gaql", BAD_FIELD);
    expect(stuckNow(s.db, "u", "run_gaql", BAD_FIELD, T)).toBe(false);
    s.call("u", 20, "run_gaql", BAD_FIELD);
    expect(stuckNow(s.db, "u", "run_gaql", BAD_FIELD, T)).toBe(true);
    s.call("u", 10, "run_gaql", BAD_FIELD);       // shown once per episode
    expect(stuckNow(s.db, "u", "run_gaql", BAD_FIELD, T)).toBe(false);
  });
  it("resets on a success, and skips errors with their own way forward or that no one can fix", () => {
    const s = setup();
    s.user("u", "u@x.com");
    s.call("u", 50, "run_gaql", BAD_FIELD);
    s.call("u", 40, "run_gaql");
    s.call("u", 30, "run_gaql", BAD_FIELD);
    s.call("u", 20, "run_gaql", BAD_FIELD);
    expect(stuckNow(s.db, "u", "run_gaql", BAD_FIELD, T)).toBe(false);
    const down = "Google Analytics API 503: The service is currently unavailable.";
    for (const ago of [30, 20, 10]) s.call("u", ago, "analytics_report", down);
    expect(stuckNow(s.db, "u", "analytics_report", down, T)).toBe(false);
    const limit = "Plan limit: Free covers 1 account.";
    for (const ago of [30, 20, 10]) s.call("u", ago, "account_overview", limit);
    expect(stuckNow(s.db, "u", "account_overview", limit, T)).toBe(false);
  });
});
