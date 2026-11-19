/**
 * search_console_site_audit: a polite crawl of one Search Console property's own site, joined to its sitemaps and a
 * sample of Google's index records. Everything here is pure or takes its fetcher as an argument, so the tests and the
 * demo site run it with fakes and only session.ts hands it the real network (fetch-safe.ts fetchPage).
 *
 * Box limits shape the defaults (~/CLAUDE.md, NAT hairpin): bursts of parallel outbound requests from this server
 * have broken outbound for every app on it, so one audit fetches 2 pages at a time and at most AUDITS_AT_ONCE
 * audits run together; the rest wait their turn.
 */
import type { PageResponse } from "./fetch-safe.js";
import type { UrlInspection } from "./google.js";

export type PageFetcher = (url: string) => Promise<PageResponse>;

export interface AuditOptions {
  /** The property exactly as Search Console lists it: sc-domain:example.com or https://www.example.com/ */
  site: string;
  fetch: PageFetcher;
  /** Sitemap URLs Search Console knows for the property. robots.txt's and /sitemap.xml are tried too. */
  sitemapPaths: string[];
  /** Google's index record for one URL; absent = skip the index sample. */
  inspect?: (url: string) => Promise<UrlInspection>;
  maxPages: number;
  indexSample: number;
  limit: number;
  /** Stop crawling after this long, so the tool call answers in time. */
  budgetMs?: number;
  concurrency?: number;
  now?: () => number;
}

const MAX_HOPS = 5;
const MAX_SITEMAP_FILES = 20;
const MAX_SITEMAP_URLS = 5000;
const SLOW_MS = 3000;
const ASSET = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|docx?|xlsx?|pptx?|zip|gz|rar|7z|mp[34]|m4a|mov|avi|webm|wav|ogg|css|js|mjs|json|woff2?|ttf|eot|otf|xml|txt|rss|atom)$/i;

// ---------------------------------------------------------------- scope

export interface Scope { start: string; inScope: (u: URL) => boolean }

/** Where to start and which URLs belong to the property. A domain property covers every subdomain. */
export function propertyScope(site: string): Scope {
  if (site.startsWith("sc-domain:")) {
    const domain = site.slice("sc-domain:".length).toLowerCase();
    return { start: `https://${domain}/`, inScope: (u) => u.hostname === domain || u.hostname.endsWith(`.${domain}`) };
  }
  const prefix = new URL(site);
  const p = prefix.toString();
  // http:// and https:// of the same prefix count as one site for crawling: a URL-prefix property often redirects to the other.
  const alt = p.startsWith("https://") ? "http://" + p.slice(8) : "https://" + p.slice(7);
  return { start: p, inScope: (u) => { const s = u.toString(); return s.startsWith(p) || s.startsWith(alt); } };
}

