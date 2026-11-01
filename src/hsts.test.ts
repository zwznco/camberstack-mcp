import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "./server.js";
import { openDb } from "./db.js";

async function hsts(baseUrl: string): Promise<string | null> {
  const { app } = createApp({
    baseUrl, port: 0, dataDir: ":memory:", encryptionKey: Buffer.alloc(32, 1),
    google: { clientId: "gid", clientSecret: "gs" }, freeAccounts: 1, proAccounts: 5,
    proEmails: new Set(), adminEmails: new Set(), allowedEmails: new Set(), gitSha: "test", gitCommitDate: "",
  } as any, openDb(":memory:"));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/healthz`);
    return res.headers.get("strict-transport-security");
  } finally { server.close(); }
}

describe("Strict-Transport-Security", () => {
  it("is sent for a year on an https site, without includeSubDomains", async () => {
    expect(await hsts("https://camberstack.example")).toBe("max-age=31536000");
  });
  it("isn't sent when the site runs on plain http", async () => {
    expect(await hsts("http://localhost")).toBeNull();
  });
});
