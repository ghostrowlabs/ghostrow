import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { callArgs, inside, parseDjango, pyClasses, splitArgs, unquote } from "../connect/orm.js";
import { findColumn, type SchemaModel, type TableModel } from "../connect/types.js";
import type { Plan } from "../engine/infer.js";
import { words } from "../engine/meanings.js";

/**
 * Code-aware rules (Pro, Max): read validators in application code — Zod, Pydantic, Django
 * and Laravel — and turn them into rules the generator honours: allowed values, length and
 * numeric limits, formats (email, URL, UUID) and patterns. Read statically; nothing is run.
 */

export interface FieldRule {
  model: string;
  field: string;
  kind: "values" | "min" | "max" | "minLength" | "maxLength" | "length" | "format" | "pattern" | "integer";
  value: string | number | (string | number)[];
  source: string;
}

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|py|php)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "venv", ".venv", "__pycache__", "coverage", "migrations", "target"]);

export function scanCode(dir: string): FieldRule[] {
  const rules: FieldRule[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 10) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (CODE_EXT.test(e.name) && statSync(p).size < 2_000_000) {
        const src = readFileSync(p, "utf8");
        const rel = relative(process.cwd(), p).replace(/\\/g, "/");
        if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && /\bz\.object\(/.test(src)) rules.push(...readZod(src, rel));
        if (e.name.endsWith(".py") && /BaseModel|pydantic/.test(src)) rules.push(...readPydantic(src, rel));
        if (e.name.endsWith(".py") && /models\.Model/.test(src)) rules.push(...readDjango(src, rel));
        if (e.name.endsWith(".php") && /=>\s*['"[]/.test(src) && /(validate|rules)\s*\(/.test(src)) rules.push(...readLaravel(src, rel));
      }
    }
  };
  walk(dir, 0);
  return rules;
}

/* ------------------------------------------------------------------ Zod */

