import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, now } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { FOLLOW_SECS, NOTE_MAX_AGE_DAYS, markNoted, notesFunnel, resultsReady, takeNote } from "./result-notes.js";

const DAY = 86400;
const NEG = JSON.stringify([{ type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "free", match_type: "PHRASE" }] }]);
const NEG_OK = JSON.stringify([{ describe: "Add 1 negative", ok: true }]);
const AD_EDIT = JSON.stringify([{ type: "edit_responsive_search_ad", ad_id: "1" }]);

const setup = () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "notes-")));
  db.prepare("INSERT INTO users (id, email, google_sub, created_at) VALUES ('u', 'u@example.com', 's', ?), ('ops', 'ops@example.com', 'o', ?)").run(now(), now());
  const ins = db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, result, undo_of, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (id: string, daysAgo: number, o: { cid?: string; changes?: string; status?: string; undoOf?: string; user?: string } = {}) =>
    ins.run(id, o.user ?? "u", o.cid ?? "1112223333", o.changes ?? NEG, `${id} summary\nsecond line`, o.status ?? "applied",
      o.changes === AD_EDIT ? NEG_OK : NEG_OK, o.undoOf ?? null, now() - daysAgo * DAY, now() - daysAgo * DAY);
  return { db, add };
};

describe("results-ready notes", () => {
  it("raises measurable applied changes once their 7 days are up, newest first, within the age limit", () => {
    const { db, add } = setup();
    add("fresh", 3);                          // results not ready yet
    add("ready", 9);
    add("older", 20);
    add("stale", NOTE_MAX_AGE_DAYS + 2);      // the launch backlog stays quiet
    add("adedit", 10, { changes: AD_EDIT });  // nothing to measure
    add("open", 10, { status: "proposed" });
    add("demo", 10, { cid: DEMO_CID });
    expect(resultsReady(db, "u").map((r) => r.proposal_id)).toEqual(["ready", "older"]);
    expect(resultsReady(db, "u")[0]!.summary).toBe("ready summary");
  });

  it("leaves out undone changes and the undos themselves", () => {
    const { db, add } = setup();
    add("kept", 10);
    add("reverted", 10);
    add("undo", 9, { undoOf: "reverted" });
    expect(resultsReady(db, "u").map((r) => r.proposal_id)).toEqual(["kept"]);
  });

  it("raises each change once, only on the accounts asked about", () => {
    const { db, add } = setup();
    add("a1", 9, { cid: "1111111111" });
    add("b1", 9, { cid: "2222222222" });
    const first = takeNote(db, "u", ["1111111111"], "account_overview");
    expect(first).toMatchObject({ results_ready: [{ customer_id: "1111111111", changes_with_results: 1 }] });
    expect(takeNote(db, "u", ["1111111111"], "account_overview")).toEqual({});
    expect(takeNote(db, "u", [], "list_accounts")).toEqual({});
    expect(takeNote(db, "u", ["1111111111", "2222222222"], "list_accounts")).toMatchObject({ results_ready: [{ customer_id: "2222222222" }] });
  });

  it("doesn't raise what change_results already showed, and keeps a note's record when change_results follows it", () => {
    const { db, add } = setup();
    add("seen", 9);
    add("noted", 10);
    markNoted(db, "u", [{ proposal_id: "seen", customer_id: "1112223333" }], "change_results");
    expect(takeNote(db, "u", undefined, "list_accounts")).toMatchObject({ results_ready: [{ changes_with_results: 1, latest: [{ change: "noted summary" }] }] });
    markNoted(db, "u", [{ proposal_id: "noted", customer_id: "1112223333" }], "change_results");
    expect(db.prepare("SELECT via FROM result_notes WHERE proposal_id = 'noted'").get()).toEqual({ via: "list_accounts" });
  });

  it("counts a note as followed only when change_results ran on that account soon after", () => {
    const { db, add } = setup();
    const t = now() - 2 * DAY;
    add("x", 12, { cid: "1111111111" }); add("y", 11, { cid: "1111111111" });
    add("z", 12, { cid: "2222222222" });
    add("o", 12, { cid: "3333333333", user: "ops" });
    markNoted(db, "u", [{ proposal_id: "x", customer_id: "1111111111" }, { proposal_id: "y", customer_id: "1111111111" }], "list_accounts", t);
    markNoted(db, "u", [{ proposal_id: "z", customer_id: "2222222222" }], "account_overview", t);
    markNoted(db, "ops", [{ proposal_id: "o", customer_id: "3333333333" }], "list_accounts", t);
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, ms, bytes) VALUES (?, ?, 'change_results', ?, ?, 1, 1)");
    call.run(t + 60, "u", "1111111111", 1);                 // followed
    call.run(t + FOLLOW_SECS + 60, "u", "2222222222", 1);   // too late
    call.run(t + 60, "ops", "3333333333", 1);               // excluded user
    const U = "(SELECT * FROM users WHERE email != 'ops@example.com')";
    const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql.replaceAll("{U}", U)).all(...p) as T[];
    expect(notesFunnel(q, t - DAY)).toEqual([
      { via: "account_overview", notes: 1, users: 1, changes: 1, followed: 0 },
      { via: "list_accounts", notes: 1, users: 1, changes: 2, followed: 1 },
    ]);
  });
});
