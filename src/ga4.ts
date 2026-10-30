/**
 * Google Analytics 4: reports (what happened on the site after the click) and the property reads the setup changes
 * (ga4-changes.ts) need. Its scopes are asked for at sign-in, as an untickable box; the first call without
 * them returns a personal /connect/analytics link (grant.ts) that adds them to the user's existing connection.
 *
 * The demo property (DEMO_PROPERTY) answers the same calls with sample data, like the demo Ads account and site.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { NotGrantedError, scopeMissing } from "./google.js";

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
export const DEMO_PROPERTY = "000000001";
const DEMO_NOTE = "Sample data from Camberstack's demo Google Analytics property (a fictional plumbing business), not a real property.";

export interface Property { property_id: string; name: string; account: string; account_id: string }
interface GaAccount { account_id: string; name: string }
interface ReportRequest {
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
  /** Only rows whose `dimension` contains `value` (case-insensitive). */
  filter?: { dimension: string; value: string };
  /** A requested metric (highest first) or dimension (A to Z, dates oldest first); defaults to the first metric. */
  orderBy?: string;
  limit: number;
}
export interface Report { rows: Record<string, string | number>[]; row_count: number }

/** The GA4 calls the tools make; the demo property answers the same ones. */
export type Analytics = {
  /** Every account this login can see (including ones with no property yet) and every property in them. */
  summaries(): Promise<{ accounts: GaAccount[]; properties: Property[] }>;
  runReport(propertyId: string, req: ReportRequest): Promise<Report>;
  /** An Admin API call by path under v1beta, e.g. GET properties/123/keyEvents. Writes go through ga4-changes.ts only. */
  admin(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: object): Promise<any>;
};

/** One user's view of the GA4 Admin and Data APIs. */
export class AnalyticsClient implements Analytics {
  constructor(private accessToken: () => Promise<string>, private grantLink: () => string | null, private f: typeof fetch = fetch) {}

