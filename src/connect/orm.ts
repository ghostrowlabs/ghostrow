import { applyMapped, mapSqlType } from "./typemap.js";
import { normalizeTable, type ColumnModel, type ForeignKey, type TableModel } from "./types.js";

/**
 * ORM model readers: Prisma schema, Django models, SQLAlchemy models and Laravel migrations.
 * Each reads the source text statically (nothing is imported or executed) and produces the
 * same TableModel a live database would.
 */

const col = (name: string, rawType: string, extra: Partial<ColumnModel> = {}): ColumnModel => ({
  name,
  type: "text",
  rawType,
  nullable: true,
  primaryKey: false,
  autoIncrement: false,
  unique: false,
  ...extra,
});

/* ------------------------------------------------------------------ helpers */

/** Split at top-level commas, respecting (), [], {} and quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") {
        cur += s[++i] ?? "";
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The text between the parenthesis at `open` and its match. */
export function inside(s: string, open: number): { text: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { text: s.slice(open + 1, i), end: i };
    }
  }
  return { text: s.slice(open + 1), end: s.length };
}

/** Keyword and positional arguments of a call's argument text. */
export function callArgs(text: string): { pos: string[]; kw: Record<string, string> } {
  const pos: string[] = [];
  const kwargs: Record<string, string> = {};
  for (const a of splitArgs(text)) {
    const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
    if (m) kwargs[m[1]!] = m[2]!.trim();
    else pos.push(a);
  }
  return { pos, kw: kwargs };
}

export const unquote = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  const m = /^[rbuf]?(['"])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2] : undefined;
};

const truthy = (s: string | undefined) => s !== undefined && /^(True|true)$/.test(s.trim());

/** Strings inside a Python/PHP list or tuple literal, in order. */
function stringsIn(s: string): string[] {
  return [...s.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
}

/* ------------------------------------------------------------------ Prisma */

const PRISMA_TYPES: Record<string, string> = {
  String: "text",
  Int: "integer",
  BigInt: "bigint",
  Float: "double precision",
  Decimal: "decimal(65,30)",
  Boolean: "boolean",
  DateTime: "timestamp",
  Json: "json",
  Bytes: "bytea",
};

export function parsePrisma(src: string): TableModel[] {
  const enums = new Map<string, string[]>();
  for (const m of src.matchAll(/^\s*enum\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    enums.set(m[1]!, m[2]!.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim().split(/\s+/)[0] ?? "").filter((v) => v && !v.startsWith("@")));
  }
  const models: { name: string; body: string }[] = [];
  for (const m of src.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) models.push({ name: m[1]!, body: m[2]! });
  const tableName = new Map<string, string>();
  for (const m of models) tableName.set(m.name, /@@map\(\s*"([^"]+)"/.exec(m.body)?.[1] ?? m.name);

  const tables: TableModel[] = [];
  for (const model of models) {
    const t: TableModel = { name: tableName.get(model.name)!, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [] };
    const fieldColumn = new Map<string, string>();
    const relations: { fields: string[]; references: string[]; target: string }[] = [];
    for (const raw of model.body.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line) continue;
      if (line.startsWith("@@")) {
        const id = /@@id\(\s*(?:fields:\s*)?\[([^\]]*)\]/.exec(line);
        if (id) t.primaryKey = id[1]!.split(",").map((x) => x.trim());
        const uq = /@@unique\(\s*(?:fields:\s*)?\[([^\]]*)\]/.exec(line);
        if (uq) t.uniques.push(uq[1]!.split(",").map((x) => x.trim()));
        continue;
      }
      const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!fm) continue;
      const [, field, type, list, optional, attrs = ""] = fm;
      if (list) continue; // the "many" side of a relation
      const rel = /@relation\(([^)]*)\)/.exec(attrs);
      if (rel && models.some((m) => m.name === type)) {
        const fields = /fields:\s*\[([^\]]*)\]/.exec(rel[1]!)?.[1];
        const refs = /references:\s*\[([^\]]*)\]/.exec(rel[1]!)?.[1];
        if (fields) relations.push({ fields: fields.split(",").map((x) => x.trim()), references: (refs ?? "id").split(",").map((x) => x.trim()), target: type! });
        continue;
      }
      if (models.some((m) => m.name === type)) continue; // relation without fields (back side)
      const name = /@map\(\s*"([^"]+)"/.exec(attrs)?.[1] ?? field!;
      fieldColumn.set(field!, name);
      const c = col(name, type!);
      const enumValues = enums.get(type!);
      if (enumValues) {
        c.type = "enum";
        c.enumValues = enumValues;
      } else {
        const db = /@db\.(\w+)(?:\(([^)]*)\))?/.exec(attrs);
        if (db) {
          c.rawType = db[0].slice(4);
          applyMapped(c, mapSqlType(db[1]!, db[2] ? db[2].split(",").map((x) => x.trim()) : []));
        } else applyMapped(c, mapSqlType(PRISMA_TYPES[type!] ?? "text"));
      }
      c.nullable = optional === "?";
      if (/@id\b/.test(attrs)) {
        c.primaryKey = true;
        t.primaryKey = [name];
      }
      if (/@unique\b/.test(attrs)) c.unique = true;
      if (/@default\(\s*autoincrement\(\)\s*\)/.test(attrs)) c.autoIncrement = true;
      const def = /@default\(([^)]*\)?)\)/.exec(attrs);
      if (def) c.defaultValue = def[1];
      if (/@default\(\s*(uuid|cuid|nanoid)\(/.test(attrs) && c.type === "text") c.defaultValue = def?.[1] ?? "uuid()";
      t.columns.push(c);
    }
    t.primaryKey = t.primaryKey.map((f) => fieldColumn.get(f) ?? f);
    t.uniques = t.uniques.map((u) => u.map((f) => fieldColumn.get(f) ?? f));
    for (const r of relations) {
      const target = models.find((m) => m.name === r.target)!;
      const targetCols = new Map<string, string>();
      for (const l of target.body.split("\n")) {
        const fm = /^\s*(\w+)\s+\w+.*?@map\(\s*"([^"]+)"/.exec(l);
        if (fm) targetCols.set(fm[1]!, fm[2]!);
      }
      t.foreignKeys.push({ columns: r.fields.map((f) => fieldColumn.get(f) ?? f), refTable: tableName.get(r.target)!, refColumns: r.references.map((f) => targetCols.get(f) ?? f) });
    }
    tables.push(normalizeTable(t));
  }
  return tables;
}

