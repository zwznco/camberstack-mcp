import { AGENCY_ACCOUNTS, PRO_ACCOUNTS } from "./plans.js";
/** Every environment variable the service reads, in one place. */

/** A comma-separated list of emails, lowercased. */
const emails = (raw: string | undefined) => new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export interface Config {
  /** Public origin, no trailing slash. Issuer for OAuth and base of every link. */
  baseUrl: string;
  port: number;
  dataDir: string;
  /** 32-byte key (hex or base64) that encrypts Google refresh tokens at rest. */
  encryptionKey: Buffer;
  google: {
    clientId: string;
    clientSecret: string;
    /** Sent when set. Google moved access decisions to the Cloud project on 2026-09-10. */
    developerToken?: string;
  };
  /** Google Ads accounts a plan covers at a time: distinct accounts used in the last 30 days, plus one switch (session.ts planState). */
  freeAccounts: number;
  proAccounts: number;
  agencyAccounts: number;
  /** Pro subscription; unset = no upgrade links (free users stop at the limit with no way to pay). */
  /** agencyPriceId: STRIPE_AGENCY_PRICE_ID; unset = no Agency plan offered. */
  stripe?: { secretKey: string; proPriceId: string; agencyPriceId?: string };
  /** Emails treated as Pro regardless of billing (the operator, testers). */
  proEmails: Set<string>;
  /** Origin of the admin site (its own host, e.g. https://admin.camberstack.io); unset = no admin site. */
  adminUrl?: string;
  /** Google accounts allowed into the admin site. */
  adminEmails: Set<string>;
  /** Hand our own campaign's conversions to operations (adconversions.ts); unset = clicks are kept but not sent. */
  conversions?: import("./adconversions.js").ConversionConfig;
  /** Lifecycle emails via Resend (lifecycle.ts); unset = none are sent. */
  mail?: import("./lifecycle.js").MailConfig;
  /** Glama ownership token for /.well-known/glama.json (from Glama's claim panel); unset = 404. */
  glamaClaim?: string;
  /** ChatGPT plugin domain-verification token for /.well-known/openai-apps-challenge (from the plugin portal); unset = 404. */
  openaiAppsChallenge?: string;
  /** Google Analytics (GA4) measurement ID for our own public pages (G-…), loaded through /e.js; unset = no GA tag. */
  ga4MeasurementId?: string;
  /** ALLOWED_EMAILS: the only Google accounts that may connect (dev.camberstack.io); empty = anyone. */
  allowedEmails?: Set<string>;
  /** NOINDEX=1: a non-production origin (dev.camberstack.io). robots.txt disallows everything and IndexNow is never pinged. */
  noindex?: boolean;
  /** Self-hosted Matomo for the public pages; unset = no analytics. See analytics.ts. */
  matomo?: { url: string; siteId: string; token: string };
  /** Where /feedback notifications go (feedback.ts); unset = the mail reply-to address. */
  feedbackTo?: string;
  gitSha: string;
  gitCommitDate: string;
}

function parseKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)");
  return key;
}

export function loadConfig(): Config {
  return {
    baseUrl: (process.env.BASE_URL ?? "https://camberstack.io").replace(/\/+$/, ""),
    port: Number(process.env.PORT ?? 3000),
    dataDir: process.env.DATA_DIR ?? "./data",
    encryptionKey: parseKey(req("ENCRYPTION_KEY")),
    google: {
      // Optional so the public pages can go live before the Google Cloud project exists (brand
      // verification needs the homepage first). Without them, sign-in reports "not open yet".
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || undefined,
    },
    freeAccounts: Number(process.env.FREE_ACCOUNTS ?? 1),
    proAccounts: Number(process.env.PRO_ACCOUNTS ?? PRO_ACCOUNTS),
    agencyAccounts: Number(process.env.AGENCY_ACCOUNTS ?? AGENCY_ACCOUNTS),
    stripe: process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRO_PRICE_ID
      ? { secretKey: process.env.STRIPE_SECRET_KEY, proPriceId: process.env.STRIPE_PRO_PRICE_ID,
          agencyPriceId: process.env.STRIPE_AGENCY_PRICE_ID || undefined }
      : undefined,
    proEmails: emails(process.env.PRO_EMAILS),
    adminUrl: process.env.ADMIN_URL?.replace(/\/+$/, "") || undefined,
    adminEmails: emails(process.env.ADMIN_EMAILS),
    noindex: process.env.NOINDEX === "1",
    allowedEmails: emails(process.env.ALLOWED_EMAILS),
    glamaClaim: process.env.GLAMA_CLAIM || undefined,
    feedbackTo: process.env.FEEDBACK_TO || undefined,
    openaiAppsChallenge: process.env.OPENAI_APPS_CHALLENGE || undefined,
    ga4MeasurementId: /^G-[A-Z0-9]{4,20}$/.test(process.env.GA4_MEASUREMENT_ID ?? "") ? process.env.GA4_MEASUREMENT_ID : undefined,
    mail: process.env.RESEND_API_KEY
      ? { apiKey: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM || "Adam at Camberstack <adam@camberstack.io>", replyTo: "adam@camberstack.io",
        postalAddress: process.env.MAIL_POSTAL_ADDRESS || undefined }
      : undefined,
    conversions: ["OPS_CONVERSIONS_URL", "OPS_KEY", "CONV_ADS_ACTION_ID"].every((k) => process.env[k])
      ? { opsUrl: process.env.OPS_CONVERSIONS_URL!, opsKey: process.env.OPS_KEY!, actionId: process.env.CONV_ADS_ACTION_ID! }
      : undefined,
    matomo: process.env.MATOMO_URL && process.env.MATOMO_SITE_ID
      ? { url: process.env.MATOMO_URL, siteId: process.env.MATOMO_SITE_ID, token: process.env.MATOMO_AUTH_TOKEN ?? "" }
      : undefined,
    gitSha: process.env.GIT_SHA ?? "",
    gitCommitDate: process.env.GIT_COMMIT_DATE ?? "",
  };
}
