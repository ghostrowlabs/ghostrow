import { findColumn, type ColumnModel, type SchemaModel, type TableModel } from "../connect/types.js";
import { parseCheck, planChecks } from "../engine/checks.js";
import { words } from "../engine/meanings.js";
import { primaryKeyOf, type Rule } from "../engine/rules.js";

/**
 * gr-rules-1: what the rule model reads and writes, and the deterministic check every
 * proposal must pass. The training data is built with these same functions
 * (training/rules/tools/*.ts), so the prompt the model was trained on and the prompt the CLI
 * sends can't drift apart. Schema text and source code only: never values from a database.
 *
 * The model is asked about one table at a time ("home" table) and writes one rule per line,
 * or `none`. Every rule lives on its home table:
 *
 *   order placed_at <= shipped_at          a column is not earlier than another (`<` for strictly)
 *   sum total = order_lines.amount         the total is the sum of a child table's lines
 *   product amount = quantity * unit_price a line amount is quantity × unit price
 *   copy unit_price = products.price       the value is copied from the referenced row
 *   min quantity 1   max discount 100      numeric limits (from application code)
 *   minlen sku 3   maxlen sku 32   len country 2
 *   values status draft|sent|paid          allowed values (from application code)
 *
 * The CLI turns each accepted line into the same Rule kinds the heuristics produce
 * (src/engine/rules.ts), so the generator satisfies them and the validator re-checks them.
 */
export const FORMAT_VERSION = 1;

export const SYSTEM_PROMPT = "You read one database table, its related tables and any application code for it, and list the data rules the table's rows must follow. One rule per line, or none.";

const MAX_CHILDREN = 4;
const MAX_PARENTS = 4;
const MAX_NEIGHBOUR_COLUMNS = 10;
export const MAX_CODE_CHARS = 1600;

const timeLike = (c: ColumnModel) => c.type === "date" || c.type === "datetime" || c.type === "time";
const numeric = (c: ColumnModel) => c.type === "integer" || c.type === "decimal" || c.type === "real";

function typeText(c: ColumnModel): string {
  const raw = c.rawType.toLowerCase().replace(/\s+/g, " ");
  if (c.type === "decimal") return c.precision !== undefined ? `decimal(${c.precision},${c.scale ?? 0})` : "decimal";
  if (c.type === "text") return c.maxLength !== undefined ? `text(${c.maxLength})` : "text";
  if (c.type === "enum" && c.enumValues?.length) return `enum(${c.enumValues.slice(0, 8).join("|")})`;
  if (c.type === "integer" && /bool|tinyint\(1\)/.test(raw)) return "integer";
  return c.type;
}

function columnLine(t: TableModel, c: ColumnModel): string {
  const parts = [c.name, typeText(c)];
  if (c.primaryKey) parts.push("pk");
  const fk = t.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
  if (fk) parts.push(`-> ${fk.refTable}`);
  if (c.unique && !c.primaryKey) parts.push("unique");
  if (c.nullable && !c.primaryKey) parts.push("null");
  return parts.join(" ");
}

/** A neighbour table in one line, with the columns most likely to take part in a rule first. */
function neighbourLine(role: "parent" | "child", t: TableModel, via: string): string {
  const score = (c: ColumnModel) => (c.primaryKey ? 3 : numeric(c) ? 2 : timeLike(c) ? 1 : 0);
  const cols = [...t.columns].map((c, i) => ({ c, i })).sort((a, b) => score(b.c) - score(a.c) || a.i - b.i).slice(0, MAX_NEIGHBOUR_COLUMNS).sort((a, b) => a.i - b.i);
  return `${role} ${t.name} (${via}): ${cols.map(({ c }) => `${c.name} ${typeText(c)}`).join(", ")}`;
}

const sameTable = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function parentsOf(schema: SchemaModel, t: TableModel): { table: TableModel; via: string }[] {
  const out: { table: TableModel; via: string }[] = [];
  for (const fk of t.foreignKeys) {
    const p = schema.tables.find((x) => sameTable(x.name, fk.refTable));
    if (!p || p === t || out.some((o) => o.table === p)) continue;
    out.push({ table: p, via: fk.columns.join(", ") });
  }
  return out.slice(0, MAX_PARENTS);
}