/* ------------------------------------------------------------------ Python */

interface PyClass {
  name: string;
  bases: string;
  /** `name = value` or `name: annotation = value` statements in the class body. */
  attrs: { name: string; annotation?: string; value: string }[];
  /** Nested class Meta attrs. */
  meta: Record<string, string>;
  /** Other nested classes (e.g. `class Kind(models.TextChoices)`), with their attributes. */
  nested: Record<string, { bases: string; attrs: { name: string; value: string }[] }>;
}

/** Read top-level classes and their attribute statements (balanced across lines). */
export function pyClasses(src: string): PyClass[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const classes: PyClass[] = [];
  let cur: PyClass | null = null;
  let inMeta = false;
  let metaIndent = 0;
  let nested: string | null = null;
  let nestedIndent = 0;
  let classIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const cm = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
    if (cm && cm[1]!.length === 0) {
      cur = { name: cm[2]!, bases: cm[3] ?? "", attrs: [], meta: {}, nested: {} };
      nested = null;
      classes.push(cur);
      classIndent = 0;
      inMeta = false;
      continue;
    }
    if (!cur) continue;
    if (indent <= classIndent) {
      cur = null;
      continue;
    }
    if (cm && /Meta/.test(cm[2]!)) {
      inMeta = true;
      metaIndent = indent;
      continue;
    }
    if (inMeta && indent <= metaIndent) inMeta = false;
    if (nested && indent <= nestedIndent) nested = null;
    if (cm) {
      nested = cm[2]!;
      nestedIndent = indent;
      cur.nested[nested] = { bases: cm[3] ?? "", attrs: [] };
      continue;
    }
    if (/^\s*(def|async def|@)/.test(line)) {
      // Skip a method body.
      const defIndent = indent;
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() && next.length - next.trimStart().length <= defIndent && !/^\s*@/.test(next)) break;
        i++;
      }
      continue;
    }
    // Join continuation lines until parentheses balance.
    let stmt = line.trim();
    let depth = (stmt.match(/[([{]/g) ?? []).length - (stmt.match(/[)\]}]/g) ?? []).length;
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      const more = lines[i]!.replace(/#.*$/, "").trim();
      stmt += ` ${more}`;
      depth += (more.match(/[([{]/g) ?? []).length - (more.match(/[)\]}]/g) ?? []).length;
    }
    const am = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(stmt);
    if (!am) continue;
    if (inMeta) {
      if (am[3]) cur.meta[am[1]!] = am[3].trim();
      continue;
    }
    if (nested) {
      if (am[3]) cur.nested[nested]!.attrs.push({ name: am[1]!, value: am[3].trim() });
      continue;
    }
    if (am[3] === undefined && am[2] === undefined) continue;
    cur.attrs.push({ name: am[1]!, ...(am[2] ? { annotation: am[2].trim() } : {}), value: (am[3] ?? "").trim() });
  }
  return classes;
}

