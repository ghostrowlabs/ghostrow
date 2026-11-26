import { decimalMax, intMax } from "../connect/typemap.js";
import type { ColumnModel, TableModel } from "../connect/types.js";
import { evaluate, planChecks } from "../engine/checks.js";
import { uuidV4 } from "../engine/domains.js";
import type { Plan } from "../engine/infer.js";
import { Rng } from "../engine/prng.js";
import { repairRow, type GenOutput, type Row } from "../gen/seed.js";

/**
 * Haunt's edge cases: values real users eventually send, chosen from each column's type,
 * limits and validators. Every case stays inside the schema's constraints (it's data your
 * database accepts), so failures point at application code, not at the database.
 */

export interface HauntCase {
  id: string;
  table: string;
  /** The column the case is about (or "*" for whole-row cases). */
  column: string;
  kind: string;
  description: string;
  /** The rows this case adds (one, or a parent with many children). */
  rows: { table: string; row: Row }[];
}

interface Candidate {
  kind: string;
  description: string;
  value: unknown;
}

const LONG_TEXT = "Ghostrow edge case: the longest value this column accepts. ";

function textCases(col: ColumnModel, email: boolean): Candidate[] {
  const max = col.maxLength;
  const fit = (s: string) => (max !== undefined ? [...s].slice(0, max).join("") : s);
  const out: Candidate[] = [];
  if (email) {
    out.push({ kind: "email-plus", description: "email with a +tag and a subdomain", value: fit("first.last+orders@mail.sub.example.co.uk") });
    out.push({ kind: "email-case", description: "email in capitals", value: fit("ADA.LOVELACE@EXAMPLE.COM") });
    out.push({ kind: "email-apostrophe", description: "email with an apostrophe", value: fit("o'connor@example.com") });
    out.push({ kind: "email-long", description: "64-character local part (the RFC maximum)", value: fit(`${"a".repeat(64)}@example.com`) });
    return out;
  }
  const target = max ?? 10_000;
  out.push({ kind: "max-length", description: max !== undefined ? `exactly ${max} characters (the column maximum)` : "10,000 characters of text", value: LONG_TEXT.repeat(Math.ceil(target / LONG_TEXT.length)).slice(0, target) });
  out.push({ kind: "unicode", description: "accents, CJK and Greek characters", value: fit("Zoë Ñúñez-Łukasiewicz 李小龍 Ἀλέξανδρος") });
  out.push({ kind: "emoji", description: "emoji with skin tone and joiner sequences", value: fit("Launch party 🎉 👩🏽‍💻 ✅") });
  out.push({ kind: "rtl", description: "right-to-left text", value: fit("مرحبا بالعالم") });
  out.push({ kind: "quotes", description: "quotes, backslash, semicolon and comment markers", value: fit(`O'Brien "Jr." \\ ; -- /* */`) });
  out.push({ kind: "whitespace", description: "leading, trailing and doubled spaces", value: fit("  two  spaces  ") });
  out.push({ kind: "newline", description: "a line break and a tab inside the value", value: fit("line one\nline two\tend") });
  out.push({ kind: "empty", description: "empty string (not NULL)", value: "" });
  return out;
}

function numberCases(col: ColumnModel): Candidate[] {
  if (col.type === "integer") {
    const max = intMax(col);
    const unsigned = /unsigned/i.test(col.rawType);
    const out: Candidate[] = [
      { kind: "zero", description: "zero", value: 0 },
      { kind: "int-max", description: `the largest value the type holds (${max})`, value: max },
    ];
    if (!unsigned) out.push({ kind: "negative", description: "minus one", value: -1 }, { kind: "int-min", description: `the smallest value the type holds (${-max - 1})`, value: max === Number.MAX_SAFE_INTEGER ? -max : -max - 1 });
    return out;
  }
  const scale = col.scale ?? 2;
  const max = col.type === "decimal" ? decimalMax(col) : 1e15;
  const precise = col.type === "decimal" ? Number(`${Math.floor(max)}.${"9".repeat(Math.min(scale, 6))}`) : 1e15;
  return [
    { kind: "zero", description: "zero", value: 0 },
    { kind: "smallest-unit", description: `the smallest positive step (${(10 ** -Math.min(scale, 6)).toFixed(Math.min(scale, 6))})`, value: Number((10 ** -Math.min(scale, 6)).toFixed(Math.min(scale, 6))) },
    { kind: "max-precision", description: "the largest value the precision allows", value: Number.isFinite(precise) && precise <= max + 1 ? precise : max },
    { kind: "negative", description: "a small negative amount", value: -0.01 },
  ];
}

