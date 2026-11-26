import type { Connection } from "mysql2/promise";
import { batches, writable, type Connector, type Row } from "./registry.js";
import { applyMapped, mapSqlType } from "./typemap.js";
import { normalizeTable, type ColumnModel, type SchemaModel, type TableModel } from "./types.js";

const q = (name: string) => `\`${name.replace(/`/g, "``")}\``;

/** MySQL 8 and MariaDB 10.5+ (also PlanetScale, RDS, Aurora MySQL). Reads information_schema of the URL's database. */
export class MysqlConnector implements Connector {
  readonly kind = "mysql" as const;
  private constructor(
    private readonly conn: Connection,
    private readonly database: string,
    readonly label: string,
  ) {}

  static async open(url: string): Promise<MysqlConnector> {
    const mysql = await import("mysql2/promise");
    const u = new URL(url);
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!database) throw new Error("the URL needs a database name, for example mysql://user:pass@host:3306/shop");
    const sslParam = u.searchParams.get("ssl") ?? u.searchParams.get("sslmode") ?? u.searchParams.get("ssl-mode");
    const managed = /(psdb\.cloud|rds\.amazonaws\.com|azure\.com|aivencloud\.com|tidbcloud\.com)/.test(u.hostname);
    const conn = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: true,
      multipleStatements: false,
      connectTimeout: 20_000,
      ...(managed || (sslParam && !/^(false|disable|disabled|0)$/i.test(sslParam)) ? { ssl: { rejectUnauthorized: /verify/i.test(sslParam ?? "") } } : {}),
    });
    return new MysqlConnector(conn, database, `${u.hostname}/${database}`);
  }

  private async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [r] = await this.conn.query(sql, params);
    return r as T[];
  }

  async inspect(): Promise<SchemaModel> {
    const db = this.database;
    const tables = await this.rows<{ name: string }>(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [db]);
    const cols = await this.rows<{ tbl: string; name: string; data_type: string; column_type: string; nullable: string; extra: string; len: number | null; prec: number | null; scale: number | null; def: string | null; gen: string | null }>(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, EXTRA AS extra,
              CHARACTER_MAXIMUM_LENGTH AS len, NUMERIC_PRECISION AS prec, NUMERIC_SCALE AS scale, COLUMN_DEFAULT AS def, GENERATION_EXPRESSION AS gen
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db],
    );
    const keys = await this.rows<{ tbl: string; cname: string; ctype: string; col: string; ref: string | null; refcol: string | null }>(
      `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS cname, t.CONSTRAINT_TYPE AS ctype, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS ref, k.REFERENCED_COLUMN_NAME AS refcol
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND t.TABLE_NAME = k.TABLE_NAME AND t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = ? ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [db],
    );
    let checks: { tbl: string; expr: string }[] = [];
    try {
      checks = await this.rows<{ tbl: string; expr: string }>(
        `SELECT t.TABLE_NAME AS tbl, c.CHECK_CLAUSE AS expr FROM information_schema.CHECK_CONSTRAINTS c
         JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME
         WHERE c.CONSTRAINT_SCHEMA = ? AND t.CONSTRAINT_TYPE = 'CHECK'`,
        [db],
      );
    } catch {
      // MySQL before 8.0.16 has no CHECK constraints table.
    }
    const out: TableModel[] = tables.map(({ name }) => {
      const columns: ColumnModel[] = cols
        .filter((c) => c.tbl === name)
        .map((c) => {
          const col: ColumnModel = { name: c.name, type: "text", rawType: c.column_type, nullable: c.nullable === "YES", primaryKey: false, autoIncrement: /auto_increment/i.test(c.extra), unique: false };
          const em = /^(enum|set)\((.*)\)$/i.exec(c.column_type);
          if (em) {
            col.type = "enum";
            col.enumValues = [...em[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
          } else {
            const args = /\(([^)]*)\)/.exec(c.column_type)?.[1]?.split(",").map((x) => x.trim()) ?? [];
            applyMapped(col, mapSqlType(`${c.data_type}${/unsigned/i.test(c.column_type) ? " unsigned" : ""}`, c.data_type === "tinyint" ? args : args.length ? args : [c.len, c.prec, c.scale].filter((x) => x !== null).map(String)));
            if (c.len !== null && col.type === "text" && c.len < 16_777_215) col.maxLength = c.len;
          }
          if (c.gen) col.defaultValue = `generated:${c.gen}`;
          else if (c.def !== null) col.defaultValue = c.def;
          return col;
        });
      const k = keys.filter((x) => x.tbl === name);
      const groups = (type: string) => {
        const m = new Map<string, typeof k>();
        for (const x of k.filter((y) => y.ctype === type)) m.set(x.cname, [...(m.get(x.cname) ?? []), x]);
        return [...m.values()];
      };
      return normalizeTable({
        name,
        columns,
        primaryKey: groups("PRIMARY KEY")[0]?.map((x) => x.col) ?? [],
        foreignKeys: groups("FOREIGN KEY").map((g) => ({ columns: g.map((x) => x.col), refTable: g[0]!.ref!, refColumns: g.map((x) => x.refcol!) })),
        uniques: groups("UNIQUE").map((g) => g.map((x) => x.col)),
        checks: checks.filter((c) => c.tbl === name).map((c) => c.expr.replace(/`/g, "")),
      });
    });
    return { dialect: "mysql", tables: out, source: this.label };
  }

  async readRows(table: TableModel, limit: number): Promise<Row[]> {
    const order = table.primaryKey.length ? ` ORDER BY ${table.primaryKey.map(q).join(", ")}` : "";
    const rows = await this.rows<Row>(`SELECT * FROM ${q(table.name)}${order} LIMIT ${Math.max(0, Math.floor(limit))}`);
    for (const r of rows) for (const c of table.columns) if (c.type === "boolean" && typeof r[c.name] === "number") r[c.name] = r[c.name] === 1;
    return rows;
  }

  async count(table: TableModel): Promise<number> {
    return Number((await this.rows<{ n: number }>(`SELECT count(*) AS n FROM ${q(table.name)}`))[0]?.n ?? 0);
  }

  async maxValue(table: TableModel, column: string): Promise<number> {
    return Number((await this.rows<{ m: number | null }>(`SELECT max(${q(column)}) AS m FROM ${q(table.name)}`))[0]?.m ?? 0) || 0;
  }

  async begin(): Promise<void> {
    await this.conn.beginTransaction();
  }
  async commit(): Promise<void> {
    await this.conn.commit();
  }
  async rollback(): Promise<void> {
    await this.conn.rollback();
  }

  async insert(table: TableModel, rows: Row[]): Promise<void> {
    const cols = writable(table);
    for (const chunk of batches(rows, cols.length, 20_000)) {
      const values = chunk.map((r) => cols.map((c) => toMysql(r[c.name], c)));
      await this.conn.query(`INSERT INTO ${q(table.name)} (${cols.map((c) => q(c.name)).join(", ")}) VALUES ?`, [values]);
    }
  }

  async deleteRows(table: TableModel, keys: Row[]): Promise<void> {
    const pk = table.primaryKey;
    if (!pk.length || !keys.length) return;
    for (const chunk of batches(keys, pk.length, 20_000)) {
      await this.conn.query(`DELETE FROM ${q(table.name)} WHERE (${pk.map(q).join(", ")}) IN (?)`, [chunk.map((k) => pk.map((c) => k[c]))]);
    }
  }

  async afterInsert(): Promise<void> {
    // AUTO_INCREMENT moves past explicit ids by itself.
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}

function toMysql(v: unknown, c: ColumnModel): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (c.type === "json" && v !== null && typeof v !== "string") return JSON.stringify(v);
  return v;
}
