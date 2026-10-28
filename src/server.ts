import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { now, openDb, sweep, type DB } from "./db.js";
import { deriveKey } from "./crypto.js";
import { CamberstackProvider, MCP_SCOPE, consentCookie } from "./provider.js";
import { UserSession, clearGoogleCache, type SessionDeps } from "./session.js";
import { Grants } from "./grant.js";
import { GRANTS } from "./google.js";
import { buildServer, SERVER_VERSION, toolCatalog } from "./tools.js";
import { Analytics, BEACON_JS, gtagJs, parseBeacon } from "./analytics.js";
import { mountAdmin } from "./admin.js";
import { mountAccount } from "./account.js";
import { mountFeedback } from "./feedback.js";
import { Billing } from "./billing.js";
import { AdConversions } from "./adconversions.js";
import { Lifecycle, lifecycleSigningKey } from "./lifecycle.js";
import { retain } from "./retention.js";
import { Announcements } from "./announce.js";
import { CHANGELOG } from "./changelog.js";
import { aboutPage, changelogPage, docsPage, errorPage, infoPage, homePage, chatgptGuidePage, claudeGuidePage, geminiGuidePage, llmsTxt, plansPage, privacyPage, robotsTxt, searchConsolePage, SITEMAP_PATHS, sitemapXml, termsPage, toolsPage, withFreePlan } from "./pages.js";
import { freePlan } from "./plans.js";
import { indexNowKey, pageDates, pingIndexNow } from "./lastmod.js";
import { readCookie } from "./http.js";
import { initErrorReporting, reportError } from "./sentry.js";
import { teeToFile } from "./logfile.js";
import { ErrorAlerts, stuckNow, UNSUPPORTED_PREFIX } from "./alerts.js";
const DRAIN_FILE = "/tmp/drain";

/** brand/ sits beside src/ and dist/ at the package root. */
const BRAND_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "brand");
const RESOURCE_NAME = "Camberstack Google Ads";
/** Gemini's OAuth relay; it registers its /r/ and /a/ paths on all three hosts. */
const GEMINI_REDIRECT = /^https:\/\/oauth-redirect(-sandbox|-test)?\.googleusercontent\.com\//;
const HOUR = 3600_000;
/** POST /mcp slower than this gets a diagnostic log line (traefik saw 240–295s Claude requests; tools never exceed ~14s). */
const SLOW_MCP_MS = 10_000;

export interface Overrides extends Partial<SessionDeps> {
  fetch?: typeof fetch;
  analyticsFetch?: typeof fetch;
  stripeFetch?: typeof fetch;
  adsConversionFetch?: typeof fetch;
  mailFetch?: typeof fetch;
  indexNowFetch?: typeof fetch;
}

export interface Service {
  app: Express;
  billing: Billing;
  /** The background sweeps. Not started by createApp, so tests run without timers. */
  startJobs(): void;
  /** Links that add one Google service to a connection, so tests can follow one. */
  grants: Grants;
  /** What every session reads, so tests can flip a flag (freeOneService) without a second server. */
  deps: SessionDeps;
}

