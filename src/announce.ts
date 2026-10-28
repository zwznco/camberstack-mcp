/**
 * Announcements: preset emails, written here and reviewed in a commit, each sent ONCE, when the operator clicks
 * Send on its page in the admin (admin.ts → Announcements → the preset's card). Nothing sends one on its own: no
 * job, no trigger (operator's rule, 2026-10-14). The admin can't write or edit one either: new text means a commit.
 *
 * They're account and feature updates, not promotions: under CAN-SPAM that makes them relationship messages
 * ("a change in the terms or features of" an account), which need an unsubscribe link but no postal address.
 * The footer carries MAIL_POSTAL_ADDRESS anyway whenever it's set.
 *
 * Recipients: the users table is the list, so there's one opt-out. Never anyone who unsubscribed (email_opt_out), never
 * an internal account (ADMIN_EMAILS, PRO_EMAILS), and only people who had signed up when the send started: someone who
 * joins later doesn't get old news. Each recipient is claimed in email_log (kind "announce:<id>") before the send, with
 * Resend's idempotency key too, so finishing an interrupted send (its page then offers "Finish sending") never sends
 * anyone twice. Once every recipient has it, the preset is marked sent and can't send again.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import type { Lifecycle } from "./lifecycle.js";
import { esc } from "./pages.js";
import { ACCOUNT_WINDOW_DAYS, PRO_ACCOUNTS } from "./plans.js";

export type Audience = "all" | "free" | "pro";
export const AUDIENCES: Record<Audience, string> = { all: "Everyone", free: "Free plan", pro: "Paid plans (Pro, Agency)" };

export interface Preset {
  id: string;
  /** When it's meant to go out, shown on its card: a note for the operator, nothing acts on it. */
  plan: string;
  audience: Audience;
  subject: string;
  /** Plain text: blank lines between paragraphs, "- " bullets, **bold**, [text](https://…) links, bare https:// URLs. */
  body: string;
}

export const PRESETS: Preset[] = [
  {
    id: "ga4-open",
    plan: "Now: Google verified the Analytics scopes 2026-10-17 and they're on for everyone (projects/camberstack/README.md).",
    audience: "all",
    subject: "Google Analytics now works in Camberstack",
    body: `Hi,

Camberstack can now read your Google Analytics 4 data, alongside your Google Ads and Search Console. In Claude or ChatGPT, ask things like:

- Which landing pages turn ad clicks into conversions?
- How did paid and organic traffic compare last month?

New connections ask for Google Analytics on Google's sign-in screen, as an optional box. If you're already connected, the first time you ask, Camberstack gives you a link that adds it, no reconnecting. Changes to your Analytics settings still wait for your approval, and each one can be undone.

Everything else that changed recently: https://camberstack.io/changelog

Adam`,
  },
  {
    id: "free-one-service",
    plan: "Monday 2026-11-02, once FREE_ONE_SERVICE=2026-11-16 is set and the site shows the change (projects/camberstack/PRICING-TEST.md). "
      + "Free users only: paid plans don't change. The date in the text is fixed, so a new date means a new commit. No price in it "
      + "(announce.test.ts): an account update, not a promotion; /plans has the prices.",
    audience: "free",
    subject: "A change to Camberstack's Free plan on November 16",
    body: `Hi,

A change to Camberstack's Free plan, starting November 16.

Today, Free covers one Google Ads account, with Search Console and Google Analytics included. From November 16, Free covers **one Google service at a time**: Google Ads, Search Console or Google Analytics.

What stays the same on Free:

- Every tool for that service, with unlimited changes, nothing applied until you approve it, and undo.
- Google Ads covers one account, with one switch every ${ACCOUNT_WINDOW_DAYS} days, as now.
- Undo and change history always work, including for everything you've done so far.

How it works: the first time you use Camberstack from November 16, your AI asks which service you want. Another one opens ${ACCOUNT_WINDOW_DAYS} days after you last used the first.

If you use them together, there's a new plan for that: Camberstack Plus covers Google Ads, Search Console and Google Analytics at once on one Google Ads account, including the tools that use them side by side (like finding searches you pay for that already rank). Pro does the same on up to ${PRO_ACCOUNTS} accounts. What each plan includes and costs: https://camberstack.io/plans

Nothing changes for Pro and Agency.

Questions or concerns? Just reply. I read every email.

Adam`,
  },
];

export interface SendState { started_at: number | null; sent_at: number | null; sent: number }

/** Resend allows 2 requests a second by default; stay under it. */
const GAP_MS = 600;

