import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { buildReport } from "./report.js";
import { PLUS_FEATURE_PREFIX } from "./plans.js";

const DAY = 86400;
const at = (d: string) => Date.parse(`${d}T12:00:00Z`) / 1000;

describe("new tools card", () => {
  it("counts real use, comebacks, demo, errors and a Plus tool's Free stops apart", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "newtools-")));
    for (const id of ["a", "b", "c", "op"]) db.prepare("INSERT INTO users (id, email, google_sub, created_at) VALUES (?, ?, ?, 0)").run(id, `${id}@x.com`, id);
    const call = db.prepare("INSERT INTO tool_calls (at, user_id, tool, customer_id, ok, error, ms, bytes) VALUES (?, ?, ?, ?, ?, ?, 1, 1)");
    const today = at("2026-11-25");
    call.run(today, "a", "performance_trend", "1112223333", 1, null);           // real
    call.run(today - 2 * DAY, "a", "performance_trend", "1112223333", 1, null); // same user, another day: came back
    call.run(today, "b", "performance_trend", "0000000001", 1, null);           // demo
    call.run(today, "c", "performance_trend", null, 1, `${PLUS_FEATURE_PREFIX} nothing was read.`);  // Free stop
    db.prepare("INSERT INTO plan_events (user_id, kind, at) VALUES ('c', 'plans_view', ?)").run(today + 600);
    call.run(today, "b", "performance_trend", "1112223333", 0, "boom");         // error
    call.run(today, "op", "performance_trend", "1112223333", 1, null);          // operator: excluded
    call.run(today, "a", "run_gaql", "1112223333", 1, null);

    const vi = Date.now;
    Date.now = () => (today + 3600) * 1000;
    try {
      const r = buildReport(db, { days: 7, exclude: ["op@x.com"] }).newTools;
      const pt = r.rows.find((x) => x.tool === "performance_trend")!;
      expect(pt).toMatchObject({ users: 1, calls: 2, ever: 1, repeat: 1, demo: 1, errors: 1, stops: { users: 1, to_plans: 1 } });
      expect(r.rows.find((x) => x.tool === "campaign_details")!.stops).toBeNull();
      expect(r.gaqlShare).toBeCloseTo(1 / 6);
      // 30 days on, the 0.45.0 tools (2026-11-18) have aged off the card.
      Date.now = () => at("2026-12-20") * 1000;
      expect(buildReport(db, { days: 7, exclude: [] }).newTools.rows.map((x) => x.tool)).toEqual(["performance_trend"]);
    } finally { Date.now = vi; }
  });
});
