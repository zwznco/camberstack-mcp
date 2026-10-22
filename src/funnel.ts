/**
 * Read-only usage report for the terminal. Same numbers as /admin (both use report.ts).
 *   docker exec $(docker ps -qf name=^camberstack-) node dist/funnel.js [--days 7] [--exclude me@example.com,other@example.com]
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildReport } from "./report.js";

const { values } = parseArgs({ options: { days: { type: "string", default: "7" }, exclude: { type: "string", default: "" } } });
const db = new Database(join(process.env.DATA_DIR ?? "/data", "camberstack.sqlite"), { readonly: true });
const r = buildReport(db, { days: Number(values.days), exclude: values.exclude!.split(",").map((e) => e.trim()).filter(Boolean) });

console.log(`# Camberstack usage — ${new Date().toISOString().slice(0, 10)}, window ${r.days}d${r.excluded ? `, excluding ${r.excluded} account(s)` : ""}\n`);
console.log("## Funnel (users, cohort = connected in window | all time)");
for (const k of Object.keys(r.funnel.all) as (keyof typeof r.funnel.all)[]) {
  console.log(`  ${k.padEnd(13)} ${String(r.funnel.window[k]).padStart(4)} | ${r.funnel.all[k]}`);
}
console.log(`  active in window (≥1 ok call): ${r.activeInWindow}`);
console.log(`\n## Connects by AI app`); console.table(r.sources);
console.log(`## Tools, last ${r.days}d`); console.table(r.tools);
console.log(`## MCP clients, last ${r.days}d`); console.table(r.clients);
console.log(`## Recent errors, last ${r.days}d`); console.table(r.errors);
