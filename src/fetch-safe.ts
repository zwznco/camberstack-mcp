/**
 * Fetches an image URL the AI passed in (Display and Demand Gen ads need uploaded images), without letting
 * it reach anything internal. This container sits on the traefik network next to every other app on the
 * box, so a user-supplied URL is an SSRF target by construction. Ported from the old site's scanner:
 *   - https only, port 443, no credentials, a public domain name (no IP literals)
 *   - the address is checked AT CONNECT TIME via a custom `lookup`, so a name that resolves public for a
 *     check and private for the connect (DNS rebinding) is still refused
 *   - redirects followed by hand (max 3), each hop re-validated
 *   - hard timeout and size cap (Google's image asset limit is 5120 KB)
 *   - the bytes must be a PNG, JPEG or GIF, whatever the Content-Type says
 */
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";

const MAX_IMAGE_BYTES = 5120 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Camberstack/1.0 (+https://camberstack.io) image fetch for a Google Ads asset";

/** True for any address that is not a routable public unicast address. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)        // CGNAT
      || (a === 169 && b === 254)                  // link-local, cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)                    // 192.0.0.0/24 + 192.0.2.0/24 docs
      || (a === 198 && (b === 18 || b === 19))     // benchmarking
      || (a === 198 && b === 51) || (a === 203 && b === 0);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd")
      || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")
      || v.startsWith("ff") || v.startsWith("2001:db8");
  }
  return true;
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, family: 0 }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const ok = addresses.filter((a) => !isPrivateAddress(a.address));
    if (!ok.length) return callback(new Error(`${hostname} resolves to a private address`), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, ok);
    callback(null, ok[0]!.address, ok[0]!.family);
  });
};

/** Validates a user-supplied image URL. Throws with a message the AI can act on. */
export function checkImageUrl(input: string): URL {
  let u: URL;
  try { u = new URL(input); } catch { throw new Error(`"${input}" is not a URL.`); }
  if (u.protocol !== "https:") throw new Error(`Image URL ${input} must be https.`);
  if (u.username || u.password) throw new Error(`Image URL ${input} must not contain credentials.`);
  if (u.port && u.port !== "443") throw new Error(`Image URL ${input} must use the standard https port.`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) throw new Error(`Image URL ${input} must use a domain name, not an IP address.`);
  if (!host.includes(".") || /\.(local|internal|lan|home|localhost)$/i.test(host)) throw new Error(`Image URL ${input} must be on a public domain.`);
  u.hash = "";
  return u;
}

function getOnce(url: URL): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", lookup: safeLookup, timeout: TIMEOUT_MS,
      headers: { "user-agent": USER_AGENT, accept: "image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location: res.headers.location, body: Buffer.alloc(0) }); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_IMAGE_BYTES) { req.destroy(new Error(`Image ${url} is larger than Google's 5120 KB limit.`)); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Image ${url} took longer than ${TIMEOUT_MS / 1000}s to download.`)));
    req.on("error", (e) => reject(new Error(`Could not download image ${url}: ${e.message}`)));
    req.end();
  });
}

/** The image's type from its first bytes, or null if it isn't one Google accepts. */
export function imageType(b: Buffer): "PNG" | "JPEG" | "GIF" | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "PNG";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "JPEG";
  if (b.length > 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "GIF";
  return null;
}

/** GET an image with re-validated redirects. Returns its bytes. */
export async function fetchImage(input: string): Promise<Buffer> {
  let url = checkImageUrl(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await getOnce(url);
    if (res.location) { url = checkImageUrl(new URL(res.location, url).toString()); continue; }
    if (res.status !== 200) throw new Error(`Image ${input} returned HTTP ${res.status}.`);
    if (!imageType(res.body)) throw new Error(`${input} is not a PNG, JPEG or GIF image.`);
    return res.body;
  }
  throw new Error(`Image ${input} redirected too many times.`);
}

// ---------------------------------------------------------------- pages, for the site audit (site-audit.ts)

const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_USER_AGENT = "Mozilla/5.0 (compatible; Camberstack-SiteAudit/1.0; +https://camberstack.io)";

/** One response, redirects NOT followed: the audit records each hop itself. */
export interface PageResponse {
  status: number;
  location?: string;
  contentType: string;
  /** The X-Robots-Tag header, lowercased. */
  xRobots: string;
  /** Text body, cut at 2 MB (truncated says so). Empty for a redirect or a non-text type. */
  body: string;
  truncated: boolean;
  ms: number;
}

/**
 * Validates a URL the audit is about to fetch: http or https on the standard port, no credentials, a public domain
 * name. The audit only fetches URLs inside a property the user verified, but a page can link anywhere and a redirect
 * can point anywhere, and the address is still re-checked at connect time (safeLookup).
 */
export function checkPageUrl(input: string): URL {
  let u: URL;
  try { u = new URL(input); } catch { throw new Error(`"${input}" is not a URL.`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${input} is not an http(s) URL.`);
  if (u.username || u.password) throw new Error(`${input} contains credentials.`);
  if (u.port && u.port !== (u.protocol === "https:" ? "443" : "80")) throw new Error(`${input} uses a non-standard port.`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) throw new Error(`${input} uses an IP address, not a domain name.`);
  if (!host.includes(".") || /\.(local|internal|lan|home|localhost)$/i.test(host)) throw new Error(`${input} is not on a public domain.`);
  u.hash = "";
  return u;
}

/** GET one page through the SSRF guard. Text types (HTML, XML, plain) are read up to 2 MB; anything else isn't read. */
export function fetchPage(input: string): Promise<PageResponse> {
  const url = checkPageUrl(input);
  const started = Date.now();
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: "GET", lookup: safeLookup, timeout: PAGE_TIMEOUT_MS,
      headers: { "user-agent": PAGE_USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" } }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
      const xr = res.headers["x-robots-tag"];
      const xRobots = (Array.isArray(xr) ? xr.join(", ") : String(xr ?? "")).toLowerCase();
      const base = { status, contentType, xRobots, location: res.headers.location };
      if ((status >= 300 && status < 400) || !/text\/|xml|xhtml/.test(contentType)) {
        res.resume();
        return resolve({ ...base, body: "", truncated: false, ms: Date.now() - started });
      }
      const chunks: Buffer[] = [];
      let size = 0, truncated = false;
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > MAX_PAGE_BYTES) { truncated = true; chunks.push(c.subarray(0, c.length - (size - MAX_PAGE_BYTES))); res.destroy(); finish(); return; }
        chunks.push(c);
      });
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ ...base, body: Buffer.concat(chunks).toString("utf8"), truncated, ms: Date.now() - started }); };
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", (e) => (truncated ? finish() : reject(e)));
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${PAGE_TIMEOUT_MS / 1000}s`)));
    req.on("error", (e) => reject(new Error(e.message)));
    req.end();
  });
}
