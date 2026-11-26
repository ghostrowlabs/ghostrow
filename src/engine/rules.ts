import { findColumn, type ColumnModel, type SchemaModel, type TableModel } from "../connect/types.js";
import { words } from "./meanings.js";

/**
 * Rules between columns. The generator satisfies every enabled rule by construction, and
 * the validator re-checks each one on every generated row.
 *
 *   fk       child columns point at an existing parent row
 *   unique   a column, or a group of columns, never repeats
 *   check    a CHECK constraint, or a rule from application code or the rules file
 *   order    one column is not later than another (starts_at ≤ ends_at)
 *   sum      a parent total equals the sum of its child lines
 *   product  a line amount equals quantity × unit price
 *   copy     a value comes from the referenced row (a line's unit price is the product's price)
 */

export type RuleSource = "schema" | "inferred" | "code" | "rules file";

interface RuleBase {
  id: string;
  table: string;
  /** Short human-readable form, as written to ghostrow.rules.yaml. */
  expr: string;
  evidence: string;
  source: RuleSource;
  enabled: boolean;
}

export type Rule =
  | (RuleBase & { kind: "fk"; columns: string[]; refTable: string; refColumns: string[] })
  | (RuleBase & { kind: "unique"; columns: string[] })
  | (RuleBase & { kind: "check"; check: string })
  | (RuleBase & { kind: "order"; earlier: string; later: string; strict: boolean })
  | (RuleBase & { kind: "sum"; column: string; childTable: string; childColumn: string; childFk: string[]; parentKey: string[] })
  | (RuleBase & { kind: "product"; column: string; factors: [string, string] })
  | (RuleBase & { kind: "copy"; column: string; fk: string; refColumn: string });

export type RuleKind = Rule["kind"];

const timeLike = (c: ColumnModel) => c.type === "date" || c.type === "datetime" || c.type === "time";
const numeric = (c: ColumnModel) => c.type === "integer" || c.type === "decimal" || c.type === "real";

export function primaryKeyOf(t: TableModel): string[] {
  if (t.primaryKey.length) return t.primaryKey;
  const unique = t.columns.find((c) => c.unique && !c.nullable);
  return unique ? [unique.name] : [];
}

export function detectFk(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      const parent = schema.tables.find((x) => x.name.toLowerCase() === fk.refTable.toLowerCase());
      const refColumns = fk.refColumns.length ? fk.refColumns : parent ? primaryKeyOf(parent) : ["id"];
      out.push({
        id: `fk:${t.name}.${fk.columns.join("+")}`,
        kind: "fk",
        table: t.name,
        columns: fk.columns,
        refTable: parent?.name ?? fk.refTable,
        refColumns,
        expr: `${t.name}.${fk.columns.join(", ")} → ${parent?.name ?? fk.refTable}.${refColumns.join(", ")}`,
        evidence: "declared FOREIGN KEY",
        source: "schema",
        enabled: true,
      });
    }
  }
  return out;
}

export function detectUnique(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  for (const t of schema.tables) {
    const groups: string[][] = [];
    if (t.primaryKey.length) groups.push(t.primaryKey);
    for (const c of t.columns) if (c.unique && !(t.primaryKey.length === 1 && t.primaryKey[0] === c.name)) groups.push([c.name]);
    groups.push(...t.uniques);
    const seen = new Set<string>();
    for (const g of groups) {
      const key = [...g].sort().join("+");
      if (seen.has(key)) continue;
      seen.add(key);
      const isPk = g.join() === t.primaryKey.join();
      out.push({
        id: `unique:${t.name}.${g.join("+")}`,
        kind: "unique",
        table: t.name,
        columns: g,
        expr: g.length === 1 ? `${t.name}.${g[0]} is unique` : `UNIQUE (${g.join(", ")})`,
        evidence: isPk ? "PRIMARY KEY" : "declared UNIQUE",
        source: "schema",
        enabled: true,
      });
    }
  }
  return out;
}

