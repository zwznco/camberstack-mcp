/**
 * How long an inactive user's data is kept (privacy policy, "What we store"). Inactive = no tool call or new connection
 * from an AI app, by last_seen_at, else created_at.
 *   GRANT_DAYS    the stored Google refresh token is revoked and deleted. Google itself invalidates a refresh token unused
 *                 for six months, so by then it is dead weight; until now one was only dropped when the user's next call
 *                 failed (session.ts). The account and change history stay, and connecting again works as before.
 *   ACCOUNT_DAYS  the account and everything keyed to it are deleted. Paying users and internal accounts (ADMIN_EMAILS,
 *                 PRO_EMAILS) are never deleted this way. Feedback stays, without the user link (it carries the sender's
 *                 own email, to reply to).
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { decrypt } from "./crypto.js";
import { revokeGoogleToken } from "./google.js";
import { clearGoogleCache } from "./session.js";

export const GRANT_DAYS = 182;
export const ACCOUNT_DAYS = 730;

export interface RetentionDeps {
  db: DB;
  encryptionKey: Buffer;
  internalEmails: Set<string>;
  /** Revokes at Google; tests pass a fake. */
  revoke?: (token: string) => Promise<void>;
}

const idle = "coalesce(last_seen_at, created_at) < ?";

export async function retain(d: RetentionDeps, t = now()): Promise<{ grants: number; accounts: number }> {
  const revoke = d.revoke ?? revokeGoogleToken;
  const stale = d.db.prepare(`SELECT id, enc_refresh FROM users WHERE enc_refresh IS NOT NULL AND ${idle}`)
    .all(t - GRANT_DAYS * 86400) as { id: string; enc_refresh: string }[];
  for (const u of stale) {
    // Best effort: Google has most likely invalidated it already, and the token is deleted either way.
    await revoke(decrypt(d.encryptionKey, u.enc_refresh)).catch(() => {});
    d.db.prepare("UPDATE users SET enc_refresh = NULL WHERE id = ?").run(u.id);
    d.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(u.id);
    clearGoogleCache(u.id);
  }

  const internal = [...d.internalEmails].map((e) => e.toLowerCase());
  const gone = (d.db.prepare(`SELECT id, email FROM users WHERE ${idle}
      AND NOT (plan IN ('plus', 'pro', 'agency') AND coalesce(stripe_sub, '') != '')`).all(t - ACCOUNT_DAYS * 86400) as { id: string; email: string }[])
    .filter((u) => !internal.includes(u.email.toLowerCase()));
  const del = d.db.transaction((id: string) => {
    // Kept per Merchant Center account, not per user: read these before tool_calls goes, and leave what someone else still uses.
    const mine = d.db.prepare(`SELECT DISTINCT substr(customer_id, 4) account FROM tool_calls WHERE user_id = ? AND customer_id LIKE 'mc:%'
      AND customer_id NOT IN (SELECT customer_id FROM tool_calls WHERE user_id != ? AND customer_id IS NOT NULL)`).all(id, id) as { account: string }[];
    for (const account of [...mine.map((m) => m.account), `demo:${id}`]) d.db.prepare("DELETE FROM merchant_overrides WHERE account_id = ?").run(account);
    for (const table of ["tokens", "auth_codes", "proposals", "tool_calls", "client_tools", "email_log", "ad_conversions", "plan_events", "demo_state", "demo_ga_state"]) {
      d.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
    }
    d.db.prepare("DELETE FROM web_sessions WHERE subject = ?").run(id);
    d.db.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").run(id);
    d.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  for (const u of gone) { del(u.id); clearGoogleCache(u.id); }

  if (stale.length || gone.length) console.log(`retention: ${stale.length} idle Google grants deleted, ${gone.length} idle accounts deleted`);
  return { grants: stale.length, accounts: gone.length };
}
