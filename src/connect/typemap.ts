import type { ColumnModel, ColumnType } from "./types.js";

export interface MappedType {
  type: ColumnType;
  maxLength?: number;
  precision?: number;
  scale?: number;
  intBytes?: number;
  enumValues?: string[];
  autoIncrement?: boolean;
}

/**
 * Map a declared SQL type to a type family. One table for every dialect:
 * Postgres, MySQL/MariaDB, SQLite and SQL Server names all land here.
 * `args` are the numbers in parentheses, e.g. varchar(64) → [64], numeric(10,2) → [10, 2].
 */
export function mapSqlType(rawName: string, args: string[] = []): MappedType {
  const name = rawName.toLowerCase().replace(/\s+/g, " ").trim();
  const n = args.map((a) => Number(a)).filter((x) => Number.isFinite(x));
  const base = name.replace(/\[\]$/, "");

  if (base === "uuid" || base === "uniqueidentifier") return { type: "uuid" };
  if (["bool", "boolean"].includes(base)) return { type: "boolean" };
  if (base === "bit" && (n[0] === undefined || n[0] === 1)) return { type: "boolean" };
  if (base === "tinyint" && n[0] === 1) return { type: "boolean" };

  if (["serial", "serial4"].includes(base)) return { type: "integer", intBytes: 4, autoIncrement: true };
  if (["bigserial", "serial8"].includes(base)) return { type: "integer", intBytes: 8, autoIncrement: true };
  if (["smallserial", "serial2"].includes(base)) return { type: "integer", intBytes: 2, autoIncrement: true };
  if (["tinyint"].includes(base)) return { type: "integer", intBytes: 1 };
  if (["smallint", "int2", "year"].includes(base)) return { type: "integer", intBytes: 2 };
  if (["mediumint"].includes(base)) return { type: "integer", intBytes: 3 };
  if (["int", "integer", "int4", "unsigned", "int unsigned", "integer unsigned"].includes(base)) return { type: "integer", intBytes: 4 };
  if (["bigint", "int8", "bigint unsigned"].includes(base)) return { type: "integer", intBytes: 8 };

  if (["numeric", "decimal", "dec", "number"].includes(base)) {
    const precision = n[0];
    const scale = n[1] ?? (precision !== undefined ? 0 : undefined);
    return { type: "decimal", ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) };
  }
  if (["money", "smallmoney"].includes(base)) return { type: "decimal", precision: 19, scale: 2 };
  if (["real", "float", "float4", "float8", "double", "double precision"].includes(base)) return { type: "real" };

  if (base === "date") return { type: "date" };
  if (/^(timestamp|timestamptz|datetime|datetime2|smalldatetime|datetimeoffset)/.test(base) || base.startsWith("timestamp")) return { type: "datetime" };
  if (/^(time|timetz)/.test(base)) return { type: "time" };
  if (base === "interval") return { type: "text" };

  if (["json", "jsonb"].includes(base)) return { type: "json" };
  if (["bytea", "blob", "longblob", "mediumblob", "tinyblob", "binary", "varbinary", "image"].includes(base)) return { type: "bytes" };

  if (["char", "character", "nchar", "bpchar"].includes(base)) return { type: "text", ...(n[0] !== undefined ? { maxLength: n[0] } : { maxLength: 1 }) };
  if (["varchar", "character varying", "nvarchar", "varchar2", "nvarchar2", "string"].includes(base)) {
    // nvarchar(max) arrives as a non-number and means "no limit".
    return { type: "text", ...(n[0] !== undefined ? { maxLength: n[0] } : {}) };
  }
  if (["tinytext"].includes(base)) return { type: "text", maxLength: 255 };
  if (["text", "ntext", "mediumtext", "longtext", "clob", "citext", "name", "xml"].includes(base)) return { type: "text" };
  if (["inet", "cidr", "macaddr"].includes(base)) return { type: "text", maxLength: 45 };

  // SQLite type affinity rules, for anything else.
  if (base.includes("int")) return { type: "integer", intBytes: 8 };
  if (/char|clob|text/.test(base)) return { type: "text", ...(n[0] !== undefined ? { maxLength: n[0] } : {}) };
  if (/real|floa|doub/.test(base)) return { type: "real" };
  if (base === "" || base === "blob") return { type: "bytes" };
  return { type: "text" };
}

/** Apply a mapped type onto a column under construction. */
export function applyMapped(col: ColumnModel, m: MappedType): ColumnModel {
  col.type = m.type;
  if (m.maxLength !== undefined) col.maxLength = m.maxLength;
  if (m.precision !== undefined) col.precision = m.precision;
  if (m.scale !== undefined) col.scale = m.scale;
  if (m.intBytes !== undefined) col.intBytes = m.intBytes;
  if (m.enumValues) col.enumValues = m.enumValues;
  if (m.autoIncrement) col.autoIncrement = true;
  return col;
}

/** Largest value an integer column can hold. */
export function intMax(c: Pick<ColumnModel, "intBytes" | "rawType">): number {
  const unsigned = /unsigned/i.test(c.rawType);
  switch (c.intBytes) {
    case 1:
      return unsigned ? 255 : 127;
    case 2:
      return unsigned ? 65_535 : 32_767;
    case 3:
      return unsigned ? 16_777_215 : 8_388_607;
    case 4:
      return unsigned ? 4_294_967_295 : 2_147_483_647;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

/** Largest absolute value a numeric(p, s) column can hold. */
export function decimalMax(c: Pick<ColumnModel, "precision" | "scale">): number {
  if (c.precision === undefined) return 1e12;
  const intDigits = c.precision - (c.scale ?? 0);
  return intDigits <= 0 ? 0.99 : 10 ** Math.min(intDigits, 15) - 1;
}
