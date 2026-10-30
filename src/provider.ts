/**
 * The OAuth 2.1 authorization server that MCP clients (Claude, ChatGPT, Cursor…) talk to.
 *
 * The flow chains two consents:
 *   MCP client ──/authorize──▶ us ──redirect──▶ Google consent (email + Ads, Search Console, Analytics; any one is enough)
 *   Google ──/oauth/google/callback──▶ us: store the Google refresh token (encrypted),
 *   issue OUR authorization code ──▶ MCP client ──/token──▶ OUR access + refresh tokens.
 *
 * The MCP client never sees a Google token. Our tokens are random and stored only as hashes.
 */
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DB, UserRow } from "./db.js";
import { now } from "./db.js";
import { encrypt, randomToken, sha256 } from "./crypto.js";
import { consentPage } from "./pages.js";
import { clearGoogleCache } from "./session.js";
import {
  ADS_SCOPE, GRANTS, SEARCH_CONSOLE_SCOPE, exchangeGoogleCode, googleAuthUrl, idTokenClaims, type GoogleCreds,
} from "./google.js";

export const MCP_SCOPE = "ads";
const ACCESS_TTL = 3600;              // 1 hour
const REFRESH_TTL = 90 * 24 * 3600;   // 90 days, rotated on every use
const CODE_TTL = 600;                 // 10 minutes

interface PendingParams {
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  /** Also in an HttpOnly cookie on the browser that saw the consent page; the Google callback needs both. */
  nonce: string;
  approved?: boolean;
}

/** Hosts of the AI apps we know; anything else gets a warning on the consent page. */
const KNOWN_REDIRECT = /^(https:\/\/(claude\.ai|claude\.com|chatgpt\.com|oauth-redirect(-sandbox|-test)?\.googleusercontent\.com)|http:\/\/(localhost|127\.0\.0\.1|\[::1\]))(:\d+)?\//;

/** One cookie per parked request, so two connections in two tabs don't overwrite each other. */
export const consentCookie = (id: string) => `cs_auth_${id.slice(0, 12)}`;

export class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private db: DB) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as
      { info: string } | undefined;
    return row ? JSON.parse(row.info) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: now(),
    };
    this.db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES (?, ?, ?)")
      .run(full.client_id, JSON.stringify(full), now());
    return full;
  }
}

export class CamberstackProvider implements OAuthServerProvider {
  readonly clientsStore: ClientsStore;

  constructor(
    private db: DB,
    private opts: { baseUrl: string; google: GoogleCreds; encryptionKey: Buffer; fetch?: typeof fetch; allowedEmails?: Set<string> },
  ) {
    this.clientsStore = new ClientsStore(db);
  }

  get googleRedirectUri(): string {
    return `${this.opts.baseUrl}/oauth/google/callback`;
  }

  /** Step 1: park the MCP client's request and send the user to Google. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.opts.google.clientId) {
      const back = new URL(params.redirectUri);
      if (params.state) back.searchParams.set("state", params.state);
      back.searchParams.set("error", "temporarily_unavailable");
      back.searchParams.set("error_description", "Camberstack sign-in is not open yet. See https://camberstack.io");
      res.redirect(302, back.toString());
      return;
    }
    const id = randomToken(24);
    const p: PendingParams = {
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [MCP_SCOPE],
      resource: params.resource?.href,
      nonce: randomToken(24),
    };
    this.db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, ?, ?, ?)")
      .run(id, client.client_id, JSON.stringify(p), now());
    // Registration is open (RFC 7591), so anyone can register a client with their own redirect and mail
    // the /authorize link to a victim; Google's screen would show only "Camberstack". Show who's asking
    // first, and bind the request to this browser so a pre-built Google URL can't skip the page.
    const secure = this.opts.baseUrl.startsWith("https://");
    res.append("Set-Cookie", `${consentCookie(id)}=${p.nonce}; Path=/oauth/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? "; Secure" : ""}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.status(200).type("html").send(consentPage({
      id, clientName: client.client_name ?? "", redirectHost: new URL(params.redirectUri).host || params.redirectUri,
      known: KNOWN_REDIRECT.test(params.redirectUri),
    }));
  }

  /** The parked request, only if it's live and this browser is the one that was shown the consent page. */
  private pendingFor(id: string | undefined, browserNonce: string | undefined) {
    const row = id
      ? (this.db.prepare("SELECT * FROM pending_auth WHERE id = ?").get(id) as
          { id: string; client_id: string; params: string; created_at: number } | undefined)
      : undefined;
    if (!row || row.created_at < now() - 3600) {
      throw new Error("This sign-in link has expired. Start the connection again from your AI app.");
    }
    const p = JSON.parse(row.params) as PendingParams;
    const a = Buffer.from(p.nonce ?? ""), b = Buffer.from(browserNonce ?? "");
    if (!p.nonce || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("This sign-in wasn't started in this browser. Start the connection again from your AI app.");
    }
    return { row, p };
  }

  /** Step 1b: the user answered the consent page. Returns where to send the browser. */
  consent(id: string | undefined, approve: boolean, browserNonce: string | undefined): string {
    const { row, p } = this.pendingFor(id, browserNonce);
    if (!approve) {
      this.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(row.id);
      const back = new URL(p.redirectUri);
      if (p.state) back.searchParams.set("state", p.state);
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user cancelled the connection.");
      return back.toString();
    }
    this.db.prepare("UPDATE pending_auth SET params = ? WHERE id = ?").run(JSON.stringify({ ...p, approved: true }), row.id);
    return googleAuthUrl(this.opts.google, this.googleRedirectUri, row.id, GRANTS.analytics.scopes);
  }

