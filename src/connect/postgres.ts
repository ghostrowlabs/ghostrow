import type { Client } from "pg";
import { batches, writable, type Connector, type Row } from "./registry.js";
import { applyMapped, mapSqlType } from "./typemap.js";
import { normalizeTable, type ColumnModel, type SchemaModel, type TableModel } from "./types.js";

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Postgres (also Neon, Supabase, RDS, Aurora, Cloud SQL). Reads the catalog of the current
 * schema (search_path). TLS follows the URL's sslmode; managed hosts get TLS automatically.
 */
export class PostgresConnector implements Connector {
  readonly kind = "postgres" as const;
  private constructor(
    private readonly client: Client,
    readonly label: string,
  ) {}

  static async open(url: string): Promise<PostgresConnector> {
    const pg = (await import("pg")).default;
    // Keep dates and timestamps as the text Postgres sends: no timezone conversion.
    for (const oid of [1082, 1114, 1184, 1083, 1266]) pg.types.setTypeParser(oid, (v: string) => v);
    pg.types.setTypeParser(20, (v: string) => (Number.isSafeInteger(Number(v)) ? Number(v) : v)); // int8
    pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric
    const u = new URL(url);
    const managed = /(neon\.tech|supabase\.co|rds\.amazonaws\.com|pooler\.|azure\.com|cloudsql|render\.com|aivencloud\.com)/.test(u.hostname);
    const mode = u.searchParams.get("sslmode");
    const ssl = mode === "disable" ? false : mode === "verify-full" || mode === "verify-ca" ? { rejectUnauthorized: true } : mode === "require" || managed ? { rejectUnauthorized: false } : undefined;
    u.searchParams.delete("sslmode");
    u.searchParams.delete("channel_binding");
    const client = new pg.Client({ connectionString: u.toString(), ssl, connectionTimeoutMillis: 20_000, application_name: "ghostrow" });
    await client.connect();
    return new PostgresConnector(client, `${u.hostname}/${u.pathname.replace(/^\//, "")}`);
  }

