/**
 * End-to-end held-out evaluation of what the CLI actually does: schema files parsed by the
 * CLI, gr-schema-1 inference, then the model through src/model (TypeScript tokenizer,
 * onnxruntime-node, the ACCEPT threshold and the type check). Compared with eval/heldout.csv.
 *
 *   npx tsx eval/cli_eval.ts [artifacts=training/artifacts/gr-col-1]   (from cli/)
 *     → eval/results/<model>.cli.json, and eval/results/<model>.json (with the Python results)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { basename, join } from "node:path";
import { loadSchema } from "../src/connect/load.js";
import { infer } from "../src/engine/infer.js";
import { ACCEPT, refineWithModel } from "../src/model/classify.js";
import type { Installed } from "../src/model/store.js";
import { BpeTokenizer } from "../src/model/tokenizer.js";

const cli = join(import.meta.dirname, "..");
const artifacts = process.argv[2] ?? join(cli, "training", "artifacts", "gr-col-1");
const info = JSON.parse(readFileSync(join(artifacts, "model.json"), "utf8"));
const variant = basename(artifacts);

// 1. The TypeScript tokenizer gives the same ids as the Python one.
const tok = new BpeTokenizer(JSON.parse(readFileSync(join(artifacts, "tokenizer.json"), "utf8")));
const golden = JSON.parse(readFileSync(join(import.meta.dirname, "tokenizer-golden.json"), "utf8")) as { text: string; ids: number[] }[];
const tokMismatch = golden.filter((g) => JSON.stringify(tok.encode(g.text, info.max_len)) !== JSON.stringify(g.ids)).length;

// 2. Held-out labels.
const csv = readFileSync(join(import.meta.dirname, "heldout.csv"), "utf8").trim().split(/\r?\n/);
const cells = (l: string) => [...l.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => (m[1]!.startsWith('"') ? m[1]!.slice(1, -1).replace(/""/g, '"') : m[1]!));
const head = cells(csv[0]!);
const rows = csv.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v])) as Record<string, string>);
const gold = new Map(rows.map((r) => [`${r.source}\u0000${r.table}\u0000${r.column}`, r.label!]));

const inst: Installed = { name: info.name, dir: artifacts, runtime: true, manifest: {} as Installed["manifest"] };
const sources = [...new Set(rows.map((r) => r.source!))];
let rule = 0;
let pipeline = 0;
let total = 0;
let changed = 0;
let fixed = 0;
let broke = 0;
let ms = 0;
let asked = 0;
const bySource: Record<string, { total: number; rule_engine: number; cli_with_model: number; model_ms: number }> = {};
for (const s of sources) {
  const dir = join(cli, "training", "data", "public", s);
  if (!existsSync(dir)) throw new Error(`missing ${dir}: run training/fetch_public.py`);
  const schema = loadSchema(dir);
  const base = infer(schema);
  const plan = infer(schema);
  const r = (await refineWithModel(plan, schema, inst))!;
  ms += r.ms;
  asked += r.asked;
  const b = (bySource[s] = { total: 0, rule_engine: 0, cli_with_model: 0, model_ms: r.ms });
  plan.columns.forEach((c, i) => {
    const g = gold.get(`${s}\u0000${c.table}\u0000${c.column}`);
    if (!g) return;
    const before = base.columns[i]!.meaning;
    total++;
    b.total++;
    if (before === g) (rule++, b.rule_engine++);
    if (c.meaning === g) (pipeline++, b.cli_with_model++);
    if (before !== c.meaning) {
      changed++;
      if (c.meaning === g) fixed++;
      if (before === g) broke++;
    }
  });
}
const round = (x: number) => Math.round(x * 10000) / 10000;
const result = {
  held_out_columns: total,
  rule_engine: { correct: rule, accuracy: round(rule / total) },
  cli_with_model: { correct: pipeline, accuracy: round(pipeline / total), accept_threshold: ACCEPT },
  changed_by_model: changed,
  changes_that_fixed_a_label: fixed,
  changes_that_broke_a_label: broke,
  by_source: bySource,
  latency_node: {
    columns_asked: asked,
    total_ms_including_model_load: ms,
    note: "per schema: open the int8 model, tokenize, run every column in batches of 32, on CPU with onnxruntime-node",
  },
  tokenizer_parity: { checked: golden.length, mismatches: tokMismatch },
  machine: { cpu: cpus()[0]?.model, logical_cpus: cpus().length, os: `${platform()} ${release()}`, node: process.version },
};
const outDir = join(import.meta.dirname, "results");
writeFileSync(join(outDir, `${variant}.cli.json`), `${JSON.stringify(result, null, 1)}\n`);
const py = join(outDir, `${variant}.model.json`);
if (existsSync(py)) {
  const model = JSON.parse(readFileSync(py, "utf8"));
  const training = JSON.parse(readFileSync(join(cli, "training", "runs", variant, "training.json"), "utf8"));
  const { log, ...train } = training;
  writeFileSync(
    join(outDir, `${variant}.json`),
    `${JSON.stringify({ model: info.name, variant, base: info.base, measured_at: new Date().toISOString(), held_out: "eval/heldout.csv (eval/LABELING.md)", cli_pipeline: result, model_alone: model, training: { ...train, epochs_log: log } }, null, 1)}\n`,
  );
}
console.log(JSON.stringify({ rule: result.rule_engine, cli: result.cli_with_model, changed, fixed, broke, ms, tokMismatch }));
