import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Document, isMap, isScalar, isSeq, parse, parseDocument, type Node } from "yaml";
import { planChecks } from "./checks.js";
import { findColumn, type SchemaModel } from "../connect/types.js";
import { ENGINE, ENGINE_VERSION, type Plan } from "./infer.js";
import { MEANINGS, type MeaningId } from "./meanings.js";
import { ruleColumnsExist, type Rule } from "./rules.js";
import type { LoadedPack } from "./rulepacks.js";

/**
 * ghostrow.rules.yaml: the reviewable plan. Ghostrow writes what it inferred; you edit it
 * and commit it. On the next run your edits win:
 *   - a column's `meaning` (and `values`) you changed is kept and used
 *   - `enabled: false` on a rule switches it off
 *   - rules you add (kind: check, with `expr`) are applied and checked
 *   - `rows:` on a table sets its row count
 * New tables and columns are added; rules for columns that no longer exist are dropped.
 * Comments you add are kept when the file is rewritten (matched by table, column and rule id).
 *
 * Rule packs (Max): `extends:` names shared rules files (see rulepacks.ts). They apply first, in
 * order; your file applies last. What a pack set is written back marked `evidence: rule pack …`
 * (columns) or `source: rule pack` (rules) and is refreshed from the pack on every run. To
 * override a pack's meaning, change it and remove that evidence line.
 */

interface FileColumn {
  meaning?: string;
  values?: (string | number)[];
  confidence?: number;
  evidence?: string;
}
interface FileRule {
  id?: string;
  kind?: string;
  table?: string;
  expr?: string;
  enabled?: boolean;
  evidence?: string;
  source?: string;
}
export interface RulesFile {
  engine?: string;
  source?: string;
  extends?: unknown;
  tables?: Record<string, { rows?: number; columns?: Record<string, FileColumn> }>;
  rules?: FileRule[];
}

const HEADER_LINES = [
  ` Ghostrow rules (${ENGINE}). Review and commit this file with your code.`,
  ` Change a column's meaning, add "values", set "rows" per table, switch a rule off with`,
  ` "enabled: false", or add your own:  - { kind: check, table: orders, expr: "total >= 0" }`,
  ` Your edits and comments are kept on every run. Same schema + rules + --seed = same rows.`,
];
const HEADER_START = " Ghostrow rules (";
/** The last header line as 1.0.0 wrote it, so upgrading doesn't keep it as "your" comment. */
const OLD_HEADER = [" Your edits are kept on every run. Same schema + rules + --seed = same rows."];

