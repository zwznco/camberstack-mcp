/**
 * /feedback: a public page anyone can read; sending needs a Google sign-in (signin.ts, identity only).
 * The sign-in is the spam filter and gives the operator an address to answer. Unlike /account it takes
 * ANY Google account, connected or not: someone who gave up before connecting is exactly who to hear from.
 * Each message is stored (feedback table, listed on the admin site) and mailed to the operator with
 * Reply-To set to the sender, so answering is one click.
 */
import express, { type Express } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import type { GoogleCreds } from "./google.js";
import { sendMail } from "./lifecycle.js";
import { SignIn } from "./signin.js";
import { appPage, esc, infoPage } from "./pages.js";

export const FEEDBACK_KINDS = { bug: "Something's broken", idea: "An idea or request", other: "Something else" } as const;
type Kind = keyof typeof FEEDBACK_KINDS;
export const FEEDBACK_MAX = 5000;
/** Per sender, per day. Generous for a person, a wall for a script with one Google account. */
const DAILY_LIMIT = 5;

export interface FeedbackDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  /** Google's token exchange (signin.ts). */
  fetch?: typeof fetch;
  /** The Resend call. */
  mailFetch?: typeof fetch;
  /** Resend, as in config.ts; unset (dev, tests) = stored only, no email. */
  mail?: { apiKey: string; from: string; replyTo: string };
  /** Where the notification goes. */
  operator: string;
}

export function mountFeedback(app: Express, d: FeedbackDeps): SignIn {
  const auth = new SignIn(d, "fb_", "cs_feedback", "/feedback", 86400);
  const shell = (body: string) => appPage(d.baseUrl, "Feedback", "/feedback", body);

  app.use("/feedback", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/feedback/login", (_req, res) => {
    if (!d.google.clientId) { res.status(503).type("html").send(infoPage(d.baseUrl, "Sign-in unavailable", "<p>Google sign-in is not configured.</p>")); return; }
    auth.start(res);
  });

  app.get("/feedback/callback", async (req, res) => {
    const who = await auth.finish(req);
    if (!who) { res.status(400).type("html").send(infoPage(d.baseUrl, "Sign-in didn't finish", `<p>The sign-in expired or was cancelled. <a href="/feedback/login">Try again</a>.</p>`)); return; }
    auth.open(res, who.email);
    res.redirect(302, "/feedback");
  });

  app.post("/feedback/logout", (req, res) => { auth.close(req, res); res.redirect(303, "/feedback"); });

  app.get("/feedback", (req, res) => {
    const email = auth.subject(req);
    const intro = `<h1 style="font-size:28px;margin:0 0 8px">Feedback</h1>
<p class="muted">Bugs, missing tools, confusing answers, a change you'd want to make that Camberstack can't: it all helps. Every message is read by the person who builds it.</p>`;
    if (req.query.sent === "1") {
      res.type("html").send(shell(`<div class="signin"><div class="card">${intro}
<p><strong>Thanks, it's sent.</strong> If it needs an answer, the reply goes to ${email ? esc(email) : "your email"}.</p>
<p><a href="/feedback">Send another</a> · <a href="/">Back to Camberstack</a></p></div></div>`));
      return;
    }
    if (!email) {
      res.type("html").send(shell(`<div class="signin"><div class="card">${intro}
<a class="btn" href="/feedback/login">Sign in with Google to send feedback</a>
<p class="muted" style="font-size:14px">Signing in keeps spam out and gives us an address to reply to. We only ask for your email address, and you don't need to have connected Camberstack.</p>
</div></div>`));
      return;
    }
    const radios = (Object.entries(FEEDBACK_KINDS) as [Kind, string][]).map(([k, label], i) =>
      `<label class="opt"><input type="radio" name="kind" value="${k}"${i === 0 ? " required" : ""}> ${esc(label)}</label>`).join("");
    res.type("html").send(shell(`<div class="fb"><div class="card">
<h1>Feedback</h1>
<p class="lede">Bugs, missing tools, confusing answers, a change you'd want to make that Camberstack can't: it all helps. Every message is read by the person who builds it.</p>
<form method="post" action="/feedback">
<fieldset><legend>What's it about?</legend>${radios}</fieldset>
<label class="lbl" for="fb-msg">Your message</label>
<textarea id="fb-msg" name="message" required minlength="3" maxlength="${FEEDBACK_MAX}" rows="8"></textarea>
<p class="hint">If it's about a change, the proposal ID (from your AI's reply or <a href="/account">your account</a>) helps.</p>
<button class="btn">Send feedback</button>
</form>
<form method="post" action="/feedback/logout" class="who">Sending as ${esc(email)} · <button class="linkish">Sign out</button></form>
</div></div>`));
  });

  app.post("/feedback", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const email = auth.subject(req);
    if (!email) { res.redirect(303, "/feedback"); return; }
    const kind = String(req.body?.kind ?? "") as Kind;
    const message = String(req.body?.message ?? "").trim();
    if (!(kind in FEEDBACK_KINDS) || message.length < 3 || message.length > FEEDBACK_MAX) {
      res.status(400).type("html").send(shell(`<div class="card"><p>That didn't go through: pick what it's about and write a message (up to ${FEEDBACK_MAX} characters). <a href="/feedback">Back</a></p></div>`));
      return;
    }
    const recent = (d.db.prepare("SELECT count(*) n FROM feedback WHERE email = ? AND at > ?").get(email, now() - 86400) as { n: number }).n;
    if (recent >= DAILY_LIMIT) {
      res.status(429).type("html").send(shell(`<div class="card"><p>That's ${DAILY_LIMIT} messages today, the daily limit. For anything urgent, email <a href="mailto:${esc(d.operator)}">${esc(d.operator)}</a>.</p></div>`));
      return;
    }
    const user = d.db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
    d.db.prepare("INSERT INTO feedback (at, email, user_id, kind, message) VALUES (?, ?, ?, ?, ?)").run(now(), email, user?.id ?? null, kind, message);
    // Stored first: a mail outage loses the notification, never the message (the admin page lists them all).
    await notify(d, email, kind, message, !!user).catch((e) => console.error(`feedback mail: ${(e as Error).message}`));
    res.redirect(303, "/feedback?sent=1");
  });

  return auth;
}

async function notify(d: FeedbackDeps, email: string, kind: Kind, message: string, connected: boolean): Promise<void> {
  if (!d.mail) return;
  const who = `${email} (${connected ? "connected user" : "not connected"})`;
  await sendMail(d.mail.apiKey, {
    from: d.mail.from, to: [d.operator], reply_to: email,
    subject: `Feedback: ${FEEDBACK_KINDS[kind]} from ${email}`,
    text: `${who}\n\n${message}`,
    html: `<p style="color:#777">${esc(who)}</p><p style="white-space:pre-wrap">${esc(message)}</p>`,
  }, d.mailFetch);
}

/** For the admin site. */
export interface FeedbackRow { id: number; at: number; email: string; user_id: string | null; kind: Kind; message: string }
export const recentFeedback = (db: DB, limit = 200) =>
  db.prepare("SELECT id, at, email, user_id, kind, message FROM feedback ORDER BY at DESC LIMIT ?").all(limit) as FeedbackRow[];
export const feedbackCount = (db: DB, since: number) =>
  (db.prepare("SELECT count(*) n FROM feedback WHERE at > ?").get(since) as { n: number }).n;

