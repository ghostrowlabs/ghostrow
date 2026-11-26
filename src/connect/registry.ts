import { parseDbUrl, redact, type DbKind, type SchemaModel, type TableModel } from "./types.js";

export type Row = Record<string, unknown>;

/**
 * One interface for every database. Reads are read-only and capped; writes happen inside
 * one transaction (`begin` … `commit`), so a failed run leaves nothing half-written.
 */
export interface Connector {
  readonly kind: DbKind;
  /** Host and database, without credentials. */
  readonly label: string;
  inspect(): Promise<SchemaModel>;
  /** Up to `limit` rows in primary-key order (stable across runs). */
  readRows(table: TableModel, limit: number): Promise<Row[]>;
  count(table: TableModel): Promise<number>;
  /** Largest value in an integer key column, or 0 for an empty table. */
  maxValue(table: TableModel, column: string): Promise<number>;
  begin(): Promise<void>;
  /** Insert rows with explicit key values (identity/serial columns included). */
  insert(table: TableModel, rows: Row[]): Promise<void>;
  /** Delete rows by primary key (Haunt cleans up after each test run). */
  deleteRows(table: TableModel, keys: Row[]): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** After inserting explicit ids: move sequences/identities past them. */
  afterInsert(tables: TableModel[]): Promise<void>;
  close(): Promise<void>;
}

export async function openConnector(url: string): Promise<Connector> {
  const { kind, url: target } = parseDbUrl(url);
  try {
    switch (kind) {
      case "postgres": {
        const { PostgresConnector } = await import("./postgres.js");
        return await PostgresConnector.open(target);
      }
      case "sqlite": {
        const { SqliteConnector } = await import("./sqlite.js");
        return await SqliteConnector.open(target);
      }
      case "mysql": {
        const { MysqlConnector } = await import("./mysql.js");
        return await MysqlConnector.open(target);
      }
      case "sqlserver": {
        const { SqlServerConnector } = await import("./sqlserver.js");
        return await SqlServerConnector.open(target);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not connect to ${redact(url)}: ${msg}`);
  }
}

/** Insert a whole generated dataset in one transaction, parents first. */
export async function insertAll(c: Connector, out: { table: TableModel; rows: Row[] }[]): Promise<void> {
  await c.begin();
  try {
    for (const { table, rows } of out) if (rows.length) await c.insert(table, rows);
    await c.afterInsert(out.map((o) => o.table));
    await c.commit();
  } catch (e) {
    await c.rollback().catch(() => undefined);
    throw e;
  }
}

/** Values for a parameterised insert: booleans and binary as the driver expects. */
export function writable(table: TableModel): TableModel["columns"] {
  return table.columns.filter((c) => !c.defaultValue?.startsWith("generated:"));
}

/** Split rows into batches that stay under a driver's parameter limit. */
export function batches<T>(rows: T[], columns: number, maxParams: number, maxRows = 1000): T[][] {
  const size = Math.max(1, Math.min(maxRows, Math.floor(maxParams / Math.max(1, columns))));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
