import type { ConnectionPool, Transaction } from "mssql";
import { batches, writable, type Connector, type Row } from "./registry.js";
import { applyMapped, mapSqlType } from "./typemap.js";
import { normalizeTable, type ColumnModel, type SchemaModel, type TableModel } from "./types.js";

const q = (name: string) => `[${name.replace(/]/g, "]]")}]`;

/**
 * SQL Server 2016+ and Azure SQL. URL: mssql://user:pass@host:1433/database
 * (`?encrypt=false` for a local server without TLS, `?trustServerCertificate=true` for a self-signed one).
 */
export class SqlServerConnector implements Connector {
  readonly kind = "sqlserver" as const;
  private tx: Transaction | null = null;
  private constructor(
    private readonly pool: ConnectionPool,
    private readonly sql: typeof import("mssql"),
    readonly label: string,
  ) {}

  static async open(url: string): Promise<SqlServerConnector> {
    const mod = await import("mssql");
    const sql = (mod as unknown as { default?: typeof import("mssql") }).default ?? mod;
    const u = new URL(url);
    const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || u.searchParams.get("database") || "master";
    const flag = (k: string, d: boolean) => (u.searchParams.has(k) ? /^(true|1|yes)$/i.test(u.searchParams.get(k)!) : d);
    const local = /^(localhost|127\.0\.0\.1|::1)$/.test(u.hostname);
    const pool = new sql.ConnectionPool({
      server: u.hostname,
      port: Number(u.port || 1433),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database,
      options: { encrypt: flag("encrypt", !local), trustServerCertificate: flag("trustServerCertificate", local), useUTC: true },
      connectionTimeout: 20_000,
      requestTimeout: 120_000,
    });
    await pool.connect();
    return new SqlServerConnector(pool, sql, `${u.hostname}/${database}`);
  }

  private request() {
    return this.tx ? new this.sql.Request(this.tx) : this.pool.request();
  }

  private async rows<T>(query: string): Promise<T[]> {
    const r = await this.request().query(query);
    return r.recordset as unknown as T[];
  }

