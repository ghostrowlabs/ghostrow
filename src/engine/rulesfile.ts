import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { findColumn, type SchemaModel } from "../connect/types.js";
import { ENGINE, ENGINE_VERSION, type Plan } from "./infer.js";
import { MEANINGS, type MeaningId } from "./meanings.js";
import { ruleColumnsExist, type Rule } from "./rules.js";

/**
 * ghostrow.rules.yaml: the reviewable plan. Ghostrow writes what it inferred; you edit it
 * and commit it. On the next run your edits win:
 *   - a column's `meaning` (and `values`) you changed is kept and used
 *   - `enabled: false` on a rule switches it off
 *   - rules you add (kind: check, with `expr`) are applied and checked
 *   - `rows:` on a table sets its row count
 * New tables and columns are added; rules for columns that no longer exist are dropped.
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
interface RulesFile {
  engine?: string;
  source?: string;
  tables?: Record<string, { rows?: number; columns?: Record<string, FileColumn> }>;
  rules?: FileRule[];
}

const HEADER = `# Ghostrow rules (${ENGINE}). Review and commit this file with your code.
# Change a column's meaning, add "values", set "rows" per table, switch a rule off with
# "enabled: false", or add your own:  - { kind: check, table: orders, expr: "total >= 0" }
# Your edits are kept on every run. Same schema + rules + --seed = same rows.
`;

export function readRulesFile(path: string): RulesFile | null {
  if (!existsSync(path)) return null;
  try {
    const doc = parse(readFileSync(path, "utf8")) as RulesFile | null;
    return doc && typeof doc === "object" ? doc : null;
  } catch (e) {
    throw new Error(`${path} is not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

/** Apply a rules file's edits onto a freshly inferred plan. */
export function mergeRules(plan: Plan, schema: SchemaModel, file: RulesFile | null): { plan: Plan; notes: string[] } {
  const notes: string[] = [];
  if (!file) return { plan, notes };
  const tables = file.tables ?? {};
  for (const [tname, t] of Object.entries(tables)) {
    const table = schema.tables.find((x) => x.name === tname);
    if (!table) continue;
    if (typeof t?.rows === "number" && t.rows >= 0) plan.rows[table.name] = Math.floor(t.rows);
    for (const [cname, c] of Object.entries(t?.columns ?? {})) {
      const inferred = plan.columns.find((x) => x.table === table.name && x.column === cname);
      if (!inferred || !findColumn(table, cname)) continue;
      if (c?.meaning && c.meaning !== inferred.meaning) {
        if ((MEANINGS as readonly string[]).includes(c.meaning)) {
          inferred.meaning = c.meaning as MeaningId;
          inferred.pinned = true;
          inferred.evidence = "set in rules file";
          inferred.confidence = 1;
        } else notes.push(`${tname}.${cname}: unknown meaning "${c.meaning}" ignored. Known meanings: ${MEANINGS.join(", ")}.`);
      }
      if (Array.isArray(c?.values) && c.values.length) {
        inferred.values = c.values;
        inferred.pinned = true;
      }
    }
  }
  const byId = new Map((file.rules ?? []).filter((r) => r?.id).map((r) => [r.id!, r]));
  for (const r of plan.rules) {
    const f = byId.get(r.id);
    if (f && f.enabled === false) r.enabled = false;
  }
  for (const f of file.rules ?? []) {
    if (!f || plan.rules.some((r) => r.id === f.id)) continue;
    if (f.source === "rules file" || !f.id || f.id.startsWith("user:")) {
      if (f.kind === "check" && f.table && f.expr && schema.tables.some((t) => t.name === f.table)) {
        plan.rules.push({ id: f.id ?? `user:${f.table}.${plan.rules.length}`, kind: "check", table: f.table, check: f.expr, expr: `CHECK (${f.expr})`, evidence: "added in rules file", source: "rules file", enabled: f.enabled !== false });
      } else if (f.kind && f.kind !== "check") notes.push(`Rule ${f.id ?? "(no id)"}: only "check" rules can be added by hand.`);
    }
  }
  plan.rules = plan.rules.filter((r) => ruleColumnsExist(schema, r));
  return { plan, notes };
}

/** Write the merged plan back. Keeps your edits; adds what's new. */
export function writeRulesFile(path: string, plan: Plan, schema: SchemaModel): void {
  const doc: RulesFile = {
    engine: `${ENGINE}/${ENGINE_VERSION}`,
    source: schema.source,
    tables: Object.fromEntries(
      schema.tables.map((t) => [
        t.name,
        {
          ...(plan.rows[t.name] !== undefined ? { rows: plan.rows[t.name] } : {}),
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
  writeFileSync(path, HEADER + stringify(doc, { lineWidth: 0 }), "utf8");
}

function toFileRule(r: Rule): FileRule {
  return {
    id: r.id,
    kind: r.kind,
    table: r.table,
    expr: r.kind === "check" && r.source === "rules file" ? (r as Extract<Rule, { kind: "check" }>).check : r.expr,
    enabled: r.enabled,
    evidence: r.evidence,
    source: r.source,
  };
}
