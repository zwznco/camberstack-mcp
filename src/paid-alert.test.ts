import { describe, expect, it } from "vitest";
import { openDb, now } from "./db.js";
import { notifyPaid, renderPaid } from "./paid-alert.js";

describe("new-subscriber alert", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, ?, ?)").run("u1", "g1", "Buyer@example.com", "pro", now() - 3 * 86400);
  db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at) VALUES (?, ?, ?, ?, ?)").run("me", "g2", "Op@example.com", "pro", now());
  db.prepare("INSERT INTO plan_events (user_id, kind, src, at) VALUES (?, ?, ?, ?)").run("u1", "upgrade_click", "tool", now());

  const capture = () => {
    const sent: { body: any; key: string | null }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      sent.push({ body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return { sent, f };
  };

  it("says who, which plan, and where the upgrade link came from", () => {
    const m = renderPaid({ db, adminUrl: "https://admin.x" }, "u1", "agency");
    expect(m.subject).toBe("New Agency subscriber: Buyer@example.com");
    expect(m.text).toContain("Plan: Agency ($49/month)");
    expect(m.text).toContain("Signed up: 3 days ago");
    expect(m.text).toContain("Upgrade link from: tool");
    expect(m.text).toContain("https://admin.x/users/u1");
  });

  it("mails the operator once per subscription, never for an internal account, and never throws", async () => {
    const { sent, f } = capture();
    const d = { db, internalEmails: new Set(["op@example.com"]), mail: { apiKey: "k", from: "a@x" }, to: "op@x", fetch: f };
    await notifyPaid(d, "u1", "pro", "sub_1");
    await notifyPaid(d, "me", "pro", "sub_2");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ to: ["op@x"], subject: "New Pro subscriber: Buyer@example.com" });
    expect(sent[0].key).toBe("paid:sub_1");
    const broken = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(notifyPaid({ ...d, fetch: broken }, "u1", "pro", "sub_3")).resolves.toBeUndefined();
  });
});
