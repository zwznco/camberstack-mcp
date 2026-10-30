/**
 * Stuck-user alerts: mail the operator when a tool error looks like it left someone without what they asked for.
 * Most errors don't: the model reads the message and the next call works, seconds later. So an error only counts
 * once RECOVERY has passed with no successful call of the same tool, and it's mailed when
 *   - the user pays (one is enough: they're who churn costs), or
 *   - anyone hits the same error MIN_REPEATS times without a success in between (a wall, not a typo).
 * Each email says whether it's worth acting on (verdict). Bugs (TypeErrors, Google 5xx) also reach Bugsink, which
 * mails them on its own; this is about the errors our code wrote on purpose and the user still couldn't get past.
 * Internal accounts (ADMIN_EMAILS, PRO_EMAILS) are left out. Read-only over tool_calls. error_alerts keeps the last error
 * each user + tool + error was mailed for, so only errors after it count again: a wall someone keeps hitting is re-mailed
 * once it meets the rule again, never the same errors twice.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { esc } from "./pages.js";
import { isPaid, PLAN_LIMIT_PREFIX } from "./plans.js";

/**
 * Starts our refusals of something Camberstack doesn't do (yet). No retry gets past one, so the model never repeats it
 * MIN_REPEATS times: it gets the feedback link and the operator a mail on the first, whatever the plan.
 */
export const UNSUPPORTED_PREFIX = "Not supported:";
export const unsupported = (message: string) => new Error(`${UNSUPPORTED_PREFIX} ${message}`);

/** How long a later success of the same tool has to turn up before the error counts as unrecovered. */
const RECOVERY = 10 * 60;
/** Unrecovered errors with the same key that make a free user's episode worth a mail. */
const MIN_REPEATS = 3;
/** How far back each run looks. */
const LOOKBACK = 86400;

interface AlertDeps {
  db: DB;
  internalEmails: Set<string>;
  /** Resend, as in config.ts; unset (dev, tests without it) = logged only. */
  mail?: { apiKey: string; from: string };
  to: string;
  adminUrl?: string;
  fetch?: typeof fetch;
  clock?: () => number;
}

interface Call { id: number; at: number; tool: string; customer_id: string | null; ok: number; error: string | null; query_shape: string | null }
interface Episode {
  key: string;
  userId: string; email: string; plan: string; app: string | null;
  tool: string; code: string;
  errors: Call[];
  /** The user's calls after the last error (up to 8, within 30 minutes): what the model did next. */
  after: Call[];
  verdict: { act: boolean; why: string };
}

/** run_gaql stays itself; the propose_* tools (old per-change ones included) recover through any proposal. */
const family = (tool: string) => (tool.startsWith("propose_") ? "propose_*" : tool);

/** Google's error code when there is one ("Google Ads API 400: UNRECOGNIZED_FIELD …"), else our own message's start. */
export function errorCode(error: string): string {
  const g = /API (\d{3}): ([A-Z][A-Z_]+)/.exec(error);
  if (g) return `${g[2]}`;
  const s = /API (\d{3})/.exec(error);
  if (s) return `HTTP_${s[1]}`;
  return error.split(/[.:\n]/)[0].replace(/\d+/g, "#").trim().slice(0, 60);
}

/** Google refusing this account or this change, whatever the query: the user has to act in Google Ads. */
const ACCOUNT_REFUSALS = /EU_POLITICAL_ADVERTISING|POLICY_FINDING|IMMUTABLE_FIELD|USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED|NOT_ADS_USER|AUTHORIZATION_ERROR|DEVELOPER_TOKEN|ACCOUNT_SUSPENDED|CUSTOMER_NOT_FOUND/;

