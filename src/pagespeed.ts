/**
 * Landing-page speed: Google's PageSpeed Insights API, which returns both what real Chrome visitors experienced over the
 * last 28 days (the Chrome UX Report, "field data") and a fresh Lighthouse run ("lab data"), with the fixes worth most.
 *
 * Public data. Called with the user's own Google access token: the API takes OAuth in place of a key, needs only the
 * openid scope every connection has, and bills quota to Camberstack's Cloud project (the Cloud console offers no API key
 * for it there). PAGESPEED_API_KEY, if ever set, is used instead. No Google service in the plan gate, nothing stored. Google fetches the page, not us, so there is no SSRF surface here. Pages on the demo site
 * (northwind-plumbing.example) answer with sample results.
 */

import type { DB } from "./db.js";

/** Pages a user may test a day. Everyone shares the Cloud project's 25,000 a day; checking a few landing pages is ~5-20. */
export const DAILY_PAGES = 100;

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const DEMO_HOST = "northwind-plumbing.example";
/** A Lighthouse run takes 10-40s. AI apps give up on a tool call at ~60s (Claude Code aborted at 60.0s, 2026-11-05), so
 *  a slow page ends here as its own error and the others still come back. */
const TIMEOUT_MS = 45_000;

export type Strategy = "mobile" | "desktop";
type Rating = "good" | "needs improvement" | "poor";

/** The Core Web Vitals and their companions, as PSI names them in field data, with Google's good / poor thresholds. */
const FIELD = {
  LARGEST_CONTENTFUL_PAINT_MS: { name: "lcp_ms", good: 2500, poor: 4000 },
  INTERACTION_TO_NEXT_PAINT: { name: "inp_ms", good: 200, poor: 500 },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { name: "cls", good: 0.1, poor: 0.25 },
  FIRST_CONTENTFUL_PAINT_MS: { name: "fcp_ms", good: 1800, poor: 3000 },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: { name: "ttfb_ms", good: 800, poor: 1800 },
} as const;
const CORE = ["lcp_ms", "inp_ms", "cls"];

const LAB = {
  "largest-contentful-paint": "lcp_ms",
  "cumulative-layout-shift": "cls",
  "total-blocking-time": "tbt_ms",
  "first-contentful-paint": "fcp_ms",
  "speed-index": "speed_index_ms",
} as const;

export interface PageSpeed {
  url: string;
  strategy: Strategy;
  /** Real Chrome visitors, 75th percentile over 28 days; null when Google has too few visits to report. */
  field: {
    /** "page" = this URL's own data; "site" = the whole origin's, because the page alone has too little traffic. */
    scope: "page" | "site";
    passes_core_web_vitals: boolean | null;
    metrics: Record<string, { value: number; rating: Rating }>;
  } | null;
  /** One Lighthouse run from Google's servers on a throttled connection: varies run to run, best for finding causes. */
  lab: { performance_score: number | null; metrics: Record<string, number> } | null;
  /** Lighthouse's failed checks that would save time, biggest saving first. */
  fixes: { id: string; title: string; detail?: string; saves?: string }[];
  error?: string;
}

const rate = (v: number, t: { good: number; poor: number }): Rating => (v <= t.good ? "good" : v <= t.poor ? "needs improvement" : "poor");

