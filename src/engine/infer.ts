import type { SampleSet, SchemaModel, TableModel } from "../connect/types.js";
import { bestMeaning, compatible, MEANING_LABEL, nameVotes, sampleVotes, typeVotes, type MeaningId } from "./meanings.js";
import { detectRules, type Rule } from "./rules.js";

/** Engine name and version. Bump the minor version whenever generated output would change. */
export const ENGINE = "gr-schema-1";
export const ENGINE_VERSION = "1.0";

export interface InferredColumn {
  table: string;
  column: string;
  meaning: MeaningId;
  /** 0–1: how strongly the signals agreed. */
  confidence: number;
  evidence: string;
  /** Set when the meaning came from the rules file rather than inference. */
  pinned?: boolean;
  /** Values the column must take (from a rules file, code or samples). */
  values?: (string | number)[];
  /** A regular expression from application code that values must match. */
  pattern?: string;
}

export interface Plan {
  engine: string;
  columns: InferredColumn[];
  rules: Rule[];
  /** Per-table row counts from the rules file. */
  rows: Record<string, number>;
  /** Tables whose row count came from a rule pack (not written back to your rules file). */
  packRows?: Record<string, string>;
}

/**
 * gr-schema-1 inference: a fixed weighted vote per column, then rule detection.
 * Deterministic — the same schema (and samples) always give the same plan.
 */
export function infer(schema: SchemaModel, samples?: SampleSet): Plan {
  const columns: InferredColumn[] = [];
  for (const t of schema.tables) {
    const rows = samples?.get(t.name);
    for (const c of t.columns) columns.push(inferColumn(t, c, rows));
  }
  return { engine: `${ENGINE}/${ENGINE_VERSION}`, columns, rules: detectRules(schema), rows: {} };
}

function inferColumn(t: TableModel, c: TableModel["columns"][number], rows?: Record<string, unknown>[]): InferredColumn {
  const fk = t.foreignKeys.find((f) => f.columns.includes(c.name));
  if (fk) return { table: t.name, column: c.name, meaning: "reference", confidence: 1, evidence: `foreign key to ${fk.refTable}` };

  const votes: Partial<Record<MeaningId, number>> = {};
  const add = (v: Partial<Record<MeaningId, number>>) => {
    for (const [k, s] of Object.entries(v)) votes[k as MeaningId] = (votes[k as MeaningId] ?? 0) + (s ?? 0);
  };
  const byName = nameVotes(c, t);
  add(byName);
  add(typeVotes(c));
  const evidence: string[] = [];
  if (Object.keys(byName).length) evidence.push("name");
  evidence.push("type");
  let sampleValues: string[] | undefined;
  if (rows && rows.length >= 3) {
    const vals = rows.map((r) => r[c.name]);
    const sv = sampleVotes(vals);
    if (Object.keys(sv).length) {
      add(sv);
      evidence.push("sampled values");
    }
    // A short, repeated set of values is a category: keep it (each value seen at least twice).
    if (sv.status) {
      const counts = new Map<string, number>();
      for (const v of vals) if (v !== null && v !== undefined) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const common = [...counts.entries()].filter(([, n]) => n >= 2).map(([v]) => v).sort();
      if (common.length >= 2) sampleValues = common;
    }
  }
  // CHECK (length(x) IN (10, 12)) on a column with "nic" in it: a Sri Lankan NIC.
  if (/(^|_)nic($|_)/i.test(c.name) && t.checks.some((k) => new RegExp(`\\b${c.name}\\b`, "i").test(k) && /\b10\b/.test(k) && /\b12\b/.test(k))) {
    votes.national_id_lk = (votes.national_id_lk ?? 0) + 4;
    evidence.push("CHECK on length 10 or 12");
  }
  const { meaning, score, total } = bestMeaning(votes, c);
  const confidence = score === 0 ? 0.3 : Math.min(0.99, Math.round((0.45 + 0.55 * (score / Math.max(total, 1)) * Math.min(1, score / 6)) * 100) / 100);
  const result: InferredColumn = { table: t.name, column: c.name, meaning, confidence, evidence: evidence.join(", ") };
  if (sampleValues && compatible("status", c) && meaning === "status") result.values = sampleValues;
  return result;
}

export function columnPlan(plan: Plan, table: string): Map<string, InferredColumn> {
  const m = new Map<string, InferredColumn>();
  for (const c of plan.columns) if (c.table === table) m.set(c.column, c);
  return m;
}

export function describeMeaning(c: InferredColumn): string {
  return MEANING_LABEL[c.meaning];
}
