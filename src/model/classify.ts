import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SchemaModel } from "../connect/types.js";
import type { Plan } from "../engine/infer.js";
import { compatible, MEANINGS, type MeaningId } from "../engine/meanings.js";
import { columnText, FEATURE_VERSION } from "./features.js";
import { loadOrt } from "./runtime.js";
import { installedModel, runtimeDir, type Installed } from "./store.js";
import { BpeTokenizer } from "./tokenizer.js";

/**
 * The model proposes; the deterministic engine decides. A proposal replaces the rule engine's
 * meaning only when the model is confident (probability >= ACCEPT), the meaning is one the
 * column's declared type can hold (`compatible`), and the column isn't a foreign key. Rules
 * from the rules file, code and the CLI's validator still apply afterwards, and generation
 * stays seeded, so the same schema and model always give the same rows.
 */
export const ACCEPT = 0.5;

interface ModelInfo {
  name: string;
  labels: string[];
  max_len: number;
  feature_version: number;
}

export interface Proposal {
  table: string;
  column: string;
  meaning: MeaningId;
  probability: number;
}

export interface ModelRun {
  model: string;
  asked: number;
  changed: number;
  ms: number;
  proposals: Proposal[];
}

export class ColumnModel {
  private constructor(
    readonly info: ModelInfo,
    private readonly tok: BpeTokenizer,
    private readonly session: import("onnxruntime-node").InferenceSession,
    private readonly ort: typeof import("onnxruntime-node"),
  ) {}

  static async open(inst: Installed): Promise<ColumnModel> {
    const info = JSON.parse(readFileSync(join(inst.dir, "model.json"), "utf8")) as ModelInfo;
    if (info.feature_version !== FEATURE_VERSION) throw new Error(`${info.name} was trained for feature version ${info.feature_version}; this CLI uses ${FEATURE_VERSION}. Run ghostrow model pull.`);
    for (const l of info.labels) if (!(MEANINGS as readonly string[]).includes(l)) throw new Error(`${info.name} has an unknown meaning ${l}`);
    const tok = new BpeTokenizer(JSON.parse(readFileSync(join(inst.dir, "tokenizer.json"), "utf8")));
    const ort = await loadOrt(runtimeDir(inst.name));
    const session = await ort.InferenceSession.create(join(inst.dir, "model.onnx"), { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
    return new ColumnModel(info, tok, session, ort);
  }

  /** Softmax probabilities per label for each text, in batches. */
  async predict(texts: string[], batch = 32): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batch) {
      const enc = texts.slice(i, i + batch).map((t) => this.tok.encode(t, this.info.max_len));
      const n = Math.max(...enc.map((e) => e.length));
      const ids = new BigInt64Array(enc.length * n).fill(BigInt(this.tok.pad));
      const mask = new BigInt64Array(enc.length * n);
      enc.forEach((e, r) => e.forEach((id, c) => {
        ids[r * n + c] = BigInt(id);
        mask[r * n + c] = 1n;
      }));
      const res = await this.session.run({
        input_ids: new this.ort.Tensor("int64", ids, [enc.length, n]),
        attention_mask: new this.ort.Tensor("int64", mask, [enc.length, n]),
      });
      const logits = res.logits!.data as Float32Array;
      const k = this.info.labels.length;
      for (let r = 0; r < enc.length; r++) {
        const row = logits.subarray(r * k, (r + 1) * k);
        const max = Math.max(...row);
        const exp = Float32Array.from(row, (x) => Math.exp(x - max));
        const sum = exp.reduce((a, b) => a + b, 0);
        out.push(exp.map((x) => x / sum));
      }
    }
    return out;
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}

/**
 * Apply the model to a plan in place. Returns what it did, or null when no model is installed.
 * Columns pinned by the rules file are merged later and win anyway; foreign keys are never asked.
 */
export async function refineWithModel(plan: Plan, schema: SchemaModel, inst: Installed | null = installedModel()): Promise<ModelRun | null> {
  if (!inst) return null;
  const t0 = performance.now();
  const model = await ColumnModel.open(inst);
  try {
    const targets: { i: number; text: string; col: SchemaModel["tables"][number]["columns"][number] }[] = [];
    plan.columns.forEach((pc, i) => {
      if (pc.meaning === "reference" || pc.pinned) return;
      const table = schema.tables.find((t) => t.name === pc.table);
      const col = table?.columns.find((c) => c.name === pc.column);
      if (!table || !col || table.foreignKeys.some((f) => f.columns.includes(col.name))) return;
      targets.push({ i, text: columnText(table, col), col });
    });
    const probs = await model.predict(targets.map((t) => t.text));
    const proposals: Proposal[] = [];
    let changed = 0;
    targets.forEach((t, j) => {
      const p = probs[j]!;
      let best = 0;
      for (let k = 1; k < p.length; k++) if (p[k]! > p[best]!) best = k;
      const meaning = model.info.labels[best] as MeaningId;
      const pc = plan.columns[t.i]!;
      proposals.push({ table: pc.table, column: pc.column, meaning, probability: Math.round(p[best]! * 1000) / 1000 });
      if (p[best]! < ACCEPT || !compatible(meaning, t.col)) return;
      const prob = Math.min(0.99, Math.round(p[best]! * 100) / 100);
      if (meaning !== pc.meaning) {
        changed++;
        pc.meaning = meaning;
        pc.confidence = prob;
        pc.evidence = `${model.info.name}, ${pc.evidence}`;
        // Values sampled for a category belong to the rule engine's guess only.
        if (meaning !== "status") delete pc.values;
      } else {
        pc.confidence = Math.max(pc.confidence, prob);
        pc.evidence = `${pc.evidence}, ${model.info.name}`;
      }
    });
    return { model: model.info.name, asked: targets.length, changed, ms: Math.round(performance.now() - t0), proposals };
  } finally {
    await model.close();
  }
}
