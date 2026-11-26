/**
 * CPU latency of the model step as the CLI runs it (onnxruntime-node, int8, batches of 32),
 * on a small schema (Chinook) and a very large one (GitLab's structure.sql).
 *
 *   npx tsx eval/latency.ts [artifacts=training/artifacts/ettin-32m]   (from cli/)
 *     → eval/results/<variant>.latency.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { basename, join } from "node:path";
import { loadSchema } from "../src/connect/load.js";
import { infer } from "../src/engine/infer.js";
import { refineWithModel } from "../src/model/classify.js";
import type { Installed } from "../src/model/store.js";

const cli = join(import.meta.dirname, "..");
const artifacts = process.argv[2] ?? join(cli, "training", "artifacts", "ettin-32m");
const info = JSON.parse(readFileSync(join(artifacts, "model.json"), "utf8"));
const inst: Installed = { name: info.name, dir: artifacts, runtime: true, manifest: {} as Installed["manifest"] };
const runs: Record<string, unknown> = {};
for (const s of ["chinook", "gitlab"]) {
  const schema = loadSchema(join(cli, "training", "data", "public", s));
  const times: number[] = [];
  let asked = 0;
  for (let i = 0; i < 3; i++) {
    const r = (await refineWithModel(infer(schema), schema, inst))!;
    times.push(r.ms);
    asked = r.asked;
  }
  times.sort((a, b) => a - b);
  const ms = times[1]!;
  runs[s] = { columns: asked, median_ms_including_model_load: ms, ms_per_column: Math.round((ms / asked) * 100) / 100, runs: times };
}
const out = { variant: basename(artifacts), model: info.name, runs, machine: { cpu: cpus()[0]?.model, logical_cpus: cpus().length, os: `${platform()} ${release()}`, node: process.version } };
writeFileSync(join(import.meta.dirname, "results", `${basename(artifacts)}.latency.json`), `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(runs));