export function readRulesFile(path: string): RulesFile | null {
  if (!existsSync(path)) return null;
  try {
    const doc = parse(readFileSync(path, "utf8")) as RulesFile | null;
    return doc && typeof doc === "object" ? doc : null;
  } catch (e) {
    throw new Error(`${path} is not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

const PACK_EVIDENCE = "rule pack ";
const fromPack = (evidence: unknown) => typeof evidence === "string" && evidence.startsWith(PACK_EVIDENCE);

type Origin = { kind: "local" } | { kind: "pack"; label: string };

/** Apply a rules file's edits onto a freshly inferred plan: each pack in order, then your file. */
export function mergeRules(plan: Plan, schema: SchemaModel, file: RulesFile | null, packs: { pack: LoadedPack; label: string }[] = []): { plan: Plan; notes: string[] } {
  const notes: string[] = [];
  for (const { pack, label } of packs) applyFile(plan, schema, pack.file, { kind: "pack", label }, notes);
  if (file) applyFile(plan, schema, file, { kind: "local" }, notes);
  if (!file && !packs.length) return { plan, notes };
  plan.rules = plan.rules.filter((r) => ruleColumnsExist(schema, r));
  notes.push(...valuesAgainstChecks(plan));
  return { plan, notes };
}

function applyFile(plan: Plan, schema: SchemaModel, file: RulesFile, origin: Origin, notes: string[]): void {
  const where = origin.kind === "pack" ? `rule pack ${origin.label}: ` : "";
  const tables = file.tables ?? {};
  for (const [tname, t] of Object.entries(tables)) {
    const table = schema.tables.find((x) => x.name === tname);
    // A pack covers many schemas: its tables that aren't in this one are simply not used.
    if (!table) continue;
    if (typeof t?.rows === "number" && t.rows >= 0) {
      const packSet = plan.packRows?.[table.name];
      // Your file holds a copy of a pack's row count only if you set it; a copy equal to the pack's is not an edit.
      if (origin.kind === "pack") {
        plan.rows[table.name] = Math.floor(t.rows);
        (plan.packRows ??= {})[table.name] = origin.label;
      } else if (!(packSet && plan.rows[table.name] === Math.floor(t.rows))) {
        plan.rows[table.name] = Math.floor(t.rows);
        if (plan.packRows) delete plan.packRows[table.name];
      }
    }
    for (const [cname, c] of Object.entries(t?.columns ?? {})) {
      const inferred = plan.columns.find((x) => x.table === table.name && x.column === cname);
      if (!inferred || !findColumn(table, cname)) continue;
      // A copy of a pack's value written back to your file: the pack decides it, not the copy.
      if (origin.kind === "local" && fromPack(c?.evidence)) continue;
      const evidence = origin.kind === "pack" ? `${PACK_EVIDENCE}${origin.label}` : "set in rules file";
      if (c?.meaning && c.meaning !== inferred.meaning) {
        if ((MEANINGS as readonly string[]).includes(c.meaning)) {
          inferred.meaning = c.meaning as MeaningId;
          inferred.pinned = true;
          inferred.evidence = evidence;
          inferred.confidence = 1;
        } else notes.push(`${where}${tname}.${cname}: unknown meaning "${c.meaning}" ignored. Known meanings: ${MEANINGS.join(", ")}.`);
      } else if (c?.meaning && origin.kind === "pack") {
        inferred.pinned = true;
        inferred.evidence = evidence;
        inferred.confidence = 1;
      }
      if (Array.isArray(c?.values) && c.values.length) {
        inferred.values = c.values;
        inferred.pinned = true;
        if (origin.kind === "pack") inferred.evidence = evidence;
      }
    }
  }
  const byId = new Map((file.rules ?? []).filter((r) => r?.id).map((r) => [String(r.id), r]));
  for (const r of plan.rules) {
    const f = byId.get(r.id);
    if (f && f.enabled === false) r.enabled = false;
  }
  for (const f of file.rules ?? []) {
    if (!f || typeof f !== "object") continue;
    const existing = f.id !== undefined ? plan.rules.find((r) => r.id === String(f.id)) : undefined;
    // A later pack may replace an earlier pack's rule with the same id; otherwise the first one stays.
    if (existing && !(origin.kind === "pack" && existing.source === "rule pack")) continue;
    // A rule Ghostrow inferred earlier (schema, sampled, code), or a pack rule copied into your file,
    // that no longer applies is stale: drop it. Anything else is yours, whatever its id: keep it.
    const handAdded = origin.kind === "pack" || f.source === undefined || f.source === "rules file" || !f.id || String(f.id).startsWith("user:");
    if (!handAdded) continue;
    const label = `${where}Rule ${f.id ?? "(no id)"}`;
    if (f.kind !== undefined && f.kind !== "check") {
      notes.push(`${label}: only "check" rules can be added by hand; ignored.`);
    } else if (!f.table || !f.expr) {
      notes.push(`${label}: a hand-added rule needs "table" and "expr"; ignored.`);
    } else if (!schema.tables.some((t) => t.name === f.table)) {
      // A pack's rule for a table this schema doesn't have is not a mistake: packs are shared.
      if (origin.kind === "local") notes.push(`${label}: no table "${f.table}" in ${schema.source}; ignored.`);
    } else {
      const id = f.id !== undefined ? String(f.id) : `${origin.kind === "pack" ? "pack" : "user"}:${f.table}.${plan.rules.length}`;
      const rule: Rule = {
        id,
        kind: "check",
        table: f.table,
        check: f.expr,
        expr: `CHECK (${f.expr})`,
        evidence: origin.kind === "pack" ? `${PACK_EVIDENCE}${origin.label}` : "added in rules file",
        source: origin.kind === "pack" ? "rule pack" : "rules file",
        enabled: f.enabled !== false,
      };
      if (existing) plan.rules[plan.rules.indexOf(existing)] = rule;
      else plan.rules.push(rule);
    }
  }
}

/** Write the merged plan back. Keeps your edits; adds what's new. */
export function writeRulesFile(path: string, plan: Plan, schema: SchemaModel): void {
  let keepExtends: unknown;
  if (existsSync(path)) {
    try {
      keepExtends = (parse(readFileSync(path, "utf8")) as RulesFile | null)?.extends;
    } catch {
      keepExtends = undefined;
    }
  }
  const data: RulesFile = {
    engine: `${ENGINE}/${ENGINE_VERSION}`,
    source: schema.source,
    ...(keepExtends !== undefined && keepExtends !== null ? { extends: keepExtends } : {}),
    tables: Object.fromEntries(
      schema.tables.map((t) => [
        t.name,
        {
          ...(plan.rows[t.name] !== undefined && !plan.packRows?.[t.name] ? { rows: plan.rows[t.name] } : {}),
          columns: Object.fromEntries(
            plan.columns
              .filter((c) => c.table === t.name)
              .map((c) => [c.column, { meaning: c.meaning, ...(c.values ? { values: c.values } : {}), confidence: c.confidence, evidence: c.evidence }]),
          ),
        },
      ]),
    ),
    rules: plan.rules.map(toFileRule),
  };
  const next = new Document(data);
  let extra: string[] = [];
  if (existsSync(path)) {
    try {
      const old = parseDocument(readFileSync(path, "utf8"));
      if (!old.errors.length) {
        const comments = new Map<string, Comments>();
        collectComments(old.contents, "", comments);
        applyComments(next.contents, "", comments);
        extra = (old.commentBefore ?? "").split("\n").filter((l) => !HEADER_LINES.includes(l) && !OLD_HEADER.includes(l) && !l.startsWith(HEADER_START));
        while (extra.length && extra[0]!.trim() === "") extra.shift();
        if (old.comment) next.comment = old.comment;
      }
    } catch {
      // An unreadable old file just means there are no comments to carry over.
    }
  }
  next.commentBefore = [...HEADER_LINES, ...(extra.length ? ["", ...extra] : [])].join("\n");
  writeFileSync(path, next.toString({ lineWidth: 0 }), "utf8");
}

interface Comments {
  before?: string;
  after?: string;
  keyBefore?: string;
  keyAfter?: string;
}

/** Rules are matched by id, so comments follow a rule when rules are added or removed. */
function itemKey(item: unknown, i: number): string {
  if (isMap(item)) {
    const id = item.get("id");
    if (typeof id === "string" || typeof id === "number") return `#${id}`;
  }
  return String(i);
}

const keyOf = (k: unknown) => (isScalar(k) ? String(k.value) : String(k));

function collectComments(node: unknown, path: string, out: Map<string, Comments>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (n.commentBefore || n.comment) out.set(path, { ...out.get(path), ...(n.commentBefore ? { before: n.commentBefore } : {}), ...(n.comment ? { after: n.comment } : {}) });
  if (isMap(n)) {
    for (const pair of n.items) {
      const p = `${path}/${keyOf(pair.key)}`;
      collectComments(pair.value, p, out);
      if (isScalar(pair.key) && (pair.key.commentBefore || pair.key.comment)) {
        out.set(p, { ...out.get(p), ...(pair.key.commentBefore ? { keyBefore: pair.key.commentBefore } : {}), ...(pair.key.comment ? { keyAfter: pair.key.comment } : {}) });
      }
    }
  } else if (isSeq(n)) {
    n.items.forEach((item, i) => collectComments(item, `${path}/${itemKey(item, i)}`, out));
  }
}

function applyComments(node: unknown, path: string, comments: Map<string, Comments>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  const c = comments.get(path);
  if (c?.before) n.commentBefore = c.before;
  if (c?.after) n.comment = c.after;
  if (isMap(n)) {
    for (const pair of n.items) {
      const p = `${path}/${keyOf(pair.key)}`;
      const kc = comments.get(p);
      if (isScalar(pair.key) && kc) {
        if (kc.keyBefore) pair.key.commentBefore = kc.keyBefore;
        if (kc.keyAfter) pair.key.comment = kc.keyAfter;
      }
      applyComments(pair.value, p, comments);
    }
  } else if (isSeq(n)) {
    n.items.forEach((item, i) => applyComments(item, `${path}/${itemKey(item, i)}`, comments));
  }
}

/** Notes for `values:` edits that a CHECK on the same column narrows or overrides. */
function valuesAgainstChecks(plan: Plan): string[] {
  const notes: string[] = [];
  for (const c of plan.columns) {
    if (!c.pinned || !c.values?.length) continue;
    const exprs = plan.rules.filter((r): r is Extract<Rule, { kind: "check" }> => r.kind === "check" && r.enabled && r.table === c.table).map((r) => r.check);
    if (!exprs.length) continue;
    const limits = planChecks(exprs).plan.limits;
    const l = limits.get(c.column) ?? [...limits.entries()].find(([k]) => k.toLowerCase() === c.column.toLowerCase())?.[1];
    if (!l?.values?.length) continue;
    const allowed = new Set(l.values.map(String));
    const out = c.values.filter((v) => !allowed.has(String(v)));
    if (!out.length) continue;
    notes.push(
      out.length === c.values.length
        ? `${c.table}.${c.column}: none of your values (${out.join(", ")}) pass the column's CHECK, so the CHECK's list is used: ${l.values.join(", ")}.`
        : `${c.table}.${c.column}: ${out.join(", ")} left out of your values; the column's CHECK doesn't allow ${out.length === 1 ? "it" : "them"}.`,
    );
  }
  return notes;
}

function toFileRule(r: Rule): FileRule {
  return {
    id: r.id,
    kind: r.kind,
    table: r.table,
    expr: r.kind === "check" && (r.source === "rules file" || r.source === "rule pack") ? (r as Extract<Rule, { kind: "check" }>).check : r.expr,
    enabled: r.enabled,
    evidence: r.evidence,
    source: r.source,
  };
}