  private async call(url: string, body?: object, method = body ? "POST" : "GET"): Promise<any> {
    const res = await this.f(url, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      if (scopeMissing(res.status, text)) throw new NotGrantedError("analytics", this.grantLink(), method !== "GET" && url.startsWith(ADMIN_API));  // a report is a POST too
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
      throw new Error(`Google Analytics API ${res.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async summaries(): Promise<{ accounts: GaAccount[]; properties: Property[] }> {
    const accounts: GaAccount[] = [], properties: Property[] = [];
    let page = "";
    do {
      const r = await this.call(`${ADMIN_API}/accountSummaries?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      for (const a of r.accountSummaries ?? []) {
        const account_id = String(a.account).replace("accounts/", "");
        accounts.push({ account_id, name: a.displayName });
        for (const p of a.propertySummaries ?? []) {
          properties.push({ property_id: String(p.property).replace("properties/", ""), name: p.displayName, account: a.displayName, account_id });
        }
      }
      page = r.nextPageToken ?? "";
    } while (page);
    return { accounts, properties };
  }

  admin(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: object): Promise<any> {
    return this.call(`${ADMIN_API}/${path}`, body, method);
  }

  async runReport(propertyId: string, q: ReportRequest): Promise<Report> {
    const r = await this.call(`${DATA_API}/properties/${propertyId}:runReport`, {
      dateRanges: [{ startDate: q.startDate, endDate: q.endDate }],
      dimensions: q.dimensions.map((name) => ({ name })),
      metrics: q.metrics.map((name) => ({ name })),
      ...(q.filter ? { dimensionFilter: { filter: { fieldName: q.filter.dimension,
        stringFilter: { matchType: "CONTAINS", value: q.filter.value, caseSensitive: false } } } } : {}),
      orderBys: [q.orderBy && q.dimensions.includes(q.orderBy) && !q.metrics.includes(q.orderBy)
        ? { dimension: { dimensionName: q.orderBy }, desc: false } : { metric: { metricName: q.orderBy ?? q.metrics[0] }, desc: true }],
      limit: q.limit,
    });
    const dims = (r.dimensionHeaders ?? []).map((h: { name: string }) => h.name) as string[];
    const mets = (r.metricHeaders ?? []).map((h: { name: string; type: string }) => h) as { name: string; type: string }[];
    return {
      row_count: r.rowCount ?? 0,
      rows: (r.rows ?? []).map((row: any) => Object.fromEntries([
        ...dims.map((d, i) => [d, row.dimensionValues[i].value]),
        ...mets.map((m, i) => [m.name, num(row.metricValues[i].value, m.type)]),
      ])),
    };
  }
}

/** GA4 returns every metric as a string; rates and money to 4 and 2 decimals. */
function num(v: string, type: string): number {
  const n = Number(v);
  if (type === "TYPE_INTEGER") return Math.round(n);
  if (type === "TYPE_CURRENCY") return Math.round(n * 100) / 100;
  return Math.round(n * 10000) / 10000;
}

/** Sends the demo property's calls to the demo, everything else to Google. */
export function routedAnalytics(google: Analytics, demo: Analytics): Analytics {
  const isDemo = (path: string) => path.startsWith(`properties/${DEMO_PROPERTY}`);
  return {
    summaries: () => google.summaries(),
    runReport: (id, q) => (id === DEMO_PROPERTY ? demo.runReport(id, q) : google.runReport(id, q)),
    admin: (method, path, body) => (isDemo(path) ? demo.admin(method, path, body) : google.admin(method, path, body)),
  };
}

// ---------------------------------------------------------------- what the tools return

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** `days` up to yesterday (GA4's today is still filling in), or an exact start/end. */
function gaWindow(o: { days: number; start_date?: string; end_date?: string }): { startDate: string; endDate: string } {
  if (o.start_date || o.end_date) {
    if (!o.start_date || !o.end_date) throw new Error("Give both start_date and end_date, or neither.");
    if (o.start_date > o.end_date) throw new Error("start_date is after end_date.");
    return { startDate: o.start_date, endDate: o.end_date };
  }
  return { startDate: ymd(Date.now() - o.days * DAY), endDate: ymd(Date.now() - DAY) };
}

/** Properties this login can read; the demo property only when there are none (or Analytics isn't granted). */
export async function listProperties(ga: Analytics) {
  const demo = [{ property_id: DEMO_PROPERTY, name: "DEMO: Northwind Plumbing (sample data)", account: "Demo", account_id: "demo" }];
  try {
    const { accounts, properties } = await ga.summaries();
    if (properties.length) return { properties, accounts };
    return { properties: demo, accounts, note: accounts.length
      ? "This login's Google Analytics account has no property yet, so the demo property (sample data) is offered. create_ga4_property "
        + "(through a proposal) can make one in an account listed here. Tell the user the data shown is a demo."
      : "This Google login has no Google Analytics account. The user creates one at analytics.google.com (Google requires accepting its "
        + "terms there); Camberstack can then add the property. Until then only the demo property (sample data) is offered: say so." };
  } catch (e) {
    if (!(e instanceof NotGrantedError)) throw e;
    return { properties: demo, not_granted: e.message, ...(e.link ? { grant_url: e.link } : {}),
      note: "Only the demo property is available until the user adds Google Analytics. Say so plainly and give them grant_url." };
  }
}

export async function report(ga: Analytics, propertyId: string, o: { days: number; start_date?: string; end_date?: string;
  dimensions: string[]; metrics: string[]; filter?: { dimension: string; contains: string }; order_by?: string; limit: number }) {
  // AIs ask for date order on trends (2026-10-23: three rejected calls), so a requested dimension sorts too.
  if (o.order_by && !o.metrics.includes(o.order_by) && !o.dimensions.includes(o.order_by))
    throw new Error(`order_by "${o.order_by}" isn't in this report. Use one of its metrics (${o.metrics.join(", ")})`
      + (o.dimensions.length ? ` or dimensions (${o.dimensions.join(", ")})` : "") + ", or add it to them.");
  const w = gaWindow(o);
  const r = await ga.runReport(propertyId, { ...w, dimensions: o.dimensions, metrics: o.metrics, limit: o.limit, orderBy: o.order_by,
    ...(o.filter ? { filter: { dimension: o.filter.dimension, value: o.filter.contains } } : {}) });
  return { property_id: propertyId, ...(propertyId === DEMO_PROPERTY ? { note: DEMO_NOTE } : {}), window: w, ...r };
}

/**
 * Landing pages by sessions, with engagement and key events (GA4's conversions), optionally for one channel
 * ("Paid Search", "Organic Search", ...). The question it answers: where do visitors land, and does it work.
 */
export async function landingPages(ga: Analytics, propertyId: string, o: { days: number; start_date?: string; end_date?: string; channel?: string; limit: number }) {
  const w = gaWindow(o);
  const r = await ga.runReport(propertyId, { ...w, dimensions: ["landingPage"],
    metrics: ["sessions", "engagedSessions", "keyEvents", "totalUsers"], limit: o.limit,
    ...(o.channel ? { filter: { dimension: "sessionDefaultChannelGroup", value: o.channel } } : {}) });
  return {
    property_id: propertyId, ...(propertyId === DEMO_PROPERTY ? { note: DEMO_NOTE } : {}), window: w, ...(o.channel ? { channel: o.channel } : {}),
    landing_pages: r.rows.map((x) => {
      const s = Number(x.sessions) || 0;
      return { landing_page: x.landingPage, sessions: s, users: x.totalUsers, engagement_rate: s ? round4(Number(x.engagedSessions) / s) : null,
        key_events: x.keyEvents, key_event_rate: s ? round4(Number(x.keyEvents) / s) : null };
    }),
  };
}
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------- demo property

const PAGES: [string, number][] = [["/", 0.34], ["/emergency-plumber", 0.22], ["/water-heater-repair", 0.15], ["/drain-cleaning", 0.12],
  ["/tankless-water-heaters", 0.09], ["/contact", 0.08]];
/** Channel: share of sessions, engagement rate, key event rate. */
const CHANNELS: [string, string, number, number, number][] = [
  ["Paid Search", "google / cpc", 0.38, 0.61, 0.071], ["Organic Search", "google / organic", 0.33, 0.68, 0.043],
  ["Direct", "(direct) / (none)", 0.16, 0.57, 0.052], ["Referral", "yelp.com / referral", 0.08, 0.64, 0.038],
  ["Organic Social", "facebook.com / referral", 0.05, 0.42, 0.012]];
const DEVICES: [string, number][] = [["mobile", 0.71], ["desktop", 0.26], ["tablet", 0.03]];
const SESSIONS_PER_DAY = 140;
const DEMO_DIMS = ["date", "landingPage", "sessionDefaultChannelGroup", "sessionSourceMedium", "deviceCategory"];
const DEMO_METRICS = ["sessions", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "totalUsers", "screenPageViews"];

/** Each user's copy of the demo property's setup: what their applied changes left, so undo finds what it reverses. */
interface DemoGaState {
  keyEvents: { id: number; eventName: string; countingMethod: string }[];
  adsLinks: { id: number; customerId: string }[];
  nextId: number;
}
const freshGa = (): DemoGaState => ({ keyEvents: [{ id: 1, eventName: "generate_lead", countingMethod: "ONCE_PER_EVENT" }], adsLinks: [], nextId: 2 });

export class DemoAnalytics implements Analytics {
  /** Without a db (tests, the tool catalog), changes last as long as this object. */
  private mem?: DemoGaState;
  constructor(private db?: DB, private userId?: string) {}

  private load(): DemoGaState {
    if (!this.db || !this.userId) return (this.mem ??= freshGa());
    const row = this.db.prepare("SELECT state FROM demo_ga_state WHERE user_id = ?").get(this.userId) as { state: string } | undefined;
    return row ? JSON.parse(row.state) as DemoGaState : freshGa();
  }
  private save(s: DemoGaState): void {
    if (!this.db || !this.userId) { this.mem = s; return; }
    this.db.prepare(`INSERT INTO demo_ga_state (user_id, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(this.userId, JSON.stringify(s), now());
  }

  async summaries() { return { accounts: [], properties: [] }; }

  /** The demo property's setup: one web stream, plus this user's key events and Google Ads links. Changes stick, like the demo Ads account's. */
  async admin(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: any): Promise<any> {
    const p = `properties/${DEMO_PROPERTY}`, s = this.load();
    const keyName = (id: number) => `${p}/keyEvents/${id}`, linkName = (id: number) => `${p}/googleAdsLinks/${id}`;
    if (method === "POST" && path === `${p}/keyEvents`) {
      const id = s.nextId++;
      s.keyEvents.push({ id, eventName: body.eventName, countingMethod: body.countingMethod ?? "ONCE_PER_EVENT" });
      this.save(s);
      return { name: keyName(id) };
    }
    if (method === "PATCH" && path.startsWith(`${p}/keyEvents/`)) {
      const k = s.keyEvents.find((x) => keyName(x.id) === path.split("?")[0]);
      if (!k) throw new Error(`Google Analytics API 404: ${path.split("?")[0]} not found.`);
      k.countingMethod = body.countingMethod;
      this.save(s);
      return { name: keyName(k.id), eventName: k.eventName, countingMethod: k.countingMethod };
    }
    if (method === "POST" && path === `${p}/googleAdsLinks`) {
      const id = s.nextId++;
      s.adsLinks.push({ id, customerId: body.customerId });
      this.save(s);
      return { name: linkName(id) };
    }
    if (method === "DELETE" && path.startsWith(`${p}/keyEvents/`)) {
      s.keyEvents = s.keyEvents.filter((k) => keyName(k.id) !== path);
      this.save(s);
      return {};
    }
    if (method === "DELETE" && path.startsWith(`${p}/googleAdsLinks/`)) {
      s.adsLinks = s.adsLinks.filter((l) => linkName(l.id) !== path);
      this.save(s);
      return {};
    }
    if (method !== "GET") throw new Error(`The demo property doesn't support ${method} ${path}.`);
    if (path === p) return { name: p, displayName: "DEMO: Northwind Plumbing (sample data)", timeZone: "America/Chicago", currencyCode: "USD" };
    if (path.startsWith(`${p}/dataStreams`)) return { dataStreams: [{ name: `${p}/dataStreams/1`, type: "WEB_DATA_STREAM", displayName: "northwindplumbing.example",
      webStreamData: { measurementId: "G-DEMO000001", defaultUri: "https://northwindplumbing.example" } }] };
    if (path.startsWith(`${p}/keyEvents`)) return { keyEvents: s.keyEvents.map((k) => ({ name: keyName(k.id), eventName: k.eventName, countingMethod: k.countingMethod, deletable: true })) };
    if (path.startsWith(`${p}/googleAdsLinks`)) return { googleAdsLinks: s.adsLinks.map((l) => ({ name: linkName(l.id), customerId: l.customerId })) };
    throw new Error(`The demo property doesn't support ${method} ${path}.`);
  }

  async runReport(_id: string, q: ReportRequest): Promise<Report> {
    const bad = [...q.dimensions.filter((d) => !DEMO_DIMS.includes(d)), ...q.metrics.filter((m) => !DEMO_METRICS.includes(m))];
    if (bad.length) throw new Error(`The demo property supports dimensions ${DEMO_DIMS.join(", ")} and metrics ${DEMO_METRICS.join(", ")}; not ${bad.join(", ")}.`);
    const start = Date.parse(`${q.startDate}T00:00:00Z`), end = Date.parse(`${q.endDate}T00:00:00Z`);
    if (!(start <= end)) throw new Error("Invalid date range.");
    const groups = new Map<string, { dims: Record<string, string>; s: number; e: number; k: number }>();
    for (let t = start; t <= end; t += DAY) {
      const day = new Date(t).getUTCDay();
      const daily = SESSIONS_PER_DAY * (day === 0 || day === 6 ? 0.75 : 1.08);
      for (const [page, ps] of PAGES) for (const [channel, sm, cs, er, kr] of CHANNELS) for (const [device, ds] of DEVICES) {
        const row = { date: ymd(t).replace(/-/g, ""), landingPage: page, sessionDefaultChannelGroup: channel, sessionSourceMedium: sm, deviceCategory: device };
        if (q.filter && !String(row[q.filter.dimension as keyof typeof row] ?? "").toLowerCase().includes(q.filter.value.toLowerCase())) continue;
        const s = daily * ps * cs * ds;
        // Paid traffic converts best on service pages and worst on the home page: a finding the demo should let someone reach.
        const fit = page === "/" ? 0.55 : page === "/contact" ? 1.6 : 1.15;
        const key = q.dimensions.map((d) => row[d as keyof typeof row]).join("\u0000");
        const g = groups.get(key) ?? { dims: Object.fromEntries(q.dimensions.map((d) => [d, row[d as keyof typeof row]])), s: 0, e: 0, k: 0 };
        g.s += s; g.e += s * er; g.k += s * kr * fit;
        groups.set(key, g);
      }
    }
    const metric = (g: { s: number; e: number; k: number }, m: string): number => ({
      sessions: Math.round(g.s), engagedSessions: Math.round(g.e), keyEvents: Math.round(g.k), totalUsers: Math.round(g.s * 0.83),
      screenPageViews: Math.round(g.s * 2.4), engagementRate: g.s ? round4(g.e / g.s) : 0, sessionKeyEventRate: g.s ? round4(g.k / g.s) : 0,
    } as Record<string, number>)[m]!;
    const by = q.orderBy ?? q.metrics[0]!;
    const byDim = q.dimensions.includes(by) && !q.metrics.includes(by);
    const rows = [...groups.values()].map((g) => ({ ...g.dims, ...Object.fromEntries(q.metrics.map((m) => [m, metric(g, m)])) }))
      .filter((r) => q.metrics.some((m) => Number(r[m]) > 0))
      .sort((a, b) => byDim ? String(a[by]).localeCompare(String(b[by])) : Number(b[by]) - Number(a[by]));
    return { row_count: rows.length, rows: rows.slice(0, q.limit) };
  }
}
