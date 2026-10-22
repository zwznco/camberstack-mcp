import * as Sentry from "@sentry/node";
import { AdsApiError, NotGrantedError } from "./google.js";
import { PlanLimitError } from "./plans.js";
import { NotConnectedError } from "./session.js";

/**
 * Error reporting over the Sentry protocol. Production points it at a self-hosted Bugsink; nothing goes to
 * sentry.io unless a DSN says so. Off unless SENTRY_DSN is set, so stdio, tests and self-hosters send nothing.
 */
export function initErrorReporting(release: string): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    release: release || undefined,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    sendDefaultPii: false,
    // Errors only, no tracing. Requests carry bearer tokens and cookies, and tool arguments carry users'
    // account data, so no request details leave the process.
    beforeSend(event) {
      delete event.request;
      delete event.user;
      return event;
    },
    beforeBreadcrumb: (b) => (b.category === "http" || b.category === "fetch" ? null : b),
  });
}

/**
 * Whether a tool error is a bug worth reporting. Our own code throws a plain Error, or one of the classes
 * below, to tell the user something, and tool_calls already logs those. A bug shows up as a TypeError,
 * a SqliteError, a failed fetch, or Google answering 5xx.
 */
export function isUnexpected(e: unknown): boolean {
  if (e instanceof AdsApiError) return e.status >= 500;
  if (e instanceof PlanLimitError || e instanceof NotGrantedError || e instanceof NotConnectedError) return false;
  return !(e instanceof Error && e.constructor === Error);
}

/** Report an error; `where` names the tool or job. A no-op when reporting is off. */
export function reportError(e: unknown, where: string): void {
  Sentry.captureException(e, { tags: { where } });
}

/** Report a bug that throws nothing (a check that misfired); `where` names the tool or job. A no-op when reporting is off. */
export function reportBug(message: string, where: string): void {
  Sentry.captureMessage(message, { level: "warning", tags: { where } });
}
