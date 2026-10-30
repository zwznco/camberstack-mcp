import { describe, expect, it } from "vitest";
import { openDb, now } from "./db.js";
import { encrypt } from "./crypto.js";
import { ACCOUNT_DAYS, GRANT_DAYS, retain } from "./retention.js";

describe("retention", () => {
  it("deletes a removed user's saved Merchant Center changes, unless someone else still uses that account", async () => {
    const db = openDb(":memory:"), key = Buffer.alloc(32, 7), t = now(), day = 86400;
    const add = (id: string, seenDaysAgo: number) => db.prepare("INSERT INTO users (id, google_sub, email, enc_refresh, created_at, last_seen_at) VALUES (?, ?, ?, NULL, 1, ?)")
      .run(id, `sub-${id}`, `${id}@example.com`, t - seenDaysAgo * day);
    const call = (id: string, account: string) => db.prepare("INSERT INTO tool_calls (at, user_id, customer_id, tool, ok, ms, bytes) VALUES (?, ?, ?, 'merchant_report', 1, 1, 1)").run(t, id, account);
    const saved = (account: string) => db.prepare("INSERT INTO merchant_overrides (account_id, product, attrs, updated_at) VALUES (?, 'p', '{}', 1)").run(account);
    add("gone", ACCOUNT_DAYS + 1); add("active", 1);
    call("gone", "mc:1"); call("gone", "mc:2"); call("active", "mc:2");
    saved("1"); saved("2"); saved("demo:gone");
    await retain({ db, encryptionKey: key, internalEmails: new Set() });
    expect((db.prepare("SELECT account_id FROM merchant_overrides").all() as { account_id: string }[]).map((r) => r.account_id)).toEqual(["2"]);
  });

  it("drops idle grants at six months and idle accounts at two years, never paying or internal ones", async () => {
    const db = openDb(":memory:"), key = Buffer.alloc(32, 7), t = now(), day = 86400;
    const add = (id: string, seenDaysAgo: number, extra: { plan?: string; stripe_sub?: string; email?: string } = {}) => {
      db.prepare("INSERT INTO users (id, google_sub, email, enc_refresh, created_at, last_seen_at, plan, stripe_sub) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, `sub-${id}`, extra.email ?? `${id}@example.com`, encrypt(key, `rt-${id}`), 1, t - seenDaysAgo * day, extra.plan ?? "free", extra.stripe_sub ?? null);
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, ms, bytes) VALUES (?, ?, 'list_accounts', 1, 1, 1)").run(t, id);
    };
    add("active", 10);
    add("idle", GRANT_DAYS + 1);
    add("gone", ACCOUNT_DAYS + 1);
    add("paying", ACCOUNT_DAYS + 1, { plan: "pro", stripe_sub: "sub_1" });
    add("staff", ACCOUNT_DAYS + 1, { email: "Owner@Example.com" });
    db.prepare("INSERT INTO feedback (at, email, user_id, kind, message) VALUES (?, 'gone@example.com', 'gone', 'other', 'hi')").run(t);

    const revoked: string[] = [];
    const r = await retain({ db, encryptionKey: key, internalEmails: new Set(["owner@example.com"]), revoke: async (tok) => { revoked.push(tok); } }, t);

    const users = Object.fromEntries((db.prepare("SELECT id, enc_refresh IS NOT NULL connected FROM users").all() as { id: string; connected: number }[])
      .map((u) => [u.id, u.connected]));
    expect(users).toEqual({ active: 1, idle: 0, paying: 0, staff: 0 });
    expect(revoked.sort()).toEqual(["rt-gone", "rt-idle", "rt-paying", "rt-staff"]);
    expect(r).toEqual({ grants: 4, accounts: 1 });
    expect(db.prepare("SELECT count(*) n FROM tool_calls WHERE user_id = 'gone'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT user_id FROM feedback").get()).toEqual({ user_id: null });
    // Internal only while listed: off the list, the idle staff account goes too (paying never does).
    expect(await retain({ db, encryptionKey: key, internalEmails: new Set(), revoke: async () => {} }, t)).toEqual({ grants: 0, accounts: 1 });
  });
});
