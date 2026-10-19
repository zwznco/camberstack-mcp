import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Analytics, gtagJs, parseBeacon } from "./analytics.js";

const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36";
const req = (ua: string, method = "GET", path = "/") =>
  ({ method, path, headers: { "user-agent": ua, "x-real-ip": "203.0.113.9" }, socket: {} }) as any;

function setup() {
  const sent: URLSearchParams[] = [];
  const a = new Analytics({ matomoUrl: "http://matomo", siteId: "7", token: "t", site: "https://camberstack.io",
    fetch: (async (_u: string, init: RequestInit) => { sent.push(init.body as URLSearchParams); return new Response(null, { status: 204 }); }) as any });
  return { a, sent };
}

describe("analytics", () => {
  it("accepts page views and rejects anything else", () => {
    expect(parseBeacon({ t: "pv", p: "/privacy", x: "https://claude.ai/" })).toEqual({ page: "/privacy", ref: "https://claude.ai/", campaign: "", keyword: "" });
    expect(parseBeacon({ t: "pv", p: "/<script>" })).toBeNull();
    expect(parseBeacon({ t: "pv", p: "/", x: "javascript:alert(1)" })).toBeNull();
    expect(parseBeacon({ t: "submit", p: "/" })).toBeNull();
  });

  it("names the campaign from the landing query, never forwarding the query itself", () => {
    const pv = (q: string) => parseBeacon({ t: "pv", p: "/", q });
    expect(pv("?gad_source=1&gad_campaignid=24316536904&gclid=abc")).toMatchObject({ campaign: "google-ads-24316536904", keyword: "" });
    expect(pv("?gbraid=xyz")).toMatchObject({ campaign: "google-ads" });
    expect(pv("?utm_campaign=launch&utm_term=mcp&gclid=abc")).toMatchObject({ campaign: "launch", keyword: "mcp" });
    expect(pv("?utm_term=mcp&ref=x")).toMatchObject({ campaign: "", keyword: "" });
    expect(pv("?utm_campaign=<script>")).toMatchObject({ campaign: "" });
  });

  it("sends page views with the visitor's IP and referrer, and drops bots", () => {
    const { a, sent } = setup();
    const pv = { page: "/", ref: "https://chatgpt.com/", campaign: "", keyword: "" };
    a.pageview(req(CHROME), pv);
    a.pageview(req("Googlebot/2.1"), pv);
    a.pageview(req(""), pv);
    a.pageview(req(CHROME), { ...pv, ref: "https://www.google.com/", campaign: "google-ads-1", keyword: "mcp" });
    expect(sent).toHaveLength(2);
    const [chat, ad] = sent.map((s) => Object.fromEntries(s));
    expect(chat).toMatchObject({ idsite: "7", url: "https://camberstack.io/", urlref: "https://chatgpt.com/", cip: "203.0.113.9", token_auth: "t" });
    expect(chat!.mtm_campaign).toBeUndefined();
    expect(ad).toMatchObject({ mtm_campaign: "google-ads-1", mtm_kwd: "mcp" });
  });

  it("records a connect with nothing that identifies the account", () => {
    const { a, sent } = setup();
    a.event(req(CHROME), "connect");
    const p = Object.fromEntries(sent[0]!);
    expect(p).toMatchObject({ e_c: "camberstack", e_a: "connect" });
    expect(p.e_n).toBeUndefined();
  });

  it("names the service when one is added to a connection", () => {
    const { a, sent } = setup();
    a.event(req(CHROME), "grant_added", "analytics");
    expect(Object.fromEntries(sent[0]!)).toMatchObject({ e_c: "camberstack", e_a: "grant_added", e_n: "analytics" });
  });

  it("logs AI-assistant page fetches as bot requests, not visits, and ignores MCP POSTs", () => {
    const { a, sent } = setup();
    const res = Object.assign(new EventEmitter(), { statusCode: 200, getHeader: () => "1234" }) as any;
    a.aiFetch(req("Mozilla/5.0 (compatible; Claude-User/1.0)", "GET", "/privacy"), res);
    a.aiFetch(req("Claude-User", "POST", "/mcp"), res);
    res.emit("finish");
    expect(sent).toHaveLength(1);
    expect(Object.fromEntries(sent[0]!)).toMatchObject({ recMode: "1", url: "https://camberstack.io/privacy", http_status: "200", bw_bytes: "1234" });
    expect(sent[0]!.get("bots")).toBeNull();
  });
});

describe("GA4 tag for our own pages", () => {
  it("loads gtag for the configured measurement ID, skipping automated browsers", () => {
    const js = gtagJs("G-ABC123");
    expect(js).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
    expect(js).toContain("gtag('config','G-ABC123')");
    expect(js).toContain("navigator.webdriver");
  });
});
