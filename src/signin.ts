/**
 * "Sign in with Google" for our own web pages (the admin site, /account): identity only (openid email), no Ads
 * scope, no refresh token. It reuses the registered redirect URI (/oauth/google/callback); each page's
 * states carry its own prefix and server.ts routes the callback by prefix, so the verified OAuth client
 * never changes. Sessions are random tokens stored as hashes, in an HttpOnly cookie scoped to the page.
 */
import type { Request, Response } from "express";
import { readCookie } from "./http.js";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { randomToken, safeEqual, sha256 } from "./crypto.js";
import { exchangeGoogleCode, googleSignInUrl, idTokenClaims, type GoogleCreds } from "./google.js";

export interface SignInDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  fetch?: typeof fetch;
}

export class SignIn {
  private readonly redirectUri: string;
  private readonly secure: boolean;

  /**
   * `siteUrl` is the origin the page lives on (the admin page has its own host); Google always returns
   * to the main site's registered callback, which forwards here, so the cookie lands on the page's host.
   */
  constructor(private d: SignInDeps, readonly prefix: string, private cookieName: string, private path: string, private ttl: number,
    private siteUrl = d.baseUrl) {
    this.redirectUri = `${d.baseUrl}/oauth/google/callback`;
    this.secure = siteUrl.startsWith("https://");
  }

  /** Absolute URL server.ts forwards Google's callback to; under the cookie's path, on the page's host. */
  get callbackUrl(): string { return `${this.siteUrl}${this.path === "/" ? "" : this.path}/callback`; }

  owns(state: unknown): boolean { return typeof state === "string" && state.startsWith(this.prefix); }

  /**
   * Redirect the browser to Google. `next` (a path on this page) is where finish() says to go afterwards; it rides in
   * the one-use state row. A nonce in the row and in a cookie ties the sign-in to this browser, so nobody can hand
   * someone a callback link that signs them in as the sender (login CSRF).
   */
  start(res: Response, next?: string): void {
    const id = this.prefix + randomToken(24), nonce = randomToken(16);
    this.d.db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, ?, ?, ?)")
      .run(id, `__${this.prefix}`, JSON.stringify({ nonce, ...(next ? { next } : {}) }), now());
    this.cookie(res, nonce, 600, `${this.cookieName}_state`);
    res.redirect(302, googleSignInUrl(this.d.google, this.redirectUri, id));
  }

  /** Google came back: one-use state, 10 minutes. Returns the verified identity, or null. */
  async finish(req: Request): Promise<{ sub: string; email: string; next?: string } | null> {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const row = this.d.db.prepare("SELECT created_at, params FROM pending_auth WHERE id = ? AND client_id = ?").get(state, `__${this.prefix}`) as
      { created_at: number; params: string } | undefined;
    this.d.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(state);
    if (!row || row.created_at < now() - 600 || !code) return null;
    const p = JSON.parse(row.params || "{}") as { next?: unknown; nonce?: string };
    if (!p.nonce || !safeEqual(p.nonce, readCookie(req, `${this.cookieName}_state`) ?? "")) return null;
    const g = await exchangeGoogleCode(this.d.google, code, this.redirectUri, this.d.fetch);
    const c = g.id_token ? idTokenClaims(g.id_token) : null;
    return c?.emailVerified ? { sub: c.sub, email: c.email, ...(typeof p.next === "string" ? { next: p.next } : {}) } : null;
  }

  /**
   * Start a session for `subject` (an email for the admin site, a user id for /account). `impersonator` marks one an admin
   * opened through "Log in as user" (account.ts), usually with a shorter `ttl`.
   */
  open(res: Response, subject: string, o: { impersonator?: string; ttl?: number } = {}): void {
    const token = randomToken(), ttl = o.ttl ?? this.ttl;
    this.d.db.prepare("INSERT INTO web_sessions (token_hash, kind, subject, expires_at, impersonator) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), this.prefix, subject, now() + ttl, o.impersonator ?? null);
    this.cookie(res, token, ttl);
  }

  /** The signed-in subject, or null. */
  subject(req: Request): string | null {
    return this.session(req)?.subject ?? null;
  }

  /** The signed-in subject and, for an admin's "Log in as user" session, the admin's email. */
  session(req: Request): { subject: string; impersonator: string | null } | null {
    const t = readCookie(req, this.cookieName);
    if (!t) return null;
    const row = this.d.db.prepare("SELECT subject, expires_at, impersonator FROM web_sessions WHERE token_hash = ? AND kind = ?").get(sha256(t), this.prefix) as
      { subject: string; expires_at: number; impersonator: string | null } | undefined;
    return row && row.expires_at > now() ? { subject: row.subject, impersonator: row.impersonator } : null;
  }

  close(req: Request, res: Response): void {
    const t = readCookie(req, this.cookieName);
    if (t) this.d.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha256(t));
    this.cookie(res, "", 0);
  }

  private cookie(res: Response, value: string, maxAge: number, name = this.cookieName): void {
    res.append("Set-Cookie", `${name}=${value}; Path=${this.path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`);
  }
}
