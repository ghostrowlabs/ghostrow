import { constraintUnsatisfied } from "../cli/errors.js";
import { findColumn, type ColumnModel, type SchemaModel, type TableModel } from "../connect/types.js";
import { evaluate, planChecks, type CheckPlan, type ColumnLimits, type Comparison, type Expr } from "../engine/checks.js";
import { fitValue, rawValue, round } from "../engine/domains.js";
import { columnPlan, type InferredColumn, type Plan } from "../engine/infer.js";
import type { MeaningId } from "../engine/meanings.js";
import { Rng } from "../engine/prng.js";
import { sampleRegex } from "../engine/regex.js";
import { fromQuantiles, type ColumnProfile, type TableProfile } from "../engine/sampling.js";
import type { Rule } from "../engine/rules.js";

/**
 * Seed generation. Tables are generated parents first; every reference points at a real
 * parent row; unique columns never repeat; CHECKs, orderings, products and sums hold by
 * construction. Each cell is a pure function of (seed, table, column, row, attempt).
 */

export type Row = Record<string, unknown>;
export type GenOutput = { table: TableModel; rows: Row[] }[];

export interface GenInput {
  schema: SchemaModel;
  plan: Plan;
  seed: number;
  /** Rows for the largest table. */
  rows?: number;
  tableRows?: Record<string, number>;
  /** First generated id per table (after existing rows when inserting into a live database). */
  idStart?: Record<string, number>;
  /** Share of NULLs in optional columns. */
  nullRate?: number;
  /** Twin: measured shapes to follow instead of the default value models. */
  profiles?: Map<string, TableProfile>;
  /** Rows already in the target database, so new unique values never collide with them. */
  existing?: Map<string, Row[]>;
}

const DEFAULT_ROWS = 500;
const FANOUT = 3;

/* ------------------------------------------------------------------ order and counts */

function enabledFks(plan: Plan, table: string) {
  return plan.rules.filter((r): r is Extract<Rule, { kind: "fk" }> => r.kind === "fk" && r.enabled && r.table === table);
}

/**
 * Parents before children. Self-references are fine (rows point at earlier rows). A cycle
 * between tables is broken at a nullable reference, which is then left empty; a cycle with
 * no nullable reference can't be generated and stops with exit 2.
 */
export function insertOrder(schema: SchemaModel, plan: Plan): { order: TableModel[]; deferred: Set<string> } {
  const deferred = new Set<string>();
  const edges = new Map<string, { to: string; id: string; nullable: boolean }[]>();
  for (const t of schema.tables) {
    edges.set(
      t.name,
      enabledFks(plan, t.name)
        .filter((f) => f.refTable !== t.name)
        .map((f) => ({ to: f.refTable, id: f.id, nullable: f.columns.every((c) => findColumn(t, c)?.nullable !== false) })),
    );
  }
  const order: TableModel[] = [];
  const done = new Set<string>();
  const remaining = [...schema.tables].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(schema.tables.map((t) => t.name));
  while (remaining.length) {
    const ready = remaining.filter((t) => edges.get(t.name)!.every((e) => done.has(e.to) || !known.has(e.to) || deferred.has(e.id)));
    if (ready.length === 0) {
      // Break the cycle at a nullable reference.
      const breakable = remaining.flatMap((t) => edges.get(t.name)!.filter((e) => e.nullable && !done.has(e.to) && !deferred.has(e.id)));
      const edge = breakable.sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!edge) {
        throw constraintUnsatisfied(
          `Tables ${remaining.map((t) => t.name).join(", ")} reference each other through NOT NULL foreign keys, so no insert order exists.`,
          "Make one of those foreign keys nullable or deferrable, or disable one fk rule in ghostrow.rules.yaml.",
        );
      }
      deferred.add(edge.id);
      continue;
    }
    const next = ready[0]!;
    order.push(next);
    done.add(next.name);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return { order, deferred };
}

/**
 * Row counts: the most-referencing (leaf) tables get `rows`; each level up gets a third as many
 * (customers → orders → order_lines reads 1 : 3 : 9). `--table` and the rules file override.
 */