export function childrenOf(schema: SchemaModel, t: TableModel): { table: TableModel; via: string }[] {
  const out: { table: TableModel; via: string }[] = [];
  for (const c of schema.tables) {
    if (c === t) continue;
    const fk = c.foreignKeys.find((f) => sameTable(f.refTable, t.name));
    if (fk && !out.some((o) => o.table === c)) out.push({ table: c, via: fk.columns.join(", ") });
  }
  // Children with numeric columns first: those are the ones a total can sum.
  return out.sort((a, b) => Number(b.table.columns.some(numeric)) - Number(a.table.columns.some(numeric))).slice(0, MAX_CHILDREN);
}

/** Whether a table is worth asking about at all: it needs columns a rule could use. */
export function askable(schema: SchemaModel, t: TableModel, code?: string): boolean {
  if (code) return true;
  const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
  const usable = t.columns.filter((c) => !c.primaryKey && !fkCols.has(c.name) && (numeric(c) || timeLike(c)));
  if (usable.length >= 2) return true;
  const parents = parentsOf(schema, t);
  if (usable.some(numeric) && (parents.length || childrenOf(schema, t).length)) return true;
  // A column with the same name as one on a referenced table may be copied from it.
  const own = new Set(t.columns.filter((c) => !c.primaryKey && !fkCols.has(c.name)).map((c) => words(c.name).join("_")));
  return parents.some((p) => p.table.columns.some((c) => !c.primaryKey && own.has(words(c.name).join("_"))));
}

/** The user message for one home table. */
export function tablePrompt(schema: SchemaModel, t: TableModel, code?: { file: string; text: string }[]): string {
  const lines = [`table ${t.name}`];
  for (const c of t.columns) lines.push(`  ${columnLine(t, c)}`);
  for (const ch of t.checks.slice(0, 6)) lines.push(`  check ${ch.replace(/\s+/g, " ").slice(0, 120)}`);
  for (const p of parentsOf(schema, t)) lines.push(neighbourLine("parent", p.table, p.via));
  for (const c of childrenOf(schema, t)) lines.push(neighbourLine("child", c.table, c.via));
  let budget = MAX_CODE_CHARS;
  for (const block of code ?? []) {
    if (budget <= 80) break;
    const text = block.text.length > budget ? block.text.slice(0, budget) : block.text;
    budget -= text.length;
    lines.push(`code ${block.file}:`, text.replace(/\r/g, "").replace(/\t/g, "  "));
  }
  return lines.join("\n");
}

