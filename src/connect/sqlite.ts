import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import type { Database, SqlJsStatic } from "sql.js";
import { parseDDL } from "./ddl.js";
import { writable, type Connector, type Row } from "./registry.js";
import type { ColumnModel, SchemaModel, TableModel } from "./types.js";

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

let sqlJs: Promise<SqlJsStatic> | null = null;

/** sql.js (SQLite compiled to WebAssembly): no native module, the same on every platform. */
export async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJs ??= (async () => {
    const init = (await import("sql.js")).default;
    const embedded = await seaAsset("sql-wasm.wasm");
    if (embedded) return init({ wasmBinary: embedded });
    const wasm = locateWasm();
    return init(wasm ? { wasmBinary: readFileSync(wasm) as unknown as ArrayBuffer } : {});
  })();
  return sqlJs;
}

/** Standalone executables carry the wasm inside the binary (Node single executable application assets). */
async function seaAsset(name: string): Promise<ArrayBuffer | null> {
  try {
    const sea = (await import("node:sea")) as { isSea(): boolean; getAsset(key: string): ArrayBuffer };
    return sea.isSea() ? sea.getAsset(name) : null;
  } catch {
    return null;
  }
}

function locateWasm(): string | null {
  // Standalone builds put the wasm next to the executable; npm installs resolve it from sql.js.
  const beside = process.env.GHOSTROW_SQLJS_WASM;
  if (beside && existsSync(beside)) return beside;
  try {
    return createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm");
  } catch {
    return null;
  }
}

/**
 * SQLite file databases. The file is read into memory, changed inside a transaction, and
 * written back (atomically, via a temporary file) only when the transaction commits.
 */
export class SqliteConnector implements Connector {
  readonly kind = "sqlite" as const;
  private dirty = false;
  private constructor(
    private readonly db: Database,
    private readonly path: string,
    readonly label: string,
  ) {}

  static async open(path: string): Promise<SqliteConnector> {
    const SQL = await loadSqlJs();
    if (path !== ":memory:" && !existsSync(path)) throw new Error(`SQLite file not found: ${path}`);
    const db = path === ":memory:" ? new SQL.Database() : new SQL.Database(readFileSync(path));
    db.run("PRAGMA foreign_keys = ON");
    return new SqliteConnector(db, path, basename(path));
  }

  /** Run raw SQL (tests and Haunt fixtures). */
  exec(sql: string): void {
    this.db.run(sql);
    this.dirty = true;
  }

  async inspect(): Promise<SchemaModel> {
    const res = this.db.exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type DESC, name`);
    const ddl = (res[0]?.values ?? []).map((r) => `${String(r[3])};`).join("\n");
    const tables = parseDDL(ddl, "sqlite");
    return { dialect: "sqlite", tables, source: this.label };
  }

  private all(sql: string, params: unknown[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as never);
    const rows: Row[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as Row);
    stmt.free();
    return rows;
  }

  async readRows(table: TableModel, limit: number): Promise<Row[]> {
    const order = table.primaryKey.length ? table.primaryKey.map(q).join(", ") : "rowid";
    return this.all(`SELECT * FROM ${q(table.name)} ORDER BY ${order} LIMIT ${Math.max(0, Math.floor(limit))}`).map((r) => fromSqlite(r, table));
  }

  async count(table: TableModel): Promise<number> {
    return Number(this.all(`SELECT count(*) AS n FROM ${q(table.name)}`)[0]?.n ?? 0);
  }

  async maxValue(table: TableModel, column: string): Promise<number> {
    return Number(this.all(`SELECT max(${q(column)}) AS m FROM ${q(table.name)}`)[0]?.m ?? 0) || 0;
  }

  async begin(): Promise<void> {
    this.db.run("BEGIN");
  }

  async commit(): Promise<void> {
    this.db.run("COMMIT");
    this.dirty = true;
    this.save();
  }

  async rollback(): Promise<void> {
    this.db.run("ROLLBACK");
  }

  async insert(table: TableModel, rows: Row[]): Promise<void> {
    const cols = writable(table);
    const stmt = this.db.prepare(`INSERT INTO ${q(table.name)} (${cols.map((c) => q(c.name)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    try {
      for (const r of rows) stmt.run(cols.map((c) => toSqlite(r[c.name], c)) as never);
    } finally {
      stmt.free();
    }
  }

  async deleteRows(table: TableModel, keys: Row[]): Promise<void> {
    const pk = table.primaryKey;
    if (!pk.length) return;
    const stmt = this.db.prepare(`DELETE FROM ${q(table.name)} WHERE ${pk.map((c) => `${q(c)} = ?`).join(" AND ")}`);
    try {
      for (const k of keys) stmt.run(pk.map((c) => k[c]) as never);
    } finally {
      stmt.free();
    }
  }

  async afterInsert(): Promise<void> {
    // SQLite picks the next rowid from max(rowid) by itself.
  }

  private save(): void {
    if (this.path === ":memory:" || !this.dirty) return;
    const tmp = `${this.path}.ghostrow-tmp`;
    writeFileSync(tmp, this.db.export());
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function toSqlite(v: unknown, c: ColumnModel): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Buffer) return new Uint8Array(v);
  if (c.type === "json" && typeof v !== "string") return JSON.stringify(v);
  return v;
}

function fromSqlite(r: Row, table: TableModel): Row {
  for (const c of table.columns) {
    const v = r[c.name];
    if (c.type === "boolean" && (v === 0 || v === 1)) r[c.name] = v === 1;
    if (v instanceof Uint8Array) r[c.name] = Buffer.from(v);
  }
  return r;
}
