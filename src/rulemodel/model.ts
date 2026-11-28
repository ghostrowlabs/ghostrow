import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrt } from "../model/runtime.js";
import { chatPrompt, FORMAT_VERSION } from "./format.js";
import { QwenTokenizer } from "./tokenizer.js";

/**
 * gr-rules-1 on the CPU: one ONNX decoder graph (int4 weights, KV cache) run by onnxruntime-node
 * with a greedy loop. Greedy decoding, so the same prompt always gives the same answer, and the
 * answer is only a list of proposals: the deterministic check in format.ts decides.
 */

export interface RuleModelInfo {
  name: string;
  version: string;
  format_version: number;
  layers: number;
  kv_heads: number;
  head_size: number;
  eos: number[];
  max_new_tokens: number;
}

type Ort = typeof import("onnxruntime-node");
type Tensor = import("onnxruntime-node").Tensor;

export class RuleModel {
  private constructor(
    readonly info: RuleModelInfo,
    private readonly tok: QwenTokenizer,
    private readonly session: import("onnxruntime-node").InferenceSession,
    private readonly ort: Ort,
  ) {}

  static async open(dir: string, runtimeDir: string, threads?: number): Promise<RuleModel> {
    const info = JSON.parse(readFileSync(join(dir, "model.json"), "utf8")) as RuleModelInfo;
    if (info.format_version !== FORMAT_VERSION) throw new Error(`${info.name} was trained for rule format ${info.format_version}; this CLI uses ${FORMAT_VERSION}. Run ghostrow model pull ${info.name}.`);
    const tok = new QwenTokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")));
    const ort = await loadOrt(runtimeDir);
    const session = await ort.InferenceSession.create(join(dir, "model.onnx"), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      ...(threads ? { intraOpNumThreads: threads } : {}),
    });
    return new RuleModel(info, tok, session, ort);
  }

  /** Greedy answer for one user message (the table prompt). */
  async answer(user: string): Promise<{ text: string; lines: { text: string; p: number }[]; promptTokens: number; newTokens: number }> {
    const ids = this.tok.encode(chatPrompt(user));
    const { layers, kv_heads: h, head_size: d } = this.info;
    const eos = new Set(this.info.eos);
    let past: Record<string, Tensor> = {};
    for (let l = 0; l < layers; l++) {
      past[`past_key_values.${l}.key`] = new this.ort.Tensor("float32", new Float32Array(0), [1, h, 0, d]);
      past[`past_key_values.${l}.value`] = new this.ort.Tensor("float32", new Float32Array(0), [1, h, 0, d]);
    }
    const out: number[] = [];
    const probs: number[] = [];
    let input = ids;
    let total = 0;
    for (let step = 0; step < this.info.max_new_tokens; step++) {
      total += input.length;
      const feeds: Record<string, Tensor> = {
        input_ids: new this.ort.Tensor("int64", BigInt64Array.from(input, BigInt), [1, input.length]),
        attention_mask: new this.ort.Tensor("int64", new BigInt64Array(total).fill(1n), [1, total]),
        ...past,
      };
      const res = await this.session.run(feeds);
      const logits = res.logits!;
      const v = logits.dims[2]!;
      const data = logits.data as Float32Array;
      const off = (input.length - 1) * v;
      let best = 0;
      let bestVal = -Infinity;
      for (let k = 0; k < v; k++) {
        const x = data[off + k]!;
        if (x > bestVal) {
          bestVal = x;
          best = k;
        }
      }
      // Probability of the chosen token (softmax at the argmax), for the per-line confidence.
      let sum = 0;
      for (let k = 0; k < v; k++) sum += Math.exp(data[off + k]! - bestVal);
      logits.dispose?.();
      const next: Record<string, Tensor> = {};
      for (let l = 0; l < layers; l++) {
        next[`past_key_values.${l}.key`] = res[`present.${l}.key`]!;
        next[`past_key_values.${l}.value`] = res[`present.${l}.value`]!;
      }
      for (const t of Object.values(past)) t.dispose?.();
      past = next;
      if (eos.has(best)) break;
      out.push(best);
      probs.push(1 / sum);
      input = [best];
    }
    for (const t of Object.values(past)) t.dispose?.();
    // A line's confidence is its least likely token: one unsure token is enough to doubt a rule.
    const lines: { text: string; p: number }[] = [];
    let start = 0;
    for (let k = 0; k <= out.length; k++) {
      if (k < out.length && !this.tok.decode([out[k]!]).includes("\n")) continue;
      // Tokens start..k-1 make up the line; token k (if any) holds the line break.
      const text = this.tok.decode(out.slice(start, k)).trim();
      if (text) lines.push({ text, p: Math.min(...probs.slice(start, k)) });
      start = k + 1;
    }
    return { text: this.tok.decode(out).trim(), lines, promptTokens: ids.length, newTokens: out.length };
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}
