/**
 * Adding one Google service to someone's existing connection: Google Ads, Search Console or Google Analytics, each
 * granted on its own ("à la carte") instead of all at sign-in. A tool that needs a missing one returns a personal,
 * signed /connect/<kind> link; Google's consent asks for just that service, with include_granted_scopes so the new
 * refresh token covers everything granted before too.
 *
 * It must come back as the same Google account the user connected (the token replaces theirs), and the browser that
 * followed the link must be the one that finishes (a nonce cookie), so a forwarded callback can't attach someone
 * else's account.
 */
import type { Express, Request, Response } from "express";
import type { DB, UserRow } from "./db.js";
import { now } from "./db.js";
import { encrypt, randomToken, safeEqual, sign } from "./crypto.js";
import { readCookie } from "./http.js";
import { GRANTS, exchangeGoogleCode, googleGrantUrl, idTokenClaims, type GoogleCreds, type GrantKind } from "./google.js";
import { esc } from "./pages.js";

const LINK_TTL = 7 * 86400;
const PREFIX = "gr_";
const STATE_COOKIE = "cs_grant_state";
const isKind = (k: unknown): k is GrantKind => typeof k === "string" && Object.hasOwn(GRANTS, k);

export interface GrantDeps {
  db: DB;
  baseUrl: string;
  google: GoogleCreds;
  encryptionKey: Buffer;
  /** Signs grant links; derived from ENCRYPTION_KEY so no new secret is needed. */
  signingKey: Buffer;
  /** Drops the user's cached Google token and account list, so the next call uses the new token (session.ts). */
  forgetToken: (userId: string) => void;
  fetch?: typeof fetch;
}

export class Grants {
  private readonly redirectUri: string;
  constructor(private d: GrantDeps) { this.redirectUri = `${d.baseUrl}/oauth/google/callback`; }

  link(kind: GrantKind, userId: string): string {
    const payload = `${userId}.${now() + LINK_TTL}`;
    return `${this.d.baseUrl}/connect/${kind}?t=${payload}.${sign(this.d.signingKey, `grant:${kind}:${payload}`)}`;
  }

  private verify(kind: GrantKind, t: unknown): string | null {
    const [userId, exp, sig] = String(t ?? "").split(".");
    if (!userId || !exp || !sig) return null;
    return safeEqual(sign(this.d.signingKey, `grant:${kind}:${userId}.${exp}`), sig) && Number(exp) >= now() ? userId : null;
  }

  owns(state: unknown): boolean { return typeof state === "string" && state.startsWith(PREFIX); }

  mount(app: Express, page: (title: string, body: string) => string): void {
    app.get("/connect/:kind", (req: Request, res: Response) => {
      const kind = req.params.kind;
      const userId = isKind(kind) ? this.verify(kind, req.query.t) : null;
      const u = userId ? this.user(userId) : undefined;
      if (!isKind(kind) || !u) {
        res.status(400).type("html").send(page("Link expired", "<p>This link has expired or is not valid. Ask your AI assistant to run the tool again for a fresh one.</p>"));
        return;
      }
      const id = PREFIX + randomToken(24), nonce = randomToken(16);
      this.d.db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, '__grant', ?, ?)")
        .run(id, JSON.stringify({ userId: u.id, kind, nonce }), now());
      res.append("Set-Cookie", `${STATE_COOKIE}=${nonce}; Path=/oauth/; HttpOnly; SameSite=Lax; Max-Age=600${this.d.baseUrl.startsWith("https://") ? "; Secure" : ""}`);
      res.redirect(302, googleGrantUrl(this.d.google, this.redirectUri, id, kind, u.email));
    });
  }

  /** Google came back to the shared callback with one of our states. Returns the service added, or null if refused. */
  async finish(req: Request, res: Response, page: (title: string, body: string) => string): Promise<GrantKind | null> {
    const state = String(req.query.state);
    const row = this.d.db.prepare("SELECT params, created_at FROM pending_auth WHERE id = ? AND client_id = '__grant'").get(state) as
      { params: string; created_at: number } | undefined;
    this.d.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(state);
    const p = row ? JSON.parse(row.params) as { userId: string; kind: GrantKind; nonce: string } : null;
    const label = p && isKind(p.kind) ? GRANTS[p.kind].label : "Google";
    const fail = (msg: string) => (res.status(400).type("html").send(page(`${label} not added`, `<p>${esc(msg)}</p>`)), null);
    if (!row || !p || !isKind(p.kind) || row.created_at < now() - 600 || !safeEqual(p.nonce, readCookie(req, STATE_COOKIE) ?? "")) {
      return fail("This sign-in expired or was started in another browser. Open the link from your AI assistant again.");
    }
    if (typeof req.query.code !== "string") return fail(`${label} access was not granted. Nothing changed.`);
    const u = this.user(p.userId);
    if (!u) return fail("This Camberstack account no longer exists.");
    const g = await exchangeGoogleCode(this.d.google, req.query.code, this.redirectUri, this.d.fetch);
    const who = g.id_token ? idTokenClaims(g.id_token) : null;
    if (!who || who.sub !== u.google_sub) return fail(`That was a different Google account. Add ${label} with the account Camberstack is connected to (${u.email}).`);
    if (!g.scope.split(" ").includes(GRANTS[p.kind].scopes[0])) return fail(`The ${label} box was unticked. Nothing changed.`);
    if (!g.refresh_token) return fail("Google didn't return a new token. Try the link again.");
    this.d.db.prepare("UPDATE users SET enc_refresh = ?, google_scopes = ? WHERE id = ?").run(encrypt(this.d.encryptionKey, g.refresh_token), g.scope, u.id);
    this.d.forgetToken(u.id);
    res.append("Set-Cookie", `${STATE_COOKIE}=; Path=/oauth/; Max-Age=0; SameSite=Lax`);
    res.status(200).type("html").send(page(`${label} added`, `<p><strong>${label} is now part of your Camberstack connection.</strong></p>`
      + "<p>Go back to your AI assistant and ask again.</p>"));
    return p.kind;
  }

  private user(id: string): UserRow | undefined {
    return this.d.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }
}
