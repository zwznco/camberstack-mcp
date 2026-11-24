/**
 * Send one user the lifecycle email they're due now, by hand: outside their morning and the 6 hours after a stop, every other
 * rule as lifecycle.ts. A dry run (prints the email) unless --send:
 *   docker exec $(docker ps -qf name=^camberstack-) node dist/lifecycle-send.js <email|user_id> [--send]
 * Same mail path, links and email_log record as the hourly run, so the automated one doesn't follow.
 */
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { deriveKey } from "./crypto.js";
import { Billing } from "./billing.js";
import { Lifecycle, lifecycleSigningKey } from "./lifecycle.js";
import { setChangeCap } from "./plans.js";

const who = (process.argv[2] ?? "").trim().toLowerCase();
const send = process.argv.includes("--send");
if (!who) { console.error("usage: node dist/lifecycle-send.js <email|user_id> [--send]"); process.exit(2); }
const cfg = loadConfig();
setChangeCap(cfg.freeChangeCap, cfg.freeChangeCapFrom);
const db = openDb(cfg.dataDir);
const u = db.prepare("SELECT id, email FROM users WHERE lower(email) = ? OR id = ?").get(who, who) as { id: string; email: string } | undefined;
if (!u) { console.error("no such user"); process.exit(1); }
const billing = new Billing({ db, baseUrl: cfg.baseUrl, stripe: cfg.stripe, onPaid: () => {}, signingKey: deriveKey(cfg.encryptionKey, "billing-links") });
const lc = new Lifecycle({ db, baseUrl: cfg.baseUrl, mail: cfg.mail, internalEmails: new Set([...cfg.adminEmails, ...cfg.proEmails]),
  signingKey: lifecycleSigningKey(cfg.encryptionKey),
  upgradeLink: (id) => billing.link("upgrade", id, "email"),
  agencyLink: (id) => billing.link("agency", id, "email"),
  plusLink: (id) => billing.link("plus", id, "email") });
const due = lc.pending(u.id);
if (!due.length) { console.error("nothing due for this user (already sent, not eligible, or held by spacing)"); process.exit(1); }
for (const d of due) console.log(`--- ${d.kind}\nSubject: ${d.email.subject}\n\n${d.email.text.replace(/https:\/\/\S+\?\S+/g, "<personal link>")}\n`);
if (!send) { console.log("dry run: add --send to send it"); process.exit(0); }
if (!cfg.mail) { console.error("RESEND_API_KEY not set"); process.exit(1); }
console.log(`sent ${await lc.sendNow(u.id)}`);