export function rowCounts(schema: SchemaModel, plan: Plan, input: Pick<GenInput, "rows" | "tableRows">): Map<string, number> {
  const base = input.rows ?? DEFAULT_ROWS;
  const children = new Map<string, string[]>();
  for (const t of schema.tables) for (const f of enabledFks(plan, t.name)) if (f.refTable !== t.name) children.set(f.refTable, [...(children.get(f.refTable) ?? []), t.name]);
  const height = new Map<string, number>();
  const h = (name: string, seen: Set<string>): number => {
    if (height.has(name)) return height.get(name)!;
    if (seen.has(name)) return 0;
    seen.add(name);
    const kids = children.get(name) ?? [];
    const v = kids.length ? 1 + Math.max(...kids.map((k) => h(k, seen))) : 0;
    seen.delete(name);
    height.set(name, v);
    return v;
  };
  const counts = new Map<string, number>();
  for (const t of schema.tables) {
    const override = input.tableRows?.[t.name] ?? plan.rows[t.name];
    counts.set(t.name, override ?? Math.max(1, Math.ceil(base / FANOUT ** h(t.name, new Set()))));
  }
  // A unique reference (one-to-one) can't have more rows than its parent.
  for (const t of schema.tables) {
    for (const f of enabledFks(plan, t.name)) {
      const uniqueFk = plan.rules.some((r) => r.kind === "unique" && r.enabled && r.table === t.name && r.columns.length === f.columns.length && r.columns.every((c) => f.columns.includes(c)));
      const parent = counts.get(f.refTable);
      if (uniqueFk && parent !== undefined && f.refTable !== t.name && !(input.tableRows?.[t.name] !== undefined)) counts.set(t.name, Math.min(counts.get(t.name)!, parent));
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ table context */

interface TableCtx {
  table: TableModel;
  cols: Map<string, InferredColumn>;
  limits: Map<string, ColumnLimits>;
  comparisons: Comparison[];
  checkTrees: { expr: string; tree: Expr }[];
  fks: Extract<Rule, { kind: "fk" }>[];
  uniques: string[][];
  products: Extract<Rule, { kind: "product" }>[];
  copies: Extract<Rule, { kind: "copy" }>[];
  /** Generation order of columns: names before emails, earlier dates before later ones. */
  columnOrder: ColumnModel[];
}

const PRIORITY: Partial<Record<MeaningId, number>> = { first_name: 0, last_name: 0, full_name: 1, company: 1, city: 2, country: 2, country_code: 2, region: 3 };

function tableCtx(plan: Plan, table: TableModel): TableCtx {
  const tableRules = plan.rules.filter((r) => r.enabled && r.table === table.name);
  const checkExprs = tableRules.filter((r): r is Extract<Rule, { kind: "check" }> => r.kind === "check").map((r) => r.check);
  const { plan: cp, parsed } = planChecks(checkExprs);
  const comparisons: Comparison[] = [...cp.comparisons];
  for (const r of tableRules) if (r.kind === "order") comparisons.push({ left: r.earlier, op: r.strict ? "<" : "<=", right: r.later });
  const cols = columnPlan(plan, table.name);
  const columnOrder = [...table.columns].sort((a, b) => (PRIORITY[cols.get(a.name)?.meaning ?? "text"] ?? 5) - (PRIORITY[cols.get(b.name)?.meaning ?? "text"] ?? 5));
  return {
    table,
    cols,
    limits: cp.limits as CheckPlan["limits"],
    comparisons,
    checkTrees: parsed.filter((p) => p.tree).map((p) => ({ expr: p.expr, tree: p.tree! })),
    fks: tableRules.filter((r): r is Extract<Rule, { kind: "fk" }> => r.kind === "fk"),
    uniques: tableRules.filter((r): r is Extract<Rule, { kind: "unique" }> => r.kind === "unique").map((r) => r.columns),
    products: tableRules.filter((r): r is Extract<Rule, { kind: "product" }> => r.kind === "product"),
    copies: tableRules.filter((r): r is Extract<Rule, { kind: "copy" }> => r.kind === "copy"),
    columnOrder,
  };
}

function limitFor(ctx: TableCtx, col: string): ColumnLimits | undefined {
  return ctx.limits.get(col) ?? [...ctx.limits.entries()].find(([k]) => k.toLowerCase() === col.toLowerCase())?.[1];
}

const isTime = (c?: ColumnModel) => c !== undefined && (c.type === "date" || c.type === "datetime" || c.type === "time");

function shiftTime(value: unknown, col: ColumnModel, rng: Rng): unknown {
  const s = String(value);
  if (col.type === "time" || /^\d{2}:\d{2}/.test(s)) {
    const [h = 0, m = 0] = s.split(":").map(Number);
    const total = Math.min(23 * 60 + 59, h * 60 + m + rng.int(15, 240));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:00`;
  }
  const base = typeof value === "number" ? value * 1000 : Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}Z`);
  if (!Number.isFinite(base)) return value;
  const ms = base + (col.type === "date" ? rng.int(1, 45) * 86_400_000 : rng.int(1, 30 * 24) * 3_600_000);
  if (typeof value === "number") return Math.floor(ms / 1000);
  const iso = new Date(ms).toISOString();
  return col.type === "date" ? iso.slice(0, 10) : iso.replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a).replace("T", " ");
  const sb = String(b).replace("T", " ");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Make `left op right` true by moving the later value. */
function applyComparison(row: Row, c: Comparison, table: TableModel, rng: Rng, fixed?: string): void {
  const [earlier, later, strict] = c.op === "<" || c.op === "<=" ? [c.left, c.right, c.op === "<"] : c.op === ">" || c.op === ">=" ? [c.right, c.left, c.op === ">"] : [c.left, c.right, false];
  const a = row[earlier];
  const b = row[later];
  if (a === null || a === undefined || b === null || b === undefined) return;
  if (fixed === later && c.op !== "=" && c.op !== "<>") {
    // The later value is the point of the case: move the earlier one instead.
    if (cmp(a, b) < 0 || (cmp(a, b) === 0 && !strict)) return;
    if (!strict) row[earlier] = b;
    else row[earlier] = typeof b === "number" ? b - 1 : b;
    return;
  }
  if (c.op === "=") {
    row[later] = a;
    return;
  }
  if (c.op === "<>") {
    if (cmp(a, b) === 0) row[later] = typeof b === "number" ? b + 1 : `${String(b)}x`;
    return;
  }
  const d = cmp(a, b);
  if (d < 0 || (d === 0 && !strict)) return;
  const laterCol = findColumn(table, later)!;
  if (isTime(laterCol) || (laterCol.type === "integer" && typeof a === "number" && a > 1e9)) row[later] = shiftTime(a, laterCol, rng);
  else if (typeof a === "number") row[later] = laterCol.type === "integer" ? a + rng.int(1, 10) : round(a + Math.max(0.01, Math.abs(a) * rng.float() * 0.5), laterCol.scale ?? 2);
}

/**
 * Re-apply a table's row-level rules after changing one column (Haunt's edge cases):
 * copies from the referenced rows, products and orderings. `fixed` is never moved.
 */
export function repairRow(plan: Plan, table: TableModel, row: Row, fixed: string, rowsOf: Map<string, Row[]>, rng: Rng): void {
  const ctx = tableCtx(plan, table);
  for (const c of ctx.copies) {
    if (c.column === fixed) continue;
    const fk = ctx.fks.find((f) => f.id === c.fk);
    if (!fk) continue;
    const parent = (rowsOf.get(fk.refTable) ?? []).find((p) => fk.columns.every((col, j) => String(p[fk.refColumns[j]!]) === String(row[col])));
    if (parent) row[c.column] = parent[c.refColumn];
  }
  for (const p of ctx.products) {
    const [q, pr] = p.factors;
    if (row[q] === null || row[pr] === null || p.column === fixed) continue;
    const col = findColumn(table, p.column)!;
    row[p.column] = round(Number(row[q]) * Number(row[pr]), col.type === "integer" ? 0 : (col.scale ?? 2));
  }
  for (const c of ctx.comparisons) applyComparison(row, c, table, rng, fixed);
}

/* ------------------------------------------------------------------ generation */

export function generateSeed(input: GenInput): GenOutput {
  const { schema, plan, seed } = input;
  const { order, deferred } = insertOrder(schema, plan);
  const counts = rowCounts(schema, plan, input);
  const out: GenOutput = [];
  const byTable = new Map<string, Row[]>();
  const nullRate = input.nullRate ?? 0.06;

  for (const table of order) {
    const ctx = tableCtx(plan, table);
    const n = counts.get(table.name) ?? 0;
    const rows: Row[] = [];
    const existing = input.existing?.get(table.name) ?? [];
    const seen = ctx.uniques.map((u) => new Set(existing.filter((r) => u.every((c) => r[c] !== null && r[c] !== undefined)).map((r) => uniqueKey(r, u))));
    const idStart = input.idStart?.[table.name] ?? 1;
    // Parent key tuples, so references point at real rows.
    const parentKeys = ctx.fks.map((f) => {
      if (deferred.has(f.id)) return null;
      if (f.refTable === table.name) return "self" as const;
      return byTable.get(f.refTable) ?? [];
    });
    // Twin: give each parent a measured number of children (cumulative weights).
    const profile = input.profiles?.get(table.name);
    const weights = ctx.fks.map((f, k) => {
      const q = profile?.fanout.get(f.id);
      const keys = parentKeys[k];
      if (!q || !Array.isArray(keys) || keys.length === 0) return null;
      const wrng = new Rng(seed, `${table.name}.fanout${k}`);
      let acc = 0;
      return keys.map(() => (acc += Math.max(0.05, fromQuantiles(q, wrng))));
    });

    for (let i = 0; i < n; i++) {
      let row: Row | null = null;
      let lastProblem = "";
      for (let attempt = 0; attempt < 30 && row === null; attempt++) {
        const candidate = makeRow(ctx, input, i, attempt, idStart, parentKeys, rows, nullRate, seed, weights, profile);
        const problem = rowProblem(ctx, candidate, seen);
        if (problem === null) row = candidate;
        else lastProblem = problem;
      }
      if (row === null) {
        throw constraintUnsatisfied(`Could not generate row ${i + 1} of ${table.name}: ${lastProblem}.`, `Lower --rows or --table ${table.name}=…, or relax the rule in ghostrow.rules.yaml.`);
      }
      ctx.uniques.forEach((u, k) => seen[k]!.add(uniqueKey(row!, u)));
      rows.push(row);
    }
    byTable.set(table.name, rows);
    out.push({ table, rows });
  }

  applySums(plan, out);
  return out;
}

function uniqueKey(row: Row, cols: string[]): string {
  return cols.map((c) => (row[c] instanceof Buffer ? (row[c] as Buffer).toString("hex") : String(row[c]))).join("\u0001");
}

function rowProblem(ctx: TableCtx, row: Row, seen: Set<string>[]): string | null {
  for (let k = 0; k < ctx.uniques.length; k++) {
    const u = ctx.uniques[k]!;
    if (u.some((c) => row[c] === null || row[c] === undefined)) continue;
    if (seen[k]!.has(uniqueKey(row, u))) return `no unused value left for unique ${u.join(", ")}`;
  }
  for (const c of ctx.checkTrees) if (evaluate(c.tree, row) === false) return `CHECK (${c.expr}) failed`;
  return null;
}

function pickParent(rng: Rng, count: number, i: number, childCount: number): number {
  // Every parent gets a child first (when there are enough children), then a skewed spread.
  if (i < count && childCount >= count) return i;
  return Math.min(count - 1, Math.floor(count * rng.float() ** 1.5));
}

function makeRow(
  ctx: TableCtx,
  input: GenInput,
  i: number,
  attempt: number,
  idStart: number,
  parentKeys: (Row[] | "self" | null)[],
  previous: Row[],
  nullRate: number,
  seed: number,
  weights: (number[] | null)[] = [],
  profile?: TableProfile,
): Row {
  const { table } = ctx;
  const row: Row = {};
  const fkCols = new Set<string>();
  const parents = new Map<string, Row>();

  // References first: whole tuples from one parent row.
  ctx.fks.forEach((f, k) => {
    for (const c of f.columns) fkCols.add(c);
    const rng = new Rng(seed, `${table.name}.fk${k}#${i}@${attempt}`);
    const keys = parentKeys[k];
    const nullable = f.columns.every((c) => findColumn(table, c)?.nullable !== false);
    let parent: Row | null = null;
    if (keys === "self") {
      if (previous.length > 0 && !(nullable && rng.chance(0.3))) parent = previous[Math.floor(previous.length * rng.float())]!;
    } else if (keys && keys.length > 0) {
      const w = weights[k];
      const fkNull = profile?.columns.get(f.columns[0]!)?.nullRate ?? nullRate;
      if (!(nullable && attempt < 25 && rng.chance(fkNull))) parent = keys[w ? pickWeighted(w, rng) : pickParent(rng, keys.length, i + attempt * 7919, Number.MAX_SAFE_INTEGER)] ?? null;
    }
    f.columns.forEach((c, j) => {
      row[c] = parent ? parent[f.refColumns[j]!] : null;
    });
    if (parent) parents.set(f.id, parent);
  });

  for (const col of ctx.columnOrder) {
    if (fkCols.has(col.name)) continue;
    const inf = ctx.cols.get(col.name);
    const meaning: MeaningId = inf?.meaning ?? "text";
    const rng = new Rng(seed, `${table.name}.${col.name}#${i}@${attempt}`);
    if (col.primaryKey && (col.autoIncrement || meaning === "id") && col.type === "integer") {
      row[col.name] = idStart + i;
      continue;
    }
    if (col.defaultValue?.startsWith("generated:")) continue; // computed by the database
    const limits = limitFor(ctx, col.name);
    const cp = profile?.columns.get(col.name);
    if (cp && !col.primaryKey) {
      const v = profiled(cp, col, rng, meaning, i, attempt, ctx, limits, inf, row);
      if (v !== undefined) {
        row[col.name] = v;
        continue;
      }
    }
    if (col.nullable && !col.primaryKey && !col.unique && !limits?.values && meaning !== "id") {
      const rate = meaning === "description" || meaning === "url" ? nullRate * 3 : meaning === "datetime" && /(deleted|archived|cancel)/i.test(col.name) ? 0.85 : nullRate;
      if (rng.chance(rate)) {
        row[col.name] = null;
        continue;
      }
    }
    const vctx = { rng, col, table: table.name, ordinal: i + attempt * 1_000_003, ...(limits ? { limits } : {}), ...(inf?.values ? { values: inf.values } : {}), row };
    const fromPattern = inf?.pattern && (col.type === "text" || col.type === "enum") ? sampleRegex(inf.pattern, rng) : null;
    let v = fitValue(fromPattern ?? rawValue(meaning, vctx), vctx);
    // Unique text that collided on an earlier attempt: make it unique with the row number.
    if (attempt > 2 && typeof v === "string" && (col.unique || col.primaryKey || ctx.uniques.some((u) => u.includes(col.name)))) {
      const tag = `${i + 1}${attempt > 10 ? `-${attempt}` : ""}`;
      v = fitValue(meaning === "email" && v.includes("@") ? v.replace("@", `.${tag}@`) : `${v}-${tag}`, vctx);
      if (typeof v === "string" && col.maxLength !== undefined && v.length >= col.maxLength) v = `${v.slice(0, Math.max(0, col.maxLength - tag.length))}${tag}`.slice(0, col.maxLength);
    } else if (attempt > 2 && typeof v === "number" && col.type === "integer" && (col.unique || ctx.uniques.some((u) => u.length === 1 && u[0] === col.name))) {
      v = fitValue(Number(v) + (i + 1) * 7 + attempt, vctx);
    }
    row[col.name] = v;
  }

  // Copies: values taken from the referenced row.
  for (const c of ctx.copies) {
    const parent = parents.get(c.fk);
    if (parent && parent[c.refColumn] !== undefined) row[c.column] = parent[c.refColumn];
  }

  // Products: line amount = quantity × unit price.
  for (const p of ctx.products) {
    const [q, pr] = p.factors;
    const qv = Number(row[q]);
    const pv = Number(row[pr]);
    if (Number.isFinite(qv) && Number.isFinite(pv) && row[q] !== null && row[pr] !== null) {
      const col = findColumn(table, p.column)!;
      row[p.column] = round(qv * pv, col.type === "integer" ? 0 : (col.scale ?? 2));
    }
  }

  // Orderings and column comparisons from CHECKs.
  const crng = new Rng(seed, `${table.name}.order#${i}@${attempt}`);
  for (const c of ctx.comparisons) applyComparison(row, c, table, crng);
  return row;
}

function pickWeighted(cumulative: number[], rng: Rng): number {
  const total = cumulative[cumulative.length - 1]!;
  const x = rng.float() * total;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function isoFromMs(ms: number, col: ColumnModel): string {
  const iso = new Date(Math.round(ms / 1000) * 1000).toISOString();
  return col.type === "date" ? iso.slice(0, 10) : iso.replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Twin: a value that follows the measured profile, or undefined to use the normal model. */
function profiled(cp: ColumnProfile, col: ColumnModel, rng: Rng, meaning: MeaningId, i: number, attempt: number, ctx: TableCtx, limits: ColumnLimits | undefined, inf: InferredColumn | undefined, row: Row): unknown {
  if (col.nullable && !col.unique && rng.chance(cp.nullRate)) return null;
  const vctx = { rng, col, table: ctx.table.name, ordinal: i + attempt * 1_000_003, ...(limits ? { limits } : {}), ...(inf?.values ? { values: inf.values } : {}), row };
  if (cp.categories?.length && !col.unique) {
    let x = rng.float();
    for (const c of cp.categories) {
      x -= c.weight;
      if (x <= 0) return fitValue(c.value, vctx);
    }
    return fitValue(cp.categories[cp.categories.length - 1]!.value, vctx);
  }
  const q = cp.quantiles;
  if (!q?.length || col.unique) return undefined;
  if (col.type === "integer" || col.type === "decimal" || col.type === "real") return fitValue(round(fromQuantiles(q, rng, cp.integer), col.scale ?? 6), vctx);
  if (col.type === "date" || col.type === "datetime") return fitValue(isoFromMs(fromQuantiles(q, rng), col), vctx);
  if (col.type === "text") {
    // Personal and free text: synthetic words shaped to the measured lengths.
    const target = Math.max(0, Math.round(fromQuantiles(q, rng)));
    let s = String(rawValue(meaning, vctx) ?? "");
    if (["text", "description", "title"].includes(meaning)) while (s.length < target) s += ` ${String(rawValue(meaning, { ...vctx, ordinal: vctx.ordinal + s.length }))}`;
    return fitValue(s.length > target && ["text", "description", "title"].includes(meaning) ? s.slice(0, target).trimEnd() : s, vctx);
  }
  return undefined;
}

/** Parent totals = sum of their child lines, computed after every table exists. */
export function applySums(plan: Plan, out: GenOutput): void {
  for (const r of plan.rules) {
    if (r.kind !== "sum" || !r.enabled) continue;
    const parent = out.find((o) => o.table.name === r.table);
    const child = out.find((o) => o.table.name === r.childTable);
    if (!parent || !child) continue;
    const col = findColumn(parent.table, r.column)!;
    const scale = col.type === "integer" ? 0 : (col.scale ?? 2);
    const f = 10 ** Math.min(scale, 6);
    const sums = new Map<string, number>();
    for (const row of child.rows) {
      const v = Number(row[r.childColumn]);
      if (row[r.childColumn] === null || !Number.isFinite(v)) continue;
      const key = r.childFk.map((c) => String(row[c])).join("\u0001");
      sums.set(key, (sums.get(key) ?? 0) + Math.round(v * f));
    }
    for (const row of parent.rows) {
      const key = r.parentKey.map((c) => String(row[c])).join("\u0001");
      row[r.column] = (sums.get(key) ?? 0) / f;
    }
  }
}
