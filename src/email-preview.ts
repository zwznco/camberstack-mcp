/**
 * Send one sample of each lifecycle email, to check delivery and rendering:
 *   docker exec $(docker ps -qf name=^camberstack-) node dist/email-preview.js adam@camberstack.io
 */
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { Lifecycle, lifecycleSigningKey } from "./lifecycle.js";

const to = process.argv[2];
if (!to) { console.error("usage: node dist/email-preview.js <to>"); process.exit(2); }
const cfg = loadConfig();
if (!cfg.mail) { console.error("RESEND_API_KEY not set"); process.exit(1); }
const lc = new Lifecycle({ db: openDb(":memory:"), baseUrl: cfg.baseUrl, mail: cfg.mail,
  internalEmails: new Set(), upgradeLink: () => null,
  signingKey: lifecycleSigningKey(cfg.encryptionKey) });
await lc.preview(to);
console.log(`sent 6 sample emails to ${to}`);
