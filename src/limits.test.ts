// Resource limits from the 2026-11-13 security review: run_gaql's LIMIT, the Ads response size cap, the Google fetch deadline.
import { describe, expect, it } from "vitest";
import { AdsClient, MAX_ADS_BODY_BYTES, fetchGoogle, GOOGLE_TIMEOUT_MS } from "./google.js";
import { capLimit, MAX_QUERY_ROWS } from "./session.js";

describe("capLimit", () => {
  const L = `LIMIT ${MAX_QUERY_ROWS}`;
  it("adds a LIMIT to a query without one", () => {
    expect(capLimit("SELECT geo_target_constant.name FROM geo_target_constant")).toBe(`SELECT geo_target_constant.name FROM geo_target_constant ${L}`);
    expect(capLimit("SELECT campaign.id FROM campaign ;\n")).toBe(`SELECT campaign.id FROM campaign ${L}`);
  });
  it("keeps a LIMIT within the cap and lowers one above it", () => {
    expect(capLimit("SELECT campaign.id FROM campaign ORDER BY campaign.id LIMIT 50")).toBe("SELECT campaign.id FROM campaign ORDER BY campaign.id LIMIT 50");
    expect(capLimit("SELECT campaign.id FROM campaign LIMIT 50000")).toBe(`SELECT campaign.id FROM campaign ${L}`);
  });
  it("puts the LIMIT before PARAMETERS, and ignores 'limit' inside a string literal", () => {
    expect(capLimit("SELECT campaign.id FROM campaign PARAMETERS include_drafts=true")).toBe(`SELECT campaign.id FROM campaign ${L} PARAMETERS include_drafts=true`);
    expect(capLimit("SELECT campaign.id FROM campaign LIMIT 20000 PARAMETERS include_drafts=true")).toBe(`SELECT campaign.id FROM campaign ${L} PARAMETERS include_drafts=true`);
    expect(capLimit("SELECT campaign.id FROM campaign WHERE campaign.name = 'no limit 5'")).toBe(`SELECT campaign.id FROM campaign WHERE campaign.name = 'no limit 5' ${L}`);
  });
});

describe("Ads response size cap", () => {
  it("stops reading a response over the cap instead of buffering it", async () => {
    const mb = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { if (sent * mb.byteLength > MAX_ADS_BODY_BYTES + mb.byteLength) c.close(); else { sent++; c.enqueue(mb); } },
    });
    const ads = new AdsClient(async () => "t", (async () => new Response(stream, { status: 200 })) as typeof fetch);
    await expect(ads.search("1112223333", "SELECT campaign.id FROM campaign")).rejects.toThrow(/over 64 MB, so Camberstack stopped reading it/);
    expect(sent * mb.byteLength).toBeLessThanOrEqual(MAX_ADS_BODY_BYTES + 2 * mb.byteLength);
  });
  it("reads a normal response as before", async () => {
    const body = JSON.stringify([{ results: [{ campaign: { id: "1" } }] }]);
    const ads = new AdsClient(async () => "t", (async () => new Response(body, { status: 200 })) as typeof fetch);
    expect(await ads.search("1112223333", "SELECT campaign.id FROM campaign")).toEqual([{ campaign: { id: "1" } }]);
  });
});

describe("Google fetch deadline", () => {
  it("passes an abort signal and says plainly when Google didn't answer in time", async () => {
    let signal: AbortSignal | undefined;
    const ok = (async (_u: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Response("{}"); }) as typeof fetch;
    await fetchGoogle(ok, "https://example.test/");
    expect(signal).toBeInstanceOf(AbortSignal);
    const hung = (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as typeof fetch;
    await expect(fetchGoogle(hung, "https://example.test/")).rejects.toThrow(`Google didn't answer within ${GOOGLE_TIMEOUT_MS / 1000} seconds`);
  });
});