function timeCases(col: ColumnModel): Candidate[] {
  const tz = /with time zone|timestamptz|datetimeoffset/i.test(col.rawType);
  if (col.type === "date") {
    return [
      { kind: "leap-day", description: "29 February in a leap year", value: "2028-02-29" },
      { kind: "year-end", description: "31 December", value: "2026-12-31" },
      { kind: "epoch", description: "1 January 1970", value: "1970-01-01" },
      { kind: "y2038", description: "19 January 2038 (32-bit timestamp limit)", value: "2038-01-19" },
      { kind: "far-past", description: "1 January 1900", value: "1900-01-01" },
    ];
  }
  if (col.type === "time") {
    return [
      { kind: "midnight", description: "midnight", value: "00:00:00" },
      { kind: "last-second", description: "23:59:59", value: "23:59:59" },
    ];
  }
  const out: Candidate[] = [
    { kind: "leap-day", description: "29 February in a leap year, one minute before midnight", value: tz ? "2028-02-29 23:59:00-12:00" : "2028-02-29 23:59:00" },
    { kind: "dst-gap", description: "a time that doesn't exist in Europe (clocks go forward)", value: "2026-03-29 02:30:00" },
    { kind: "dst-overlap", description: "a time that happens twice in the US (clocks go back)", value: "2026-11-01 01:30:00" },
    { kind: "year-end", description: "the last second of the year", value: "2026-12-31 23:59:59" },
    { kind: "epoch", description: "the Unix epoch", value: "1970-01-01 00:00:00" },
    { kind: "y2038", description: "one second past the 32-bit timestamp limit", value: "2038-01-19 03:14:08" },
  ];
  if (tz) out.push({ kind: "tz-east", description: "the easternmost time zone (UTC+14)", value: "2027-01-01 00:00:00+14:00" });
  if (col.type === "integer") return out.map((c) => ({ ...c, value: Math.floor(Date.parse(`${String(c.value).replace(" ", "T").replace(/([+-]\d{2}:\d{2})?$/, (m) => m || "Z")}`) / 1000) }));
  return out;
}

