/**
 * Results-ready notes: when a user comes back, list_accounts and account_overview say which applied changes have results
 * waiting (change_results), once per proposal. Users came back after 76% of applied proposals but checked change history
 * after only 16% (prod, 834 proposals applied 7-60 days before 2026-11-12): they return to do the next thing, and nothing
 * told them a result was there.
 *
 * Local only: readiness comes from the proposals table (results.ts measurable), never a Google call, so the note costs
 * nothing on every list_accounts. The numbers come from change_results when the AI calls it.
 *
 * result_notes holds one row per proposal pointed out or shown, so none is raised twice: `via` is the tool that raised it
 * (list_accounts, account_overview), or change_results when the user reached it without a note. The admin's Results card
 * (notesFunnel) reads whether a note was followed: change_results on that account within FOLLOW_SECS.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { MIN_DAYS, measurable } from "./results.js";

/** Older applied changes aren't raised: the backlog at launch would bury the latest under changes from months ago. */
export const NOTE_MAX_AGE_DAYS = 60;
/** A note counts as followed when change_results runs on that account this soon after it. */
export const FOLLOW_SECS = 3600;
/** How many summaries a note names; the rest are a count. */
const NAMED = 3;

export type NoteVia = "list_accounts" | "account_overview" | "change_results";

export interface ReadyProposal { proposal_id: string; customer_id: string; summary: string; applied_at: number }

/**
 * Applied Google Ads changes with results ready (MIN_DAYS after the apply day, as change_history counts) that no note or
 * change_results has raised yet, newest first. Undone proposals, undos and the demo are left out.
 */
export function resultsReady(db: DB, userId: string, customerIds?: string[], t = now()): ReadyProposal[] {
  if (customerIds && !customerIds.length) return [];
  const rows = db.prepare(`SELECT p.id, p.customer_id, p.summary, p.applied_at, p.changes, p.result FROM proposals p
      WHERE p.user_id = ? AND p.status = 'applied' AND p.undo_of IS NULL AND p.customer_id != ?
        AND p.applied_at BETWEEN ? AND ?
        ${customerIds ? `AND p.customer_id IN (${customerIds.map(() => "?").join(",")})` : ""}
        AND NOT EXISTS (SELECT 1 FROM proposals u WHERE u.undo_of = p.id AND u.status = 'applied')
        AND NOT EXISTS (SELECT 1 FROM result_notes n WHERE n.proposal_id = p.id)
      ORDER BY p.applied_at DESC`)
    .all(userId, DEMO_CID, t - NOTE_MAX_AGE_DAYS * 86400, t - (MIN_DAYS + 1) * 86400, ...(customerIds ?? [])) as
    { id: string; customer_id: string; summary: string; applied_at: number; changes: string; result: string | null }[];
  return rows.filter((r) => { try { return measurable(r.changes, r.result); } catch { return false; } })
    .map((r) => ({ proposal_id: r.id, customer_id: r.customer_id, summary: r.summary.split("\n")[0]!, applied_at: r.applied_at }));
}

/** Record proposals as raised, so they aren't raised again. The first record wins: a later change_results keeps the note's `via`. */
export function markNoted(db: DB, userId: string, rows: { proposal_id: string; customer_id: string }[], via: NoteVia, t = now()): void {
  const ins = db.prepare("INSERT OR IGNORE INTO result_notes (proposal_id, user_id, customer_id, via, noted_at) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => { for (const r of rows) ins.run(r.proposal_id, userId, r.customer_id, via, t); })();
}

/** The note itself, grouped by account: what list_accounts and account_overview add to their result. */
export function noteFor(ready: ReadyProposal[], tool: (name: string) => string = (n) => n) {
  const by = new Map<string, ReadyProposal[]>();
  for (const r of ready) by.set(r.customer_id, [...(by.get(r.customer_id) ?? []), r]);
  return {
    results_ready: [...by].map(([customer_id, ps]) => ({
      customer_id, changes_with_results: ps.length,
      latest: ps.slice(0, NAMED).map((p) => ({ applied_on: new Date(p.applied_at * 1000).toISOString().slice(0, 10), change: p.summary })),
    })),
    results_ready_note: `Before/after results are ready for changes the user applied through Camberstack. Tell the user in one line, `
      + `and offer to show them: ${tool("change_results")} with the customer_id gives the figures. Mentioned once; it won't be repeated.`,
  };
}

/** Raise what's ready on these accounts, once, and say so in the tool's result. Empty when there's nothing new. */
export function takeNote(db: DB, userId: string, customerIds: string[] | undefined, via: NoteVia, tool?: (name: string) => string) {
  const ready = resultsReady(db, userId, customerIds);
  if (!ready.length) return {};
  markNoted(db, userId, ready, via);
  return noteFor(ready, tool);
}

/**
 * Whether notes work, for the admin: each note (one tool call raising results on one account), and whether change_results
 * then ran on that account within FOLLOW_SECS. `users` excludes the operator's accounts via the caller's {U}.
 */
export function notesFunnel(q: <T>(sql: string, ...p: unknown[]) => T[], since: number) {
  return q<{ via: string; notes: number; users: number; changes: number; followed: number }>(
    `SELECT n.via, count(*) notes, count(DISTINCT n.user_id) users, sum(n.k) changes,
       sum(EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = n.user_id AND c.customer_id = n.customer_id AND c.tool = 'change_results'
         AND c.ok = 1 AND c.at BETWEEN n.noted_at AND n.noted_at + ${FOLLOW_SECS})) followed
     FROM (SELECT r.user_id, r.customer_id, r.via, r.noted_at, count(*) k FROM result_notes r JOIN {U} u ON u.id = r.user_id
           WHERE r.noted_at >= ? GROUP BY 1, 2, 3, 4) n
     GROUP BY n.via ORDER BY n.via = 'change_results', notes DESC, n.via`, since);
}