export function detectChecks(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  for (const t of schema.tables) {
    t.checks.forEach((check, i) => {
      out.push({ id: `check:${t.name}.${i + 1}`, kind: "check", table: t.name, check, expr: `CHECK (${check})`, evidence: "declared CHECK", source: "schema", enabled: true });
    });
    for (const c of t.columns) {
      if (c.type === "enum" && c.enumValues?.length) {
        const check = `${c.name} IN (${c.enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
        out.push({ id: `values:${t.name}.${c.name}`, kind: "check", table: t.name, check, expr: `${c.name} is one of ${c.enumValues.join(", ")}`, evidence: "declared enum", source: "schema", enabled: true });
      }
    }
  }
  return out;
}

/** Word pairs where the first happens no later than the second, on columns that share the rest of their name. */
const ORDER_PAIRS: [string, string][] = [
  ["start", "end"],
  ["starts", "ends"],
  ["started", "ended"],
  ["start", "finish"],
  ["started", "finished"],
  ["started", "completed"],
  ["begin", "end"],
  ["begins", "ends"],
  ["from", "to"],
  ["from", "until"],
  ["valid", "expires"],
  ["open", "close"],
  ["opened", "closed"],
  ["opens", "closes"],
  ["created", "updated"],
  ["created", "modified"],
  ["created", "deleted"],
  ["created", "closed"],
  ["created", "completed"],
  ["issued", "expires"],
  ["issued", "due"],
  ["issue", "due"],
  ["issued", "paid"],
  ["ordered", "shipped"],
  ["shipped", "delivered"],
  ["placed", "shipped"],
  ["check", "check"],
  ["checkin", "checkout"],
  ["arrival", "departure"],
  ["departure", "arrival"],
  ["birth", "death"],
  ["min", "max"],
  ["low", "high"],
  ["hired", "terminated"],
  ["enrolled", "graduated"],
];

function orderStem(name: string, word: string): string | null {
  const w = words(name);
  const i = w.indexOf(word);
  if (i < 0) return null;
  return [...w.slice(0, i), "*", ...w.slice(i + 1)].join("_");
}

export function detectOrdering(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  for (const t of schema.tables) {
    const done = new Set<string>();
    for (const [a, b] of ORDER_PAIRS) {
      for (const early of t.columns) {
        for (const late of t.columns) {
          if (early === late || done.has(late.name)) continue;
          const kindOk = (timeLike(early) && timeLike(late)) || (numeric(early) && numeric(late) && (a === "min" || a === "low"));
          if (!kindOk) continue;
          let sa = orderStem(early.name, a);
          let sb = orderStem(late.name, b);
          if (a === "check") {
            // check_in / check_out
            sa = /check_?in/i.test(early.name) ? early.name.toLowerCase().replace(/check_?in/, "*") : null;
            sb = /check_?out/i.test(late.name) ? late.name.toLowerCase().replace(/check_?out/, "*") : null;
          }
          if (sa === null || sb === null || sa !== sb) continue;
          done.add(late.name);
          out.push({
            id: `order:${t.name}.${early.name}<=${late.name}`,
            kind: "order",
            table: t.name,
            earlier: early.name,
            later: late.name,
            strict: false,
            expr: `${late.name} is not before ${early.name}`,
            evidence: `column names ${early.name} / ${late.name}`,
            source: "inferred",
            enabled: true,
          });
        }
      }
    }
  }
  return out;
}

const isTotalName = (c: ColumnModel) => {
  const w = words(c.name);
  return w.includes("total") || w.includes("subtotal") || (w.length === 1 && w[0] === "amount") || w.join("_") === "grand_total";
};
const lineScore = (c: ColumnModel) => {
  const j = words(c.name).join("_");
  if (/^(line_?total|line_?amount|extended_?(price|amount)|amount|total|subtotal|net_?amount)$/.test(j)) return 3;
  if (/(amount|total)$/.test(j)) return 2;
  return 0;
};
const moneyish = (c: ColumnModel) => c.type === "decimal" || c.type === "integer" || c.type === "real";

export function detectAggregates(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  const used = new Set<string>();
  for (const child of schema.tables) {
    for (const fk of child.foreignKeys) {
      const parent = schema.tables.find((t) => t.name.toLowerCase() === fk.refTable.toLowerCase());
      if (!parent || parent === child) continue;
      const parentCol = parent.columns.find((c) => moneyish(c) && isTotalName(c) && !c.primaryKey);
      if (!parentCol || used.has(`${parent.name}.${parentCol.name}`)) continue;
      const candidates = child.columns.filter((c) => moneyish(c) && !fk.columns.includes(c.name) && !c.primaryKey && lineScore(c) > 0).sort((x, y) => lineScore(y) - lineScore(x));
      const childCol = candidates[0];
      if (!childCol) continue;
      used.add(`${parent.name}.${parentCol.name}`);
      const parentKey = fk.refColumns.length ? fk.refColumns : primaryKeyOf(parent);
      out.push({
        id: `sum:${parent.name}.${parentCol.name}`,
        kind: "sum",
        table: parent.name,
        column: parentCol.name,
        childTable: child.name,
        childColumn: childCol.name,
        childFk: fk.columns,
        parentKey,
        expr: `${parent.name}.${parentCol.name} = sum of ${child.name}.${childCol.name}`,
        evidence: `${child.name} references ${parent.name} and both carry an amount`,
        source: "inferred",
        enabled: true,
      });
    }
  }
  return out;
}

export function detectProducts(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  for (const t of schema.tables) {
    const qty = t.columns.find((c) => /^(quantity|qty|units|count)$/.test(words(c.name).join("_")) && numeric(c));
    const price = t.columns.find((c) => /^(unit_?price|price|unit_?cost|unit_?amount|rate)$/.test(words(c.name).join("_")) && numeric(c));
    const amount = t.columns.find((c) => c !== price && numeric(c) && /^(line_?total|line_?amount|extended_?(price|amount)|amount|total|subtotal)$/.test(words(c.name).join("_")));
    if (!qty || !price || !amount) continue;
    out.push({
      id: `product:${t.name}.${amount.name}`,
      kind: "product",
      table: t.name,
      column: amount.name,
      factors: [qty.name, price.name],
      expr: `${amount.name} = ${qty.name} × ${price.name}`,
      evidence: `column names ${qty.name}, ${price.name} and ${amount.name}`,
      source: "inferred",
      enabled: true,
    });
  }
  return out;
}

const PRICE_WORDS = /^(unit_?price|price|unit_?cost|cost|list_?price|rate|unit_?amount)$/;

/** A line's unit price comes from its product; a line's currency from its order. */
export function detectCopies(schema: SchemaModel): Rule[] {
  const out: Rule[] = [];
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      if (fk.columns.length !== 1) continue;
      const parent = schema.tables.find((x) => x.name.toLowerCase() === fk.refTable.toLowerCase());
      if (!parent || parent === t) continue;
      for (const c of t.columns) {
        if (fk.columns.includes(c.name) || c.primaryKey || t.foreignKeys.some((f) => f.columns.includes(c.name))) continue;
        const cw = words(c.name).join("_");
        let ref: ColumnModel | undefined;
        if (PRICE_WORDS.test(cw) && numeric(c)) ref = parent.columns.find((p) => numeric(p) && PRICE_WORDS.test(words(p.name).join("_")) && !p.primaryKey);
        else if (/^(currency|currency_?code)$/.test(cw)) ref = parent.columns.find((p) => words(p.name).join("_") === cw);
        if (!ref) continue;
        out.push({
          id: `copy:${t.name}.${c.name}`,
          kind: "copy",
          table: t.name,
          column: c.name,
          fk: `fk:${t.name}.${fk.columns.join("+")}`,
          refColumn: ref.name,
          expr: `${c.name} = ${parent.name}.${ref.name} of the referenced row`,
          evidence: `${t.name} references ${parent.name}, which has ${ref.name}`,
          source: "inferred",
          enabled: true,
        });
      }
    }
  }
  return out;
}

export function detectRules(schema: SchemaModel): Rule[] {
  return [...detectFk(schema), ...detectUnique(schema), ...detectChecks(schema), ...detectOrdering(schema), ...detectCopies(schema), ...detectProducts(schema), ...detectAggregates(schema)];
}

/** Column referenced by a rule, if it exists in the schema (used to drop stale rules). */
export function ruleColumnsExist(schema: SchemaModel, r: Rule): boolean {
  const t = schema.tables.find((x) => x.name === r.table);
  if (!t) return false;
  const has = (c: string) => !!findColumn(t, c);
  switch (r.kind) {
    case "fk":
    case "unique":
      return r.columns.every(has);
    case "order":
      return has(r.earlier) && has(r.later);
    case "sum":
      return has(r.column);
    case "product":
      return has(r.column) && r.factors.every(has);
    case "copy":
      return has(r.column);
    case "check":
      return true;
  }
}