export function createApp(cfg: Config, db: DB, overrides: Overrides = {}): Service {
  const app = express();
  app.set("trust proxy", 1); // behind Traefik: one hop
  app.disable("x-powered-by");
  const adConversions = new AdConversions(db, cfg.conversions, cfg.baseUrl.startsWith("https://"), overrides.adsConversionFetch);
  const billing = new Billing({ db, baseUrl: cfg.baseUrl, stripe: cfg.stripe, fetch: overrides.stripeFetch,
    signingKey: deriveKey(cfg.encryptionKey, "billing-links") });
  const internalEmails = new Set([...cfg.adminEmails, ...cfg.proEmails]);
  const lifecycle = new Lifecycle({
    db, baseUrl: cfg.baseUrl, mail: cfg.mail, fetch: overrides.mailFetch, internalEmails,
    signingKey: lifecycleSigningKey(cfg.encryptionKey),
    upgradeLink: (userId) => billing.link("upgrade", userId, "email"),
    agencyLink: (userId) => billing.link("agency", userId, "email"),
    plusLink: (userId) => billing.link("plus", userId, "email"),
    freeOneServiceFrom: cfg.freeOneServiceFrom,
  });
  const announcements = new Announcements({ db, lifecycle, internalEmails, canSend: !!cfg.mail });
  const info = (title: string, body: string) => infoPage(cfg.baseUrl, title, body);

  const provider = new CamberstackProvider(db, {
    baseUrl: cfg.baseUrl, google: cfg.google, encryptionKey: cfg.encryptionKey, fetch: overrides.fetch, allowedEmails: cfg.allowedEmails,
    // Google verified the Analytics scopes 2026-10-17, so sign-in asks for them next to Ads + Search Console.
    extraGoogleScopes: GRANTS.analytics.scopes,
  });
  const grants = new Grants({ db, baseUrl: cfg.baseUrl, google: cfg.google, encryptionKey: cfg.encryptionKey,
    signingKey: deriveKey(cfg.encryptionKey, "grant-links"), forgetToken: clearGoogleCache, fetch: overrides.fetch });
  const deps: SessionDeps = {
    db, baseUrl: cfg.baseUrl, google: cfg.google, encryptionKey: cfg.encryptionKey,
    freeAccounts: cfg.freeAccounts, proAccounts: cfg.proAccounts, proEmails: cfg.proEmails, freeOneServiceFrom: cfg.freeOneServiceFrom,
    agencyAccounts: billing.agencyEnabled ? cfg.agencyAccounts : undefined, plusAvailable: billing.plusEnabled,
    billingLink: (kind, userId) => billing.link(kind, userId, "tool"), plansLink: (userId) => billing.plansLink(userId),
    refreshPlan: (userId) => billing.refreshPlan(userId),
    grantLink: (kind, userId) => grants.link(kind, userId), ...overrides,
  };
  const mcpUrl = new URL(`${cfg.baseUrl}/mcp`);
  const logCall = db.prepare(`INSERT INTO tool_calls (at, user_id, client_id, tool, customer_id, ok, error, ms, bytes, query_shape, service)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const analytics = new Analytics({ matomoUrl: cfg.matomo?.url ?? "", siteId: cfg.matomo?.siteId ?? "",
    token: cfg.matomo?.token ?? "", site: cfg.baseUrl, fetch: overrides.analyticsFetch });

  app.use((req, res, next) => {
    analytics.aiFetch(req, res);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Before every public route: the admin host serves only the admin site.
  const admin = mountAdmin(app, {
    db, google: cfg.google, baseUrl: cfg.baseUrl, adminUrl: cfg.adminUrl, adminEmails: cfg.adminEmails,
    internalEmails, announcements, fetch: overrides.fetch,
  });

  // Gemini (Spark custom apps) registers asking for client_secret_post, takes the secret, then its
  // redirect page fails ("Cannot Complete Request") without ever calling /token. Registered as a public
  // client (PKCE only, no secret) it completes, as in ghchinoy/spark-agent-tools' field notes. Only
  // clients whose every redirect is Google's relay get this; everyone else keeps the SDK default.
  app.post("/register", express.json({ limit: "100kb" }), (req, _res, next) => {
    const uris = (req.body as { redirect_uris?: unknown })?.redirect_uris;
    if (Array.isArray(uris) && uris.length > 0
      && uris.every((u) => typeof u === "string" && GEMINI_REDIRECT.test(u))) {
      req.body.token_endpoint_auth_method = "none";
    }
    next();
  });

  // Issuer without the trailing slash the SDK always adds ("https://camberstack.io/"): for a bare origin
  // RFC 8414 derives the metadata URL from "https://camberstack.io", and Gemini abandoned the flow after
  // /register with the slashed form. Served ahead of the SDK router; every other field is the SDK's.
  const issuer = new URL(cfg.baseUrl).origin;
  const resourceMetadata = {
    resource: mcpUrl.href, authorization_servers: [issuer], scopes_supported: [MCP_SCOPE],
    resource_name: RESOURCE_NAME, resource_documentation: `${cfg.baseUrl}/docs`,
  };
  app.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"], (_q, r) => {
    r.set("Access-Control-Allow-Origin", "*").json(resourceMetadata);
  });
  app.get("/.well-known/oauth-authorization-server", (_q, r) => {
    r.set("Access-Control-Allow-Origin", "*").json({
      issuer, service_documentation: `${cfg.baseUrl}/docs`,
      authorization_endpoint: `${issuer}/authorize`, response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint: `${issuer}/token`, token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: [MCP_SCOPE],
      revocation_endpoint: `${issuer}/revoke`, revocation_endpoint_auth_methods_supported: ["client_secret_post"],
      registration_endpoint: `${issuer}/register`,
    });
  });

  // OAuth: /.well-known/*, /authorize, /token, /register, /revoke
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(cfg.baseUrl),
    resourceServerUrl: mcpUrl,
    scopesSupported: [MCP_SCOPE],
    resourceName: RESOURCE_NAME,
    serviceDocumentationUrl: new URL(`${cfg.baseUrl}/docs`),
  }));

  if (cfg.glamaClaim) {
    app.get("/.well-known/glama.json", (_q, r) => {
      r.json({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: cfg.glamaClaim });
    });
  }
  if (cfg.openaiAppsChallenge) {
    // ChatGPT's plugin portal wants the bare token as plain text, not JSON.
    app.get("/.well-known/openai-apps-challenge", (_q, r) => { r.type("text/plain").send(cfg.openaiAppsChallenge); });
  }
  // The GEO audit that used to live on this domain. Gone for good, so say so instead of a plain 404.
  for (const p of ["/geo-audit", "/aeo-audit", "/ai-visibility-audit", "/ai-visibility-checker", "/methodology", "/report/:id", "/fixpack/:id"]) {
    app.get(p, (_q, r) => { r.status(410).type("html").send(errorPage(cfg.baseUrl, "That page belonged to an earlier product and has been removed.")); });
  }

  const account = mountAccount(app, {
    db, google: cfg.google, baseUrl: cfg.baseUrl, fetch: overrides.fetch,
    session: (userId, o) => UserSession.load(deps, userId, o), billingLink: (kind, userId) => billing.link(kind, userId, "account"),
    adminUrl: cfg.adminUrl,
  });
  const feedback = mountFeedback(app, {
    db, google: cfg.google, baseUrl: cfg.baseUrl, fetch: overrides.fetch, mailFetch: overrides.mailFetch,
    mail: cfg.mail && { apiKey: cfg.mail.apiKey, from: cfg.mail.from, replyTo: cfg.mail.replyTo }, operator: cfg.feedbackTo ?? cfg.mail?.replyTo ?? "adam@camberstack.io",
  });

  // The consent page's answer (provider.authorize renders it). Same-origin form POST; the cookie the page set
  // is what proves this browser saw it, so a cross-site auto-submit or a forwarded link gets nowhere.
  app.post("/oauth/consent", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : undefined;
    try {
      const to = provider.consent(id, req.body?.decision === "approve", id ? readCookie(req, consentCookie(id)) : undefined);
      res.redirect(303, to);
    } catch (e) {
      res.status(400).type("html").send(errorPage(cfg.baseUrl, (e as Error).message));
    }
  });

  app.get("/oauth/google/callback", async (req, res) => {
    // One registered redirect URI serves every Google flow. Web sign-ins (/admin, /account) are told
    // apart by their state prefix and finish on their own path, where their session cookie is scoped.
    const site = [admin, account, feedback].find((s) => s?.owns(req.query.state));
    if (site) {
      res.redirect(302, `${site.callbackUrl}?${new URLSearchParams(req.query as Record<string, string>)}`);
      return;
    }
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    if (grants.owns(state)) {
      const added = await grants.finish(req, res, info).catch((e: Error) => void res.status(400).type("html").send(errorPage(cfg.baseUrl, e.message)));
      if (added) analytics.event(req, "grant_added", added);
      return;
    }
    try {
      const done = await provider.completeGoogleCallback({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      }, state ? readCookie(req, consentCookie(state)) : undefined);
      res.append("Set-Cookie", `${consentCookie(state!)}=; Path=/oauth/; Max-Age=0; SameSite=Lax${cfg.baseUrl.startsWith("https://") ? "; Secure" : ""}`);
      if (done.userId) {
        analytics.event(req, "connect");
        adConversions.record(req, res, done.userId, !!done.created);
      }
      res.redirect(302, done.to);
    } catch (e) {
      res.status(400).type("html").send(errorPage(cfg.baseUrl, (e as Error).message));
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // ChatGPT's plugin guidelines bar upgrade prompts and checkout links, so its connections get none. Known by the
  // redirect_uri it registered (chatgpt.com/connector/oauth/…): its client_name is whatever the user typed.
  const clientInfo = db.prepare("SELECT info FROM clients WHERE client_id = ?");
  const isChatGpt = (clientId: string | null) => {
    const row = clientId ? clientInfo.get(clientId) as { info: string } | undefined : undefined;
    const uris = row ? (JSON.parse(row.info) as { redirect_uris?: string[] }).redirect_uris ?? [] : [];
    return uris.some((u) => { try { return new URL(u).hostname === "chatgpt.com"; } catch { return false; } });
  };

  // A fresh server per request, bound to the caller the bearer middleware verified.
  const serverFor = (auth: AuthInfo | undefined) => {
    const userId = String(auth?.extra?.userId ?? "");
    const clientId = auth?.clientId ?? null;
    const chatgpt = isChatGpt(clientId);
    let session: UserSession | undefined;
    return buildServer(() => (session ??= UserSession.load(deps, userId, { chatgpt })), (c) => {
      logCall.run(now(), userId, clientId, c.tool, c.customerId, c.ok ? 1 : 0, c.error, c.ms, c.bytes, c.queryShape ?? null, c.service ?? null);
    }, [], { chatgpt, stuck: (tool, error) => (!userId || !stuckNow(db, userId, tool, error) ? null
      : error.startsWith(UNSUPPORTED_PREFIX)
        ? `Tell the user Camberstack can't do this yet, and that they can ask for it at ${cfg.baseUrl}/feedback: `
          + `the maintainer reads every request.`
        : `This is the same error a third time. If you can't get the user what they asked for, tell them they can report it `
          + `to Camberstack's maintainer at ${cfg.baseUrl}/feedback, saying what they were trying to get.`) });
  };
  // 2026-07-28 traffic (server/discover, per-request _meta envelope). The SDK's own legacy leg would
  // answer 2025-era requests over SSE, so it is off and those keep the JSON-response wiring below.
  // The OAuth server (mcpAuthRouter, requireBearerAuth) stays on SDK 1.x: v2 ships no authorization server.
  const modern = toNodeHandler(createMcpHandler((ctx) => serverFor(ctx.authInfo as AuthInfo | undefined), {
    legacy: "reject",
    onerror: (e) => console.warn(`mcp error: ${e.message}`),
  }));

  // CORS for browser-based MCP clients (the OAuth endpoints already get it from mcpAuthRouter). Every
  // call still needs a bearer token, so any origin is fine; no cookies are involved.
  app.use("/mcp", (req, res, next) => {
    if (req.path !== "/") { next(); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
    if (req.method !== "OPTIONS") { next(); return; }
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
  });

  // Stamped before bearer + body parsing, so a slow request's log line splits auth/upload time (pre) from handling.
  const noteToolList = db.prepare(`INSERT INTO client_tools (user_id, client_id, version, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, client_id) DO UPDATE SET version = excluded.version, fetched_at = excluded.fetched_at`);
  const stampStart = (_req: express.Request, res: express.Response, next: express.NextFunction) => { res.locals.t0 = Date.now(); next(); };
  app.post("/mcp", stampStart, bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const t0 = res.locals.t0 as number;
    const tHandler = Date.now();
    let leg = "?";
    // Diagnostics for rejected, slow (>= SLOW_MCP_MS) or client-aborted requests: JSON-RPC method, tool
    // name, protocol header and timings, never arguments or data.
    const diagnose = (outcome: string) => {
      const ms = Date.now() - t0;
      if (outcome === "finish" && res.statusCode < 400 && ms < SLOW_MCP_MS) return;
      type Msg = { method?: string; params?: { name?: unknown } };
      const label = (b: Msg | undefined) => b?.method === "tools/call" && typeof b.params?.name === "string" ? `tools/call:${b.params.name}` : b?.method;
      const body = req.body as Msg | Msg[] | undefined;
      const method = Array.isArray(body) ? `batch[${body.map(label).join(",")}]` : label(body);
      const status = outcome === "finish" ? String(res.statusCode) : "aborted";
      console.warn(`mcp ${status} ms=${ms} pre=${tHandler - t0} leg=${leg} method=${method ?? "?"} protocol=${req.get("mcp-protocol-version") ?? "-"} accept=${req.get("accept") ?? "-"} ua=${req.get("user-agent") ?? "-"}`);
    };
    res.on("finish", () => {
      diagnose("finish");
      // A served tools/list is the tool set this app now holds (client_tools in db.ts).
      const msgs = [req.body].flat() as { method?: string }[];
      if (res.statusCode === 200 && msgs.some((m) => m?.method === "tools/list") && req.auth?.clientId) {
        noteToolList.run(String(req.auth.extra?.userId ?? ""), req.auth.clientId, SERVER_VERSION, now());
      }
    });
    // subscriptions/listen is a long-lived SSE stream the client holds open and hangs up on by design
    // (Claude at ~295s, then reconnects), so its "abort" is the normal end, not a failure.
    res.on("close", () => { if (!res.writableFinished && (req.body as { method?: string } | undefined)?.method !== "subscriptions/listen") diagnose("close"); });
    try {
      leg = (await isLegacyRequest(await toWebRequest(req, req.body), req.body)) ? "legacy" : "modern";
      if (leg === "modern") return await modern(req, res, req.body);
      // 2025-era: stateless, one JSON body per request, as before v2.
      const server = serverFor(req.auth);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      reportError(e, "mcp");
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });
  const noSessions = (_req: express.Request, res: express.Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null });
  };
  app.get("/mcp", noSessions);
  app.delete("/mcp", noSessions);

  const tools = toolCatalog();
  // Each page rendered once per phase of FREE_ONE_SERVICE (plans.ts FreePlan: announced, then on), and the live phase's copy
  // served, so the pages flip with the gate at its date, no restart. Unset, there's one phase.
  const render = (): Record<string, string> => ({
    "/": homePage(cfg.baseUrl),
    "/google-ads-claude": claudeGuidePage(cfg.baseUrl),
    "/google-ads-chatgpt": chatgptGuidePage(cfg.baseUrl),
    "/google-search-console-mcp": searchConsolePage(cfg.baseUrl),
    "/docs": docsPage(cfg.baseUrl),
    "/tools": toolsPage(cfg.baseUrl, tools),
    "/changelog": changelogPage(cfg.baseUrl, CHANGELOG),
    "/about": aboutPage(cfg.baseUrl),
    "/privacy": privacyPage(cfg.baseUrl),
    "/terms": termsPage(cfg.baseUrl),
    "/google-ads-gemini": geminiGuidePage(cfg.baseUrl),
    // Not in the sitemap: the homepage #pricing is the page for search; this one is what ChatGPT connections link to.
    "/plans": plansPage(cfg.baseUrl),
    "/llms.txt": llmsTxt(cfg.baseUrl, tools),
  });
  const from = cfg.freeOneServiceFrom;
  const phases = new Map((from === undefined ? [freePlan(undefined)] : [freePlan(from, from - 1), freePlan(from, from)])
    .map((fp) => [fp.kind, withFreePlan(fp, render)]));
  const live = () => phases.get(freePlan(from).kind)!;
  const pages = live();
  const page = (path: string) => (req: express.Request, res: express.Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    adConversions.captureClick(req, res);  // keeps an ad click id; makes the response private if it does
    res.type("html").send(live()[path]!);
  };
  for (const path of Object.keys(pages)) if (path !== "/llms.txt" && path !== "/plans") app.get(path, page(path));
  for (const alias of ["/contact", "/contact-us", "/about-us"]) app.get(alias, (_q, r) => r.redirect(301, "/about"));
  // A personal link (session.ts plansPage) counts the view in the paywall funnel; the page is the same for everyone.
  app.get("/plans", (req, _res, next) => { const u = billing.verify("plans", req.query.t); if (u) billing.track(u, "plans_view"); next(); },
    page("/plans"));
  const indexed = Object.fromEntries(SITEMAP_PATHS.map((p) => [p, pages[p]!]));
  const { dates: lastmod, changed: changedPages } = pageDates(db, indexed, cfg.gitCommitDate);
  const inKey = indexNowKey(cfg.encryptionKey);
  app.get(`/${inKey}.txt`, (_q, r) => { r.type("text/plain").send(inKey); });
  app.get("/robots.txt", (_q, r) => { r.type("text/plain").send(cfg.noindex ? "User-agent: *\nDisallow: /\n" : robotsTxt(cfg.baseUrl)); });
  app.get("/llms.txt", (_q, r) => { r.type("text/plain").send(live()["/llms.txt"]!); });
  app.get("/sitemap.xml", (_q, r) => { r.type("application/xml").send(sitemapXml(cfg.baseUrl, lastmod)); });
  // Brand assets: the SVG is the source; the PNGs are rendered from it (brand/).
  const brand = (file: string, type: string) => (_q: express.Request, r: express.Response) => {
    r.setHeader("Cache-Control", "public, max-age=86400");
    r.type(type).sendFile(file, { root: BRAND_DIR });
  };
  app.get("/favicon.svg", brand("logo.svg", "image/svg+xml"));
  app.get("/favicon.png", brand("favicon-32.png", "image/png"));
  app.get("/favicon.ico", brand("favicon-32.png", "image/png"));
  app.get("/logo.png", brand("logo-wordmark-480.png", "image/png"));
  app.get("/adam-williams.webp", brand("adam-williams.webp", "image/webp"));
  // Self-hosted IBM Plex (OFL, brand/fonts/OFL.txt), so pages make no third-party font requests.
  app.get("/fonts/:file", (q, r, next) => {
    if (!/^[a-z0-9-]+\.woff2$/.test(q.params.file)) return next();
    brand(`fonts/${q.params.file}`, "font/woff2")(q, r);
  });
  // Setup-guide screenshots (brand/shots/): cropped, personal data painted out, WebP.
  app.get("/shots/:file", (q, r, next) => {
    if (!/^[a-z0-9-]+\.webp$/.test(q.params.file)) return next();
    brand(`shots/${q.params.file}`, "image/webp")(q, r);
  });
  billing.mount(app, info);
  grants.mount(app, info);
  lifecycle.mount(app, info);

  // Page-view beacon (analytics.ts): only browsers that run JS are counted, which keeps bots out.
  const beaconJs = BEACON_JS + (cfg.ga4MeasurementId ? gtagJs(cfg.ga4MeasurementId) : "");
  app.get("/e.js", (_q, r) => { r.setHeader("Cache-Control", "public, max-age=86400"); r.type("application/javascript").send(beaconJs); });

  app.post("/e", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const b = parseBeacon(req.body ?? {});
    if (b) analytics.pageview(req, b);
    res.status(204).end();
  });
  // Blue/green drain hook: deploy.sh touches DRAIN_FILE in the outgoing color, traefik's healthcheck sees 503
  // and stops routing new requests to it, while requests already in flight still finish. Then it is stopped.
  app.get("/healthz", (_q, r) => {
    if (existsSync(DRAIN_FILE)) { r.status(503).json({ ok: false, draining: true, sha: cfg.gitSha }); return; }
    r.json({ ok: true, version: SERVER_VERSION, sha: cfg.gitSha });
  });

  app.use((_req, res) => { res.status(404).type("html").send(errorPage(cfg.baseUrl, "Page not found.")); });
  // A route that threw: report it, then let express answer as before. A 4xx error is the client's (body-parser's 400
  // for a body that isn't JSON: coda-agent-runtime POSTs "not-json" to /register every few hours, 2026-10-23 →), not a bug.
  app.use((e: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const status = (e as { status?: unknown })?.status;
    if (!(typeof status === "number" && status >= 400 && status < 500)) reportError(e, "http");
    next(e);
  });

  const errorAlerts = new ErrorAlerts({ db, internalEmails, mail: cfg.mail, adminUrl: cfg.adminUrl,
    to: cfg.alertTo ?? cfg.feedbackTo ?? cfg.mail?.replyTo ?? "adam@camberstack.io", fetch: overrides.mailFetch });
  const every = (ms: number, name: string, job: () => unknown) => {
    const run = async () => { try { await job(); } catch (e) { console.error(`${name}: ${(e as Error).message}`); reportError(e, name); } };
    setInterval(run, ms).unref();
    return run;
  };
  const startJobs = () => {
    every(10 * 60_000, "db sweep", () => sweep(db));
    void every(HOUR, "billing sweep", () => billing.sweep())();  // also at boot: a restart mustn't delay a downgrade an hour
    every(HOUR, "lifecycle", () => lifecycle.run());
    every(60_000, "transactional mail", () => lifecycle.transactional());
    every(15 * 60_000, "error alerts", () => errorAlerts.run());
    every(HOUR, "ad conversions", () => adConversions.flush());
    every(HOUR, "retention", () => retain({ db, encryptionKey: cfg.encryptionKey, internalEmails }));
    // Pages new or changed since the last boot. Production only: a dev or test origin isn't ours to submit.
    if (cfg.baseUrl.startsWith("https://") && !cfg.noindex) {
      pingIndexNow(cfg.baseUrl, inKey, changedPages, overrides.indexNowFetch)
        .then(() => changedPages.length && console.log(`IndexNow: submitted ${changedPages.join(" ")}`))
        .catch((e) => console.error(`IndexNow: ${(e as Error).message}`));
    }
  };
  return { app, billing, startJobs, grants, deps };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  teeToFile(process.env.LOG_FILE);
  const cfg = loadConfig();
  initErrorReporting(cfg.gitSha);
  const { app, startJobs } = createApp(cfg, openDb(cfg.dataDir));
  startJobs();
  app.listen(cfg.port, () => console.log(`camberstack-mcp ${SERVER_VERSION} on :${cfg.port} (${cfg.baseUrl})`));
}
