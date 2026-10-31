import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  enc_refresh   TEXT,            -- AES-GCM(Google refresh token); NULL once disconnected
  plan          TEXT NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- MCP clients registered through dynamic client registration (RFC 7591).
CREATE TABLE IF NOT EXISTS clients (
  client_id   TEXT PRIMARY KEY,
  info        TEXT NOT NULL,     -- OAuthClientInformationFull as JSON
  created_at  INTEGER NOT NULL
);

-- When each user's AI app last fetched the tool list, and the SERVER_VERSION live then: clients keep the
-- list they fetched (ChatGPT until the user refreshes the connector), so this is the tool set they have.
-- Per user and client, since one OAuth client can serve many users.
CREATE TABLE IF NOT EXISTS client_tools (
  user_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  version     TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);

-- An MCP client's /authorize request, parked while the user is at Google.
CREATE TABLE IF NOT EXISTS pending_auth (
  id          TEXT PRIMARY KEY,  -- also the Google 'state'
  client_id   TEXT NOT NULL,
  params      TEXT NOT NULL,     -- redirectUri, codeChallenge, state, scopes, resource
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  scopes         TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  resource    TEXT,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);

-- A set of changes the AI proposed. Nothing touches the account until apply.
CREATE TABLE IF NOT EXISTS proposals (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  customer_id        TEXT NOT NULL,
  login_customer_id  TEXT,
  changes            TEXT NOT NULL,   -- Change[] as JSON
  summary            TEXT NOT NULL,   -- human-readable diff shown before approval
  status             TEXT NOT NULL CHECK (status IN ('proposed','applied','failed','discarded')),
  result             TEXT,            -- per-change outcome + inverse ops (for undo)
  undo_of            TEXT,            -- proposal this one reverses
  created_at         INTEGER NOT NULL,
  applied_at         INTEGER
);
CREATE INDEX IF NOT EXISTS proposals_user ON proposals(user_id, created_at);

-- One row per MCP tool call: usage + failures. Metadata only, never arguments or Ads data
-- (the privacy page promises the Google data goes nowhere else).
CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  client_id    TEXT,            -- which registered MCP client (clients.info has its client_name)
  tool         TEXT NOT NULL,
  customer_id  TEXT,
  ok           INTEGER NOT NULL,
  error        TEXT,            -- first 1000 chars of the message shown to the AI (300 before 2026-10-15)
  ms           INTEGER NOT NULL,
  bytes        INTEGER NOT NULL, -- size of the result text
  query_shape  TEXT,             -- run_gaql only: the query with every value replaced by ? (gaql.ts queryShape)
  service      TEXT              -- Google services a real (non-demo) call used, comma-joined (tools.ts servicesOf); plan gate for Option C
);
CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls(at);

-- Browser sign-ins to our own pages (signin.ts): kind = the page's state prefix, subject = an email
-- (/admin) or a user id (/account). Tokens stored as hashes.
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
DROP TABLE IF EXISTS admin_sessions;  -- replaced by web_sessions 2026-10-01

-- Our own ad campaign's conversions (adconversions.ts): one per user, on their first connection.
CREATE TABLE IF NOT EXISTS ad_conversions (
  user_id      TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('gclid','gbraid','wbraid')),
  click_id     TEXT NOT NULL,
  at           INTEGER NOT NULL,
  uploaded_at  INTEGER,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);