/** The URL as the audit keys it: no fragment, lowercase host, default port dropped. Query strings are kept. */
export function normUrl(input: string, base?: string): string | null {
  try {
    const u = new URL(input, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

// ---------------------------------------------------------------- robots.txt

export interface Robots { allowed: (url: string) => boolean; sitemaps: string[] }

/** Groups for our user agent ("camberstack") if any, else "*". Longest matching rule wins; Allow wins a tie. */
export function parseRobots(text: string): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase(), val = m[2]!.trim();
    if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (cur && (key === "allow" || key === "disallow") && val) cur.rules.push({ allow: key === "allow", path: val });
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && "camberstack-siteaudit".includes(a)));
  const rules = (ours.length ? ours : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  const compiled = rules.map((r) => ({ ...r, len: r.path.length,
    re: new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")) }));
  return {
    sitemaps,
    allowed: (url) => {
      let path: string;
      try { const u = new URL(url); path = u.pathname + u.search; } catch { return false; }
      let best: (typeof compiled)[number] | null = null;
      for (const r of compiled) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      return !best || best.allow;
    },
  };
}

// ---------------------------------------------------------------- sitemaps

/** The <loc>s of a sitemap: page URLs from a urlset, child sitemaps from a sitemapindex. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (block: string) => [...block.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1]!.trim()));
  if (/<sitemapindex[\s>]/i.test(xml)) return { urls: [], sitemaps: locs(xml) };
  return { urls: locs(xml), sitemaps: [] };
}

// ---------------------------------------------------------------- HTML

export interface PageFacts {
  title: string | null;
  description: string | null;
  /** meta robots / googlebot content, lowercased. */
  robots: string;
  canonical: string | null;
  h1: number;
  links: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[m[1]!.toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

/** What the audit needs from a page, by pattern rather than a full parser: scripts, styles and comments removed first. */
export function parsePage(html: string, url: string): PageFacts {
  // svg goes too: an inline icon's <title> is not the page's.
  const h = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const head = /<head[\s>][\s\S]*?<\/head>/i.exec(h)?.[0] ?? h;
  // Streaming frameworks (Next.js app router, React 19) send <title> in the body and hoist it when the page renders, which is
  // what Google indexes; so the head's title, else the first one anywhere.
  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/i;
  const title = titleRe.exec(head)?.[1] ?? titleRe.exec(h)?.[1];
  let description: string | null = null, robots = "", canonical: string | null = null;
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const name = (a.name ?? "").toLowerCase();
    if (name === "description" && description == null) description = (a.content ?? "").trim();
    if (name === "robots" || name === "googlebot") robots += (robots ? ", " : "") + (a.content ?? "").toLowerCase();
  }
  let base = url;
  const baseTag = /<base\b[^>]*>/i.exec(head);
  if (baseTag) { const b = attrs(baseTag[0]).href; if (b) base = normUrl(b, url) ?? url; }
  for (const m of h.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") && a.href && canonical == null) canonical = normUrl(a.href, base);
  }
  const links = new Set<string>();
  for (const m of h.matchAll(/<a\b[^>]*>/gi)) {
    const href = attrs(m[0]).href;
    if (!href || /^(mailto|tel|javascript|data|sms):/i.test(href.trim())) continue;
    const n = normUrl(href.trim(), base);
    if (n) links.add(n);
  }
  return {
    title: title != null ? decode(title).replace(/\s+/g, " ").trim() : null,
    description, robots, canonical,
    h1: (h.match(/<h1[\s>]/gi) ?? []).length,
    links: [...links],
  };
}

// ---------------------------------------------------------------- crawl

interface Fetched {
  url: string;
  /** Each redirect hop, in order: [from, status]. */
  hops: { url: string; status: number }[];
  final: string;
  status: number | null;
  error?: string;
  /** Redirected out of the property, or to a non-http URL. */
  offsite?: string;
  contentType: string;
  noindex: boolean;
  ms: number;
  facts?: PageFacts;
}

/** Follow redirects by hand so each hop is recorded and stays inside the property. */
async function fetchWithHops(fetch: PageFetcher, url: string, scope: Scope): Promise<Fetched> {
  const hops: Fetched["hops"] = [];
  let cur = url, ms = 0;
  for (let i = 0; i <= MAX_HOPS; i++) {
    let r: PageResponse;
    try { r = await fetch(cur); } catch (e) {
      return { url, hops, final: cur, status: null, error: (e as Error).message, contentType: "", noindex: false, ms };
    }
    ms += r.ms;
    if (r.status >= 300 && r.status < 400 && r.location) {
      hops.push({ url: cur, status: r.status });
      const next = normUrl(r.location, cur);
      if (!next) return { url, hops, final: cur, status: r.status, offsite: r.location, contentType: "", noindex: false, ms };
      let nu: URL; try { nu = new URL(next); } catch { nu = new URL(cur); }
      if (!scope.inScope(nu)) return { url, hops, final: next, status: r.status, offsite: next, contentType: "", noindex: false, ms };
      cur = next;
      continue;
    }
    const html = /html/.test(r.contentType) || (!r.contentType && /^\s*</.test(r.body));
    const facts = html && r.status === 200 ? parsePage(r.body, cur) : undefined;
    const noindex = /noindex|\bnone\b/.test(r.xRobots) || /noindex|\bnone\b/.test(facts?.robots ?? "");
    return { url, hops, final: cur, status: r.status, contentType: r.contentType, noindex, ms, facts };
  }
  return { url, hops, final: cur, status: null, error: `more than ${MAX_HOPS} redirects`, contentType: "", noindex: false, ms };
}

let running = 0;
const waiting: (() => void)[] = [];
/** At most this many audits crawl at once across the whole server; the rest queue (box outbound limit). */
export const AUDITS_AT_ONCE = 2;
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= AUDITS_AT_ONCE) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/** Crawl, then report. Throws only if the start page can't be fetched at all. */
export function auditSite(o: AuditOptions) { return slot(() => runAudit(o)); }

async function runAudit(o: AuditOptions) {
  const now = o.now ?? Date.now;
  const started = now();
  const budget = o.budgetMs ?? 40_000;
  const scope = propertyScope(o.site);
  const startUrl = new URL(scope.start);
  const origin = `${startUrl.protocol}//${startUrl.host}`;

  // robots.txt
  let robots: Robots = { allowed: () => true, sitemaps: [] };
  let robotsNote: string | null = null;
  try {
    const r = await o.fetch(`${origin}/robots.txt`);
    if (r.status === 200) robots = parseRobots(r.body);
    else if (r.status >= 500) robotsNote = `robots.txt answered HTTP ${r.status}: Google treats that as "don't crawl anything" until it recovers.`;
  } catch (e) { robotsNote = `robots.txt could not be fetched: ${(e as Error).message}`; }

  // sitemaps: Search Console's, robots.txt's, else /sitemap.xml
  const sitemapQueue = [...new Set([...o.sitemapPaths, ...robots.sitemaps])];
  if (!sitemapQueue.length) sitemapQueue.push(`${origin}/sitemap.xml`);
  const sitemapUrls = new Set<string>();
  const sitemapProblems: { sitemap: string; problem: string }[] = [];
  const seenMaps = new Set<string>();
  while (sitemapQueue.length && seenMaps.size < MAX_SITEMAP_FILES && sitemapUrls.size < MAX_SITEMAP_URLS) {
    const sm = sitemapQueue.shift()!;
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    try {
      const r = await o.fetch(sm);
      if (r.status !== 200) { sitemapProblems.push({ sitemap: sm, problem: `HTTP ${r.status}` }); continue; }
      const p = parseSitemap(r.body);
      if (!p.urls.length && !p.sitemaps.length) sitemapProblems.push({ sitemap: sm, problem: "no <loc> entries (not a sitemap, or empty)" });
      sitemapQueue.push(...p.sitemaps);
      for (const u of p.urls) {
        const n = normUrl(u);
        if (!n) continue;
        if (!scope.inScope(new URL(n))) { if (sitemapProblems.length < 50) sitemapProblems.push({ sitemap: sm, problem: `lists ${n}, outside the property` }); continue; }
        if (sitemapUrls.size < MAX_SITEMAP_URLS) sitemapUrls.add(n);
      }
    } catch (e) { sitemapProblems.push({ sitemap: sm, problem: (e as Error).message }); }
  }

  // crawl: links first (breadth-first from the start page), then sitemap URLs nothing linked to
  const pages = new Map<string, Fetched>();
  const linkedFrom = new Map<string, Set<string>>();
  const queued = new Set<string>([scope.start]);
  const queue: string[] = [scope.start];
  const blocked = new Set<string>();
  let sitemapPhase = false, stopped: "pages" | "time" | null = null;
  const enqueue = (u: string) => {
    if (queued.has(u)) return;
    let url: URL; try { url = new URL(u); } catch { return; }
    if (!scope.inScope(url) || ASSET.test(url.pathname)) return;
    queued.add(u); queue.push(u);
  };
  const nextUrl = (): string | null => {
    for (;;) {
      if (!queue.length && !sitemapPhase) { sitemapPhase = true; for (const u of sitemapUrls) enqueue(u); }
      const u = queue.shift();
      if (u == null) return null;
      if (!robots.allowed(u)) { blocked.add(u); continue; }
      return u;
    }
  };
  let taken = 0; // reserved before fetching, so two workers can't both take the last slot
  const worker = async () => {
    for (;;) {
      if (taken >= o.maxPages) { if (queue.length || !sitemapPhase) stopped ??= "pages"; return; }
      if (now() - started > budget) { stopped ??= "time"; return; }
      const u = nextUrl();
      if (u == null) return;
      taken++;
      const f = await fetchWithHops(o.fetch, u, scope);
      pages.set(u, f);
      for (const l of f.facts?.links ?? []) {
        if (!linkedFrom.has(l)) linkedFrom.set(l, new Set());
        linkedFrom.get(l)!.add(u);
        enqueue(l);
      }
    }
  };
  await Promise.all(Array.from({ length: o.concurrency ?? 2 }, worker));
  const first = pages.get(scope.start);
  if (!first || (first.status == null && pages.size === 1)) {
    throw new Error(`Could not fetch ${scope.start}: ${first?.error ?? "no response"}. The audit needs the site's home page to be reachable from the internet.`);
  }
  const capped = stopped != null && (queue.length > 0 || !sitemapPhase);

  return report({ o, scope, pages, linkedFrom, sitemapUrls, sitemapProblems, blocked, robotsNote, capped, stopped, ms: now() - started, seenMaps });
}

// ---------------------------------------------------------------- report

interface Crawl {
  o: AuditOptions; scope: Scope; pages: Map<string, Fetched>; linkedFrom: Map<string, Set<string>>; sitemapUrls: Set<string>;
  sitemapProblems: { sitemap: string; problem: string }[]; blocked: Set<string>; robotsNote: string | null;
  capped: boolean; stopped: "pages" | "time" | null; ms: number; seenMaps: Set<string>;
}

async function report(x: Crawl) {
  const { o, pages, linkedFrom, sitemapUrls } = x;
  const lim = o.limit;
  const from = (u: string) => [...(linkedFrom.get(u) ?? [])];
  const inSitemap = (u: string) => sitemapUrls.has(u);
  const all = [...pages.values()];
  // One entry per final page: a page reached by its own URL and through a redirect is still one page.
  const ok = [...new Map(all.filter((p) => p.status === 200 && p.facts).map((p) => [p.final, p] as const)).values()];
  const byFinal = new Map(all.map((p) => [p.final, p]));
  const top = <T>(arr: T[]) => arr.slice(0, lim);

  const broken = all.filter((p) => p.status == null || p.status >= 400).map((p) => ({
    url: p.url, status: p.status, ...(p.error ? { error: p.error } : {}), in_sitemap: inSitemap(p.url),
    linked_from: from(p.url).slice(0, 3), linked_from_count: from(p.url).length,
  })).sort((a, b) => b.linked_from_count - a.linked_from_count || Number(b.in_sitemap) - Number(a.in_sitemap));

  const redirects = all.filter((p) => p.hops.length).map((p) => ({
    url: p.url, to: p.final, hops: p.hops.length, codes: p.hops.map((h) => h.status), ...(p.offsite ? { leaves_property: true } : {}),
    in_sitemap: inSitemap(p.url), linked_from_count: from(p.url).length, linked_from: from(p.url).slice(0, 3),
  })).sort((a, b) => b.hops - a.hops || b.linked_from_count - a.linked_from_count);

  const noindexed = ok.filter((p) => p.noindex).map((p) => ({ url: p.final, in_sitemap: inSitemap(p.url), linked_from_count: from(p.url).length }))
    .sort((a, b) => Number(b.in_sitemap) - Number(a.in_sitemap));

  const canonicalIssues: { url: string; canonical: string | null; problem: string; in_sitemap: boolean }[] = [];
  let noCanonical = 0;
  for (const p of ok) {
    const c = p.facts!.canonical;
    if (!c) { noCanonical++; continue; }
    if (c === p.final) continue;
    const target = pages.get(c) ?? byFinal.get(c);
    const problem = target && (target.status == null || target.status >= 400) ? `points to a page that answers ${target.status ?? target.error}`
      : target && target.hops.length ? `points to a URL that redirects to ${target.final}`
      : target?.noindex ? "points to a noindex page"
      : inSitemap(p.url) ? "page is in the sitemap but names another URL as canonical"
      : null;
    if (problem) canonicalIssues.push({ url: p.final, canonical: c, problem, in_sitemap: inSitemap(p.url) });
  }

  // Title, description and H1 checks look only at pages Google would index as themselves: not noindex, and their own
  // canonical (or none). A ?utm_ variant that names the clean URL as canonical isn't a duplicate.
  const indexable = ok.filter((p) => !p.noindex && (!p.facts!.canonical || p.facts!.canonical === p.final));
  const group = (key: (p: Fetched) => string | null) => {
    const m = new Map<string, string[]>();
    for (const p of indexable) { const k = key(p); if (!k) continue; m.set(k, [...(m.get(k) ?? []), p.final]); }
    return [...m.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ text: k, pages: v.slice(0, 5), count: v.length }))
      .sort((a, b) => b.count - a.count);
  };
  const missingTitle = indexable.filter((p) => !p.facts!.title).map((p) => p.final);
  const longTitle = indexable.filter((p) => (p.facts!.title ?? "").length > 65).map((p) => ({ url: p.final, title: p.facts!.title, length: p.facts!.title!.length }));
  const missingDesc = indexable.filter((p) => !p.facts!.description).map((p) => p.final);
  const longDesc = indexable.filter((p) => (p.facts!.description ?? "").length > 160).map((p) => ({ url: p.final, length: p.facts!.description!.length }));
  const dupTitles = group((p) => p.facts!.title || null);
  const dupDescs = group((p) => p.facts!.description || null);
  const noH1 = indexable.filter((p) => p.facts!.h1 === 0).map((p) => p.final);
  const manyH1 = indexable.filter((p) => p.facts!.h1 > 1).map((p) => ({ url: p.final, h1_count: p.facts!.h1 }));

  // Sitemap ↔ crawl. "Orphan" needs the link crawl to have finished; a capped crawl just hasn't reached the linking page.
  const linkCrawlDone = !x.capped;
  const orphans = [...sitemapUrls].filter((u) => !linkedFrom.has(u) && u !== x.scope.start && pages.get(u)?.status === 200);
  const sitemapBad = [...sitemapUrls].map((u) => pages.get(u)).filter((p): p is Fetched => !!p)
    .filter((p) => p.status !== 200 || p.hops.length || p.noindex || (p.facts?.canonical && p.facts.canonical !== p.final))
    .map((p) => ({ url: p.url, problem: p.status == null ? `fetch failed: ${p.error}` : p.status >= 400 ? `HTTP ${p.status}`
      : p.hops.length ? `redirects to ${p.final}` : p.noindex ? "noindex" : `canonical is ${p.facts!.canonical}` }));
  const notInSitemap = sitemapUrls.size ? indexable.filter((p) => !inSitemap(p.final)).map((p) => p.final) : [];

  const slow = all.filter((p) => p.ms > SLOW_MS && p.status === 200).map((p) => ({ url: p.final, ms: p.ms })).sort((a, b) => b.ms - a.ms);

  // Google's view: a sample, the URLs most likely to be in trouble first.
  let index: Record<string, unknown> | undefined;
  if (o.inspect && o.indexSample > 0) {
    const pick = [...new Set([
      ...(linkCrawlDone ? orphans : []), ...notInSitemap, ...[...sitemapUrls].filter((u) => pages.get(u)?.status === 200), ...indexable.map((p) => p.final),
    ])].slice(0, o.indexSample);
    const rows: { url: string; coverage_state: string; last_crawl?: string | null; google_canonical?: string | null }[] = [];
    let failed: string | null = null;
    for (let i = 0; i < pick.length; i += 5) {
      const chunk = await Promise.all(pick.slice(i, i + 5).map((u) => o.inspect!(u).then(
        (r) => ({ url: u, coverage_state: r.indexStatusResult?.coverageState ?? "unknown", last_crawl: r.indexStatusResult?.lastCrawlTime ?? null,
          ...(r.indexStatusResult?.googleCanonical && r.indexStatusResult.googleCanonical !== u ? { google_canonical: r.indexStatusResult.googleCanonical } : {}) }),
        (e: Error) => { failed ??= e.message; return null; })));
      rows.push(...chunk.filter((r): r is NonNullable<typeof r> => r != null));
      if (failed) break;
    }
    const tally: Record<string, number> = {};
    for (const r of rows) tally[r.coverage_state] = (tally[r.coverage_state] ?? 0) + 1;
    index = { checked: rows.length, tally, not_indexed: rows.filter((r) => !/indexed/i.test(r.coverage_state) || /not indexed/i.test(r.coverage_state)),
      ...(rows.some((r) => r.google_canonical) ? { google_chose_other_canonical: rows.filter((r) => r.google_canonical) } : {}),
      ...(failed ? { error: failed } : {}) };
  }

  const counts = {
    broken: broken.length, redirects: redirects.length, redirect_chains: redirects.filter((r) => r.hops > 1).length,
    noindex: noindexed.length, noindex_in_sitemap: noindexed.filter((p) => p.in_sitemap).length, canonical_problems: canonicalIssues.length,
    missing_canonical: noCanonical, missing_title: missingTitle.length, duplicate_titles: dupTitles.length, long_titles: longTitle.length,
    missing_description: missingDesc.length, duplicate_descriptions: dupDescs.length, long_descriptions: longDesc.length,
    missing_h1: noH1.length, multiple_h1: manyH1.length, sitemap_problems: sitemapBad.length + x.sitemapProblems.length,
    orphans: linkCrawlDone ? orphans.length : null, not_in_sitemap: notInSitemap.length, slow: slow.length,
  };
  return {
    site: o.site, start: x.scope.start,
    crawl: {
      pages_fetched: pages.size, html_pages_ok: ok.length, sitemap_urls: sitemapUrls.size, sitemaps_read: [...x.seenMaps].slice(0, 10),
      blocked_by_robots: x.blocked.size, seconds: Math.round(x.ms / 100) / 10,
      complete: !x.capped,
      ...(x.capped ? { stopped_at: x.stopped === "time" ? "time limit" : `max_pages (${o.maxPages})` } : {}),
      ...(x.robotsNote ? { robots_txt: x.robotsNote } : {}),
    },
    counts,
    broken: top(broken),
    redirects: top(redirects),
    noindex: top(noindexed),
    canonical: top(canonicalIssues),
    titles: { missing: top(missingTitle), duplicates: top(dupTitles), too_long: top(longTitle) },
    descriptions: { missing: top(missingDesc), duplicates: top(dupDescs), too_long: top(longDesc) },
    h1: { missing: top(noH1), multiple: top(manyH1) },
    sitemap: {
      problems_in_sitemap: top(sitemapBad), ...(x.sitemapProblems.length ? { sitemap_files: top(x.sitemapProblems) } : {}),
      orphans: linkCrawlDone ? top(orphans) : "not checked: the crawl stopped before following every link",
      indexable_not_in_sitemap: sitemapUrls.size ? top(notInSitemap) : "no sitemap found",
    },
    slow_pages: top(slow),
    ...(index ? { index_sample: index } : {}),
  };
}
