import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { guessDialect, parseDDL } from "./ddl.js";
import { parseDjango, parseLaravel, parsePrisma, parseSqlAlchemy } from "./orm.js";
import type { DbKind, SchemaModel, TableModel } from "./types.js";

/**
 * `--schema <file|dir>`: SQL DDL, a Prisma schema, Django models, SQLAlchemy models or
 * Laravel migrations. A directory is searched (skipping node_modules, .git, venvs) and every
 * recognised file is read; tables with the same name merge, later files adding columns.
 */
export function loadSchema(path: string): SchemaModel {
  const st = statSync(path);
  const files = st.isDirectory() ? schemaFiles(path) : [path];
  if (files.length === 0) throw new Error(`No schema files found in ${path}. Expected .sql, .prisma, models.py or Laravel migrations.`);
  let dialect: DbKind | null = null;
  const tables = new Map<string, TableModel>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const kind = detect(file, src);
    if (!kind) continue;
    let found: TableModel[] = [];
    if (kind === "sql") {
      const d = guessDialect(src);
      dialect ??= d;
      // SQL Server scripts separate batches with GO lines.
      found = parseDDL(src.replace(/^\s*GO\s*$/gim, ";"), d);
    } else if (kind === "prisma") {
      dialect ??= prismaProvider(src);
      found = parsePrisma(src);
    } else if (kind === "django") found = parseDjango(src, basename(dirname(file)));
    else if (kind === "sqlalchemy") found = parseSqlAlchemy(src);
    else if (kind === "laravel") {
      dialect ??= "mysql";
      found = parseLaravel(src);
    }
    for (const t of found) {
      const prev = tables.get(t.name.toLowerCase());
      if (!prev) tables.set(t.name.toLowerCase(), t);
      else {
        for (const c of t.columns) if (!prev.columns.some((p) => p.name === c.name)) prev.columns.push(c);
        prev.foreignKeys.push(...t.foreignKeys);
        prev.uniques.push(...t.uniques);
        prev.checks.push(...t.checks);
        if (t.primaryKey.length) prev.primaryKey = t.primaryKey;
      }
    }
  }
  const list = [...tables.values()];
  if (list.length === 0) throw new Error(`No tables found in ${path}. Supported: SQL DDL (CREATE TABLE), Prisma, Django, SQLAlchemy and Laravel migrations.`);
  return { dialect: dialect ?? "postgres", tables: list, source: st.isDirectory() ? `${relative(process.cwd(), path) || "."}/` : basename(path) };
}

type Kind = "sql" | "prisma" | "django" | "sqlalchemy" | "laravel";

export function detect(file: string, src: string): Kind | null {
  const ext = extname(file).toLowerCase();
  if (ext === ".prisma" || /^\s*(datasource|generator)\s+\w+\s*\{/m.test(src)) return "prisma";
  if (ext === ".sql" || ext === ".ddl") return "sql";
  if (ext === ".php") return /Schema::(create|table)\(/.test(src) ? "laravel" : null;
  if (ext === ".py") {
    if (/__tablename__|\bTable\(\s*['"]\w+['"]\s*,\s*\w*metadata/.test(src)) return "sqlalchemy";
    if (/from\s+django\.db\s+import\s+models|models\.Model\b/.test(src)) return "django";
    return null;
  }
  if (/\bcreate\s+table\b/i.test(src)) return "sql";
  return null;
}

function prismaProvider(src: string): DbKind {
  const p = /provider\s*=\s*"(\w+)"/.exec(/datasource\s+\w+\s*\{[\s\S]*?\}/.exec(src)?.[0] ?? "")?.[1];
  if (p === "mysql") return "mysql";
  if (p === "sqlite") return "sqlite";
  if (p === "sqlserver") return "sqlserver";
  return "postgres";
}

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "env", "__pycache__", "dist", "build", "vendor", ".next", "target"]);

function schemaFiles(dir: string, depth = 0): string[] {
  if (depth > 8) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...schemaFiles(p, depth + 1));
    else if (/\.(sql|ddl|prisma|py|php)$/i.test(e.name)) out.push(p);
  }
  return out;
}
