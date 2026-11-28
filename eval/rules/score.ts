/**
 * Scores rule proposals on the real held-out set against the hand labels and the declared
 * CHECKs, for the current heuristics, the model alone, and the two together as the CLI runs
 * them (heuristics first; model proposals only after they pass the deterministic check).
 *
 *   npx tsx eval/rules/score.ts eval/rules/results/<answers>.jsonl [--json out.json]
 *
 * Matching: a proposal is correct when its rule (kind, table, columns, value) is in the
 * answer key. Orderings also count when implied by the key (a <= b and b <= c imply a <= c),
 * and a labelled ordering is found when the proposals imply it. Strict and non-strict
 * orderings are the same rule here. "also" labels are true but not required: they are never
 * false positives and never count against recall. "ignore" labels (rules the schema already
 * declares) are dropped from every side.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaModel } from "../../src/connect/types.js";
import { detectChecks, detectFk, detectUnique, type Rule } from "../../src/engine/rules.js";
import { checkProposal, parseLine, proposalKey, type Proposal } from "../../src/rulemodel/format.js";
import { CASES, heldoutSchema, heuristicRules, type HeldoutItem } from "./heldout.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJsonl = <T>(p: string): T[] => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

interface Label {
  id: string;
  gold: string[];
  also: string[];
  ignore: string[];
}
const CROSS = new Set(["order", "sum", "product", "copy"]);
type Group = "all" | "cross" | "code";
const group = (k: string): Group => (CROSS.has(k) ? "cross" : "code");

interface Tally {
  tp: number;
  fp: number;
  fn: number;
}
const tally = (): Record<Group, Tally> => ({ all: { tp: 0, fp: 0, fn: 0 }, cross: { tp: 0, fp: 0, fn: 0 }, code: { tp: 0, fp: 0, fn: 0 } });

function closure(table: string, ps: Proposal[]): Set<string> {
  const keys = new Set(ps.map((p) => proposalKey(table, p)));
  const edges = ps.filter((p): p is Extract<Proposal, { kind: "order" }> => p.kind === "order").map((p) => [p.earlier.toLowerCase(), p.later.toLowerCase()] as const);
  const nodes = new Set(edges.flat());
  for (const a of nodes) {
    const seen = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const n = stack.pop()!;
      for (const [x, y] of edges) if (x === n && !seen.has(y)) {
        seen.add(y);
        stack.push(y);
      }
    }
    for (const b of seen) if (b !== a) keys.add(`order:${table.toLowerCase()}.${a}<${b}`);
  }
  return keys;
}

const parse = (lines: string[]) => lines.map(parseLine).filter((p): p is Proposal => !!p);

export function score(items: HeldoutItem[], labels: Map<string, Label>, predict: (i: HeldoutItem) => Proposal[]) {
  const t = tally();
  const misses: string[] = [];
  const wrong: string[] = [];
  for (const i of items) {
    const l = labels.get(i.id);
    if (!l) continue;
    const tbl = i.table;
    const ignore = new Set(parse(l.ignore).map((p) => proposalKey(tbl, p)));
    const gold = [...parse(l.gold), ...parse(i.declared)].filter((p) => !ignore.has(proposalKey(tbl, p)));
    const also = parse(l.also);
    const okKeys = closure(tbl, [...gold, ...also]);
    const pred = predict(i).filter((p) => !ignore.has(proposalKey(tbl, p)));
    const predKeys = closure(tbl, pred);
    const seen = new Set<string>();
    for (const p of pred) {
      const k = proposalKey(tbl, p);
      if (seen.has(k)) continue;
      seen.add(k);
      const g = group(p.kind);
      if (okKeys.has(k)) {
        if (gold.some((x) => proposalKey(tbl, x) === k) || p.kind === "order") {
          // counted on the recall side below; a correct but unlabelled-as-required rule is neutral
        }
      } else {
        t[g].fp++;
        t.all.fp++;
        wrong.push(`${i.id}: ${k}`);
      }
    }
    const goldKeys = new Set<string>();
    for (const p of gold) {
      const k = proposalKey(tbl, p);
      if (goldKeys.has(k)) continue;
      goldKeys.add(k);
      const g = group(p.kind);
      if (predKeys.has(k)) {
        t[g].tp++;
        t.all.tp++;
      } else {
        t[g].fn++;
        t.all.fn++;
        misses.push(`${i.id}: ${k}`);
      }
    }
  }
  const metrics = Object.fromEntries(
    (Object.keys(t) as Group[]).map((g) => {
      const { tp, fp, fn } = t[g];
      return [g, { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null }];
    }),
  );
  return { metrics, misses, wrong };
}

/** The rules a plan has before inference: declared keys, uniques, checks. */
function declaredRules(schema: SchemaModel): Rule[] {
  return [...detectFk(schema), ...detectUnique(schema), ...detectChecks(schema)];
}