/** Whether it's worth acting on, and what to do. Rules, not judgment: the email carries the trace to check it. */
export function verdict(code: string, error: string, recoveredLater: boolean): { act: boolean; why: string } {
  if (recoveredLater && !error.startsWith(UNSUPPORTED_PREFIX)) return { act: false, why: "Recovered later (a success of this tool after the alert window). Nothing to do." };
  if (error.startsWith(UNSUPPORTED_PREFIX))
    return { act: true, why: "Camberstack doesn't do this, and the user wanted it. Consider building it; email them when it ships." };
  if (/^HTTP_5\d\d$/.test(code)) return { act: false, why: "Google was down (5xx). Transient; act only if it keeps happening (Bugsink tracks these)." };
  if (error.startsWith(PLAN_LIMIT_PREFIX)) return { act: true, why: "Plan limit: working as designed, but they wanted more. An upgrade nudge may land." };
  if (/access isn't part of this Google connection|needs its edit access/.test(error))
    return { act: true, why: "Missing Google grant. The message carries the grant link; if they never clicked it, email them the link." };
  if (code === "METRIC_ACCESS_DENIED") return { act: false, why: "Data Google doesn't give Camberstack (auction insights). Nothing we can fix." };
  if (ACCOUNT_REFUSALS.test(code)) return { act: true, why: "Google refuses this for their account; the user must fix it in Google Ads. Check our message says how, and consider emailing them." };
  if (/^[A-Z_]+$/.test(code)) return { act: true, why: "The model kept writing a request Google rejects. Check the error tells it the fix (src/gaql.ts catalog, or the hint in google.ts)." };
  if (/^(TypeError|ReferenceError|SqliteError|RangeError)|Cannot read propert|is not a function|fetch failed/.test(error))
    return { act: true, why: "Looks like our bug. Check Bugsink (errors.zwznco.com) for the stack." };
  return { act: true, why: "Our own message, and the model didn't get past it. Check it says what to do next." };
}

/**
 * Whether the error a call is about to return makes MIN_REPEATS in a row: the same tool and error code, with no success of
 * that tool since. Only the call that reaches it, so one episode shows the feedback link once. Errors that carry their own
 * way forward (a plan limit, a grant link) or that no one can fix (Google down, verdict() FYI) never count. Asked after
 * the call is logged, so the error being returned is the latest row.
 */
export function stuckNow(db: DB, userId: string, tool: string, error: string, t = now()): boolean {
  if (error.startsWith(UNSUPPORTED_PREFIX)) return true;
  const code = errorCode(error);
  if (error.startsWith(PLAN_LIMIT_PREFIX) || /access isn't part of this Google connection|needs its edit access/.test(error)) return false;
  if (!verdict(code, error, false).act) return false;
  const fam = family(tool);
  const calls = db.prepare("SELECT tool, ok, error FROM tool_calls WHERE user_id = ? AND at >= ? ORDER BY id DESC").all(userId, t - RECOVERY) as Call[];
  let same = 0;
  for (const c of calls.filter((c) => family(c.tool) === fam)) {
    if (c.ok || errorCode(c.error ?? "") !== code) break;
    same++;
  }
  return same === MIN_REPEATS;
}

/** Unrecovered episodes in the last LOOKBACK, alert-worthy by the rules above. `mailed` maps an episode key to the last
 *  error already mailed for it; errors up to that one are left out. */
export function findStuck(db: DB, internalEmails: Set<string>, t = now(), mailed = new Map<string, number>()): Episode[] {
  const errs = db.prepare(`SELECT c.id, c.at, c.user_id, c.tool, c.customer_id, c.ok, c.error, c.query_shape, u.email, u.plan,
      (SELECT json_extract(cl.info, '$.client_name') FROM clients cl WHERE cl.client_id = c.client_id) app
    FROM tool_calls c JOIN users u ON u.id = c.user_id
    WHERE c.ok = 0 AND c.at > ? AND c.at <= ? ORDER BY c.at`).all(t - LOOKBACK, t - RECOVERY) as (Call & { user_id: string; email: string; plan: string; app: string | null })[];
  const later = db.prepare("SELECT id, at, tool, customer_id, ok, error, query_shape FROM tool_calls WHERE user_id = ? AND at >= ? ORDER BY at, id");
  const byUser = new Map<string, Call[]>();
  const callsOf = (u: string) => byUser.get(u) ?? (byUser.set(u, later.all(u, t - LOOKBACK) as Call[]), byUser.get(u)!);

  const groups = new Map<string, Episode>();
  for (const e of errs) {
    if (internalEmails.has(e.email.toLowerCase())) continue;
    const fam = family(e.tool);
    const calls = callsOf(e.user_id);
    // Recovered: the same tool worked for this user within RECOVERY. Then this error isn't part of any episode.
    // Not for an unsupported refusal: another proposal working later doesn't get them the thing we refused.
    if (!e.error?.startsWith(UNSUPPORTED_PREFIX) && calls.some((c) => c.ok && family(c.tool) === fam && c.at >= e.at && c.at <= e.at + RECOVERY && c.id > e.id)) continue;
    const code = errorCode(e.error ?? "");
    const key = `${e.user_id}|${fam}|${code}`;
    if (e.id <= (mailed.get(key) ?? 0)) continue;
    const g = groups.get(key) ?? { key, userId: e.user_id, email: e.email, plan: e.plan, app: e.app, tool: fam, code, errors: [], after: [], verdict: { act: false, why: "" } };
    g.errors.push(e);
    groups.set(key, g);
  }

  const out: Episode[] = [];
  for (const g of groups.values()) {
    if (!(isPaid(g.plan) || g.errors.length >= MIN_REPEATS || g.code === UNSUPPORTED_PREFIX.slice(0, -1))) continue;
    const last = g.errors[g.errors.length - 1];
    const calls = callsOf(g.userId);
    g.after = calls.filter((c) => c.id > last.id && c.at <= last.at + 1800).slice(0, 8);
    const recoveredLater = calls.some((c) => c.ok && family(c.tool) === g.tool && c.id > last.id);
    g.verdict = verdict(g.code, last.error ?? "", recoveredLater);
    out.push(g);
  }
  return out;
}

const when = (at: number) => new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const line = (c: Call) => `${when(c.at)}  ${c.tool}${c.customer_id ? ` [${c.customer_id}]` : ""}  ${c.ok ? "ok" : "ERROR"}${c.query_shape ? `  ${c.query_shape.slice(0, 160)}` : ""}`;

function render(eps: Episode[], adminUrl?: string): { subject: string; text: string; html: string } {
  const act = eps.filter((e) => e.verdict.act);
  const paid = eps.filter((e) => isPaid(e.plan));
  const subject = `Camberstack: ${eps.length === 1 ? `${eps[0].email} stuck on ${eps[0].tool}` : `${eps.length} users stuck`}`
    + `${paid.length ? " (paying)" : ""}${act.length ? "" : " — FYI, nothing to act on"}`;
  const block = (e: Episode) => {
    const head = `${e.verdict.act ? "ACT" : "FYI"}: ${e.email} (${e.plan}${e.app ? `, ${e.app}` : ""}) — ${e.tool} ${e.code}, ${e.errors.length}× unrecovered`;
    const err = (e.errors[e.errors.length - 1].error ?? "").slice(0, 700);
    const user = adminUrl ? `${adminUrl}/users/${e.userId}` : "";
    return { head, why: e.verdict.why, err, errors: e.errors.map(line), after: e.after.length ? e.after.map(line) : ["(no calls in the 30 minutes after)"], user };
  };
  const bs = [...eps].sort((a, b) => Number(b.verdict.act) - Number(a.verdict.act) || Number(isPaid(b.plan)) - Number(isPaid(a.plan))).map(block);
  const text = bs.map((b) => [b.head, b.why, "", "Last error:", b.err, "", "Errors:", ...b.errors, "", "Next calls:", ...b.after, b.user].join("\n")).join("\n\n────────\n\n");
  const pre = (s: string[]) => `<pre style="font-size:12px;white-space:pre-wrap">${esc(s.join("\n"))}</pre>`;
  const html = bs.map((b) => `<h3 style="margin:0">${esc(b.head)}</h3><p><strong>${esc(b.why)}</strong></p>`
    + `<p style="color:#555">Last error:</p>${pre([b.err])}<p style="color:#555">Errors:</p>${pre(b.errors)}`
    + `<p style="color:#555">Next calls:</p>${pre(b.after)}${b.user ? `<p><a href="${esc(b.user)}">User on the admin site</a></p>` : ""}`).join("<hr>");
  return { subject, text, html };
}

export class ErrorAlerts {
  constructor(private d: AlertDeps) {}

  /** One run: find stuck episodes with errors not mailed yet, claim them, mail them as one digest. */
  async run(): Promise<Episode[]> {
    const t = (this.d.clock ?? now)();
    const db = this.d.db;
    db.prepare("DELETE FROM error_alerts WHERE at < ?").run(t - 30 * 86400);
    const mailed = new Map((db.prepare("SELECT k, last_id FROM error_alerts").all() as { k: string; last_id: number }[]).map((r) => [r.k, r.last_id]));
    const claim = db.prepare(`INSERT INTO error_alerts (k, last_id, at) VALUES (?, ?, ?)
      ON CONFLICT(k) DO UPDATE SET last_id = excluded.last_id, at = excluded.at WHERE error_alerts.last_id < excluded.last_id`);
    // Claimed before sending, atomically, so both blue/green colors during a cutover can't mail the same one twice.
    const prev = new Map<string, number | undefined>();
    const fresh = findStuck(db, this.d.internalEmails, t, mailed).filter((e) => {
      prev.set(e.key, mailed.get(e.key));
      return claim.run(e.key, e.errors[e.errors.length - 1].id, t).changes === 1;
    });
    if (!fresh.length) return fresh;
    const m = render(fresh, this.d.adminUrl);
    if (!this.d.mail) { console.log(`error alert (mail off): ${m.subject}`); return fresh; }
    const res = await (this.d.fetch ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.d.mail.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.d.mail.from, to: [this.d.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Unclaim, so the next run tries again.
      for (const e of fresh) {
        const p = prev.get(e.key);
        if (p === undefined) db.prepare("DELETE FROM error_alerts WHERE k = ?").run(e.key);
        else db.prepare("UPDATE error_alerts SET last_id = ? WHERE k = ?").run(p, e.key);
      }
      throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return fresh;
  }
}
