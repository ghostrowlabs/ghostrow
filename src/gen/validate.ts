import { findColumn } from "../connect/types.js";
import { evaluate, parseCheck } from "../engine/checks.js";
import type { Plan } from "../engine/infer.js";
import type { GenOutput, Row } from "./seed.js";

export interface Violation {
  table: string;
  row: number;
  rule: string;
}

export interface Validation {
  rows: number;
  checked: { foreignKeys: number; uniques: number; checks: number; orderings: number; sums: number };
  violations: Violation[];
}

const key = (row: Row, cols: string[]) => cols.map((c) => (row[c] instanceof Buffer ? (row[c] as Buffer).toString("hex") : String(row[c]))).join("\u0001");

/**
 * Re-checks every generated row against the schema and every enabled rule, independently
 * of how the rows were made: NOT NULL, lengths, enums, uniqueness, foreign keys, CHECKs,
 * orderings, products and sums. `seed` reports the result; it never writes rows that fail.
 */
export function validate(out: GenOutput, plan: Plan, options: { skip?: Set<string> } = {}): Validation {
  const violations: Violation[] = [];
  const v: Validation = { rows: 0, checked: { foreignKeys: 0, uniques: 0, checks: 0, orderings: 0, sums: 0 }, violations };
  const add = (table: string, row: number, rule: string) => {
    if (violations.length < 200) violations.push({ table, row: row + 1, rule });
  };
  const rowsOf = new Map(out.map((o) => [o.table.name, o.rows]));

  for (const { table, rows } of out) {
    v.rows += rows.length;
    rows.forEach((row, i) => {
      for (const c of table.columns) {
        const val = row[c.name];
        if (c.defaultValue?.startsWith("generated:")) continue;
        if ((val === null || val === undefined) && !c.nullable && !(c.autoIncrement && val === undefined)) add(table.name, i, `${c.name} is NOT NULL`);
        if (typeof val === "string" && c.maxLength !== undefined && val.length > c.maxLength) add(table.name, i, `${c.name} longer than ${c.maxLength}`);
        if (c.type === "enum" && val !== null && val !== undefined && c.enumValues && !c.enumValues.includes(String(val))) add(table.name, i, `${c.name} not in enum`);
      }
    });
  }

  for (const r of plan.rules) {
    if (!r.enabled || options.skip?.has(r.id)) continue;
    const rows = rowsOf.get(r.table);
    if (!rows) continue;
    switch (r.kind) {
      case "unique": {
        v.checked.uniques++;
        const seen = new Set<string>();
        rows.forEach((row, i) => {
          if (r.columns.some((c) => row[c] === null || row[c] === undefined)) return;
          const k = key(row, r.columns);
          if (seen.has(k)) add(r.table, i, r.expr);
          seen.add(k);
        });
        break;
      }
      case "fk": {
        v.checked.foreignKeys++;
        const parents = rowsOf.get(r.refTable);
        if (!parents) break; // parent not generated (outside the run): the database checks it
        const keys = new Set(parents.map((p) => key(p, r.refColumns)));
        rows.forEach((row, i) => {
          if (r.columns.some((c) => row[c] === null || row[c] === undefined)) return;
          if (!keys.has(key(row, r.columns))) add(r.table, i, r.expr);
        });
        break;
      }
      case "check": {
        v.checked.checks++;
        const tree = parseCheck(r.check);
        if (!tree) break;
        rows.forEach((row, i) => {
          if (evaluate(tree, row) === false) add(r.table, i, r.expr);
        });
        break;
      }
      case "order": {
        v.checked.orderings++;
        rows.forEach((row, i) => {
          const a = row[r.earlier];
          const b = row[r.later];
          if (a === null || a === undefined || b === null || b === undefined) return;
          const sa = typeof a === "number" ? a : String(a).replace("T", " ");
          const sb = typeof b === "number" ? b : String(b).replace("T", " ");
          if (sa > sb || (r.strict && sa === sb)) add(r.table, i, r.expr);
        });
        break;
      }
      case "product": {
        const t = out.find((o) => o.table.name === r.table)!.table;
        const scale = findColumn(t, r.column)?.scale ?? 2;
        rows.forEach((row, i) => {
          const [q, p] = r.factors;
          if (row[q] === null || row[p] === null || row[r.column] === null) return;
          if (Math.abs(Number(row[q]) * Number(row[p]) - Number(row[r.column])) > 10 ** -scale) add(r.table, i, r.expr);
        });
        break;
      }
      case "copy": {
        const fk = plan.rules.find((x) => x.id === r.fk);
        if (!fk || fk.kind !== "fk") break;
        const parents = rowsOf.get(fk.refTable);
        if (!parents) break;
        const byKey = new Map(parents.map((p) => [key(p, fk.refColumns), p]));
        rows.forEach((row, i) => {
          const p = byKey.get(key(row, fk.columns));
          if (p && row[r.column] !== null && String(p[r.refColumn]) !== String(row[r.column])) add(r.table, i, r.expr);
        });
        break;
      }
      case "sum": {
        v.checked.sums++;
        const children = rowsOf.get(r.childTable);
        if (!children) break;
        const sums = new Map<string, number>();
        for (const c of children) {
          if (c[r.childColumn] === null) continue;
          const k = key(c, r.childFk);
          sums.set(k, (sums.get(k) ?? 0) + Math.round(Number(c[r.childColumn]) * 1e6));
        }
        rows.forEach((row, i) => {
          const expected = (sums.get(key(row, r.parentKey)) ?? 0) / 1e6;
          if (Math.abs(Number(row[r.column]) - expected) > 0.005) add(r.table, i, r.expr);
        });
        break;
      }
    }
  }
  return v;
}