export function readZod(src: string, file: string): FieldRule[] {
  const out: FieldRule[] = [];
  const source = `${file} (Zod)`;
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*z\s*\.\s*object\s*\(/g)) {
    const model = m[1]!.replace(/(Schema|Input|Validator|Shape|Dto|Form)$/i, "");
    const open = m.index! + m[0].length - 1;
    const body = inside(src, open).text.trim().replace(/^\{|\}$/g, "");
    for (const prop of splitArgs(body)) {
      const pm = /^["']?(\w+)["']?\s*:\s*([\s\S]+)$/.exec(prop.trim());
      if (!pm) continue;
      const field = pm[1]!;
      const chain = pm[2]!;
      const add = (kind: FieldRule["kind"], value: FieldRule["value"]) => out.push({ model, field, kind, value, source });
      const en = /z\s*\.\s*enum\s*\(\s*\[([^\]]*)\]/.exec(chain);
      if (en) add("values", [...en[1]!.matchAll(/(['"])(.*?)\1/g)].map((x) => x[2]!));
      const lits = [...chain.matchAll(/z\s*\.\s*literal\s*\(\s*(['"])(.*?)\1/g)].map((x) => x[2]!);
      if (lits.length) add("values", lits);
      const isString = /z\s*\.\s*string\(/.test(chain);
      const isNumber = /z\s*\.\s*(number|bigint)\(|z\.coerce\.number\(/.test(chain);
      for (const c of chain.matchAll(/\.(email|url|uuid|cuid|ulid|ip|datetime|min|max|length|regex|int|positive|nonnegative|negative|gte|gt|lte|lt|startsWith|endsWith)\s*\(\s*([^)]*)\)/g)) {
        const fn = c[1]!;
        const arg = c[2]!.split(",")[0]!.trim();
        if (["email", "url", "uuid", "ip"].includes(fn)) add("format", fn);
        else if (fn === "int") add("integer", 1);
        else if (fn === "positive") add("min", 1);
        else if (fn === "nonnegative") add("min", 0);
        else if (fn === "regex") {
          const re = /^\/(.*)\/[a-z]*$/s.exec(arg);
          if (re) add("pattern", re[1]!);
        } else if (["min", "gte", "gt"].includes(fn) && /^-?[\d.]+$/.test(arg)) add(isString ? "minLength" : "min", Number(arg) + (fn === "gt" && isNumber ? 1 : 0));
        else if (["max", "lte", "lt"].includes(fn) && /^-?[\d.]+$/.test(arg)) add(isString ? "maxLength" : "max", Number(arg) - (fn === "lt" && isNumber ? 1 : 0));
        else if (fn === "length" && /^\d+$/.test(arg)) add("length", Number(arg));
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ Pydantic */

export function readPydantic(src: string, file: string): FieldRule[] {
  const out: FieldRule[] = [];
  const source = `${file} (Pydantic)`;
  for (const cls of pyClasses(src)) {
    if (!/BaseModel|SQLModel|BaseSettings/.test(cls.bases)) continue;
    const model = cls.name.replace(/(Schema|In|Out|Create|Update|Model|Base|Request|Response)$/, "") || cls.name;
    for (const a of cls.attrs) {
      if (!a.annotation) continue;
      const add = (kind: FieldRule["kind"], value: FieldRule["value"]) => out.push({ model, field: a.name, kind, value, source });
      const ann = a.annotation;
      if (/\bEmailStr\b/.test(ann)) add("format", "email");
      if (/\b(AnyUrl|HttpUrl|AnyHttpUrl)\b/.test(ann)) add("format", "url");
      if (/\bUUID\d?\b/.test(ann)) add("format", "uuid");
      const lit = /Literal\[([^\]]*)\]/.exec(ann);
      if (lit) add("values", [...lit[1]!.matchAll(/(['"])(.*?)\1/g)].map((x) => x[2]!));
      const kwSources = [...`${ann} ${a.value}`.matchAll(/\b(constr|conint|confloat|condecimal|Field|StringConstraints)\s*\(/g)].map((x) => inside(`${ann} ${a.value}`, x.index! + x[0].length - 1).text);
      for (const ks of kwSources) {
        const { kw } = callArgs(ks);
        const num = (k: string) => (kw[k] !== undefined && /^-?[\d.]+$/.test(kw[k]!) ? Number(kw[k]) : undefined);
        if (num("min_length") !== undefined) add("minLength", num("min_length")!);
        if (num("max_length") !== undefined) add("maxLength", num("max_length")!);
        if (num("ge") !== undefined) add("min", num("ge")!);
        if (num("gt") !== undefined) add("min", num("gt")! + (/int/.test(ann) ? 1 : 0.01));
        if (num("le") !== undefined) add("max", num("le")!);
        if (num("lt") !== undefined) add("max", num("lt")! - (/int/.test(ann) ? 1 : 0.01));
        const pat = unquote(kw.pattern ?? kw.regex);
        if (pat) add("pattern", pat);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ Django */

export function readDjango(src: string, file: string): FieldRule[] {
  const out: FieldRule[] = [];
  const source = `${file} (Django)`;
  for (const t of parseDjango(src)) {
    const model = t.name.replace(/^app_/, "");
    for (const c of t.columns) {
      if (c.enumValues?.length) out.push({ model, field: c.name, kind: "values", value: c.enumValues, source });
      if (c.maxLength !== undefined && c.type === "text") out.push({ model, field: c.name, kind: "maxLength", value: c.maxLength, source });
      if (/^varchar\(254\)$/.test(c.rawType) && /email/i.test(c.name)) out.push({ model, field: c.name, kind: "format", value: "email", source });
    }
    for (const check of t.checks) {
      const m = /^(?:length\()?(\w+)\)?\s*(>=|<=)\s*(-?[\d.]+)$/.exec(check);
      if (m) out.push({ model, field: m[1]!, kind: check.startsWith("length(") ? (m[2] === ">=" ? "minLength" : "maxLength") : m[2] === ">=" ? "min" : "max", value: Number(m[3]), source });
    }
  }
  // Django class names: map "app_invoice" back to the class (Invoice) for matching.
  return out.map((r) => ({ ...r, model: r.model.replace(/^[a-z0-9]+_/, "") }));
}

/* ------------------------------------------------------------------ Laravel */

export function readLaravel(src: string, file: string): FieldRule[] {
  const out: FieldRule[] = [];
  const source = `${file} (Laravel)`;
  const model = /class\s+(?:Store|Update|Create)?(\w+?)(?:Request|Controller)\b/.exec(src)?.[1] ?? "";
  for (const m of src.matchAll(/(['"])([\w.*]+)\1\s*=>\s*(\[[^\]]*\]|(['"])[^'"]*\4)/g)) {
    const field = m[2]!.split(".").pop()!;
    if (field === "*") continue;
    const raw = m[3]!;
    const parts = raw.startsWith("[") ? [...raw.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]!) : raw.slice(1, -1).split("|");
    const add = (kind: FieldRule["kind"], value: FieldRule["value"]) => out.push({ model, field, kind, value, source });
    const numeric = parts.some((p) => /^(integer|numeric|decimal)/.test(p));
    for (const p of parts) {
      const [rule, arg = ""] = p.split(/:(.*)/s) as [string, string?];
      if (rule === "email") add("format", "email");
      else if (rule === "url") add("format", "url");
      else if (rule === "uuid") add("format", "uuid");
      else if (rule === "integer") add("integer", 1);
      else if (rule === "in") add("values", arg.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")));
      else if (rule === "min" && /^-?[\d.]+$/.test(arg)) add(numeric ? "min" : "minLength", Number(arg));
      else if (rule === "max" && /^-?[\d.]+$/.test(arg)) add(numeric ? "max" : "maxLength", Number(arg));
      else if (rule === "size" && /^\d+$/.test(arg)) add(numeric ? "min" : "length", Number(arg));
      else if (rule === "between") {
        const [lo, hi] = arg.split(",").map(Number);
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          add(numeric ? "min" : "minLength", lo!);
          add(numeric ? "max" : "maxLength", hi!);
        }
      } else if (rule === "digits" && /^\d+$/.test(arg)) add("pattern", `^\\d{${arg}}$`);
      else if (rule === "regex") {
        const re = /^\/(.*)\/[a-z]*$/s.exec(arg);
        if (re) add("pattern", re[1]!);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ mapping */

const norm = (s: string) => words(s).join("");
const singular = (s: string) => s.replace(/ies$/, "y").replace(/(ses|xes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");

function tableFor(schema: SchemaModel, model: string): TableModel | undefined {
  if (!model) return undefined;
  const m = singular(norm(model));
  return schema.tables.find((t) => singular(norm(t.name)) === m) ?? schema.tables.find((t) => singular(norm(t.name)).endsWith(m) && m.length >= 4);
}

export interface AppliedCodeRules {
  applied: { table: string; column: string; rule: string; source: string }[];
  unmatched: number;
}

/**
 * Attach code rules to the plan: allowed values and patterns become column settings;
 * limits become CHECK rules (source "code"), which the generator honours and the validator checks.
 */
export function applyCodeRules(plan: Plan, schema: SchemaModel, rules: FieldRule[]): AppliedCodeRules {
  const applied: AppliedCodeRules["applied"] = [];
  let unmatched = 0;
  const fieldIndex = new Map<string, { t: TableModel; c: string }[]>();
  for (const t of schema.tables) for (const c of t.columns) fieldIndex.set(norm(c.name), [...(fieldIndex.get(norm(c.name)) ?? []), { t, c: c.name }]);
  const seen = new Set<string>();
  for (const r of rules) {
    let table = tableFor(schema, r.model);
    let colName = table ? findColumn(table, r.field)?.name ?? table.columns.find((c) => norm(c.name) === norm(r.field))?.name : undefined;
    if (!table || !colName) {
      // No matching model: use the field only if exactly one table has a column with that name.
      const hits = fieldIndex.get(norm(r.field)) ?? [];
      if (hits.length !== 1) {
        unmatched++;
        continue;
      }
      table = hits[0]!.t;
      colName = hits[0]!.c;
    }
    const col = findColumn(table, colName)!;
    const inferred = plan.columns.find((c) => c.table === table!.name && c.column === colName);
    const key = `${table.name}.${colName}.${r.kind}.${JSON.stringify(r.value)}`;
    if (seen.has(key) || !inferred) continue;
    seen.add(key);
    const id = `code:${table.name}.${colName}.${r.kind}`;
    const pushCheck = (check: string, expr: string) => {
      if (plan.rules.some((x) => x.id === id)) return;
      plan.rules.push({ id, kind: "check", table: table!.name, check, expr, evidence: r.source, source: "code", enabled: true });
    };
    const q = (v: string | number) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    switch (r.kind) {
      case "values": {
        const vals = (r.value as (string | number)[]).filter((v) => col.maxLength === undefined || String(v).length <= col.maxLength);
        if (!vals.length || inferred.pinned) continue;
        inferred.values = vals;
        inferred.meaning = "status";
        inferred.evidence = r.source;
        inferred.confidence = 0.97;
        pushCheck(`${colName} IN (${vals.map(q).join(", ")})`, `${colName} is one of ${vals.join(", ")}`);
        break;
      }
      case "format": {
        const meaning = { email: "email", url: "url", uuid: "uuid", ip: "ip_address" }[String(r.value)] as typeof inferred.meaning | undefined;
        if (meaning && !inferred.pinned && col.type !== "uuid") {
          inferred.meaning = meaning;
          inferred.evidence = r.source;
          inferred.confidence = 0.97;
        }
        break;
      }
      case "pattern":
        if (!inferred.pinned) {
          inferred.pattern = String(r.value);
          inferred.evidence = r.source;
        }
        break;
      case "min":
        if (col.type !== "text") pushCheck(`${colName} >= ${r.value}`, `${colName} ≥ ${r.value}`);
        break;
      case "max":
        if (col.type !== "text") pushCheck(`${colName} <= ${r.value}`, `${colName} ≤ ${r.value}`);
        break;
      case "minLength":
        pushCheck(`length(${colName}) >= ${r.value}`, `${colName} has at least ${r.value} characters`);
        break;
      case "maxLength":
        pushCheck(`length(${colName}) <= ${r.value}`, `${colName} has at most ${r.value} characters`);
        break;
      case "length":
        pushCheck(`length(${colName}) = ${r.value}`, `${colName} has exactly ${r.value} characters`);
        break;
      case "integer":
        break;
    }
    applied.push({ table: table.name, column: colName, rule: `${r.kind} ${Array.isArray(r.value) ? r.value.join("/") : r.value}`, source: r.source });
  }
  return { applied, unmatched };
}
