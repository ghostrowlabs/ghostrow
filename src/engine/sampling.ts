import type { Connector, Row } from "../connect/registry.js";
import type { ColumnModel, SchemaModel, TableModel } from "../connect/types.js";
import type { Plan } from "./infer.js";
import type { MeaningId } from "./meanings.js";
import type { Rng } from "./prng.js";

/**
 * Twin's measurements: the shape and statistics of a database, computed in memory on your
 * machine. A profile holds counts, null rates, quantiles and (for low-cardinality category
 * columns) value frequencies — never a row. Personal fields are never profiled by value.
 */

export interface ColumnProfile {
  nullRate: number;
  /** 21 quantiles (0%, 5% … 100%) of numbers, dates (epoch ms) or text lengths. */
  quantiles?: number[];
  integer?: boolean;
  /** Category values seen at least K times, with their share. */
  categories?: { value: string | number | boolean; weight: number }[];
}

export interface TableProfile {
  rows: number;
  measuredRows: number;
  columns: Map<string, ColumnProfile>;
  /** Per foreign key rule id: quantiles of children per parent. */
  fanout: Map<string, number[]>;
}

/** Each category value must appear at least this often to be reused (k-anonymity). */
export const K_MIN = 5;
/** Rows read per table to measure statistics. */
export const MEASURE_CAP = 50_000;

const PERSONAL: MeaningId[] = ["email", "phone", "first_name", "last_name", "full_name", "username", "password_hash", "token", "company", "national_id_lk", "national_id", "postal_code", "street", "address", "ip_address", "latitude", "longitude", "url", "domain", "description", "title", "birth_date", "slug", "sku", "file_path", "json", "bytes", "uuid", "id", "reference", "text"];

export function quantiles(values: number[], n = 21): number[] {
  if (!values.length) return [];
  const s = [...values].sort((a, b) => a - b);
  return Array.from({ length: n }, (_, i) => s[Math.min(s.length - 1, Math.round((i / (n - 1)) * (s.length - 1)))]!);
}

/** Draw from a quantile summary by interpolating between neighbouring quantiles. */
export function fromQuantiles(q: number[], rng: Rng, integer = false): number {
  if (q.length === 0) return 0;
  const pos = rng.float() * (q.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(q.length - 1, lo + 1);
  const v = q[lo]! + (q[hi]! - q[lo]!) * (pos - lo);
  return integer ? Math.round(v) : v;
}

function timeValue(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== "string") return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v.replace(" ", "T") : `${v.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}

export function profileColumn(col: ColumnModel, meaning: MeaningId, values: unknown[]): ColumnProfile {
  const present = values.filter((v) => v !== null && v !== undefined);
  const p: ColumnProfile = { nullRate: values.length ? 1 - present.length / values.length : 0 };
  if (!present.length) return p;
  const isKey = col.primaryKey || meaning === "reference" || meaning === "id";
  if (isKey) return p;
  if (col.type === "integer" || col.type === "decimal" || col.type === "real") {
    const nums = present.map(Number).filter(Number.isFinite);
    p.quantiles = quantiles(nums);
    p.integer = col.type === "integer";
  } else if (col.type === "date" || col.type === "datetime") {
    const ts = present.map(timeValue).filter((t): t is number => t !== null);
    p.quantiles = quantiles(ts);
  } else if (col.type === "text" || col.type === "enum") {
    p.quantiles = quantiles(present.map((v) => String(v).length));
  }
  // Categories: low-cardinality, non-personal columns only, each value seen ≥ K_MIN times.
  if (!PERSONAL.includes(meaning) || col.type === "enum" || col.type === "boolean") {
    const counts = new Map<string, { value: string | number | boolean; n: number }>();
    for (const v of present) {
      const k = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (k.length > 60) return p;
      const e = counts.get(k) ?? { value: v as string | number | boolean, n: 0 };
      e.n++;
      counts.set(k, e);
    }
    if (counts.size <= 40) {
      const kept = [...counts.values()].filter((e) => e.n >= K_MIN).sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
      const total = kept.reduce((s, e) => s + e.n, 0);
      if (kept.length && total / present.length >= 0.8) p.categories = kept.map((e) => ({ value: e.value, weight: e.n / total }));
    }
  }
  return p;
}

export async function measureDatabase(c: Connector, schema: SchemaModel, plan: Plan): Promise<Map<string, TableProfile>> {
  const profiles = new Map<string, TableProfile>();
  const data = new Map<string, Row[]>();
  for (const t of schema.tables) {
    const rows = await c.readRows(t, MEASURE_CAP);
    data.set(t.name, rows);
    const total = rows.length < MEASURE_CAP ? rows.length : await c.count(t);
    const columns = new Map<string, ColumnProfile>();
    for (const col of t.columns) {
      const meaning = plan.columns.find((x) => x.table === t.name && x.column === col.name)?.meaning ?? "text";
      columns.set(col.name, profileColumn(col, meaning, rows.map((r) => r[col.name])));
    }
    profiles.set(t.name, { rows: total, measuredRows: rows.length, columns, fanout: new Map() });
  }
  for (const r of plan.rules) {
    if (r.kind !== "fk" || !r.enabled) continue;
    const child = data.get(r.table);
    const parent = data.get(r.refTable);
    if (!child || !parent || !parent.length) continue;
    const perParent = new Map<string, number>();
    for (const p of parent) perParent.set(r.refColumns.map((c) => String(p[c])).join("\u0001"), 0);
    for (const row of child) {
      const k = r.columns.map((c) => String(row[c])).join("\u0001");
      if (perParent.has(k)) perParent.set(k, perParent.get(k)! + 1);
    }
    profiles.get(r.table)!.fanout.set(r.id, quantiles([...perParent.values()]));
  }
  return profiles;
}

/** Same-shape check for the report: share of nulls and the median, original vs synthetic. */
export function shapeOf(t: TableModel, rows: Row[], plan: Plan): Map<string, ColumnProfile> {
  const m = new Map<string, ColumnProfile>();
  for (const col of t.columns) {
    const meaning = plan.columns.find((x) => x.table === t.name && x.column === col.name)?.meaning ?? "text";
    m.set(col.name, profileColumn(col, meaning, rows.map((r) => r[col.name])));
  }
  return m;
}