/** Chat-formatted prompt (ChatML, as used by the base model's chat template), ending where the answer starts. */
export function chatPrompt(user: string): string {
  return `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

/* ------------------------------------------------------------------ proposals */

export type Proposal =
  | { kind: "order"; earlier: string; later: string; strict: boolean }
  | { kind: "sum"; column: string; childTable: string; childColumn: string }
  | { kind: "product"; column: string; factors: [string, string] }
  | { kind: "copy"; column: string; refTable: string; refColumn: string }
  | { kind: "min" | "max"; column: string; value: number }
  | { kind: "minlen" | "maxlen" | "len"; column: string; value: number }
  | { kind: "values"; column: string; values: string[] };

const ID = String.raw`[A-Za-z_][\w$]*`;
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const PATTERNS: [RegExp, (m: RegExpExecArray) => Proposal][] = [
  [new RegExp(`^order (${ID}) (<=|<) (${ID})$`), (m) => ({ kind: "order", earlier: m[1]!, later: m[3]!, strict: m[2] === "<" })],
  [new RegExp(`^sum (${ID}) = (${ID})\\.(${ID})$`), (m) => ({ kind: "sum", column: m[1]!, childTable: m[2]!, childColumn: m[3]! })],
  [new RegExp(`^product (${ID}) = (${ID}) \\* (${ID})$`), (m) => ({ kind: "product", column: m[1]!, factors: [m[2]!, m[3]!] })],
  [new RegExp(`^copy (${ID}) = (${ID})\\.(${ID})$`), (m) => ({ kind: "copy", column: m[1]!, refTable: m[2]!, refColumn: m[3]! })],
  [new RegExp(`^(min|max) (${ID}) (${NUM})$`), (m) => ({ kind: m[1] as "min" | "max", column: m[2]!, value: Number(m[3]) })],
  [new RegExp(`^(minlen|maxlen|len) (${ID}) (\\d+)$`), (m) => ({ kind: m[1] as "minlen" | "maxlen" | "len", column: m[2]!, value: Number(m[3]) })],
  [new RegExp(`^values (${ID}) (\\S+)$`), (m) => ({ kind: "values", column: m[1]!, values: m[2]!.split("|").filter(Boolean) })],
];

/** One output line → a proposal, or null if it doesn't follow the format. */
export function parseLine(line: string): Proposal | null {
  const s = line.trim().replace(/\s+/g, " ");
  for (const [re, make] of PATTERNS) {
    const m = re.exec(s);
    if (m) return make(m);
  }
  return null;
}

export function proposalLine(p: Proposal): string {
  switch (p.kind) {
    case "order":
      return `order ${p.earlier} ${p.strict ? "<" : "<="} ${p.later}`;
    case "sum":
      return `sum ${p.column} = ${p.childTable}.${p.childColumn}`;
    case "product":
      return `product ${p.column} = ${p.factors[0]} * ${p.factors[1]}`;
    case "copy":
      return `copy ${p.column} = ${p.refTable}.${p.refColumn}`;
    case "min":
    case "max":
    case "minlen":
    case "maxlen":
    case "len":
      return `${p.kind} ${p.column} ${p.value}`;
    case "values":
      return `values ${p.column} ${p.values.join("|")}`;
  }
}

const KIND_ORDER = ["order", "sum", "product", "copy", "min", "max", "minlen", "maxlen", "len", "values"];

/** The answer text for a set of proposals: a stable order, so training targets are deterministic. */
export function answerText(ps: Proposal[]): string {
  if (!ps.length) return "none";
  const lines = [...new Set(ps.map(proposalLine))];
  return lines.sort((a, b) => KIND_ORDER.indexOf(a.split(" ")[0]!) - KIND_ORDER.indexOf(b.split(" ")[0]!) || a.localeCompare(b)).join("\n");
}

/** Comparable identity of a proposal on a home table (used for de-duplication and scoring). */
export function proposalKey(table: string, p: Proposal): string {
  const l = (s: string) => s.toLowerCase();
  switch (p.kind) {
    case "order":
      return `order:${l(table)}.${l(p.earlier)}<${l(p.later)}`;
    case "sum":
      return `sum:${l(table)}.${l(p.column)}=${l(p.childTable)}.${l(p.childColumn)}`;
    case "product":
      return `product:${l(table)}.${l(p.column)}=${[l(p.factors[0]), l(p.factors[1])].sort().join("*")}`;
    case "copy":
      return `copy:${l(table)}.${l(p.column)}=${l(p.refTable)}.${l(p.refColumn)}`;
    case "values":
      return `values:${l(table)}.${l(p.column)}=${[...p.values].sort().join("|")}`;
    default:
      return `${p.kind}:${l(table)}.${l(p.column)}=${p.value}`;
  }
}

/* ------------------------------------------------------------------ the deterministic check */

export type Verdict = { ok: true; rule: Rule; values?: string[] } | { ok: false; reason: string };

/**
 * Accept or reject one proposal for a home table. A proposal is accepted only if every column
 * exists, the column types fit the rule, the relation it needs (a foreign key) is declared,
 * and it doesn't fight a rule already in the plan. Accepted proposals become ordinary rules:
 * the generator satisfies them and the validator re-checks them on every row.
 */
export function checkProposal(schema: SchemaModel, table: TableModel, p: Proposal, existing: Rule[], evidence: string, fromCode: boolean): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, reason });
  const col = (t: TableModel, name: string) => findColumn(t, name);
  const fkCols = new Set(table.foreignKeys.flatMap((f) => f.columns.map((c) => c.toLowerCase())));
  const plain = (c: ColumnModel) => !c.primaryKey && !fkCols.has(c.name.toLowerCase()) && !c.defaultValue?.startsWith("generated:");
  const derivedTargets = new Set(existing.filter((r) => r.table === table.name && (r.kind === "sum" || r.kind === "product" || r.kind === "copy")).map((r) => (r as { column: string }).column.toLowerCase()));
  const base = { table: table.name, evidence, source: (fromCode ? "code" : "inferred") as Rule["source"], enabled: true };
  const target = (name: string): ColumnModel | string => {
    const c = col(table, name);
    if (!c) return `no column ${table.name}.${name}`;
    if (!plain(c)) return `${c.name} is a key`;
    if (derivedTargets.has(c.name.toLowerCase())) return `${c.name} is already derived by another rule`;
    return c;
  };

  switch (p.kind) {
    case "order": {
      const a = col(table, p.earlier);
      const b = col(table, p.later);
      if (!a || !b) return no(`no column ${table.name}.${!a ? p.earlier : p.later}`);
      if (a === b) return no("a column can't be ordered against itself");
      if (!((timeLike(a) && timeLike(b) && a.type === b.type) || (numeric(a) && numeric(b)) || (timeLike(a) && timeLike(b) && a.type !== "time" && b.type !== "time"))) return no(`${a.name} and ${b.name} can't be compared (${a.type}, ${b.type})`);
      const key = (c: ColumnModel) => (c.primaryKey && table.primaryKey.length <= 1) || fkCols.has(c.name.toLowerCase());
      if (key(a) || key(b)) return no("keys aren't ordered");
      const orders = existing.filter((r): r is Extract<Rule, { kind: "order" }> => r.kind === "order" && r.table === table.name);
      if (orders.some((r) => r.earlier.toLowerCase() === b.name.toLowerCase() && r.later.toLowerCase() === a.name.toLowerCase())) return no(`the plan already orders ${b.name} before ${a.name}`);
      if (reaches(orders, b.name, a.name)) return no("it would make a cycle of orderings");
      return { ok: true, rule: { ...base, id: `order:${table.name}.${a.name}<=${b.name}`, kind: "order", earlier: a.name, later: b.name, strict: p.strict, expr: `${b.name} is ${p.strict ? "after" : "not before"} ${a.name}` } };
    }
    case "sum": {
      const t = target(p.column);
      if (typeof t === "string") return no(t);
      if (!numeric(t)) return no(`${t.name} isn't numeric`);
      const child = schema.tables.find((x) => sameTable(x.name, p.childTable));
      if (!child) return no(`no table ${p.childTable}`);
      const cc = col(child, p.childColumn);
      if (!cc) return no(`no column ${child.name}.${p.childColumn}`);
      if (!numeric(cc) || cc.primaryKey) return no(`${child.name}.${cc.name} isn't an amount`);
      const fks = child.foreignKeys.filter((f) => sameTable(f.refTable, table.name));
      if (fks.length !== 1) return no(fks.length ? `${child.name} references ${table.name} more than once` : `${child.name} doesn't reference ${table.name}`);
      const fk = fks[0]!;
      if (fk.columns.some((c) => c.toLowerCase() === cc.name.toLowerCase())) return no(`${cc.name} is the reference itself`);
      const parentKey = fk.refColumns.length ? fk.refColumns : primaryKeyOf(table);
      const fkId = `fk:${child.name}.${fk.columns.join("+")}`;
      if (existing.some((r) => r.kind === "copy" && r.table === child.name && r.fk === fkId && r.column.toLowerCase() === cc.name.toLowerCase() && r.refColumn.toLowerCase() === t.name.toLowerCase())) return no(`${child.name}.${cc.name} is copied from ${t.name}: a sum of it would be circular`);
      if (!parentKey.length) return no(`${table.name} has no key`);
      return { ok: true, rule: { ...base, id: `sum:${table.name}.${t.name}`, kind: "sum", column: t.name, childTable: child.name, childColumn: cc.name, childFk: fk.columns, parentKey, expr: `${table.name}.${t.name} = sum of ${child.name}.${cc.name}` } };
    }
    case "product": {
      const t = target(p.column);
      if (typeof t === "string") return no(t);
      const f = p.factors.map((n) => col(table, n));
      if (f.some((x) => !x)) return no(`no column ${table.name}.${p.factors[f.findIndex((x) => !x)]}`);
      const [q, r] = f as [ColumnModel, ColumnModel];
      if (q === r || q === t || r === t) return no("a product needs three different columns");
      if (![t, q, r].every(numeric)) return no("a product needs numeric columns");
      if (q.primaryKey || r.primaryKey || fkCols.has(q.name.toLowerCase()) || fkCols.has(r.name.toLowerCase())) return no("keys aren't factors");
      return { ok: true, rule: { ...base, id: `product:${table.name}.${t.name}`, kind: "product", column: t.name, factors: [q.name, r.name], expr: `${t.name} = ${q.name} × ${r.name}` } };
    }
    case "copy": {
      const t = target(p.column);
      if (typeof t === "string") return no(t);
      const fks = table.foreignKeys.filter((f) => sameTable(f.refTable, p.refTable) && f.columns.length === 1);
      if (fks.length !== 1) return no(fks.length ? `${table.name} references ${p.refTable} more than once` : `${table.name} doesn't reference ${p.refTable}`);
      const parent = schema.tables.find((x) => sameTable(x.name, p.refTable));
      if (!parent) return no(`no table ${p.refTable}`);
      const rc = col(parent, p.refColumn);
      if (!rc) return no(`no column ${parent.name}.${p.refColumn}`);
      if (rc.primaryKey) return no(`${rc.name} is the parent's key; that's the reference itself`);
      const fits = (numeric(t) && numeric(rc)) || t.type === rc.type || (t.type === "text" && rc.type === "enum");
      if (!fits) return no(`${t.name} (${t.type}) can't hold ${parent.name}.${rc.name} (${rc.type})`);
      if (t.type === "text" && t.maxLength !== undefined && (rc.maxLength === undefined || rc.maxLength > t.maxLength)) return no(`${parent.name}.${rc.name} may be longer than ${t.name}`);
      const fk = fks[0]!;
      if (existing.some((r) => r.kind === "sum" && r.table === parent.name && r.column.toLowerCase() === rc.name.toLowerCase() && r.childTable === table.name && r.childColumn.toLowerCase() === t.name.toLowerCase())) return no(`${parent.name}.${rc.name} is the sum of ${t.name}: a copy of it would be circular`);
      return { ok: true, rule: { ...base, id: `copy:${table.name}.${t.name}`, kind: "copy", column: t.name, fk: `fk:${table.name}.${fk.columns.join("+")}`, refColumn: rc.name, expr: `${t.name} = ${parent.name}.${rc.name} of the referenced row` } };
    }
    case "min":
    case "max": {
      if (!fromCode) return no("limits come from application code, and none was read for this table");
      const c = col(table, p.column);
      if (!c) return no(`no column ${table.name}.${p.column}`);
      if (!numeric(c)) return no(`${c.name} isn't numeric`);
      if (!Number.isFinite(p.value)) return no("not a number");
      if (c.type === "integer" && !Number.isInteger(p.value)) return no(`${c.name} is an integer`);
      const opp = existing.find((r) => r.kind === "check" && r.table === table.name && r.id === `code:${table.name}.${c.name}.${p.kind === "min" ? "max" : "min"}`);
      const oppVal = opp && opp.kind === "check" ? Number(/(-?[\d.]+)\s*$/.exec(opp.check)?.[1]) : NaN;
      if (Number.isFinite(oppVal) && (p.kind === "min" ? p.value > oppVal : p.value < oppVal)) return no(`it contradicts ${opp!.expr}`);
      const lim = declaredLimits(table, c.name);
      // Only a limit at least as strict as the declared one adds anything (min 1 over a declared min 0 does).
      if (lim && (p.kind === "min" ? lim.min !== undefined && p.value <= lim.min : lim.max !== undefined && p.value >= lim.max)) return no(`the schema already limits ${c.name} at least as strictly`);
      const op = p.kind === "min" ? ">=" : "<=";
      return checkRule(base, table.name, c.name, `${p.kind}`, `${c.name} ${op} ${p.value}`, `${c.name} ${p.kind === "min" ? "≥" : "≤"} ${p.value}`);
    }
    case "minlen":
    case "maxlen":
    case "len": {
      if (!fromCode) return no("limits come from application code, and none was read for this table");
      const c = col(table, p.column);
      if (!c) return no(`no column ${table.name}.${p.column}`);
      if (c.type !== "text") return no(`${c.name} isn't text`);
      if (p.kind !== "maxlen" && c.maxLength !== undefined && p.value > c.maxLength) return no(`${c.name} holds at most ${c.maxLength} characters`);
      if (p.kind !== "minlen" && p.value < 1) return no("a length limit below 1");
      if (p.kind === "maxlen" && c.maxLength !== undefined && p.value >= c.maxLength) return no(`${c.name} is already declared with at most ${c.maxLength} characters`);
      const op = { minlen: ">=", maxlen: "<=", len: "=" }[p.kind];
      const words_ = { minlen: "at least", maxlen: "at most", len: "exactly" }[p.kind];
      return checkRule(base, table.name, c.name, { minlen: "minLength", maxlen: "maxLength", len: "length" }[p.kind], `length(${c.name}) ${op} ${p.value}`, `${c.name} has ${words_} ${p.value} characters`);
    }
    case "values": {
      if (!fromCode) return no("allowed values come from application code, and none was read for this table");
      const c = col(table, p.column);
      if (!c) return no(`no column ${table.name}.${p.column}`);
      if (!p.values.length || p.values.length > 64) return no("an empty or very long list of values");
      if (!(c.type === "text" || c.type === "enum" || c.type === "integer")) return no(`${c.name} (${c.type}) can't hold a list of values`);
      if (c.type === "integer" && p.values.some((v) => !/^-?\d+$/.test(v))) return no(`${c.name} holds integers`);
      if (c.maxLength !== undefined && p.values.some((v) => v.length > c.maxLength!)) return no(`a value is longer than ${c.name} allows`);
      if (c.type === "enum" && c.enumValues && p.values.some((v) => !c.enumValues!.includes(v))) return no(`a value isn't in ${c.name}'s enum`);
      const q = (v: string) => (c.type === "integer" ? v : `'${v.replace(/'/g, "''")}'`);
      const v = checkRule(base, table.name, c.name, "values", `${c.name} IN (${p.values.map(q).join(", ")})`, `${c.name} is one of ${p.values.join(", ")}`);
      return v.ok ? { ...v, values: p.values } : v;
    }
  }
}

