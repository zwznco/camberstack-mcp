import { describe, expect, it } from "vitest";
import { openDb, now } from "./db.js";
import { Lifecycle } from "./lifecycle.js";
import { Announcements, PRESETS, render } from "./announce.js";
import { listMerchant } from "./plans.js";

function setup(o: { failFor?: string } = {}) {
  const db = openDb(":memory:");
  const sent: any[] = [];
  const mail = { apiKey: "re_test", from: "Adam at Camberstack <adam@camberstack.io>", replyTo: "adam@camberstack.io" };
  const lifecycle = new Lifecycle({
    db, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7), mail, internalEmails: new Set(), upgradeLink: () => null,
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (o.failFor && body.to[0] === o.failFor) return new Response("down", { status: 500 });
      sent.push({ ...body, key: (init.headers as Record<string, string>)["Idempotency-Key"] });
      return new Response("{}", { status: 200 });
    }) as any,
  });
  const ann = new Announcements({ db, lifecycle, internalEmails: new Set(["me@example.com"]), canSend: true, sleep: async () => {} });
  const user = (id: string, email: string, plan = "free", optOut = 0, at = now() - 60) =>
    db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, email_opt_out) VALUES (?, ?, ?, ?, ?, ?)").run(id, `s-${id}`, email, plan, at, optOut);
  return { db, ann, sent, user, p: PRESETS[0]! };
}

describe("announcement presets", () => {
  it("send once to the audience, never to unsubscribed or internal accounts, and never again", async () => {
    const { ann, sent, user, p } = setup();
    user("a", "a@example.com"); user("b", "b@example.com", "pro"); user("c", "c@example.com", "free", 1); user("me", "me@example.com");
    expect(ann.recipients(p).map((u) => u.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(await ann.start(p.id)).toEqual({ sent: 2, left: 0 });
    expect(sent.map((m) => m.to[0])).toEqual(["a@example.com", "b@example.com"]);
    expect(sent[0].subject).toBe(p.subject);
    expect(sent[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent[0].key).toBe(`a:announce:${p.id}`);
    const st = ann.state(p.id);
    expect(st.sent_at).not.toBeNull();
    expect(st.sent).toBe(2);
    // Sent means done: no second send, and someone who signs up afterwards isn't on the list.
    user("d", "d@example.com", "free", 0, now() + 5);
    expect(ann.recipients(p)).toEqual([]);
    expect(() => ann.start(p.id)).toThrow("already sent");
  });

  it("an interrupted send finishes without sending anyone twice", async () => {
    const s = setup({ failFor: "b@example.com" });
    s.user("a", "a@example.com"); s.user("b", "b@example.com"); s.user("c", "c@example.com");
    const err = console.error; console.error = () => {};
    try { expect(await s.ann.start(s.p.id)).toEqual({ sent: 1, left: 2 }); } finally { console.error = err; }
    expect(s.ann.state(s.p.id).sent_at).toBeNull();
    expect(s.ann.recipients(s.p).map((u) => u.email)).toEqual(["b@example.com", "c@example.com"]);
  });

  it("a test goes to one address only and logs nothing", async () => {
    const { ann, sent, user, p } = setup();
    user("a", "a@example.com");
    await ann.sendTest(p.id, "me@example.com");
    expect(sent.map((m) => [m.to[0], m.subject])).toEqual([["me@example.com", `[TEST] ${p.subject}`]]);
    expect(ann.state(p.id)).toMatchObject({ started_at: null, sent: 0 });
  });

  it("renders paragraphs, bullets, bold and links, and escapes everything else", () => {
    const m = render({ subject: "S", body: "Hi <b>there</b>,\n\n- **one**\n- [two](https://x.test/a?b=1&c=2)\n\nSee https://camberstack.io/changelog." }, false);
    expect(m.html).toContain("Hi &lt;b&gt;there&lt;/b&gt;,");
    expect(m.html).toContain("<li><strong>one</strong></li>");
    expect(m.html).toContain('<a href="https://x.test/a?b=1&amp;c=2">two</a>');
    expect(m.html).toContain('<a href="https://camberstack.io/changelog">https://camberstack.io/changelog</a>.');
    expect(m.text).toContain("two (https://x.test/a?b=1&c=2)");
  });

  it("a preset can't go out before what it describes is live, though a test copy can", async () => {
    const { ann, sent, user } = setup();
    user("a", "a@example.com");
    const p = PRESETS.find((x) => x.id === "merchant-center-open")!;
    try {
      listMerchant(undefined);
      expect(ann.ready(p)).toBe(false);
      expect(() => ann.start(p.id)).toThrow("isn't ready");
      expect(ann.state(p.id).started_at).toBeNull();
      await ann.sendTest(p.id, "me@example.com");
      expect(sent[0].subject).toContain("[TEST]");
      listMerchant(Math.floor(Date.now() / 1000) - 1);
      expect(ann.ready(p)).toBe(true);
      expect(await ann.start(p.id)).toEqual({ sent: 1, left: 0 });
    } finally { listMerchant(undefined); }
  });

  it("every preset is an update, not a sales pitch, and has a unique id", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) expect(`${p.subject}\n${p.body}`, p.id).not.toMatch(/\b(upgrade|discount|offer|deal|sale|coupon)\b|\$\d/i);
  });
});
