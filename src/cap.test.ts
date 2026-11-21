import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, now } from "./db.js";
import { capChanges, capCounted } from "./session.js";

const DAY = 86400;

describe("capCounted", () => {
  const setup = () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "cap-")));
    db.prepare("INSERT INTO users (id, email, google_sub, created_at) VALUES ('u', 'u@example.com', 's', ?)").run(now());
    const ins = db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, created_at, applied_at)
        VALUES (?, 'u', ?, ?, 's', 'applied', ?, ?)`);
    return { db, add: (id: string, at: number, changes = '[{"type":"pause_campaign"}]', cid = "1112223333") => ins.run(id, cid, changes, at, at) };
  };

  it("counts each change in an applied proposal, not each approval", () => {
    // Prod, 2026-11-21: a Free user's one apply of 12 merged proposals counted once.
    const { db, add } = setup();
    add("twelve", now() - DAY, JSON.stringify(Array.from({ length: 12 }, () => ({ type: "pause_campaign" }))));
    add("one", now() - DAY);
    expect(capCounted(db, "u", null)).toHaveLength(13);
  });

  it("leaves out a Tag Manager publish, on its own or shipped with tag changes", () => {
    const { db, add } = setup();
    const publish = JSON.stringify([{ type: "publish_container", container: "accounts/1/containers/2" }]);
    add("tags", now() - DAY, JSON.stringify([{ type: "add_tag", container: "accounts/1/containers/2" }]), "gtm");
    add("publish", now() - DAY, publish, "gtm");
    add("both", now() - DAY, JSON.stringify([{ type: "add_tag", container: "accounts/1/containers/2" }, { type: "publish_container", container: "accounts/1/containers/2" }]), "gtm");
    expect(capChanges(publish)).toBe(0);
    expect(capChanges("[]")).toBe(0);
    expect(capCounted(db, "u", null)).toHaveLength(2);
  });

  it("counts from when a paid plan ended: approvals made while paid don't count on Free", () => {
    const { db, add } = setup();
    add("paid1", now() - 5 * DAY);
    add("paid2", now() - 4 * DAY);
    db.prepare("UPDATE users SET paid_ended_at = ? WHERE id = 'u'").run(now() - 3 * DAY);
    add("free1", now() - 2 * DAY);
    expect(capCounted(db, "u", null)).toHaveLength(1);
  });
});
