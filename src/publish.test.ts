// What the MCP registry and ChatGPT's plugin review check before listing Camberstack.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, toolCatalog } from "./tools.js";

const json = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

describe("published metadata", () => {
  it("has one version everywhere it's published", () => {
    for (const p of ["package.json", "server.json"]) expect(json(p).version, p).toBe(SERVER_VERSION);
  });

  it("sets all three hints on every tool (ChatGPT's review rejects an unset one)", () => {
    for (const t of toolCatalog({ merchant: true }))
      for (const h of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) expect(typeof t.annotations[h], `${t.name}.${h}`).toBe("boolean");
  });
});
