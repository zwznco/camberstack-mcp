import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { openDb, now } from "./db.js";
import { Lifecycle } from "./lifecycle.js";
import { Announcements, PRESETS } from "./announce.js";
import { CHOICES, LANGS, SURVEY_ID, Survey, langFor } from "./survey.js";

const KEY = Buffer.alloc(32, 9);

function setup() {
  const db = openDb(":memory:");
  const survey = new Survey({ db, baseUrl: "https://camberstack.io", signingKey: KEY });
  const user = (id: string, tz: string | null = null) =>
    db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, time_zone) VALUES (?, ?, ?, 'free', ?, ?)").run(id, `s-${id}`, `${id}@example.com`, now() - 60, tz);
  return { db, survey, user };
}

async function serve(survey: Survey) {
  const app = express();
  survey.mount(app, (lang, title, body) => `<html lang="${lang}"><h1>${title}</h1>${body}</html>`);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => srv.close() };
}

const local = (u: string, base: string) => u.replace("https://camberstack.io", base);

describe("survey language", () => {
  it("maps time zones to the translated languages, English otherwise", () => {
    expect(langFor("America/Sao_Paulo")).toBe("pt");
    expect(langFor("Europe/Lisbon")).toBe("pt");
    expect(langFor("America/Mexico_City")).toBe("es");
    expect(langFor("America/Argentina/Buenos_Aires")).toBe("es");
    expect(langFor("Asia/Riyadh")).toBe("ar");
    expect(langFor("Europe/Istanbul")).toBe("tr");
    expect(langFor("Europe/Paris")).toBe("fr");
    expect(langFor("Europe/Vienna")).toBe("de");
    expect(langFor("Asia/Hong_Kong")).toBe("zh");
    for (const z of ["America/New_York", "Asia/Calcutta", "Europe/Rome", "Asia/Tokyo", null, "", "Not/AZone"]) expect(langFor(z)).toBe("en");
  });

  it("each email has six signed links in its language, an English line when translated, and RTL for Arabic", () => {
    const { survey } = setup();
    for (const lang of LANGS) {
      const m = survey.email("u1", null, lang);
      const links = m.body.match(/\]\((https:\/\/[^)]+)\)/g) ?? [];
      expect(links).toHaveLength(CHOICES.length);
      expect(m.body.includes("(In English:")).toBe(lang !== "en");
      expect(m.rtl).toBe(lang === "ar");
      expect(m.body).toContain(`l=${lang}`);
    }
    expect(survey.email("u1", "America/Sao_Paulo").subject).toMatch(/^Um clique/);
  });
});

describe("survey answer links", () => {
  it("opening a link records nothing; the POST records the answer; the latest click counts", async () => {
    const { db, survey, user } = setup();
    user("u1", "Europe/Istanbul"); user("u2");
    const s = await serve(survey);
    try {
      const link = (u: string, c: string) => local(survey.email(u, null, u === "u1" ? "tr" : "en").body.match(new RegExp(`\\((https://[^)]*c=${c}[^)]*)\\)`))![1]!, s.base);
      const page = await fetch(link("u1", "keywords"));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Anahtar kelime araştırması");
      expect((db.prepare("SELECT count(*) n FROM survey_answers").get() as { n: number }).n).toBe(0);
      await fetch(link("u1", "keywords"), { method: "POST" });
      await fetch(link("u1", "conversions"), { method: "POST" });
      await fetch(link("u2", "enough"), { method: "POST" });
      const r = survey.results();
      expect(r).toEqual({ total: 2, clicks: 3, byChoice: { conversions: 1, enough: 1 }, byLang: { tr: 1, en: 1 } });
    } finally { s.close(); }
  });

  it("refuses a tampered link and records nothing for a test copy", async () => {
    const { db, survey, user } = setup();
    user("u1");
    const s = await serve(survey);
    try {
      const good = local(survey.url("u1", "en", "answers"), s.base);
      expect((await fetch(good.replace("u=u1", "u=u2"), { method: "POST" })).status).toBe(400);
      expect((await fetch(good.replace("c=answers", "c=nope"))).status).toBe(400);
      expect((await fetch(local(survey.url("preview", "en", "answers"), s.base), { method: "POST" })).status).toBe(200);
      expect((db.prepare("SELECT count(*) n FROM survey_answers").get() as { n: number }).n).toBe(0);
    } finally { s.close(); }
  });
});

describe("survey announcement", () => {
  it("sends each recipient their own links in their language", async () => {
    const { db, survey, user } = setup();
    user("br", "America/Sao_Paulo"); user("sa", "Asia/Riyadh"); user("us", "America/Chicago");
    const sent: any[] = [];
    const mail = { apiKey: "re_test", from: "Adam <adam@camberstack.io>", replyTo: "adam@camberstack.io" };
    const lifecycle = new Lifecycle({ db, baseUrl: "https://camberstack.io", signingKey: KEY, mail, internalEmails: new Set(), upgradeLink: () => null,
      fetch: (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any });
    const ann = new Announcements({ db, lifecycle, internalEmails: new Set(), canSend: true, survey, sleep: async () => {} });
    const p = PRESETS.find((x) => x.id === SURVEY_ID)!;
    expect(await ann.start(p.id)).toEqual({ sent: 3, left: 0 });
    const by = Object.fromEntries(sent.map((m) => [m.to[0].split("@")[0], m]));
    expect(by.br.subject).toMatch(/^Um clique/);
    expect(by.br.html).toContain("u=br&amp;c=answers&amp;l=pt");
    expect(by.sa.html).toContain('dir="rtl"');
    expect(by.us.subject).toBe(p.subject);
    expect(by.us.text).not.toContain("u=br");
  });

  it("a test sends one copy per language, with links that record nothing", async () => {
    const { db, survey } = setup();
    const sent: any[] = [];
    const mail = { apiKey: "re_test", from: "Adam <adam@camberstack.io>", replyTo: "adam@camberstack.io" };
    const lifecycle = new Lifecycle({ db, baseUrl: "https://camberstack.io", signingKey: KEY, mail, internalEmails: new Set(), upgradeLink: () => null,
      fetch: (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any });
    const ann = new Announcements({ db, lifecycle, internalEmails: new Set(), canSend: true, survey, sleep: async () => {} });
    await ann.sendTest(SURVEY_ID, "me@example.com");
    expect(sent).toHaveLength(LANGS.length);
    expect(sent.every((m) => m.subject.startsWith("[TEST] ") && m.html.includes("u=preview"))).toBe(true);
  });
});