/** Edge cases for every column of every table, interleaved across tables and capped at `limit`. */
export function buildCases(base: GenOutput, plan: Plan, seed: number, limit: number, idStart: Map<string, number>): HauntCase[] {
  const perTable: HauntCase[][] = [];
  const nextId = new Map(idStart);
  const used = new Map<string, Set<string>>();
  let n = 0;

  for (const { table, rows } of base) {
    if (!rows.length) continue;
    const list: HauntCase[] = [];
    const checks = plan.rules.filter((r) => r.enabled && r.table === table.name && r.kind === "check").map((r) => (r.kind === "check" ? r.check : ""));
    const trees = planChecks(checks).parsed.filter((p) => p.tree).map((p) => p.tree!);
    const uniques = plan.rules.filter((r) => r.enabled && r.table === table.name && r.kind === "unique").map((r) => (r.kind === "unique" ? r.columns : []));
    const fkCols = new Set(table.foreignKeys.flatMap((f) => f.columns));
    const rng = new Rng(seed, `haunt.${table.name}`);
    const sumTargets = new Set(plan.rules.filter((r) => r.kind === "sum" && r.enabled && r.table === table.name).map((r) => (r.kind === "sum" ? r.column : "")));

    const rowsOf = new Map(base.map((o) => [o.table.name, o.rows]));
    const derived = new Set(plan.rules.filter((r) => r.enabled && r.table === table.name && (r.kind === "copy" || r.kind === "product")).map((r) => (r.kind === "copy" || r.kind === "product" ? r.column : "")));
    const derive = (changes: Row, label: string): Row | null => {
      const template = rows[rng.int(0, rows.length - 1)]!;
      const row: Row = { ...template, ...changes };
      freshKeys(table, row, nextId, `${label}`, Object.keys(changes), rng);
      const fixed = Object.keys(changes).length === 1 ? Object.keys(changes)[0]! : "";
      repairRow(plan, table, row, fixed, rowsOf, rng);
      if (fixed && row[fixed] !== changes[fixed]) return null;
      for (const c of table.columns) {
        const v = row[c.name];
        if ((v === null || v === undefined) && !c.nullable && !(c.autoIncrement && v === undefined)) return null;
        if (typeof v === "string" && c.maxLength !== undefined && v.length > c.maxLength) return null;
        if (c.type === "enum" && v !== null && v !== undefined && c.enumValues && !c.enumValues.includes(String(v))) return null;
      }
      if (trees.some((t) => evaluate(t, row) === false)) return null;
      for (const u of uniques) {
        if (u.some((c) => row[c] === null || row[c] === undefined)) continue;
        const key = `${table.name}:${u.join("+")}`;
        const set = used.get(key) ?? new Set(rows.map((r) => u.map((c) => String(r[c])).join("\u0001")));
        used.set(key, set);
        const k = u.map((c) => String(row[c])).join("\u0001");
        if (set.has(k)) return null;
        set.add(k);
      }
      return row;
    };

    for (const col of table.columns) {
      if (col.primaryKey || fkCols.has(col.name) || col.defaultValue?.startsWith("generated:") || sumTargets.has(col.name) || derived.has(col.name)) continue;
      const meaning = plan.columns.find((c) => c.table === table.name && c.column === col.name)?.meaning;
      const candidates =
        col.type === "text" ? textCases(col, meaning === "email") : col.type === "integer" || col.type === "decimal" || col.type === "real" ? numberCases(col) : col.type === "date" || col.type === "datetime" || col.type === "time" ? timeCases(col) : col.type === "enum" && col.enumValues?.length ? [{ kind: "rare-enum", description: `the last enum value (${col.enumValues[col.enumValues.length - 1]})`, value: col.enumValues[col.enumValues.length - 1] }] : [];
      for (const c of candidates) {
        const row = derive({ [col.name]: c.value }, c.kind);
        if (row) list.push({ id: "", table: table.name, column: col.name, kind: c.kind, description: c.description, rows: [{ table: table.name, row }] });
      }
    }
    // Nulls where nobody expects them: every nullable column empty at once.
    const nullable = table.columns.filter((c) => c.nullable && !c.primaryKey);
    if (nullable.length > 1) {
      const row = derive(Object.fromEntries(nullable.map((c) => [c.name, null])), "all-null");
      if (row) list.push({ id: "", table: table.name, column: "*", kind: "all-nulls", description: `every optional column NULL (${nullable.length} columns)`, rows: [{ table: table.name, row }] });
    }
    perTable.push(list);
  }

  // Parents with no children, and with many.
  for (const r of plan.rules) {
    if (r.kind !== "fk" || !r.enabled || r.refTable === r.table) continue;
    const parent = base.find((o) => o.table.name === r.refTable);
    const child = base.find((o) => o.table.name === r.table);
    if (!parent?.rows.length || !child?.rows.length) continue;
    const list = perTable[base.indexOf(parent)] ?? [];
    const rng = new Rng(seed, `haunt.fanout.${r.id}`);
    const lonely: Row = { ...parent.rows[0]! };
    freshKeys(parent.table, lonely, nextId, "lonely", [], rng);
    list.push({ id: "", table: parent.table.name, column: "*", kind: "no-children", description: `a ${parent.table.name} row with no ${child.table.name}`, rows: [{ table: parent.table.name, row: lonely }] });
    const busy: Row = { ...parent.rows[0]! };
    freshKeys(parent.table, busy, nextId, "busy", [], rng);
    const kids: { table: string; row: Row }[] = [];
    for (let k = 0; k < 50; k++) {
      const c: Row = { ...child.rows[k % child.rows.length]! };
      r.columns.forEach((col, j) => (c[col] = busy[r.refColumns[j]!]));
      freshKeys(child.table, c, nextId, `busy${k}`, r.columns, rng);
      kids.push({ table: child.table.name, row: c });
    }
    const uniqueFk = child.table.columns.some((c) => c.unique && r.columns.includes(c.name)) || child.table.uniques.some((u) => u.every((c) => r.columns.includes(c)));
    if (!uniqueFk) list.push({ id: "", table: parent.table.name, column: "*", kind: "many-children", description: `one ${parent.table.name} row with 50 ${child.table.name}`, rows: [{ table: parent.table.name, row: busy }, ...kids] });
  }

  // Interleave tables so a small --cases still covers every table.
  const out: HauntCase[] = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const list of perTable) {
      const c = list[round];
      if (!c) continue;
      added = true;
      if (out.length < limit) out.push({ ...c, id: `H${String(++n).padStart(3, "0")}` });
    }
    if (!added) break;
  }
  return out;
}

/** New primary key and unique values for a derived row, so it never collides with the base rows. */
function freshKeys(table: TableModel, row: Row, nextId: Map<string, number>, tag: string, keep: string[], rng: Rng): void {
  for (const c of table.columns) {
    if (keep.includes(c.name)) continue;
    const fk = table.foreignKeys.some((f) => f.columns.includes(c.name));
    const isKey = c.primaryKey || c.unique || (!fk && table.uniques.some((u) => u.includes(c.name)));
    if (!isKey) continue;
    if (c.type === "integer") {
      const next = nextId.get(table.name) ?? 1_000_000;
      nextId.set(table.name, next + 1);
      row[c.name] = next;
    } else if (c.type === "uuid") row[c.name] = uuidV4(rng);
    else if (c.type === "text") {
      const base = String(row[c.name] ?? c.name);
      const suffix = `-h${tag}${rng.int(100, 999)}`;
      row[c.name] = c.maxLength !== undefined ? `${base.slice(0, Math.max(0, c.maxLength - suffix.length))}${suffix}`.slice(-c.maxLength) : `${base}${suffix}`;
      if (/@/.test(base)) row[c.name] = `h${tag}${rng.int(100, 999)}.${base}`.slice(0, c.maxLength ?? 320);
    }
  }
}