export interface AnnounceDeps {
  db: DB;
  lifecycle: Lifecycle;
  internalEmails: Set<string>;
  /** False when Resend isn't configured: nothing can be sent. */
  canSend: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export class Announcements {
  /** Sends in progress in this process, so a double click doesn't start a second loop. */
  private sending = new Set<string>();
  constructor(private d: AnnounceDeps) {}

  get canSend(): boolean { return this.d.canSend; }

  preset(id: string): Preset | undefined { return PRESETS.find((x) => x.id === id); }

  state(id: string): SendState & { running: boolean } {
    const r = this.d.db.prepare("SELECT started_at, sent_at FROM announcement_sends WHERE id = ?").get(id) as { started_at: number; sent_at: number | null } | undefined;
    const sent = (this.d.db.prepare("SELECT count(*) n FROM email_log WHERE kind = ?").get(`announce:${id}`) as { n: number }).n;
    return { started_at: r?.started_at ?? null, sent_at: r?.sent_at ?? null, sent, running: this.sending.has(id) };
  }

  /** Who it would go to now, or still will if a send was interrupted. Empty once it has been sent. */
  recipients(p: Preset): { id: string; email: string; plan: string }[] {
    const s = this.state(p.id);
    if (s.sent_at) return [];
    const plan = p.audience === "free" ? "AND u.plan = 'free'" : p.audience === "pro" ? "AND u.plan != 'free'" : "";
    return (this.d.db.prepare(`SELECT u.id, u.email, u.plan FROM users u WHERE u.email_opt_out = 0 ${plan} AND u.created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = ?) ORDER BY u.created_at`)
      .all(s.started_at ?? now(), `announce:${p.id}`) as { id: string; email: string; plan: string }[])
      .filter((u) => !this.d.internalEmails.has(u.email.toLowerCase()));
  }

  /** One copy to one address, logged nowhere: for checking a preset before its send. */
  async sendTest(id: string, to: string): Promise<void> {
    const p = this.preset(id);
    if (!p) throw new Error("No such announcement.");
    if (!this.d.canSend) throw new Error("Email isn't configured (RESEND_API_KEY).");
    await this.d.lifecycle.sendAnnouncement(to, render(p, true), "preview");
  }

  /**
   * The Send button: starts the send (fixing who's eligible) or finishes an interrupted one; refuses one that already
   * went out. Runs to the end in the background; stops at a failed send, which is unclaimed so "Finish sending" retries it.
   */
  start(id: string): Promise<{ sent: number; left: number }> {
    const p = this.preset(id);
    if (!p) throw new Error("No such announcement.");
    if (!this.d.canSend) throw new Error("Email isn't configured (RESEND_API_KEY).");
    if (this.state(id).sent_at) throw new Error("This announcement was already sent; each one goes out once.");
    if (this.sending.has(id)) throw new Error("It's already sending.");
    this.d.db.prepare("INSERT OR IGNORE INTO announcement_sends (id, started_at) VALUES (?, ?)").run(id, now());
    this.sending.add(id);
    return this.run(p).finally(() => this.sending.delete(id));
  }

  private async run(p: Preset): Promise<{ sent: number; left: number }> {
    const m = render(p, false);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const kind = `announce:${p.id}`;
    let sent = 0;
    for (const u of this.recipients(p)) {
      if (!this.d.db.prepare("INSERT OR IGNORE INTO email_log (user_id, kind, sent_at) VALUES (?, ?, ?)").run(u.id, kind, now()).changes) continue;
      try {
        await this.d.lifecycle.sendAnnouncement(u.email, m, u.id, `${u.id}:${kind}`);
        sent++;
      } catch (e) {
        this.d.db.prepare("DELETE FROM email_log WHERE user_id = ? AND kind = ?").run(u.id, kind);
        console.error(`announcement ${p.id}: ${u.email}: ${(e as Error).message}`);
        break;
      }
      await sleep(GAP_MS);
    }
    const left = this.recipients(p).length;
    if (!left) this.d.db.prepare("UPDATE announcement_sends SET sent_at = ? WHERE id = ? AND sent_at IS NULL").run(now(), p.id);
    return { sent, left };
  }
}

/** Subject + body as an email: paragraphs, "- " bullets, **bold**, [text](https://…) and bare https:// links. */
export function render(a: Pick<Preset, "subject" | "body">, test: boolean): { subject: string; text: string; html: string } {
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
    // A sentence's closing punctuation isn't part of the URL.
    .replace(/(^|[\s(])(https:\/\/[^\s<)]*[^\s<).,;:!?'"])/g, (_m, pre: string, u: string) => `${pre}<a href="${u}">${u}</a>`);
  const html = a.body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((b) => {
    const lines = b.split("\n");
    return lines.every((l) => l.startsWith("- "))
      ? `<ul style="margin:0 0 14px;padding-left:22px">${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`
      : `<p style="margin:0 0 14px">${lines.map(inline).join("<br>")}</p>`;
  }).join("");
  return {
    subject: `${test ? "[TEST] " : ""}${a.subject}`,
    text: a.body.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, "$1 ($2)"),
    html: `<div style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19;max-width:560px">${html}</div>`,
  };
}
