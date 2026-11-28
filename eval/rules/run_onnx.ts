/**
 * Runs an exported gr-rules-1 model through the CLI's own decoder (src/rulemodel/model.ts,
 * onnxruntime-node on the CPU) for every held-out table, timing each one.
 *
 *   npx tsx eval/rules/run_onnx.ts <model dir> <out.jsonl> [--split test] [--threads N] [--limit N]
 */
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleModel } from "../../src/rulemodel/model.js";
import type { HeldoutItem } from "./heldout.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = resolve(process.argv[2]!);
const outFile = process.argv[3]!;
const split = arg("--split");
const threads = arg("--threads") ? Number(arg("--threads")) : undefined;
const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;
const src = arg("--items") ?? join(HERE, "heldout.jsonl");

const items = readFileSync(src, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as HeldoutItem & { prompt?: string }).filter((i) => !split || i.split === split).slice(0, limit);
const t0 = performance.now();
const model = await RuleModel.open(dir, dir, threads);
const load = performance.now() - t0;
const out: string[] = [];
let tokens = 0;
for (const [n, i] of items.entries()) {
  const t = performance.now();
  const a = await model.answer(i.user);
  const ms = Math.round(performance.now() - t);
  tokens += a.newTokens;
  out.push(JSON.stringify({ id: i.id, output: a.text, lines: a.lines, ms, prompt_tokens: a.promptTokens, new_tokens: a.newTokens }));
  if ((n + 1) % 20 === 0) process.stderr.write(`${n + 1}/${items.length}\n`);
}
await model.close();
writeFileSync(outFile, out.join("\n") + "\n");
const total = performance.now() - t0;
console.log(JSON.stringify({ model: dir, tables: items.length, load_ms: Math.round(load), total_ms: Math.round(total), new_tokens: tokens, cpu: cpus()[0]?.model, cores: cpus().length, threads: threads ?? "default" }));
