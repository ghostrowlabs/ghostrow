/**
 * Public schemas → one JSON line per column, parsed with the CLI's own schema readers and
 * weakly labelled by the gr-schema-1 rule engine.
 *
 *   npx tsx training/tools/extract.ts      (run from cli/)  → training/data/public.jsonl
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchema } from "../../src/connect/load.js";
import { infer } from "../../src/engine/infer.js";
import { columnText } from "../../src/model/features.js";

const root = join(import.meta.dirname, "..");
const sources = JSON.parse(readFileSync(join(root, "sources.json"), "utf8")).sources as { id: string; split: string; license: string; repo: string }[];
const lines: string[] = [];
for (const s of sources) {
  const dir = join(root, "data", "public", s.id);
  if (!existsSync(dir) || readdirSync(dir).length === 0) continue;
  let schema;
  try {
    schema = loadSchema(dir);
  } catch (e) {
    console.error(`${s.id}: ${e instanceof Error ? e.message : e}`);
    continue;
  }
  const plan = infer(schema);
  const byKey = new Map(plan.columns.map((c) => [`${c.table}\u0000${c.column}`, c]));
  let n = 0;
  for (const t of schema.tables) {
    for (const c of t.columns) {
      const r = byKey.get(`${t.name}\u0000${c.name}`)!;
      lines.push(
        JSON.stringify({
          source: s.id,
          split: s.split,
          table: t.name,
          column: c.name,
          type: c.type,
          raw_type: c.rawType,
          fk: t.foreignKeys.some((f) => f.columns.includes(c.name)),
          text: columnText(t, c),
          rule: r.meaning,
          rule_confidence: r.confidence,
        }),
      );
      n++;
    }
  }
  console.log(`${s.id.padEnd(14)} ${s.split.padEnd(6)} ${String(schema.tables.length).padStart(5)} tables ${String(n).padStart(6)} columns`);
}
writeFileSync(join(root, "data", "public.jsonl"), lines.join("\n") + "\n");
console.log(`${lines.length} columns → training/data/public.jsonl`);
