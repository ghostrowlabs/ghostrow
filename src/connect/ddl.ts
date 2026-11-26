import { applyMapped, mapSqlType } from "./typemap.js";
import { normalizeTable, type ColumnModel, type DbKind, type ForeignKey, type TableModel } from "./types.js";

/**
 * SQL DDL reader for Postgres, MySQL/MariaDB, SQLite and SQL Server dialects.
 *
 * Understands CREATE TABLE (columns, inline and table constraints), CREATE TYPE … AS ENUM,
 * ALTER TABLE … ADD CONSTRAINT and CREATE UNIQUE INDEX. Everything else (views, functions,
 * INSERTs, comments) is skipped. Built on a small tokenizer, so quoting, nested parentheses
 * and comments are handled properly instead of by regular expressions.
 */

type Tok = { k: "id" | "qid" | "str" | "num" | "p" | "op"; v: string };

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = sql;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && s[i + 1] === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "#" && (i === 0 || s[i - 1] === "\n")) {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (ch === "'" || (ch === "N" && s[i + 1] === "'") || (ch === "E" && s[i + 1] === "'")) {
      let j = ch === "'" ? i + 1 : i + 2;
      let v = "";
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          v += "'";
          j += 2;
        } else if (s[j] === "\\" && ch === "E") {
          v += s[j + 1] ?? "";
          j += 2;
        } else if (s[j] === "'") break;
        else v += s[j++];
      }
      out.push({ k: "str", v });
      i = j + 1;
      continue;
    }
    // `[name]` is a SQL Server identifier; `ARRAY[…]` and `int[]` are not.
    const bracketName = ch === "[" && /^\[[A-Za-z_][\w $#@-]*\]/.test(s.slice(i)) && !(out.length && /^array$/i.test(out[out.length - 1]!.v));
    if (ch === "[" && !bracketName) {
      out.push({ k: "op", v: "[" });
      i++;
      continue;
    }
    if (ch === "]") {
      out.push({ k: "op", v: "]" });
      i++;
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let v = "";
      while (j < s.length) {
        if (s[j] === close && s[j + 1] === close) {
          v += close;
          j += 2;
        } else if (s[j] === close) break;
        else v += s[j++];
      }
      out.push({ k: "qid", v });
      i = j + 1;
      continue;
    }
    if (ch === "$" && /[$A-Za-z_]/.test(s[i + 1] ?? "")) {
      // Postgres dollar-quoted body: $$ … $$ or $tag$ … $tag$
      const m = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        const body = end < 0 ? s.slice(i + m[0].length) : s.slice(i + m[0].length, end);
        out.push({ k: "str", v: body });
        i = end < 0 ? s.length : end + m[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(s[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(s.slice(i))!;
      out.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_@#À-￿]/.test(ch)) {
      const m = /^[A-Za-z_@#À-￿][\w$#@À-￿]*/.exec(s.slice(i))!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if ("(),;.".includes(ch)) {
      out.push({ k: "p", v: ch });
      i++;
      continue;
    }
    const op = /^(<=|>=|<>|!=|::|\|\||[=<>+\-*/%~!])/.exec(s.slice(i));
    out.push({ k: "op", v: op ? op[0] : ch });
    i += op ? op[0].length : 1;
  }
  return out;
}

const kw = (t: Tok | undefined, ...words: string[]) => t !== undefined && t.k === "id" && words.includes(t.v.toLowerCase());
const isName = (t: Tok | undefined) => t !== undefined && (t.k === "id" || t.k === "qid");

/** Rebuild SQL text from tokens (used for CHECK and DEFAULT expressions). */
export function detok(ts: Tok[]): string {
  let out = "";
  for (const t of ts) {
    const piece = t.k === "str" ? `'${t.v.replace(/'/g, "''")}'` : t.k === "qid" ? `"${t.v}"` : t.v;
    const glue = out === "" || t.v === ")" || t.v === "," || t.v === "." || out.endsWith("(") || out.endsWith(".") || t.v === "::" || out.endsWith("::") ? "" : " ";
    out += (t.v === "(" && /[\w"]$/.test(out) ? "" : glue) + piece;
  }
  return out;
}

function splitStatements(ts: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of ts) {
    if (t.v === "(" && t.k === "p") depth++;
    if (t.v === ")" && t.k === "p") depth--;
    if (t.k === "p" && t.v === ";" && depth <= 0) {
      if (cur.length) out.push(cur);
      cur = [];
      depth = 0;
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Split tokens at top-level commas. */
function splitTop(ts: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of ts) {
    if (t.k === "p" && t.v === "(") depth++;
    if (t.k === "p" && t.v === ")") depth--;
    if (t.k === "p" && t.v === "," && depth === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Index of the matching close paren for the open paren at `i`. */
function closeParen(ts: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < ts.length; j++) {
    if (ts[j]!.k === "p" && ts[j]!.v === "(") depth++;
    if (ts[j]!.k === "p" && ts[j]!.v === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return ts.length - 1;
}

/** Read a possibly schema-qualified name starting at `i`; returns the last part. */
function readName(ts: Tok[], i: number): { name: string; next: number } {
  let j = i;
  let name = ts[j]?.v ?? "";
  j++;
  while (ts[j]?.k === "p" && ts[j]!.v === "." && isName(ts[j + 1])) {
    name = ts[j + 1]!.v;
    j += 2;
  }
  return { name, next: j };
}

function nameList(ts: Tok[]): string[] {
  return splitTop(ts)
    .map((part) => part.filter((t) => isName(t)).map((t) => t.v)[0])
    .filter((x): x is string => !!x);
}

interface DdlState {
  tables: Map<string, TableModel>;
  enums: Map<string, string[]>;
}

export function parseDDL(sql: string, dialect: DbKind = "postgres"): TableModel[] {
  const st: DdlState = { tables: new Map(), enums: new Map() };
  const statements = splitStatements(tokenize(sql));
  // Enums first, so CREATE TABLE can use them whatever the file order.
  for (const s of statements) if (kw(s[0], "create") && kw(s[1], "type")) parseCreateType(s, st);
  for (const s of statements) {
    if (kw(s[0], "create")) {
      let i = 1;
      while (kw(s[i], "or", "replace", "temporary", "temp", "global", "local", "unlogged")) i++;
      if (kw(s[i], "table")) parseCreateTable(s, i + 1, st, dialect);
      else if (kw(s[i], "unique") && kw(s[i + 1], "index", "clustered", "nonclustered")) parseUniqueIndex(s, st);
    } else if (kw(s[0], "alter") && kw(s[1], "table")) parseAlterTable(s, st);
  }
  return [...st.tables.values()].map(normalizeTable);
}

function parseCreateType(s: Tok[], st: DdlState): void {
  const { name, next } = readName(s, 2);
  if (!kw(s[next], "as") || !kw(s[next + 1], "enum")) return;
  const open = next + 2;
  const close = closeParen(s, open);
  st.enums.set(name.toLowerCase(), s.slice(open + 1, close).filter((t) => t.k === "str").map((t) => t.v));
}

function parseCreateTable(s: Tok[], i: number, st: DdlState, dialect: DbKind): void {
  if (kw(s[i], "if") && kw(s[i + 1], "not") && kw(s[i + 2], "exists")) i += 3;
  const { name, next } = readName(s, i);
  if (!(s[next]?.k === "p" && s[next]!.v === "(")) return; // CREATE TABLE … AS SELECT
  const close = closeParen(s, next);
  const table: TableModel = { name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], checks: [] };
  for (const item of splitTop(s.slice(next + 1, close))) parseTableItem(item, table, st, dialect);
  st.tables.set(name.toLowerCase(), table);
}

function parseTableItem(item: Tok[], table: TableModel, st: DdlState, dialect: DbKind): void {
  if (item.length === 0) return;
  let i = 0;
  if (kw(item[0], "constraint")) i = 2;
  const head = item[i];
  if (kw(head, "primary") && kw(item[i + 1], "key")) {
    const open = item.findIndex((t, j) => j > i && t.v === "(");
    if (open >= 0) table.primaryKey = nameList(item.slice(open + 1, closeParen(item, open)));
    return;
  }
  if (kw(head, "unique")) {
    const open = item.findIndex((t, j) => j > i && t.v === "(");
    if (open >= 0) table.uniques.push(nameList(item.slice(open + 1, closeParen(item, open))));
    return;
  }
  if (kw(head, "foreign") && kw(item[i + 1], "key")) {
    const fk = parseForeignKey(item, i + 2);
    if (fk) table.foreignKeys.push(fk);
    return;
  }
  if (kw(head, "check")) {
    const open = i + 1;
    if (item[open]?.v === "(") table.checks.push(detok(item.slice(open + 1, closeParen(item, open))));
    return;
  }
  if (kw(head, "key", "index", "fulltext", "spatial", "exclude", "like", "period")) return;
  if (!isName(head)) return;
  table.columns.push(parseColumn(item, table, st, dialect));
}

function parseForeignKey(item: Tok[], openAt: number): ForeignKey | null {
  let i = openAt;
  if (item[i]?.v !== "(") return null;
  const close = closeParen(item, i);
  const columns = nameList(item.slice(i + 1, close));
  i = close + 1;
  if (!kw(item[i], "references")) return null;
  const { name, next } = readName(item, i + 1);
  let refColumns: string[] = [];
  if (item[next]?.v === "(") refColumns = nameList(item.slice(next + 1, closeParen(item, next)));
  return { columns, refTable: name, refColumns };
}

function parseColumn(item: Tok[], table: TableModel, st: DdlState, dialect: DbKind): ColumnModel {
  const name = item[0]!.v;
  let i = 1;
  // Type: one or more words, optional (args), optional [] — stop at a constraint keyword.
  const typeWords: string[] = [];
  let args: string[] = [];
  let enumValues: string[] | undefined;
  const stop = ["not", "null", "primary", "unique", "default", "references", "check", "constraint", "auto_increment", "autoincrement", "identity", "generated", "collate", "comment", "on", "as", "character", "charset", "unsigned", "zerofill"];
  while (i < item.length) {
    const t = item[i]!;
    if (t.k === "p" && t.v === "(") {
      const close = closeParen(item, i);
      const inner = item.slice(i + 1, close);
      if (typeWords.length && /^(enum|set)$/i.test(typeWords[typeWords.length - 1]!)) enumValues = inner.filter((x) => x.k === "str").map((x) => x.v);
      else args = inner.filter((x) => x.k === "num" || x.k === "id").map((x) => x.v);
      i = close + 1;
      continue;
    }
    if (t.k === "op" && (t.v === "[" || t.v === "]")) {
      i++;
      continue;
    }
    if (t.k === "id" && (typeWords.length === 0 || (!stop.includes(t.v.toLowerCase()) && /^(precision|varying|with|without|time|zone|unsigned)$/i.test(t.v)))) {
      typeWords.push(t.v);
      i++;
      continue;
    }
    if (t.k === "qid" && typeWords.length === 0) {
      typeWords.push(t.v);
      i++;
      continue;
    }
    if (t.k === "p" && t.v === "." && typeWords.length) {
      // schema-qualified type: public.mood
      typeWords.pop();
      i++;
      continue;
    }
    break;
  }
  if (kw(item[i], "unsigned")) {
    typeWords.push("unsigned");
    i++;
  }
  const rawType = typeWords.join(" ") + (args.length ? `(${args.join(",")})` : "");
  const enumFromType = st.enums.get((typeWords[0] ?? "").toLowerCase());
  const col: ColumnModel = { name, type: "text", rawType, nullable: true, primaryKey: false, autoIncrement: false, unique: false };
  if (enumValues || enumFromType) {
    col.type = "enum";
    col.enumValues = enumValues ?? enumFromType;
  } else applyMapped(col, mapSqlType(typeWords.filter((w, idx) => idx === 0 || !/^(with|without|time|zone)$/i.test(w)).join(" "), args));
  if (/^timestamp/i.test(typeWords[0] ?? "")) col.type = "datetime";

  // Constraints.
  for (; i < item.length; i++) {
    const t = item[i]!;
    if (kw(t, "not") && kw(item[i + 1], "null")) {
      col.nullable = false;
      i++;
    } else if (kw(t, "null")) col.nullable = true;
    else if (kw(t, "primary") && kw(item[i + 1], "key")) {
      col.primaryKey = true;
      col.nullable = false;
      i++;
      if (kw(item[i + 1], "autoincrement")) {
        col.autoIncrement = true;
        i++;
      }
    } else if (kw(t, "unique")) col.unique = true;
    else if (kw(t, "auto_increment", "autoincrement")) col.autoIncrement = true;
    else if (kw(t, "identity")) {
      col.autoIncrement = true;
      if (item[i + 1]?.v === "(") i = closeParen(item, i + 1);
    } else if (kw(t, "generated")) {
      // GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY | AS (expr) STORED
      let j = i + 1;
      while (j < item.length && !kw(item[j], "identity") && item[j]!.v !== "(") j++;
      if (kw(item[j], "identity")) {
        col.autoIncrement = true;
        if (item.slice(i, j).some((x) => kw(x, "always"))) col.rawType += " identity always";
      }
      else if (item[j]?.v === "(") col.defaultValue = `generated:${detok(item.slice(j + 1, closeParen(item, j)))}`;
      if (item[j]?.v === "(") j = closeParen(item, j);
      i = j;
    } else if (kw(t, "default")) {
      const start = i + 1;
      let j = start;
      if (item[j]?.v === "(") j = closeParen(item, j) + 1;
      else {
        j++;
        while (j < item.length && (item[j]!.v === "(" || item[j]!.v === "::" || item[j - 1]!.v === "::")) {
          if (item[j]!.v === "(") j = closeParen(item, j) + 1;
          else j++;
        }
      }
      col.defaultValue = detok(item.slice(start, j));
      i = j - 1;
    } else if (kw(t, "references")) {
      const { name: ref, next } = readName(item, i + 1);
      let refColumns: string[] = [];
      if (item[next]?.v === "(") refColumns = nameList(item.slice(next + 1, closeParen(item, next)));
      table.foreignKeys.push({ columns: [name], refTable: ref, refColumns });
      i = next - 1;
    } else if (kw(t, "check") && item[i + 1]?.v === "(") {
      const close = closeParen(item, i + 1);
      table.checks.push(detok(item.slice(i + 2, close)));
      i = close;
    } else if (t.v === "(") i = closeParen(item, i);
  }
  if (/^(serial|bigserial|smallserial)/i.test(rawType)) col.autoIncrement = true;
  // SQLite: INTEGER PRIMARY KEY is the rowid, generated by the database.
  if (dialect === "sqlite" && col.primaryKey && /^integer$/i.test(typeWords.join(" "))) col.autoIncrement = true;
  return col;
}

function parseAlterTable(s: Tok[], st: DdlState): void {
  let i = 2;
  if (kw(s[i], "if") && kw(s[i + 1], "exists")) i += 2;
  if (kw(s[i], "only")) i++;
  const { name, next } = readName(s, i);
  const table = st.tables.get(name.toLowerCase());
  if (!table) return;
  for (const action of splitTop(s.slice(next))) {
    if (!kw(action[0], "add")) continue;
    let j = 1;
    if (kw(action[j], "constraint")) j += 2;
    if (kw(action[j], "foreign") && kw(action[j + 1], "key")) {
      const fk = parseForeignKey(action, j + 2);
      if (fk) table.foreignKeys.push(fk);
    } else if (kw(action[j], "primary") && kw(action[j + 1], "key")) {
      const open = action.findIndex((t, k) => k > j && t.v === "(");
      if (open >= 0) table.primaryKey = nameList(action.slice(open + 1, closeParen(action, open)));
    } else if (kw(action[j], "unique")) {
      const open = action.findIndex((t, k) => k > j && t.v === "(");
      if (open >= 0) table.uniques.push(nameList(action.slice(open + 1, closeParen(action, open))));
    } else if (kw(action[j], "check") && action[j + 1]?.v === "(") {
      table.checks.push(detok(action.slice(j + 2, closeParen(action, j + 1))));
    }
  }
}

function parseUniqueIndex(s: Tok[], st: DdlState): void {
  const on = s.findIndex((t) => kw(t, "on"));
  if (on < 0) return;
  const { name, next } = readName(s, on + 1);
  const table = st.tables.get(name.toLowerCase());
  let open = next;
  if (kw(s[open], "using")) open += 2;
  if (!table || s[open]?.v !== "(") return;
  const cols = nameList(s.slice(open + 1, closeParen(s, open)));
  if (cols.length && !s.some((t) => kw(t, "where"))) table.uniques.push(cols);
}

/** Which dialect does a DDL file look like? */
export function guessDialect(src: string): DbKind {
  if (/\bAUTOINCREMENT\b/i.test(src) || /\bWITHOUT\s+ROWID\b/i.test(src)) return "sqlite";
  if (/\bIDENTITY\s*\(|\bNVARCHAR\b|\bDATETIME2\b|\bUNIQUEIDENTIFIER\b|^\s*GO\s*$/im.test(src)) return "sqlserver";
  if (/`|\bAUTO_INCREMENT\b|\bENGINE\s*=/i.test(src)) return "mysql";
  return "postgres";
}