  async inspect(): Promise<SchemaModel> {
    const tables = await this.rows<{ id: number; name: string }>(`SELECT t.object_id AS id, t.name FROM sys.tables t WHERE t.schema_id = SCHEMA_ID() AND t.is_ms_shipped = 0 ORDER BY t.name`);
    const cols = await this.rows<{ tid: number; name: string; type: string; max_length: number; precision: number; scale: number; nullable: boolean; identity: boolean; computed: boolean; def: string | null }>(
      `SELECT c.object_id AS tid, c.name, ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable AS nullable, c.is_identity AS [identity], c.is_computed AS computed,
              OBJECT_DEFINITION(c.default_object_id) AS def
       FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       JOIN sys.tables t ON t.object_id = c.object_id WHERE t.schema_id = SCHEMA_ID() ORDER BY c.object_id, c.column_id`,
    );
    const idx = await this.rows<{ tid: number; iid: number; pk: boolean; col: string }>(
      `SELECT i.object_id AS tid, i.index_id AS iid, i.is_primary_key AS pk, c.name AS col
       FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       JOIN sys.tables t ON t.object_id = i.object_id
       WHERE t.schema_id = SCHEMA_ID() AND (i.is_unique = 1) AND i.has_filter = 0 ORDER BY i.object_id, i.index_id, ic.key_ordinal`,
    );
    const fks = await this.rows<{ tid: number; fid: number; col: string; ref: string; refcol: string }>(
      `SELECT fk.parent_object_id AS tid, fk.object_id AS fid, pc.name AS col, rt.name AS ref, rc.name AS refcol
       FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
       JOIN sys.tables t ON t.object_id = fk.parent_object_id
       WHERE t.schema_id = SCHEMA_ID() ORDER BY fk.object_id, fkc.constraint_column_id`,
    );
    const checks = await this.rows<{ tid: number; def: string }>(`SELECT cc.parent_object_id AS tid, cc.definition AS def FROM sys.check_constraints cc WHERE cc.is_disabled = 0`);
    const out: TableModel[] = tables.map((t) => {
      const columns: ColumnModel[] = cols
        .filter((c) => c.tid === t.id)
        .map((c) => {
          const unicode = /^n(var)?char$/.test(c.type);
          const len = c.max_length === -1 ? undefined : unicode ? c.max_length / 2 : c.max_length;
          const args = /char|binary/.test(c.type) ? (len !== undefined ? [String(len)] : []) : /decimal|numeric/.test(c.type) ? [String(c.precision), String(c.scale)] : [];
          const col: ColumnModel = { name: c.name, type: "text", rawType: `${c.type}${args.length ? `(${args.join(",")})` : ""}`, nullable: c.nullable, primaryKey: false, autoIncrement: c.identity, unique: false };
          applyMapped(col, mapSqlType(c.type, args));
          if (c.computed) col.defaultValue = "generated:computed";
          else if (c.def) col.defaultValue = c.def.replace(/^\(+|\)+$/g, "");
          return col;
        });
      const groups = new Map<number, { pk: boolean; cols: string[] }>();
      for (const i of idx.filter((x) => x.tid === t.id)) {
        const g = groups.get(i.iid) ?? { pk: i.pk, cols: [] };
        g.cols.push(i.col);
        groups.set(i.iid, g);
      }
      const fkGroups = new Map<number, { ref: string; cols: string[]; refcols: string[] }>();
      for (const f of fks.filter((x) => x.tid === t.id)) {
        const g = fkGroups.get(f.fid) ?? { ref: f.ref, cols: [], refcols: [] };
        g.cols.push(f.col);
        g.refcols.push(f.refcol);
        fkGroups.set(f.fid, g);
      }
      return normalizeTable({
        name: t.name,
        columns,
        primaryKey: [...groups.values()].find((g) => g.pk)?.cols ?? [],
        foreignKeys: [...fkGroups.values()].map((g) => ({ columns: g.cols, refTable: g.ref, refColumns: g.refcols })),
        uniques: [...groups.values()].filter((g) => !g.pk).map((g) => g.cols),
        checks: checks.filter((c) => c.tid === t.id).map((c) => c.def.replace(/\[([^\]]+)\]/g, "$1")),
      });
    });
    return { dialect: "sqlserver", tables: out, source: this.label };
  }

  async readRows(table: TableModel, limit: number): Promise<Row[]> {
    const order = table.primaryKey.length ? table.primaryKey.map(q).join(", ") : "(SELECT NULL)";
    const rows = await this.rows<Row>(`SELECT * FROM ${q(table.name)} ORDER BY ${order} OFFSET 0 ROWS FETCH NEXT ${Math.max(1, Math.floor(limit))} ROWS ONLY`);
    for (const r of rows) for (const c of table.columns) if (r[c.name] instanceof Date) r[c.name] = (r[c.name] as Date).toISOString().replace("T", " ").replace(/\.000Z$|Z$/, "");
    return rows;
  }

  async count(table: TableModel): Promise<number> {
    return Number((await this.rows<{ n: number }>(`SELECT count_big(*) AS n FROM ${q(table.name)}`))[0]?.n ?? 0);
  }

  async maxValue(table: TableModel, column: string): Promise<number> {
    return Number((await this.rows<{ m: number | null }>(`SELECT max(${q(column)}) AS m FROM ${q(table.name)}`))[0]?.m ?? 0) || 0;
  }

  async begin(): Promise<void> {
    this.tx = new this.sql.Transaction(this.pool);
    await this.tx.begin();
  }
  async commit(): Promise<void> {
    await this.tx?.commit();
    this.tx = null;
  }
  async rollback(): Promise<void> {
    await this.tx?.rollback();
    this.tx = null;
  }

  async insert(table: TableModel, rows: Row[]): Promise<void> {
    const cols = writable(table);
    const identity = cols.some((c) => c.autoIncrement);
    // 2100 parameters per request, 1000 rows per VALUES list.
    for (const chunk of batches(rows, cols.length, 2_000, 1_000)) {
      const req = this.request();
      let n = 0;
      const values = chunk.map((r) => `(${cols.map((c) => {
        const name = `p${n++}`;
        req.input(name, toMssql(r[c.name], c));
        return `@${name}`;
      }).join(", ")})`);
      const body = `INSERT INTO ${q(table.name)} (${cols.map((c) => q(c.name)).join(", ")}) VALUES ${values.join(", ")};`;
      await req.query(identity ? `SET IDENTITY_INSERT ${q(table.name)} ON; ${body} SET IDENTITY_INSERT ${q(table.name)} OFF;` : body);
    }
  }

  async deleteRows(table: TableModel, keys: Row[]): Promise<void> {
    const pk = table.primaryKey;
    if (!pk.length || !keys.length) return;
    for (const chunk of batches(keys, pk.length, 2_000)) {
      const req = this.request();
      let n = 0;
      const cond = chunk.map((k) => `(${pk.map((c) => {
        const name = `k${n++}`;
        req.input(name, k[c]);
        return `${q(c)} = @${name}`;
      }).join(" AND ")})`);
      await req.query(`DELETE FROM ${q(table.name)} WHERE ${cond.join(" OR ")}`);
    }
  }

  async afterInsert(tables: TableModel[]): Promise<void> {
    for (const t of tables) if (t.columns.some((c) => c.autoIncrement)) await this.request().query(`DBCC CHECKIDENT ('${t.name.replace(/'/g, "''")}', RESEED) WITH NO_INFOMSGS`).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

function toMssql(v: unknown, c: ColumnModel): unknown {
  if (v === undefined) return null;
  if (c.type === "json" && v !== null && typeof v !== "string") return JSON.stringify(v);
  return v;
}