function declaredLimits(t: TableModel, column: string) {
  if (!t.checks.length) return undefined;
  const limits = planChecks(t.checks).plan.limits;
  return limits.get(column) ?? [...limits.entries()].find(([k]) => k.toLowerCase() === column.toLowerCase())?.[1];
}

function checkRule(base: { table: string; evidence: string; source: Rule["source"]; enabled: boolean }, table: string, column: string, kind: string, check: string, expr: string): Verdict {
  if (!parseCheck(check)) return { ok: false, reason: "the check can't be read" };
  return { ok: true, rule: { ...base, id: `code:${table}.${column}.${kind}`, kind: "check", check, expr } };
}

function reaches(orders: Extract<Rule, { kind: "order" }>[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const r of orders) next.set(r.earlier.toLowerCase(), [...(next.get(r.earlier.toLowerCase()) ?? []), r.later.toLowerCase()]);
  const seen = new Set<string>();
  const stack = [from.toLowerCase()];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to.toLowerCase()) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(next.get(n) ?? []));
  }
  return false;
}

/** A Rule the heuristics (or the rules file) produced, as a proposal line on its home table, for scoring. */
export function ruleAsProposal(schema: SchemaModel, r: Rule): Proposal | null {
  switch (r.kind) {
    case "order":
      return { kind: "order", earlier: r.earlier, later: r.later, strict: r.strict };
    case "sum":
      return { kind: "sum", column: r.column, childTable: r.childTable, childColumn: r.childColumn };
    case "product":
      return { kind: "product", column: r.column, factors: r.factors };
    case "copy": {
      const fk = schema.tables.find((t) => t.name === r.table)?.foreignKeys.find((f) => `fk:${r.table}.${f.columns.join("+")}` === r.fk);
      return fk ? { kind: "copy", column: r.column, refTable: fk.refTable, refColumn: r.refColumn } : null;
    }
    case "check": {
      const m = /^code:[^.]+\.(.+)\.(min|max|minLength|maxLength|length|values)$/.exec(r.id);
      if (!m) return null;
      const column = m[1]!;
      const kind = m[2]!;
      if (kind === "values") {
        const vals = /IN \((.*)\)$/.exec(r.check)?.[1];
        return vals ? { kind: "values", column, values: [...vals.matchAll(/'((?:[^']|'')*)'|(-?\d+)/g)].map((x) => (x[1] ?? x[2]!).replace(/''/g, "'")) } : null;
      }
      const value = Number(/(-?[\d.]+)\s*$/.exec(r.check)?.[1]);
      const k = ({ min: "min", max: "max", minLength: "minlen", maxLength: "maxlen", length: "len" } as const)[kind as "min"]!;
      return { kind: k, column, value } as Proposal;
    }
    default:
      return null;
  }
}

/** Plain words of a name, for matching code to tables. */
export const nameWords = (s: string) => words(s).join("_");
