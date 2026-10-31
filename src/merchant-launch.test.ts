// MERCHANT_PUBLIC=YYYY-MM-DD: everything public about Merchant Center flips at that date, on a running server.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "./db.js";
import { listMerchant, parseDateFlag } from "./plans.js";
import { createApp } from "./server.js";
import { SERVER_VERSION } from "./tools.js";

const launch = parseDateFlag("2031-03-10")!;
const freeFrom = parseDateFlag("2031-02-01")!;
let server: Server;
let base = "";

beforeAll(async () => {
  const app = createApp({
    baseUrl: "http://localhost", port: 0, dataDir: ":memory:", encryptionKey: Buffer.alloc(32, 1),
    google: { clientId: "gid", clientSecret: "gs" }, freeAccounts: 1, proAccounts: 5, merchantPublicFrom: launch, freeOneServiceFrom: freeFrom,
    proEmails: new Set(), adminEmails: new Set(), allowedEmails: new Set(), gitSha: "test", gitCommitDate: "",
  } as any, openDb(":memory:")).app;
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { server?.close(); listMerchant(undefined); });

const at = (t: number) => vi.spyOn(Date, "now").mockReturnValue(t * 1000);
const get = async (path: string) => (await fetch(`${base}${path}`)).text();

describe("MERCHANT_PUBLIC on a date", () => {
  it("reads 08:00 UTC that day", () => expect(launch).toBe(Date.UTC(2031, 2, 10, 8) / 1000));

  it("before the date, nothing public names it", async () => {
    at(launch - 1);
    expect(await get("/tools")).not.toContain('id="merchant_accounts"');
    expect(await get("/llms.txt")).not.toContain("merchant_accounts");
    expect(await get("/plans")).not.toContain("Merchant Center");
    expect(await get("/changelog")).not.toContain(`id="v${SERVER_VERSION}"`);
    expect(await get("/terms")).not.toContain("Merchant Center");
  });

  it("from the date, with no restart, it all does, whichever way the two date flags fall", async () => {
    at(launch);
    expect(await get("/tools")).toContain('id="merchant_accounts"');
    expect(await get("/llms.txt")).toContain("merchant_accounts");
    const plans = await get("/plans");
    expect(plans).toContain("Merchant Center together");
    expect(plans).toContain("one Google service at a time"); // one-service Free's phase, already on
    const log = await get("/changelog");
    expect(log).toContain(`id="v${SERVER_VERSION}"`);
    expect(log).toContain("2031-03-10");
    const terms = await get("/terms");
    expect(terms).toContain("Merchant Center");
    expect(terms).toContain("Last updated 2031-03-10");
  });
});
