/**
 * The real held-out set for gr-rules-1: public schemas (and application code) that neither the
 * model's training data nor its vocabulary came from. Builds, for every table the CLI would
 * ask about, the exact prompt the CLI sends, and the heuristic baseline's rules for it.
 *
 *   npx tsx eval/rules/heldout.ts            → eval/rules/heldout.jsonl
 *
 * Cross-column CHECKs the schema's authors declared (DueDate >= OrderDate) are taken out of
 * the input and kept as labels: an objective part of the answer key that nobody here wrote.
 * The rest of the labels are hand-written in labels.jsonl (see LABELING.md).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDjango, readLaravel, readPydantic, readZod, applyCodeRules } from "../../src/code/index.js";
import { loadSchema } from "../../src/connect/load.js";
import type { SchemaModel, TableModel } from "../../src/connect/types.js";
import { infer } from "../../src/engine/infer.js";
import { codeContext, type CodeFile } from "../../src/rulemodel/code.js";
import { askable, proposalKey, proposalLine, ruleAsProposal, tablePrompt, type Proposal } from "../../src/rulemodel/format.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../..");

export interface Case {
  id: string;
  /** Schema file or folder, relative to cli/. */
  schema: string;
  /** Code files, relative to cli/ (code cases). */
  code?: string[];
  /** Only these tables (default: every table the CLI would ask about). */
  tables?: string[];
  /** A seeded sample of this many askable tables (by SHA-256 of the name), for very large schemas. */
  sample?: number;
  split: "dev" | "test";
  source: string;
  license: string;
}

export interface HeldoutItem {
  id: string;
  case: string;
  split: "dev" | "test";
  table: string;
  user: string;
  /** Rules declared as CHECKs by the schema's authors, taken out of the input. */
  declared: string[];
  /** What the current heuristics propose for this table (rule lines in the model's format). */
  heuristics: string[];
  code: boolean;
}

const ORDER_CHECK = /^\(*\s*"?(\w+)"?\s*(>=|>|<=|<)\s*"?(\w+)"?\s*\)*(\s*OR\s*\(*\s*"?\w+"?\s+IS\s+NULL\s*\)*)*$/i;

/** Take author-declared "a >= b" CHECKs out of a table; return them as order proposals. */
export function stripDeclared(t: TableModel): Proposal[] {
  const out: Proposal[] = [];
  t.checks = t.checks.filter((c) => {
    const x = c.replace(/\s+/g, " ").trim().replace(/^\((.*)\)$/, "$1").replace(/^\((.*)\)$/, "$1").replace(/OR\(/gi, "OR (");
    const m = ORDER_CHECK.exec(x);
    if (!m) return true;
    const a = t.columns.find((k) => k.name.toLowerCase() === m[1]!.toLowerCase());
    const b = t.columns.find((k) => k.name.toLowerCase() === m[3]!.toLowerCase());
    if (!a || !b) return true;
    const lessFirst = m[2]!.startsWith("<");
    out.push({ kind: "order", earlier: (lessFirst ? a : b).name, later: (lessFirst ? b : a).name, strict: !m[2]!.includes("=") });
    return false;
  });
  return out;
}

function heuristicCode(schema: SchemaModel, files: CodeFile[]) {
  const plan = infer(schema);
  const found = files.flatMap((f) => [
    ...(/\.(ts|tsx|js|mjs|cjs)$/.test(f.file) && /\bz\.object\(/.test(f.text) ? readZod(f.text, f.file) : []),
    ...(f.file.endsWith(".py") && /BaseModel|pydantic/.test(f.text) ? readPydantic(f.text, f.file) : []),
    ...(f.file.endsWith(".py") && /models\.Model/.test(f.text) ? readDjango(f.text, f.file) : []),
    ...(f.file.endsWith(".php") && /=>\s*['"[]/.test(f.text) && /(validate|rules)\s*\(/.test(f.text) ? readLaravel(f.text, f.file) : []),
  ]);
  applyCodeRules(plan, schema, found);
  return plan;
}

export function buildHeldout(cases: Case[]): HeldoutItem[] {
  const items: HeldoutItem[] = [];
  for (const c of cases) {
    const schema = loadSchema(resolve(CLI, c.schema));
    const declared = new Map(schema.tables.map((t) => [t.name, stripDeclared(t)]));
    const files: CodeFile[] = (c.code ?? []).map((p) => ({ file: p.replace(/^eval\/rules\/code\/[^/]+\//, ""), text: readFileSync(resolve(CLI, p), "utf8") }));
    const plan = files.length ? heuristicCode(schema, files) : infer(schema);
    const h = (n: string) => createHash("sha256").update(n).digest("hex");
    const sampled = c.sample ? new Set(schema.tables.filter((t) => askable(schema, t)).sort((a, b) => h(a.name).localeCompare(h(b.name))).slice(0, c.sample).map((t) => t.name)) : null;
    for (const t of schema.tables) {
      if (c.tables && !c.tables.includes(t.name)) continue;
      if (sampled && !sampled.has(t.name)) continue;
      const blocks = files.length ? codeContext(t, files) : [];
      if (!askable(schema, t, blocks.length ? "code" : undefined)) continue;
      const heur = plan.rules
        .filter((r) => r.table === t.name && r.kind !== "fk" && r.kind !== "unique" && (r.kind !== "check" || r.source === "code"))
        .map((r) => ruleAsProposal(schema, r))
        .filter((p): p is Proposal => !!p);
      items.push({
        id: `${c.id}.${t.name}`,
        case: c.id,
        split: c.split,
        table: t.name,
        user: tablePrompt(schema, t, blocks),
        declared: (declared.get(t.name) ?? []).map(proposalLine),
        heuristics: [...new Set(heur.map(proposalLine))],
        code: blocks.length > 0,
      });
    }
  }
  return items;
}

/** The plan rules the heuristics produce for a case (what the CLI has before the rule model runs). */
export function heuristicRules(c: Case, schema: SchemaModel) {
  const files: CodeFile[] = (c.code ?? []).map((p) => ({ file: p.replace(/^eval\/rules\/code\/[^/]+\//, ""), text: readFileSync(resolve(CLI, p), "utf8") }));
  return (files.length ? heuristicCode(schema, files) : infer(schema)).rules;
}

/** The schema a held-out item was built from (with its declared CHECKs stripped), for the validator. */
export function heldoutSchema(c: Case): SchemaModel {
  const s = loadSchema(resolve(CLI, c.schema));
  for (const t of s.tables) stripDeclared(t);
  return s;
}

export const CASES: Case[] = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")).cases;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const items = buildHeldout(CASES);
  writeFileSync(join(HERE, "heldout.jsonl"), items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  console.log(`${items.length} tables (${items.filter((i) => i.code).length} with code, ${items.reduce((n, i) => n + i.declared.length, 0)} declared rules) → eval/rules/heldout.jsonl`);
  void proposalKey;
}