  /**
   * Step 2: Google sent the user back. Returns the URL to redirect the browser to — the MCP
   * client's redirect_uri carrying either our code or an OAuth error — and, when Google Ads was
   * connected, who connected and whether it was their first time (for our own ad measurement).
   */
  async completeGoogleCallback(
    q: { code?: string; state?: string; error?: string }, browserNonce: string | undefined,
  ): Promise<{ to: string; userId?: string; created?: boolean }> {
    const { row: pending, p } = this.pendingFor(q.state, browserNonce);
    if (!p.approved) throw new Error("This sign-in wasn't approved on Camberstack. Start the connection again from your AI app.");
    this.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(pending.id);
    const back = new URL(p.redirectUri);
    if (p.state) back.searchParams.set("state", p.state);

    if (q.error || !q.code) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "Google access was not granted.");
      return { to: back.toString() };
    }

    const g = await exchangeGoogleCode(this.opts.google, q.code, this.googleRedirectUri, this.opts.fetch);
    // À la carte: any one service is enough to connect; a tool that needs another returns a link that adds it (grant.ts).
    const granted = g.scope.split(" ");
    const enough = [ADS_SCOPE, SEARCH_CONSOLE_SCOPE, GRANTS.analytics.scopes[0]];
    if (!enough.some((s) => granted.includes(s))) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "No Google service was granted (every box was unticked).");
      return { to: back.toString() };
    }
    if (!g.id_token) throw new Error("Google did not return an id_token");
    const { sub, email } = idTokenClaims(g.id_token);
    const allowed = this.opts.allowedEmails;
    if (allowed?.size && !allowed.has(email.toLowerCase())) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "This Camberstack server is private. Connect https://camberstack.io/mcp instead.");
      return { to: back.toString() };
    }
    const { user, created } = this.upsertUser(sub, email, g.refresh_token, g.scope, pending.client_id);

    const code = randomToken();
    this.db.prepare(`INSERT INTO auth_codes
        (code_hash, client_id, user_id, code_challenge, redirect_uri, resource, scopes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(code), pending.client_id, user.id, p.codeChallenge, p.redirectUri,
        p.resource ?? null, p.scopes.join(" "), now() + CODE_TTL);
    back.searchParams.set("code", code);
    return { to: back.toString(), userId: user.id, created };
  }

  private upsertUser(sub: string, email: string, refreshToken?: string, scope?: string, clientId?: string): { user: UserRow; created: boolean } {
    const existing = this.db.prepare("SELECT * FROM users WHERE google_sub = ?").get(sub) as UserRow | undefined;
    const enc = refreshToken ? encrypt(this.opts.encryptionKey, refreshToken) : null;
    if (existing) {
      this.db.prepare("UPDATE users SET email = ?, enc_refresh = COALESCE(?, enc_refresh), google_scopes = COALESCE(?, google_scopes), last_seen_at = ? WHERE id = ?")
        .run(email, enc, enc ? scope ?? null : null, now(), existing.id);
      if (enc) clearGoogleCache(existing.id);
      return { user: { ...existing, email, enc_refresh: enc ?? existing.enc_refresh }, created: false };
    }
    if (!enc) throw new Error("Google did not return a refresh token; remove Camberstack at myaccount.google.com/permissions and connect again.");
    const id = randomUUID();
    this.db.prepare("INSERT INTO users (id, google_sub, email, enc_refresh, google_scopes, created_at, last_seen_at, signup_client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, sub, email, enc, scope ?? null, now(), now(), clientId ?? null);
    return { user: this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow, created: true };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.codeRow(client, code);
    return row.code_challenge;
  }

  private codeRow(client: OAuthClientInformationFull, code: string) {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(sha256(code)) as
      { client_id: string; user_id: string; code_challenge: string; redirect_uri: string;
        resource: string | null; scopes: string; expires_at: number } | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.codeRow(client, code);
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource mismatch");
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(sha256(code));
    return this.issue(client.client_id, row.user_id, row.scopes.split(" "), row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'")
      .get(sha256(refreshToken)) as
      { client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number } | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const user = this.db.prepare("SELECT enc_refresh FROM users WHERE id = ?").get(row.user_id) as
      { enc_refresh: string | null } | undefined;
    if (!user?.enc_refresh) throw new InvalidGrantError("Google Ads is disconnected; connect again");
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha256(refreshToken)); // rotate
    const granted = row.scopes.split(" ");
    const want = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
    return this.issue(client.client_id, row.user_id, want, resource?.href ?? row.resource);
  }

  private issue(clientId: string, userId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = randomToken();
    const refresh = randomToken();
    const ins = this.db.prepare(`INSERT INTO tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run(sha256(access), "access", clientId, userId, scopes.join(" "), resource, now() + ACCESS_TTL);
    ins.run(sha256(refresh), "refresh", clientId, userId, scopes.join(" "), resource, now() + REFRESH_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token)) as
      { client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number } | undefined;
    if (!row || row.expires_at < now()) throw new InvalidTokenError("Invalid or expired access token");
    // No Google token (revoked, or never finished): a 401 is what makes the AI app run sign-in again. A tool
    // error saying "reconnect" left users stuck behind a connector their app still showed as connected (2026-10-16).
    const user = this.db.prepare("SELECT enc_refresh FROM users WHERE id = ?").get(row.user_id) as { enc_refresh: string | null } | undefined;
    if (!user?.enc_refresh) throw new InvalidTokenError("Google is disconnected; sign in again");
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(" ").filter(Boolean),
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ? AND client_id = ?").run(sha256(req.token), client.client_id);
  }
}
