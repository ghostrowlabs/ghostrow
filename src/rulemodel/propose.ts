import { resolve } from "node:path";
import type { SchemaModel } from "../connect/types.js";
import type { Plan } from "../engine/infer.js";
import type { Rule } from "../engine/rules.js";
import { generateSeed } from "../gen/seed.js";
import { validate } from "../gen/validate.js";
import { runtimeDir, type Installed } from "../model/store.js";
import { codeContext, readCodeDir, type CodeFile } from "./code.js";
import { askable, checkProposal, parseLine, proposalKey, ruleAsProposal, tablePrompt } from "./format.js";
import { RuleModel } from "./model.js";

/**
 * The model proposes; the generator decides. For every table worth asking about, gr-rules-1
 * reads the table (and its application code, with --code) and proposes rules. Each proposal
 * must then pass, in order:
 *   1. the format (one rule per line, a known kind)
 *   2. the deterministic check in format.ts (columns exist, types fit, the foreign key it needs
 *      is declared, nothing it fights in the plan; limits only from code that was read)
 *   3. a trial run: a small seeded sample is generated with the rule and validated; a rule the
 *      generator can't satisfy together with the rest of the plan is dropped.
 * What survives is an ordinary rule (source "inferred", or "code" when it came from code): it is
 * written to ghostrow.rules.yaml, where it can be switched off like any other.
 */

export interface RuleRun {
  model: string;
  asked: number;
  proposed: number;
  accepted: number;
  rejected: { table: string; line: string; reason: string }[];
  /** Accepted by the check, then dropped because a trial run couldn't satisfy them. */
  dropped: string[];
  ms: number;
}

const TRIAL_ROWS = 40;
/**
 * A proposal is considered only if every token of its line was at least this likely: the lowest
 * token probability is the line's confidence. Chosen on the dev split of the held-out set (see
 * eval/rules/RESULTS.md), never on the test split.
 */
export const ACCEPT = 0.9;

export async function proposeRules(plan: Plan, schema: SchemaModel, inst: Installed, opts: { codeDir?: string; threads?: number } = {}): Promise<RuleRun> {
  const t0 = performance.now();
  const files: CodeFile[] = opts.codeDir ? readCodeDir(resolve(opts.codeDir)) : [];
  const model = await RuleModel.open(inst.dir, runtimeDir(inst.name), opts.threads);
  const run: RuleRun = { model: model.info.name, asked: 0, proposed: 0, accepted: 0, rejected: [], dropped: [], ms: 0 };
  const added: Rule[] = [];
  try {
    for (const t of schema.tables) {
      const blocks = files.length ? codeContext(t, files) : [];
      if (!askable(schema, t, blocks.length ? "code" : undefined)) continue;
      run.asked++;
      const { lines } = await model.answer(tablePrompt(schema, t, blocks));
      const have = new Set(plan.rules.filter((r) => r.table === t.name).map((r) => ruleAsProposal(schema, r)).filter((p) => !!p).map((p) => proposalKey(t.name, p!)));
      for (const { text: line, p: confidence } of lines.filter((l) => l.text !== "none")) {
        run.proposed++;
        if (confidence < ACCEPT) {
          run.rejected.push({ table: t.name, line, reason: `confidence ${confidence.toFixed(2)} below ${ACCEPT}` });
          continue;
        }
        const p = parseLine(line);
        if (!p) {
          run.rejected.push({ table: t.name, line, reason: "not in the rule format" });
          continue;
        }
        const key = proposalKey(t.name, p);
        if (have.has(key)) continue; // already in the plan: nothing to add
        const v = checkProposal(schema, t, p, plan.rules, blocks.length ? `${model.info.name}, from ${blocks.map((b) => b.file).join(", ")}` : model.info.name, blocks.length > 0);
        if (!v.ok) {
          run.rejected.push({ table: t.name, line, reason: v.reason });
          continue;
        }
        if (plan.rules.some((r) => r.id === v.rule.id)) continue;
        have.add(key);
        plan.rules.push(v.rule);
        added.push(v.rule);
        if (v.values && p.kind === "values") {
          const col = plan.columns.find((c) => c.table === t.name && c.column.toLowerCase() === p.column.toLowerCase());
          if (col && !col.pinned) {
            col.values = v.values;
            col.meaning = "status";
            col.evidence = v.rule.evidence;
          }
        }
      }
    }
  } finally {
    await model.close();
  }
  // The generator decides: a rule that a trial run can't satisfy alongside the rest goes.
  for (let round = 0; round < 3 && added.some((r) => r.enabled); round++) {
    let bad: Set<string>;
    try {
      const out = generateSeed({ schema, plan, seed: 1, rows: TRIAL_ROWS });
      bad = new Set(validate(out, plan).violations.map((v) => `${v.table}\u0000${v.rule}`));
    } catch {
      // The plan with these rules can't be generated at all: drop every proposal, keep the run going.
      bad = new Set(added.filter((r) => r.enabled).map((r) => `${r.table}\u0000${r.expr}`));
    }
    const failing = added.filter((r) => r.enabled && bad.has(`${r.table}\u0000${r.expr}`));
    if (!failing.length) break;
    for (const r of failing) {
      plan.rules = plan.rules.filter((x) => x !== r);
      r.enabled = false;
      run.dropped.push(`${r.table}: ${r.expr}`);
    }
  }
  run.accepted = added.filter((r) => r.enabled).length;
  run.ms = Math.round(performance.now() - t0);
  return run;
}
