import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const reported: string[] = [];
vi.mock("./sentry.js", async (orig) => ({ ...(await orig<typeof import("./sentry.js")>()), reportError: (_e: unknown, where: string) => { reported.push(where); } }));
const { createApp } = await import("./server.js");
const { openDb } = await import("./db.js");

let server: Server;
let base = "";
beforeAll(async () => {
  const app = createApp({
    baseUrl: "http://localhost", port: 0, dataDir: ":memory:", encryptionKey: Buffer.alloc(32, 1),
    google: { clientId: "gid", clientSecret: "gs" }, freeAccounts: 1, proAccounts: 5,
    proEmails: new Set(), adminEmails: new Set(), allowedEmails: new Set(), gitSha: "test", gitCommitDate: "",
  } as any, openDb(":memory:")).app;
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

describe("the http error handler", () => {
  it("answers a body that isn't JSON with 400 and doesn't report it (coda-agent-runtime's probe)", async () => {
    const res = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" });
    expect(res.status).toBe(400);
    expect(reported).toEqual([]);
  });
});