function field(exp: any): PageSpeed["field"] {
  if (!exp?.metrics || !Object.keys(exp.metrics).length) return null;
  const metrics: Record<string, { value: number; rating: Rating }> = {};
  for (const [key, t] of Object.entries(FIELD)) {
    const m = exp.metrics[key];
    if (typeof m?.percentile !== "number") continue;
    // CrUX reports CLS ×100 as an integer.
    const value = key === "CUMULATIVE_LAYOUT_SHIFT_SCORE" ? m.percentile / 100 : m.percentile;
    metrics[t.name] = { value, rating: rate(value, t) };
  }
  // Google's rule: passing needs LCP, INP and CLS all good; with one missing it can't say.
  const core = CORE.map((n) => metrics[n]);
  return {
    scope: exp.origin_fallback || /^https?:\/\/[^/]+$/.test(String(exp.id ?? "")) ? "site" : "page",
    passes_core_web_vitals: core.every(Boolean) ? core.every((m) => m!.rating === "good") : null,
    metrics,
  };
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

/** What a failed audit would save: its own estimate, else the sum of the metric savings Lighthouse attributes to it. */
function savings(a: any): { rank: number; text?: string } {
  const overall = a.details?.overallSavingsMs;
  if (typeof overall === "number" && overall > 0) return { rank: overall, text: `~${ms(overall)}` };
  const s = a.metricSavings ?? {};
  const parts: string[] = [];
  let rank = 0;
  for (const k of ["LCP", "FCP", "TBT", "INP"]) if (s[k] > 0) { parts.push(`${k} ${ms(s[k])}`); rank += s[k]; }
  if (s.CLS > 0) { parts.push(`CLS ${s.CLS.toFixed(2)}`); rank += s.CLS * 5000; }
  return { rank, text: parts.length ? parts.join(", ") : undefined };
}

export function summarize(url: string, strategy: Strategy, r: any, maxFixes: number): PageSpeed {
  const L = r.lighthouseResult;
  let lab: PageSpeed["lab"] = null;
  const fixes: (PageSpeed["fixes"][number] & { rank: number })[] = [];
  if (L?.audits && !L.runtimeError) {
    const metrics: Record<string, number> = {};
    for (const [id, name] of Object.entries(LAB)) {
      const v = L.audits[id]?.numericValue;
      if (typeof v === "number") metrics[name] = name === "cls" ? Math.round(v * 1000) / 1000 : Math.round(v);
    }
    const score = L.categories?.performance?.score;
    lab = { performance_score: typeof score === "number" ? Math.round(score * 100) : null, metrics };
    for (const ref of L.categories?.performance?.auditRefs ?? []) {
      const a = L.audits[ref.id];
      if (!a || ref.group === "metrics" || ref.group === "hidden" || a.score === null || a.score >= 0.9) continue;
      if (["informative", "notApplicable", "manual", "error"].includes(a.scoreDisplayMode)) continue;
      const s = savings(a);
      // A check with no time saved (a 100-score page still "fails" its cache or dependency-tree insight) isn't a fix.
      if (s.rank <= 0) continue;
      fixes.push({ id: ref.id, title: a.title, ...(a.displayValue ? { detail: a.displayValue } : {}), ...(s.text ? { saves: s.text } : {}), rank: s.rank });
    }
    fixes.sort((x, y) => y.rank - x.rank);
  }
  return {
    url: L?.finalDisplayedUrl || L?.finalUrl || url, strategy,
    field: field(r.loadingExperience) ?? field(r.originLoadingExperience),
    lab,
    fixes: fixes.slice(0, maxFixes).map(({ rank: _, ...f }) => f),
    ...(L?.runtimeError?.message ? { error: `Lighthouse couldn't load the page: ${L.runtimeError.message}` } : {}),
  };
}

export class PageSpeedClient {
  constructor(private apiKey: string | undefined, private f: typeof fetch = fetch, private db?: DB) {}

  /** Counts `pages` real pages against the user's day, or refuses the call (nothing counted) if it would go over. */
  private spend(userId: string, pages: number): void {
    if (!this.db || !pages) return;
    const day = new Date().toISOString().slice(0, 10);
    const used = (this.db.prepare("SELECT pages FROM pagespeed_usage WHERE user_id = ? AND day = ?").get(userId, day) as { pages: number } | undefined)?.pages ?? 0;
    if (used + pages > DAILY_PAGES) {
      throw new Error(`Daily page speed limit reached: ${used} of ${DAILY_PAGES} pages tested today (UTC)`
        + (used < DAILY_PAGES ? `; ${DAILY_PAGES - used} left, so test fewer pages at once` : "; it resets at midnight UTC") + ". Nothing was tested.");
    }
    this.db.prepare("INSERT INTO pagespeed_usage (user_id, day, pages) VALUES (?, ?, ?) ON CONFLICT (user_id, day) DO UPDATE SET pages = pages + excluded.pages")
      .run(userId, day, pages);
  }

  /** `token`: the calling user's Google access token, used when there is no API key. */
  async check(urls: string[], o: { strategy: Strategy; fixes: number; token?: () => Promise<string>; userId?: string }): Promise<{ pages: PageSpeed[]; note: string }> {
    if (o.userId) this.spend(o.userId, urls.filter((u) => !isDemoUrl(u)).length);
    const pages = await Promise.all(urls.map((u) => this.one(u, o).catch((e: Error) =>
      ({ url: u, strategy: o.strategy, field: null, lab: null, fixes: [], error: e.message } satisfies PageSpeed))));
    if (pages.every((p) => p.error)) throw new Error(pages.length === 1 ? pages[0]!.error! : `No page could be checked: ${pages[0]!.error}`);
    const demo = urls.some((u) => isDemoUrl(u));
    return {
      pages,
      note: (demo ? "Sample results for the demo website (a fictional plumbing business), not a real page. " : "")
        + "field is what real Chrome visitors experienced (75th percentile, last 28 days) and is what Google uses for Core Web Vitals; "
        + "when its scope is \"site\" the page has too little traffic and the whole site's numbers stand in, and null means the whole site has too "
        + "little Chrome traffic for Google to report it (not an error). lab is one test run that varies "
        + "between runs: use it to find causes, not to judge the page. Landing-page experience is part of an ad's Quality Score.",
    };
  }

  private async one(url: string, o: { strategy: Strategy; fixes: number; token?: () => Promise<string> }): Promise<PageSpeed> {
    if (isDemoUrl(url)) return demoResult(url, o.strategy, o.fixes);
    if (!this.apiKey && !o.token) throw new Error("Page speed checks need a connected Google account.");
    const q = new URLSearchParams({ url, strategy: o.strategy, category: "performance", ...(this.apiKey ? { key: this.apiKey } : {}) });
    const headers: Record<string, string> = this.apiKey ? {} : { Authorization: `Bearer ${await o.token!()}` };
    const res = await this.f(`${PSI}?${q}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e: Error) => {
      throw new Error(e.name === "TimeoutError" ? `Google took over ${TIMEOUT_MS / 1000}s to test ${url}; try it again on its own.` : `PageSpeed Insights unreachable: ${e.message}`);
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
      // A page Google couldn't load (DNS, 4xx/5xx, timeout) comes back as a 400/500 with Lighthouse's reason.
      if (res.status === 429) throw new Error("PageSpeed Insights is over its quota right now; try again in a minute.");
      throw new Error(`PageSpeed Insights couldn't test ${url}: ${msg}`);
    }
    return summarize(url, o.strategy, JSON.parse(text), o.fixes);
  }
}

export function isDemoUrl(u: string): boolean {
  try { return new URL(u).hostname.replace(/^www\./, "") === DEMO_HOST; } catch { return false; }
}

/** Sample results, stable per page: the home page is fine, deeper pages progressively worse, mobile worse than desktop. */
function demoResult(url: string, strategy: Strategy, maxFixes: number): PageSpeed {
  const path = new URL(url).pathname;
  const depth = path.split("/").filter(Boolean).length;
  const m = strategy === "mobile" ? 1 : 0.55;
  const lcp = Math.round((1900 + depth * 1300) * m);
  const cls = depth > 1 ? 0.18 : 0.04;
  const inp = Math.round((140 + depth * 90) * m);
  const metric = (value: number, t: { good: number; poor: number }) => ({ value, rating: rate(value, t) });
  const fieldM = {
    lcp_ms: metric(lcp, FIELD.LARGEST_CONTENTFUL_PAINT_MS),
    inp_ms: metric(inp, FIELD.INTERACTION_TO_NEXT_PAINT),
    cls: metric(cls, FIELD.CUMULATIVE_LAYOUT_SHIFT_SCORE),
    fcp_ms: metric(Math.round(lcp * 0.6), FIELD.FIRST_CONTENTFUL_PAINT_MS),
    ttfb_ms: metric(Math.round(620 * m + depth * 150), FIELD.EXPERIMENTAL_TIME_TO_FIRST_BYTE),
  };
  const fixes = [
    { id: "image-delivery-insight", title: "Improve image delivery", detail: "Est savings of 1,240 KiB", saves: `LCP ${ms(lcp * 0.35)}` },
    { id: "render-blocking-insight", title: "Render blocking requests", saves: `LCP ${ms(lcp * 0.2)}, FCP ${ms(lcp * 0.25)}` },
    ...(depth > 1 ? [{ id: "cls-culprits-insight", title: "Layout shift culprits", detail: "Unsized images in the reviews widget", saves: `CLS ${cls.toFixed(2)}` }] : []),
    { id: "third-parties-insight", title: "Third parties", detail: "Chat widget: 410 ms of main-thread time", saves: `TBT ${ms(410 * m)}` },
  ];
  const core = [fieldM.lcp_ms, fieldM.inp_ms, fieldM.cls];
  return {
    url, strategy,
    field: { scope: depth > 1 ? "site" : "page", passes_core_web_vitals: core.every((x) => x.rating === "good"), metrics: Object.fromEntries(Object.entries(fieldM)) },
    lab: { performance_score: Math.min(100, Math.max(18, Math.round((96 - depth * 22) * (strategy === "mobile" ? 1 : 1.15)))),
      metrics: { lcp_ms: Math.round(lcp * 1.3), cls, tbt_ms: Math.round(380 * m * (1 + depth)), fcp_ms: Math.round(lcp * 0.7), speed_index_ms: Math.round(lcp * 1.1) } },
    fixes: fixes.slice(0, maxFixes),
  };
}