  async inspect(): Promise<SchemaModel> {
    const c = this.client;
    const tables = await c.query<{ oid: number; name: string }>(
      `SELECT c.oid::int AS oid, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') AND n.nspname = current_schema() AND NOT c.relispartition ORDER BY c.relname`,
    );
    const cols = await c.query<{ rel: number; name: string; num: number; type: string; notnull: boolean; identity: string; generated: string; def: string | null; enum_values: string[] | null }>(
      `SELECT a.attrelid::int AS rel, a.attname AS name, a.attnum AS num, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              a.attidentity AS identity, a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS def,
              (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_values
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum`,
      [tables.rows.map((t) => t.oid)],
    );
    const cons = await c.query<{ rel: number; type: string; cols: string[]; ref: string | null; refcols: string[] | null; def: string }>(
      `SELECT con.conrelid::int AS rel, con.contype AS type,
              ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols,
              rc.relname AS ref,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS refcols,
              pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con LEFT JOIN pg_class rc ON rc.oid = con.confrelid
       WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p','u','f','c') ORDER BY con.conname`,
      [tables.rows.map((t) => t.oid)],
    );
    const idx = await c.query<{ rel: number; cols: string[] }>(
      `SELECT i.indrelid::int AS rel, ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols
       FROM pg_index i WHERE i.indrelid = ANY($1::oid[]) AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL AND 0 <> ALL(i.indkey)`,
      [tables.rows.map((t) => t.oid)],
    );
    const out: TableModel[] = tables.rows.map((t) => {
      const columns: ColumnModel[] = cols.rows
        .filter((x) => x.rel === t.oid)
        .map((x) => {
          const m = /^([a-z ]+?)(?:\((\d+)(?:,(\d+))?\))?(\[\])?$/i.exec(x.type);
          const col: ColumnModel = { name: x.name, type: "text", rawType: x.type, nullable: !x.notnull, primaryKey: false, autoIncrement: x.identity !== "" || /^nextval\(/.test(x.def ?? ""), unique: false };
          if (x.enum_values?.length) {
            col.type = "enum";
            col.enumValues = x.enum_values;
          } else applyMapped(col, mapSqlType(m?.[1] ?? x.type, [m?.[2], m?.[3]].filter((v): v is string => v !== undefined)));
          if (m?.[4]) col.type = "text"; // arrays are written as text literals
          if (x.generated === "s") col.defaultValue = `generated:${x.def}`;
          else if (x.def) col.defaultValue = x.def;
          if (x.identity === "a") col.rawType += " identity always";
          return col;
        });
      const tc = cons.rows.filter((x) => x.rel === t.oid);
      return normalizeTable({
        name: t.name,
        columns,
        primaryKey: tc.find((x) => x.type === "p")?.cols ?? [],
        foreignKeys: tc.filter((x) => x.type === "f").map((x) => ({ columns: x.cols, refTable: x.ref!, refColumns: x.refcols ?? [] })),
        uniques: [...tc.filter((x) => x.type === "u").map((x) => x.cols), ...idx.rows.filter((x) => x.rel === t.oid).map((x) => x.cols)],
        checks: tc.filter((x) => x.type === "c").map((x) => x.def.replace(/^CHECK\s*/i, "").replace(/\s+NOT VALID$/i, "")),
      });
    });
    return { dialect: "postgres", tables: out, source: this.label };
  }

  async readRows(table: TableModel, limit: number): Promise<Row[]> {
    const order = table.primaryKey.length ? ` ORDER BY ${table.primaryKey.map(q).join(", ")}` : "";
    const r = await this.client.query(`SELECT * FROM ${q(table.name)}${order} LIMIT ${Math.max(0, Math.floor(limit))}`);
    return r.rows as Row[];
  }

  async count(table: TableModel): Promise<number> {
    const r = await this.client.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(table.name)}`);
    return Number(r.rows[0]?.n ?? 0);
  }

  async maxValue(table: TableModel, column: string): Promise<number> {
    const r = await this.client.query<{ m: string | null }>(`SELECT max(${q(column)})::text AS m FROM ${q(table.name)}`);
    return Number(r.rows[0]?.m ?? 0) || 0;
  }

  async begin(): Promise<void> {
    await this.client.query("BEGIN");
  }
  async commit(): Promise<void> {
    await this.client.query("COMMIT");
  }
  async rollback(): Promise<void> {
    await this.client.query("ROLLBACK");
  }

  async insert(table: TableModel, rows: Row[]): Promise<void> {
    const cols = writable(table);
    const override = cols.some((c) => /identity always/.test(c.rawType)) ? " OVERRIDING SYSTEM VALUE" : "";
    for (const chunk of batches(rows, cols.length, 30_000)) {
      const params: unknown[] = [];
      const values = chunk.map((r) => `(${cols.map((c) => {
        params.push(toPg(r[c.name], c));
        return `$${params.length}`;
      }).join(", ")})`);
      await this.client.query(`INSERT INTO ${q(table.name)} (${cols.map((c) => q(c.name)).join(", ")})${override} VALUES ${values.join(", ")}`, params);
    }
  }

  async deleteRows(table: TableModel, keys: Row[]): Promise<void> {
    const pk = table.primaryKey;
    if (!pk.length || !keys.length) return;
    for (const chunk of batches(keys, pk.length, 30_000)) {
      const params: unknown[] = [];
      const cond = chunk.map((k) => `(${pk.map((c) => {
        params.push(k[c]);
        return `${q(c)} = $${params.length}`;
      }).join(" AND ")})`);
      await this.client.query(`DELETE FROM ${q(table.name)} WHERE ${cond.join(" OR ")}`, params);
    }
  }

  async afterInsert(tables: TableModel[]): Promise<void> {
    for (const t of tables) {
      for (const c of t.columns.filter((x) => x.autoIncrement && x.type === "integer")) {
        await this.client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT max(${q(c.name)}) FROM ${q(t.name)}), 0), 1))`,
          [q(t.name), c.name],
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

function toPg(v: unknown, c: ColumnModel): unknown {
  if (v === undefined) return null;
  if (c.type === "json" && typeof v !== "string" && v !== null) return JSON.stringify(v);
  return v;
}