export interface Answer {
  id: string;
  output: string;
  /** Per-line confidence from the CLI decoder (lowest token probability in the line). */
  lines?: { text: string; p: number }[];
  ms?: number;
}

export function evaluate(answers: Answer[], split: "dev" | "test" | "all" = "all", minP = 0) {
  const items = readJsonl<HeldoutItem>(join(HERE, "heldout.jsonl")).filter((i) => split === "all" || i.split === split);
  const labels = new Map(readJsonl<Label>(join(HERE, "labels.jsonl")).map((l) => [l.id, { ...l, ignore: [...l.ignore] }]));
  const byId = new Map(answers.map((a) => [a.id, a]));
  const schemas = new Map<string, SchemaModel>();
  const schemaOf = (c: string) => {
    if (!schemas.has(c)) schemas.set(c, heldoutSchema(CASES.find((x) => x.id === c)!));
    return schemas.get(c)!;
  };
  const heurOf = new Map<string, Rule[]>();
  const heurRulesOf = (c: string) => {
    if (!heurOf.has(c)) heurOf.set(c, heuristicRules(CASES.find((x) => x.id === c)!, schemaOf(c)));
    return heurOf.get(c)!;
  };
  let lines = 0;
  let unparsed = 0;
  let rejected = 0;
  const rejections: string[] = [];
  const accepted = new Map<string, Proposal[]>();
  const combined = new Map<string, Proposal[]>();
  for (const i of items) {
    const a = byId.get(i.id);
    const out = a?.lines ? a.lines.filter((l) => l.p >= minP).map((l) => l.text) : (a?.output ?? "none").split("\n").map((s) => s.trim()).filter(Boolean);
    const schema = schemaOf(i.case);
    const table = schema.tables.find((t) => t.name === i.table)!;
    const base = declaredRules(schema);
    const heur = parse(i.heuristics);
    const ok: Proposal[] = [];
    const both: Proposal[] = [...heur];
    const heurKeys = new Set(heur.map((p) => proposalKey(i.table, p)));
    const combinedRules: Rule[] = [...heurRulesOf(i.case)];
    for (const line of out) {
      if (line === "none") continue;
      lines++;
      const p = parseLine(line);
      if (!p) {
        unparsed++;
        rejections.push(`${i.id}: unreadable "${line}"`);
        continue;
      }
      const v = checkProposal(schema, table, p, base, "gr-rules-1", i.code);
      if (!v.ok) {
        rejected++;
        rejections.push(`${i.id}: ${line} (${v.reason})`);
        continue;
      }
      ok.push(p);
      // Combined, as the CLI runs it: checked again against the heuristics' rules (plus the model's
      // accepted ones so far); only what's new is added.
      const k = proposalKey(i.table, p);
      if (heurKeys.has(k)) continue;
      const vc = checkProposal(schema, table, p, combinedRules, "gr-rules-1", i.code);
      if (!vc.ok) continue;
      combinedRules.push(vc.rule);
      heurKeys.add(k);
      both.push(p);
    }
    accepted.set(i.id, ok);
    combined.set(i.id, both);
    // A code "maxlen" equal to the column's declared length changes nothing: redundant everywhere.
    const l = labels.get(i.id);
    if (l) for (const line of [...out, ...i.heuristics, ...l.gold, ...l.also]) {
      const p = parseLine(line);
      const c = p && p.kind === "maxlen" ? table.columns.find((x) => x.name.toLowerCase() === p.column.toLowerCase()) : undefined;
      if (p && p.kind === "maxlen" && c?.maxLength !== undefined && p.value >= c.maxLength) l.ignore.push(line);
    }
  }
  const ms = answers.map((a) => a.ms).filter((x): x is number => typeof x === "number");
  return {
    tables: items.filter((i) => labels.has(i.id)).length,
    labelled_rules: items.reduce((n, i) => n + (labels.get(i.id)?.gold.length ?? 0) + i.declared.length, 0),
    declared_rules: items.reduce((n, i) => n + i.declared.length, 0),
    heuristics: score(items, labels, (i) => parse(i.heuristics)),
    model: score(items, labels, (i) => accepted.get(i.id) ?? []),
    combined: score(items, labels, (i) => combined.get(i.id) ?? []),
    declared_only: {
      heuristics: score(items.map((i) => ({ ...i })), new Map([...labels].map(([k, l]) => [k, { ...l, gold: [], also: [...l.gold, ...l.also] }])), (i) => parse(i.heuristics)).metrics.all.recall,
      model: score(items, new Map([...labels].map(([k, l]) => [k, { ...l, gold: [], also: [...l.gold, ...l.also] }])), (i) => accepted.get(i.id) ?? []).metrics.all.recall,
    },
    proposals: { lines, unreadable: unparsed, rejected, invalid_rate: lines ? (unparsed + rejected) / lines : 0 },
    rejections,
    latency_ms: ms.length ? { tables: ms.length, median: ms.sort((x, y) => x - y)[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)], total: ms.reduce((x, y) => x + y, 0) } : null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2]!;
  const si = process.argv.indexOf("--split");
  const pi = process.argv.indexOf("--min-p");
  const r = evaluate(readJsonl<Answer>(file), si > 0 ? (process.argv[si + 1] as "dev" | "test") : "all", pi > 0 ? Number(process.argv[pi + 1]) : 0);
  const fmt = (m: { precision: number | null; recall: number | null; tp: number; fp: number; fn: number }) => `P ${m.precision === null ? "-" : (m.precision * 100).toFixed(1)}%  R ${m.recall === null ? "-" : (m.recall * 100).toFixed(1)}%  (tp ${m.tp}, fp ${m.fp}, fn ${m.fn})`;
  console.log(`${r.tables} tables, ${r.labelled_rules} labelled rules (${r.declared_rules} declared by the schemas' authors)`);
  for (const s of ["heuristics", "model", "combined"] as const) for (const g of ["all", "cross", "code"] as const) console.log(`${s.padEnd(11)} ${g.padEnd(6)} ${fmt(r[s].metrics[g] as never)}`);
  console.log(`proposals: ${r.proposals.lines} lines, ${r.proposals.unreadable} unreadable, ${r.proposals.rejected} rejected by the validator (${(r.proposals.invalid_rate * 100).toFixed(1)}%)`);
  if (process.argv.includes("-v")) {
    console.log("\nmodel misses:\n  " + r.model.misses.join("\n  "));
    console.log("\nmodel wrong:\n  " + r.model.wrong.join("\n  "));
    console.log("\nheuristics wrong:\n  " + r.heuristics.wrong.join("\n  "));
    console.log("\nrejected:\n  " + r.rejections.join("\n  "));
  }
  const j = process.argv.indexOf("--json");
  if (j > 0) writeFileSync(process.argv[j + 1]!, JSON.stringify(r, null, 1));
}
