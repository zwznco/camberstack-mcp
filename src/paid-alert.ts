/**
 * New-subscriber alert: mail the operator when someone starts a paid plan. billing.ts's onPaid fires once per new
 * subscription (the /upgraded page, a paywall refresh or the hourly sweep, whichever settles it first), so this sends
 * once per subscription; the subscription id is the Resend idempotency key, for a retry inside Resend's window.
 * Switches between paid plans in Stripe's portal and cancellations aren't new subscriptions and aren't mailed.
 * Internal accounts (ADMIN_EMAILS, PRO_EMAILS) are left out, so testing checkout doesn't mail. Never throws.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";
import { sendMail } from "./lifecycle.js";
import { esc } from "./pages.js";
import { AGENCY_PRICE_LABEL, PLUS_PRICE_LABEL, PRO_PRICE_LABEL, planLabel, type Plan } from "./plans.js";

export interface PaidAlertDeps {
  db: DB;
  internalEmails: Set<string>;
  /** Resend, as in config.ts; unset (dev) = logged only. */
  mail?: { apiKey: string; from: string };
  to: string;
  adminUrl?: string;
  fetch?: typeof fetch;
}

const price = (p: Plan) => (p === "agency" ? AGENCY_PRICE_LABEL : p === "plus" ? PLUS_PRICE_LABEL : PRO_PRICE_LABEL);

export function renderPaid(d: Pick<PaidAlertDeps, "db" | "adminUrl">, userId: string, plan: Plan, t = now()) {
  const u = d.db.prepare("SELECT email, created_at FROM users WHERE id = ?").get(userId) as { email: string; created_at: number } | undefined;
  const email = u?.email ?? userId;
  const app = (d.db.prepare(`SELECT json_extract(cl.info, '$.client_name') app FROM tool_calls c JOIN clients cl ON cl.client_id = c.client_id
    WHERE c.user_id = ? ORDER BY c.at DESC LIMIT 1`).get(userId) as { app: string | null } | undefined)?.app ?? null;
  const click = (d.db.prepare("SELECT src FROM plan_events WHERE user_id = ? AND kind = 'upgrade_click' ORDER BY at DESC LIMIT 1")
    .get(userId) as { src: string | null } | undefined)?.src ?? null;
  const days = u ? Math.floor((t - u.created_at) / 86400) : null;
  const lines: [string, string][] = [
    ["Plan", `${planLabel(plan)} (${price(plan)})`],
    ["Signed up", days === null ? "unknown" : days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`],
    ...(app ? [["AI app", app] as [string, string]] : []),
    ...(click ? [["Upgrade link from", click] as [string, string]] : []),
  ];
  const link = d.adminUrl ? `${d.adminUrl}/users/${encodeURIComponent(userId)}` : "";
  const subject = `New ${planLabel(plan)} subscriber: ${email}`;
  const text = [`${email} subscribed to Camberstack ${planLabel(plan)}.`, "", ...lines.map(([k, v]) => `${k}: ${v}`), ...(link ? ["", link] : [])].join("\n");
  const html = `<p><strong>${esc(email)}</strong> subscribed to Camberstack ${esc(planLabel(plan))}.</p>
<table>${lines.map(([k, v]) => `<tr><td style="padding-right:12px;color:#666">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
${link ? `<p><a href="${esc(link)}">Open in admin</a></p>` : ""}`;
  return { subject, text, html, email };
}

export async function notifyPaid(d: PaidAlertDeps, userId: string, plan: Plan, subId: string): Promise<void> {
  try {
    const m = renderPaid(d, userId, plan);
    if (d.internalEmails.has(m.email.toLowerCase())) return;
    if (!d.mail) { console.log(`paid alert (mail off): ${m.subject}`); return; }
    await sendMail(d.mail.apiKey, { from: d.mail.from, to: [d.to], subject: m.subject, text: m.text, html: m.html }, d.fetch, `paid:${subId}`);
  } catch (e) {
    console.error(`paid alert: ${(e as Error).message}`);
  }
}