-- Lifecycle emails (lifecycle.ts): one row per user per kind, so each is sent at most once.
CREATE TABLE IF NOT EXISTS email_log (
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- The paywall funnel past the stop itself (billing.ts track; PRICING-TEST.md): a click on a personal upgrade link
-- (src = where the link was handed out), a view of /plans through a personal link, a paid checkout. The stops are
-- tool_calls rows already (error 'Service limit:' etc.), and the emails are email_log.
CREATE TABLE IF NOT EXISTS plan_events (
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('upgrade_click','plans_view','paid')),
  src      TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_events_user ON plan_events (user_id, kind);

-- Announcement presets (announce.ts) the operator has sent from the admin: each goes out once. Who got one is in
-- email_log, kind 'announce:<id>'. started_at also fixes who's eligible (users who'd signed up by then).
CREATE TABLE IF NOT EXISTS announcement_sends (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
DROP TABLE IF EXISTS announcements;  -- the admin compose box (2709633, never used: 0 rows), replaced by presets 2026-10-14

-- Each user's copy of the demo account (demo.ts): only what their changes altered, as JSON.
CREATE TABLE IF NOT EXISTS demo_state (
  user_id     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The same for the demo Google Analytics property (ga4.ts DemoAnalytics): its key events and Google Ads links.
CREATE TABLE IF NOT EXISTS demo_ga_state (
  user_id     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- What Camberstack's supplemental Merchant Center source holds per product (merchant.ts OverrideStore): Google applies
-- overrides but can't return them, and undo restores exactly these. Keyed by account; demo:<user id> for the demo's.
CREATE TABLE IF NOT EXISTS merchant_overrides (
  account_id  TEXT NOT NULL,
  product     TEXT NOT NULL,
  attrs       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, product)
);

-- Public pages' content hashes, so the sitemap's lastmod moves only when a page really changes (lastmod.ts).
CREATE TABLE IF NOT EXISTS page_versions (
  path     TEXT PRIMARY KEY,
  hash     TEXT NOT NULL,
  changed  TEXT NOT NULL      -- YYYY-MM-DD
);

-- Messages from /feedback (feedback.ts). email is the sender's verified Google address; user_id is set
-- when that address has connected Camberstack.
CREATE TABLE IF NOT EXISTS feedback (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  email    TEXT NOT NULL,
  user_id  TEXT,
  kind     TEXT NOT NULL,     -- bug | idea | other
  message  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_email_at ON feedback (email, at);

-- Stuck-user alerts already mailed (alerts.ts): per user + tool + error, the last tool_calls.id mailed, so no error is mailed twice.
CREATE TABLE IF NOT EXISTS error_alerts (
  k        TEXT PRIMARY KEY,      -- user_id|tool family|error key
  last_id  INTEGER NOT NULL,      -- tool_calls.id
  at       INTEGER NOT NULL       -- when it was mailed (rows go after 30 days)
);
`;

export function openDb(dataDir: string): DB {
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, "camberstack.sqlite");
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Columns added after launch; CREATE TABLE IF NOT EXISTS won't add them to an existing table.
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("stripe_customer")) db.exec("ALTER TABLE users ADD COLUMN stripe_customer TEXT");
  if (!cols.has("stripe_sub")) db.exec("ALTER TABLE users ADD COLUMN stripe_sub TEXT");
  if (!cols.has("email_opt_out")) db.exec("ALTER TABLE users ADD COLUMN email_opt_out INTEGER NOT NULL DEFAULT 0");
  // IANA zone of the Google Ads account they use (session.ts); lifecycle.ts sends in their morning.
  if (!cols.has("time_zone")) db.exec("ALTER TABLE users ADD COLUMN time_zone TEXT");
  // Google scopes on their token as Google last reported them (sign-in, /connect, every refresh); NULL = not seen yet.
  if (!cols.has("google_scopes")) db.exec("ALTER TABLE users ADD COLUMN google_scopes TEXT");
  // Operator courtesy reset of plan accounts (session.ts usage): calls before it don't count. NULL = never reset.
  if (!cols.has("plan_reset_at")) db.exec("ALTER TABLE users ADD COLUMN plan_reset_at INTEGER");
  // What their Google login can reach, as of its last fresh account list (session.ts accounts(), 2026-10-22): ad accounts
  // (not managers, not the demo) and manager accounts. NULL = not listed since this was added.
  for (const c of ["ads_accounts", "ads_managers", "ads_accounts_at"]) if (!cols.has(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} INTEGER`);
  // Which manager accounts, as a JSON array of IDs (2026-10-22): logins under one manager are how Free could be multiplied (report.ts sharing).
  if (!cols.has("ads_manager_ids")) db.exec("ALTER TABLE users ADD COLUMN ads_manager_ids TEXT");
  // How many of those ad accounts spent in the last 30 days, and when that was read (session.ts spendActivity, 2026-10-26):
  // only a count, read while the user lists or picks accounts. NULL = never fully read.
  for (const c of ["ads_active", "ads_active_at"]) if (!cols.has(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} INTEGER`);
  // The registered MCP client the account was created through (provider.ts, 2026-10-23): names the app for a connect the
  // app never finished (a Codex sign-in that never swapped its code for a token left no call or token to name it).
  if (!cols.has("signup_client_id")) db.exec("ALTER TABLE users ADD COLUMN signup_client_id TEXT");
  // First-touch utm source (2026-10-16 → 10-22) tagged 2 of 34 users; the AI app a user connected from (report.ts) replaced it.
  for (const c of ["src_source", "src_campaign", "src_content", "src_click"]) if (cols.has(c)) db.exec(`ALTER TABLE users DROP COLUMN ${c}`);
  // run_gaql's query shape (2026-10-15): which fields custom queries ask for, never the values in them.
  const tc = new Set((db.prepare("PRAGMA table_info(tool_calls)").all() as { name: string }[]).map((c) => c.name));
  if (!tc.has("query_shape")) db.exec("ALTER TABLE tool_calls ADD COLUMN query_shape TEXT");
  // Which Google service each call used (2026-10-28), for the one-service Free plan behind FREE_ONE_SERVICE.
  if (!tc.has("service")) db.exec("ALTER TABLE tool_calls ADD COLUMN service TEXT");
  // Which services a call stopped by a notice was after (2026-10-31): `service` stays null there, or a stop would count as use.
  if (!tc.has("service_wanted")) db.exec("ALTER TABLE tool_calls ADD COLUMN service_wanted TEXT");
  // The admin's email on an /account session opened through "Log in as user" (account.ts); NULL = the user's own.
  const ws = new Set((db.prepare("PRAGMA table_info(web_sessions)").all() as { name: string }[]).map((c) => c.name));
  if (!ws.has("impersonator")) db.exec("ALTER TABLE web_sessions ADD COLUMN impersonator TEXT");
  // The conversion and keyword relays moved to ~/operations (2026-10-16): their tables go.
  db.exec("DROP TABLE IF EXISTS relay_conversions; DROP TABLE IF EXISTS relay_keys");
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  enc_refresh: string | null;
  plan: string;
  created_at: number;
  last_seen_at: number | null;
  stripe_customer?: string | null;
  stripe_sub?: string | null;
  time_zone?: string | null;
  /** Calls before this don't count toward plan accounts (session.ts usage); set by hand as a courtesy reset. */
  plan_reset_at?: number | null;
  google_scopes?: string | null;
}

export interface ProposalRow {
  id: string;
  user_id: string;
  customer_id: string;
  login_customer_id: string | null;
  changes: string;
  summary: string;
  status: "proposed" | "applied" | "failed" | "discarded";
  result: string | null;
  undo_of: string | null;
  created_at: number;
  applied_at: number | null;
}

/** Drop expired rows. Cheap; run on an interval. */
export function sweep(db: DB): void {
  const t = now();
  db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM pending_auth WHERE created_at < ?").run(t - 3600);
  db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(t);
}