/** `models.CharField(...)` → { fn: "CharField", args } */
function callOf(value: string): { fn: string; args: string } | null {
  const m = /^([\w.]+)\s*\(/.exec(value);
  if (!m) return null;
  const { text } = inside(value, m[0].length - 1);
  return { fn: m[1]!.split(".").pop()!, args: text };
}

const DJANGO_TYPES: Record<string, (kw: Record<string, string>) => Partial<ColumnModel> & { sql: string }> = {
  AutoField: () => ({ sql: "integer", autoIncrement: true }),
  BigAutoField: () => ({ sql: "bigint", autoIncrement: true }),
  SmallAutoField: () => ({ sql: "smallint", autoIncrement: true }),
  CharField: (k) => ({ sql: `varchar(${k.max_length ?? 255})` }),
  SlugField: (k) => ({ sql: `varchar(${k.max_length ?? 50})` }),
  EmailField: (k) => ({ sql: `varchar(${k.max_length ?? 254})` }),
  URLField: (k) => ({ sql: `varchar(${k.max_length ?? 200})` }),
  TextField: () => ({ sql: "text" }),
  IntegerField: () => ({ sql: "integer" }),
  BigIntegerField: () => ({ sql: "bigint" }),
  SmallIntegerField: () => ({ sql: "smallint" }),
  PositiveIntegerField: () => ({ sql: "integer" }),
  PositiveBigIntegerField: () => ({ sql: "bigint" }),
  PositiveSmallIntegerField: () => ({ sql: "smallint" }),
  BooleanField: () => ({ sql: "boolean" }),
  NullBooleanField: () => ({ sql: "boolean", nullable: true }),
  DateField: () => ({ sql: "date" }),
  DateTimeField: () => ({ sql: "timestamp" }),
  TimeField: () => ({ sql: "time" }),
  DurationField: () => ({ sql: "interval" }),
  DecimalField: (k) => ({ sql: `decimal(${k.max_digits ?? 10},${k.decimal_places ?? 2})` }),
  FloatField: () => ({ sql: "double precision" }),
  UUIDField: () => ({ sql: "uuid" }),
  JSONField: () => ({ sql: "jsonb" }),
  BinaryField: () => ({ sql: "bytea" }),
  GenericIPAddressField: () => ({ sql: "inet" }),
  IPAddressField: () => ({ sql: "inet" }),
  FileField: (k) => ({ sql: `varchar(${k.max_length ?? 100})` }),
  ImageField: (k) => ({ sql: `varchar(${k.max_length ?? 100})` }),
};

/** Django models.py → tables named `<app>_<model>` (or Meta.db_table). */
export function parseDjango(src: string, appLabel = "app"): TableModel[] {
  const classes = pyClasses(src).filter((c) => /models\.Model|Model\b/.test(c.bases) && c.meta.abstract !== "True");
  const tableOf = (cls: string) => {
    const c = classes.find((x) => x.name === cls);
    return unquote(c?.meta.db_table) ?? `${appLabel}_${cls.toLowerCase()}`;
  };
  const tables: TableModel[] = [];
  for (const cls of classes) {
    const t: TableModel = { name: tableOf(cls.name), columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [] };
    for (const a of cls.attrs) {
      const call = callOf(a.value);
      if (!call) continue;
      const { pos, kw } = callArgs(call.args);
      if (call.fn === "ForeignKey" || call.fn === "OneToOneField") {
        const target = unquote(pos[0]) ?? pos[0] ?? kw.to ?? "";
        const targetName = target === "self" ? cls.name : target.split(".").pop()!;
        const name = unquote(kw.db_column) ?? `${a.name}_id`;
        const c = col(name, "integer", { nullable: truthy(kw.null), unique: call.fn === "OneToOneField" || truthy(kw.unique) });
        applyMapped(c, mapSqlType("bigint"));
        t.columns.push(c);
        t.foreignKeys.push({ columns: [name], refTable: tableOf(targetName), refColumns: ["id"] });
        continue;
      }
      if (call.fn === "ManyToManyField") {
        const target = (unquote(pos[0]) ?? pos[0] ?? "").split(".").pop()!;
        const through = `${t.name}_${a.name}`;
        const left = `${cls.name.toLowerCase()}_id`;
        const right = `${target.toLowerCase()}_id`;
        tables.push(
          normalizeTable({
            name: through,
            columns: [col("id", "bigint", { type: "integer", primaryKey: true, autoIncrement: true, nullable: false, intBytes: 8 }), col(left, "bigint", { type: "integer", nullable: false, intBytes: 8 }), col(right, "bigint", { type: "integer", nullable: false, intBytes: 8 })],
            primaryKey: ["id"],
            foreignKeys: [
              { columns: [left], refTable: t.name, refColumns: ["id"] },
              { columns: [right], refTable: tableOf(target), refColumns: ["id"] },
            ],
            uniques: [[left, right]],
            checks: [],
          }),
        );
        continue;
      }
      const spec = DJANGO_TYPES[call.fn];
      if (!spec) continue;
      const s = spec(kw);
      const name = unquote(kw.db_column) ?? a.name;
      const c = col(name, s.sql);
      applyMapped(c, mapSqlType(s.sql.replace(/\(.*$/, ""), (/\(([^)]*)\)/.exec(s.sql)?.[1] ?? "").split(",").filter(Boolean)));
      if (s.autoIncrement) c.autoIncrement = true;
      c.nullable = truthy(kw.null) || s.nullable === true;
      c.unique = truthy(kw.unique);
      if (truthy(kw.primary_key)) c.primaryKey = true;
      if (kw.choices) {
        const values = djangoChoices(kw.choices, cls, src);
        if (values.length) {
          c.type = "enum";
          c.enumValues = values;
        }
      }
      if (kw.default !== undefined) c.defaultValue = kw.default;
      if (/^Positive/.test(call.fn)) t.checks.push(`${name} >= 0`);
      for (const v of (kw.validators ?? "").matchAll(/(Min|Max)ValueValidator\(\s*([-\d.]+)/g)) t.checks.push(`${name} ${v[1] === "Min" ? ">=" : "<="} ${v[2]}`);
      for (const v of (kw.validators ?? "").matchAll(/MinLengthValidator\(\s*(\d+)/g)) t.checks.push(`length(${name}) >= ${v[1]}`);
      t.columns.push(c);
    }
    if (!t.columns.some((c) => c.primaryKey)) t.columns.unshift(col("id", "bigint", { type: "integer", intBytes: 8, primaryKey: true, autoIncrement: true, nullable: false }));
    const ut = cls.meta.unique_together;
    if (ut) for (const group of ut.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g)) {
      const names = stringsIn(group[0]);
      if (names.length > 1) t.uniques.push(names);
    }
    if (ut && !/[([]\s*[([]/.test(ut)) {
      const names = stringsIn(ut);
      if (names.length > 1 && !t.uniques.some((u) => u.join() === names.join())) t.uniques.push(names);
    }
    for (const u of (cls.meta.constraints ?? "").matchAll(/UniqueConstraint\(([^)]*)\)/g)) {
      const fields = /fields\s*=\s*([[(][^\])]*[\])])/.exec(u[1]!)?.[1];
      if (fields) t.uniques.push(stringsIn(fields));
    }
    tables.push(normalizeTable(t));
  }
  return tables;
}

/** Values of a Django `choices=`: an inline list of pairs, a named constant, or a TextChoices class. */
function djangoChoices(expr: string, cls: PyClass, src: string): string[] {
  const pairs = (text: string) => [...text.matchAll(/\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,/g)].map((m) => m[2]!);
  if (/^[[(]/.test(expr)) return pairs(expr);
  const name = expr.replace(/\.choices$/, "").split(".").pop()!;
  const local = cls.attrs.find((a) => a.name === name);
  if (local) return pairs(local.value);
  const inner = cls.nested[name];
  if (inner) return inner.attrs.map((a) => unquote(splitArgs(a.value.replace(/^\(|\)$/g, ""))[0]) ?? a.name.toLowerCase());
  const top = new RegExp(`^${name}\\s*=\\s*([\\s\\S]*?)\\n(?=\\S)`, "m").exec(`${src}\n`);
  if (top) return pairs(top[1]!);
  const choiceClass = pyClasses(src).find((c) => c.name === name);
  if (choiceClass) return choiceClass.attrs.map((a) => unquote(a.value.split(",")[0]?.replace(/^\(/, "")) ?? a.name.toLowerCase());
  return [];
}

const SA_TYPES: Record<string, string> = {
  Integer: "integer",
  BigInteger: "bigint",
  SmallInteger: "smallint",
  String: "varchar",
  Unicode: "varchar",
  Text: "text",
  UnicodeText: "text",
  Boolean: "boolean",
  Date: "date",
  DateTime: "timestamp",
  Time: "time",
  Numeric: "numeric",
  Float: "double precision",
  Double: "double precision",
  JSON: "json",
  JSONB: "jsonb",
  UUID: "uuid",
  Uuid: "uuid",
  LargeBinary: "bytea",
  Interval: "interval",
  int: "integer",
  str: "varchar",
  bool: "boolean",
  float: "double precision",
  datetime: "timestamp",
  date: "date",
  Decimal: "numeric",
  dict: "json",
  bytes: "bytea",
};

/** SQLAlchemy declarative models (1.x Column and 2.0 Mapped/mapped_column) and Table(...) calls. */
export function parseSqlAlchemy(src: string): TableModel[] {
  const tables: TableModel[] = [];
  const enumClasses = new Map<string, string[]>();
  for (const c of pyClasses(src)) if (/Enum/.test(c.bases)) enumClasses.set(c.name, c.attrs.map((a) => unquote(a.value) ?? a.name));

  const addColumn = (t: TableModel, name: string, args: string, annotation?: string) => {
    const { pos, kw } = callArgs(args);
    let typeExpr = pos.find((p) => /^[A-Z]\w*(\(|$)/.test(p) && !/^ForeignKey/.test(p) && !/^(Identity|Sequence|Computed)\b/.test(p));
    const fk = pos.find((p) => /^ForeignKey\(/.test(p));
    let nullable = kw.nullable !== undefined ? truthy(kw.nullable) : true;
    if (annotation) {
      const inner = /Mapped\[(.*)\]$/.exec(annotation)?.[1] ?? annotation;
      const optional = /Optional\[|\|\s*None|None\s*\|/.test(inner);
      if (kw.nullable === undefined) nullable = optional;
      if (!typeExpr) typeExpr = inner.replace(/Optional\[(.*)\]/, "$1").replace(/\s*\|\s*None|None\s*\|\s*/, "").trim();
    }
    const tm = /^([\w.]+)(?:\((.*)\))?$/.exec(typeExpr ?? "String");
    const typeName = tm?.[1]?.split(".").pop() ?? "String";
    const targs = tm?.[2] ? splitArgs(tm[2]).filter((a) => /^\d+$/.test(a.replace(/^\w+\s*=\s*/, ""))).map((a) => a.replace(/^\w+\s*=\s*/, "")) : [];
    const c = col(unquote(pos[0]) && pos[0] !== typeExpr ? unquote(pos[0])! : name, typeName);
    if (typeName === "Enum" || enumClasses.has(typeName)) {
      const vals = typeName === "Enum" ? (enumClasses.get(tm?.[2]?.split(",")[0]?.trim() ?? "") ?? stringsIn(tm?.[2] ?? "")) : enumClasses.get(typeName)!;
      c.type = "enum";
      c.enumValues = vals;
    } else applyMapped(c, mapSqlType(SA_TYPES[typeName] ?? "text", targs));
    c.nullable = nullable;
    if (truthy(kw.primary_key)) {
      c.primaryKey = true;
      c.nullable = false;
      if (c.type === "integer" && kw.autoincrement !== "False") c.autoIncrement = true;
    }
    if (truthy(kw.unique)) c.unique = true;
    if (kw.default !== undefined) c.defaultValue = kw.default;
    if (kw.server_default !== undefined) c.defaultValue = kw.server_default;
    t.columns.push(c);
    if (fk) {
      const target = unquote(callArgs(inside(fk, fk.indexOf("(")).text).pos[0]) ?? "";
      const [refTable, refCol] = target.includes(".") ? [target.slice(0, target.lastIndexOf(".")), target.slice(target.lastIndexOf(".") + 1)] : [target, "id"];
      t.foreignKeys.push({ columns: [c.name], refTable: refTable!.split(".").pop()!, refColumns: [refCol!] });
    }
  };

  for (const cls of pyClasses(src)) {
    const tn = cls.attrs.find((a) => a.name === "__tablename__");
    if (!tn) continue;
    const t: TableModel = { name: unquote(tn.value) ?? cls.name.toLowerCase(), columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [] };
    for (const a of cls.attrs) {
      const call = callOf(a.value);
      if (call && (call.fn === "Column" || call.fn === "mapped_column")) addColumn(t, a.name, call.args, a.annotation);
    }
    const targs = cls.attrs.find((a) => a.name === "__table_args__");
    if (targs) {
      for (const u of targs.value.matchAll(/UniqueConstraint\(([^)]*)\)/g)) t.uniques.push(stringsIn(u[1]!.split(/name\s*=/)[0]!));
      for (const k of targs.value.matchAll(/CheckConstraint\(\s*(['"])(.*?)\1/g)) t.checks.push(k[2]!);
    }
    tables.push(normalizeTable(t));
  }
  // Core style: users = Table("users", metadata, Column(...), ...)
  for (const m of src.matchAll(/\bTable\(\s*(['"])(\w+)\1\s*,/g)) {
    const open = m.index! + m[0].indexOf("(");
    const { text } = inside(src, open);
    const t: TableModel = { name: m[2]!, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [] };
    for (const part of splitArgs(text).slice(2)) {
      const c = callOf(part);
      if (c?.fn === "Column") {
        const name = unquote(callArgs(c.args).pos[0]);
        if (name) addColumn(t, name, c.args);
      } else if (c?.fn === "UniqueConstraint") t.uniques.push(stringsIn(c.args.split(/name\s*=/)[0]!));
      else if (c?.fn === "CheckConstraint") t.checks.push(unquote(callArgs(c.args).pos[0]) ?? "");
    }
    if (!tables.some((x) => x.name === t.name)) tables.push(normalizeTable(t));
  }
  return tables;
}

/* ------------------------------------------------------------------ Laravel */

/** Laravel migrations: Schema::create('table', function (Blueprint $table) { … }) blocks. */
export function parseLaravel(src: string): TableModel[] {
  const tables = new Map<string, TableModel>();
  for (const m of src.matchAll(/Schema::(create|table)\(\s*(['"])(\w+)\2\s*,\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{/g)) {
    const name = m[3]!;
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      if (src[i] === "}") depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    const t = tables.get(name) ?? { name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [] };
    for (const stmt of body.split(";")) laravelStatement(stmt.trim(), t);
    tables.set(name, t);
  }
  return [...tables.values()].map(normalizeTable);
}

const LARAVEL_TYPES: Record<string, (a: string[]) => string> = {
  string: (a) => `varchar(${a[1] ?? 255})`,
  char: (a) => `char(${a[1] ?? 255})`,
  text: () => "text",
  mediumText: () => "text",
  longText: () => "text",
  tinyText: () => "text",
  integer: () => "integer",
  unsignedInteger: () => "integer unsigned",
  bigInteger: () => "bigint",
  unsignedBigInteger: () => "bigint unsigned",
  smallInteger: () => "smallint",
  unsignedSmallInteger: () => "smallint",
  tinyInteger: () => "tinyint",
  unsignedTinyInteger: () => "tinyint",
  mediumInteger: () => "mediumint",
  boolean: () => "boolean",
  date: () => "date",
  dateTime: () => "datetime",
  dateTimeTz: () => "datetime",
  timestamp: () => "timestamp",
  timestampTz: () => "timestamp",
  time: () => "time",
  year: () => "year",
  decimal: (a) => `decimal(${a[1] ?? 8},${a[2] ?? 2})`,
  unsignedDecimal: (a) => `decimal(${a[1] ?? 8},${a[2] ?? 2})`,
  double: () => "double",
  float: () => "float",
  json: () => "json",
  jsonb: () => "jsonb",
  uuid: () => "uuid",
  ulid: () => "char(26)",
  binary: () => "blob",
  ipAddress: () => "varchar(45)",
  macAddress: () => "varchar(17)",
};

function laravelStatement(stmt: string, t: TableModel): void {
  const calls = [...stmt.matchAll(/->(\w+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => ({ fn: m[1]!, args: splitArgs(m[2]!).map((a) => unquote(a) ?? a) }));
  const first = calls[0];
  if (!first || !stmt.startsWith("$table")) return;
  const mods = calls.slice(1);
  const has = (fn: string) => mods.some((m) => m.fn === fn);
  const add = (name: string, sql: string, extra: Partial<ColumnModel> = {}) => {
    const c = col(name, sql);
    applyMapped(c, mapSqlType(sql.replace(/\(.*$/, ""), (/\(([^)]*)\)/.exec(sql)?.[1] ?? "").split(",").filter(Boolean)));
    Object.assign(c, extra);
    c.nullable = has("nullable");
    if (has("unique")) c.unique = true;
    if (has("unsigned")) c.rawType += " unsigned";
    const def = mods.find((m) => m.fn === "default");
    if (def) c.defaultValue = def.args[0];
    if (has("primary")) c.primaryKey = true;
    if (has("autoIncrement")) c.autoIncrement = true;
    t.columns.push(c);
    return c;
  };
  const a = first.args;
  switch (first.fn) {
    case "id":
    case "bigIncrements":
      add(a[0] ?? "id", "bigint", { primaryKey: true, autoIncrement: true });
      return;
    case "increments":
      add(a[0] ?? "id", "integer", { primaryKey: true, autoIncrement: true });
      return;
    case "timestamps":
    case "timestampsTz":
    case "nullableTimestamps":
      add("created_at", "timestamp").nullable = true;
      add("updated_at", "timestamp").nullable = true;
      return;
    case "softDeletes":
    case "softDeletesTz":
      add(a[0] ?? "deleted_at", "timestamp").nullable = true;
      return;
    case "rememberToken":
      add("remember_token", "varchar(100)").nullable = true;
      return;
    case "enum": {
      const c = add(a[0]!, "varchar(255)");
      c.type = "enum";
      c.enumValues = stringsIn(stmt.slice(stmt.indexOf("[")));
      return;
    }
    case "foreignId":
    case "foreignUuid":
    case "foreignUlid": {
      const name = a[0]!;
      add(name, first.fn === "foreignId" ? "bigint unsigned" : first.fn === "foreignUuid" ? "uuid" : "char(26)");
      const constrained = mods.find((m) => m.fn === "constrained");
      if (constrained) {
        const table = constrained.args[0] ?? `${name.replace(/_id$/, "")}s`;
        t.foreignKeys.push({ columns: [name], refTable: table, refColumns: [constrained.args[1] ?? "id"] });
      }
      return;
    }
    case "foreign": {
      const refs = mods.find((m) => m.fn === "references")?.args[0] ?? "id";
      const on = mods.find((m) => m.fn === "on")?.args[0];
      if (on) t.foreignKeys.push({ columns: [a[0]!], refTable: on, refColumns: [refs] });
      return;
    }
    case "primary":
      t.primaryKey = stringsIn(stmt).length ? stringsIn(stmt) : [a[0]!];
      return;
    case "unique": {
      const names = stmt.includes("[") ? stringsIn(stmt.slice(stmt.indexOf("["), stmt.indexOf("]") + 1)) : [a[0]!];
      t.uniques.push(names);
      return;
    }
    case "morphs":
    case "nullableMorphs": {
      add(`${a[0]}_type`, "varchar(255)").nullable = first.fn === "nullableMorphs";
      add(`${a[0]}_id`, "bigint unsigned").nullable = first.fn === "nullableMorphs";
      return;
    }
    default: {
      const map = LARAVEL_TYPES[first.fn];
      if (map && a[0]) add(a[0], map(a));
    }
  }
}

export type { ForeignKey };
