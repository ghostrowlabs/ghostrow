import { describe, expect, it } from "vitest";
import { guessDialect, parseDDL, tokenize } from "../../src/connect/ddl.js";
import { decimalMax, intMax, mapSqlType } from "../../src/connect/typemap.js";
import type { TableModel } from "../../src/connect/types.js";

const one = (sql: string, dialect: Parameters<typeof parseDDL>[1] = "postgres"): TableModel => {
  const t = parseDDL(sql, dialect);
  expect(t.length).toBeGreaterThan(0);
  return t[0]!;
};
const col = (t: TableModel, name: string) => {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new Error(`no column ${name}`);
  return c;
};

describe("parseDDL: Postgres", () => {
  it("reads SERIAL primary keys as auto-increment", () => {
    const t = one("CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);");
    expect(t.name).toBe("users");
    expect(t.primaryKey).toEqual(["id"]);
    const id = col(t, "id");
    expect(id.autoIncrement).toBe(true);
    expect(id.primaryKey).toBe(true);
    expect(id.nullable).toBe(false);
    expect(id.type).toBe("integer");
    expect(col(t, "name").nullable).toBe(false);
  });

  it("captures varchar(n) max length", () => {
    const c = col(one("CREATE TABLE t (a varchar(64));"), "a");
    expect(c.type).toBe("text");
    expect(c.maxLength).toBe(64);
    expect(c.nullable).toBe(true);
  });

  it("captures numeric(10,2) precision and scale", () => {
    const c = col(one("CREATE TABLE t (price numeric(10,2) NOT NULL);"), "price");
    expect(c.type).toBe("decimal");
    expect(c.precision).toBe(10);
    expect(c.scale).toBe(2);
  });

  it("reads an inline REFERENCES as a foreign key", () => {
    const t = parseDDL("CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));").find((x) => x.name === "b")!;
    expect(t.foreignKeys).toEqual([{ columns: ["a_id"], refTable: "a", refColumns: ["id"] }]);
  });

  it("reads a composite table-level FOREIGN KEY", () => {
    const t = parseDDL(`CREATE TABLE p (x int, y int, PRIMARY KEY (x, y));
      CREATE TABLE c (x int, y int, FOREIGN KEY (x, y) REFERENCES p (x, y));`).find((n) => n.name === "c")!;
    expect(t.foreignKeys).toEqual([{ columns: ["x", "y"], refTable: "p", refColumns: ["x", "y"] }]);
  });

  it("reads a composite PRIMARY KEY", () => {
    const t = one("CREATE TABLE p (x int, y int, PRIMARY KEY (x, y));");
    expect(t.primaryKey).toEqual(["x", "y"]);
    expect(col(t, "x").primaryKey).toBe(true);
    expect(col(t, "y").nullable).toBe(false);
  });

  it("puts composite UNIQUE into table.uniques", () => {
    const t = one("CREATE TABLE t (a int, b int, UNIQUE (a, b));");
    expect(t.uniques).toEqual([["a", "b"]]);
    expect(col(t, "a").unique).toBe(false);
  });

  it("puts inline UNIQUE on the column", () => {
    const t = one("CREATE TABLE t (email text UNIQUE, n int);");
    expect(col(t, "email").unique).toBe(true);
    expect(col(t, "n").unique).toBe(false);
    expect(t.uniques).toEqual([]);
  });

  it("treats a single-column table-level UNIQUE as a column flag", () => {
    const t = one("CREATE TABLE t (email text, UNIQUE (email));");
    expect(col(t, "email").unique).toBe(true);
    expect(t.uniques).toEqual([]);
  });

  it("captures inline and table-level CHECKs", () => {
    const t = one("CREATE TABLE t (qty int CHECK (qty > 0), a int, b int, CHECK (b > a));");
    expect(t.checks).toHaveLength(2);
    expect(t.checks[0]).toBe("qty > 0");
    expect(t.checks[1]).toBe("b > a");
  });

  it("reads a named CONSTRAINT ... CHECK", () => {
    const t = one("CREATE TABLE t (a int, CONSTRAINT a_pos CHECK (a >= 0));");
    expect(t.checks).toEqual(["a >= 0"]);
  });

  it("resolves a CREATE TYPE ... AS ENUM used by a column", () => {
    const t = parseDDL(`CREATE TABLE person (id int, m mood NOT NULL);
      CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');`)[0]!;
    const m = col(t, "m");
    expect(m.type).toBe("enum");
    expect(m.enumValues).toEqual(["sad", "ok", "happy"]);
  });

  it("resolves a schema-qualified enum type", () => {
    const t = parseDDL(`CREATE TYPE public.mood AS ENUM ('a','b'); CREATE TABLE p (m public.mood);`)[0]!;
    expect(col(t, "m").type).toBe("enum");
    expect(col(t, "m").enumValues).toEqual(["a", "b"]);
  });

  it("applies ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY", () => {
    const tables = parseDDL(`CREATE TABLE a (id int PRIMARY KEY);
      CREATE TABLE b (id int PRIMARY KEY, a_id int);
      ALTER TABLE ONLY public.b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES public.a (id);`);
    expect(tables.find((t) => t.name === "b")!.foreignKeys).toEqual([{ columns: ["a_id"], refTable: "a", refColumns: ["id"] }]);
  });

  it("applies ALTER TABLE ADD UNIQUE and ADD CHECK", () => {
    const t = parseDDL(`CREATE TABLE t (a int, b int);
      ALTER TABLE t ADD CONSTRAINT u UNIQUE (a, b);
      ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);`)[0]!;
    expect(t.uniques).toEqual([["a", "b"]]);
    expect(t.checks).toEqual(["a > 0"]);
  });

  it("reads CREATE UNIQUE INDEX as a composite unique", () => {
    const t = parseDDL("CREATE TABLE t (a int, b int); CREATE UNIQUE INDEX t_ab ON t (a, b);")[0]!;
    expect(t.uniques).toEqual([["a", "b"]]);
  });

  it("reads CREATE UNIQUE INDEX ... USING btree", () => {
    const t = parseDDL("CREATE TABLE t (a int, b int); CREATE UNIQUE INDEX t_ab ON public.t USING btree (a, b);")[0]!;
    expect(t.uniques).toEqual([["a", "b"]]);
  });

  it("ignores a partial unique index (WHERE)", () => {
    const t = parseDDL("CREATE TABLE t (a int, b int); CREATE UNIQUE INDEX t_ab ON t (a, b) WHERE b > 0;")[0]!;
    expect(t.uniques).toEqual([]);
  });

  it("marks GENERATED ALWAYS AS IDENTITY as auto-increment with 'identity always' in rawType", () => {
    const c = col(one("CREATE TABLE t (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);"), "id");
    expect(c.autoIncrement).toBe(true);
    expect(c.rawType).toContain("identity always");
  });

  it("marks GENERATED BY DEFAULT AS IDENTITY as auto-increment without 'always'", () => {
    const c = col(one("CREATE TABLE t (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);"), "id");
    expect(c.autoIncrement).toBe(true);
    expect(c.rawType).not.toContain("identity always");
  });

  it("maps timestamp with time zone to datetime", () => {
    const c = col(one("CREATE TABLE t (at timestamp with time zone NOT NULL);"), "at");
    expect(c.type).toBe("datetime");
  });

  it("maps time without time zone to time", () => {
    expect(col(one("CREATE TABLE t (at time without time zone);"), "at").type).toBe("time");
  });

  it("maps double precision to real", () => {
    expect(col(one("CREATE TABLE t (x double precision);"), "x").type).toBe("real");
  });

  it("accepts text[] array columns without breaking the next column", () => {
    const t = one("CREATE TABLE t (tags text[] NOT NULL, other int);");
    expect(col(t, "tags").type).toBe("text");
    expect(col(t, "tags").nullable).toBe(false);
    expect(col(t, "other").type).toBe("integer");
  });

  it("ignores -- and block comments", () => {
    const t = one(`-- header
      CREATE TABLE t ( -- trailing
        a int, /* block ; with semicolon */
        b int  -- last
      );`);
    expect(t.columns.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("skips dollar-quoted function bodies", () => {
    const tables = parseDDL(`CREATE FUNCTION f() RETURNS int AS $$ BEGIN CREATE TABLE fake (x int); RETURN 1; END; $$ LANGUAGE plpgsql;
      CREATE TABLE real_one (id int);`);
    expect(tables.map((t) => t.name)).toEqual(["real_one"]);
  });

  it("skips views, inserts and CREATE TABLE ... AS SELECT", () => {
    const tables = parseDDL(`CREATE TABLE a (id int);
      CREATE VIEW v AS SELECT * FROM a;
      INSERT INTO a VALUES (1);
      CREATE TABLE c AS SELECT * FROM a;`);
    expect(tables.map((t) => t.name)).toEqual(["a"]);
  });

  it("records DEFAULT values", () => {
    const t = one("CREATE TABLE t (s text DEFAULT 'x', n int DEFAULT 0, at timestamp DEFAULT now());");
    expect(col(t, "s").defaultValue).toBe("'x'");
    expect(col(t, "n").defaultValue).toBe("0");
    expect(col(t, "at").defaultValue).toBe("now()");
  });

  it("handles IF NOT EXISTS and schema-qualified names", () => {
    const t = one('CREATE TABLE IF NOT EXISTS public."My Table" (id int);');
    expect(t.name).toBe("My Table");
  });

  it("uses uuid type", () => {
    expect(col(one("CREATE TABLE t (id uuid PRIMARY KEY DEFAULT gen_random_uuid());"), "id").type).toBe("uuid");
  });
});

describe("parseDDL: MySQL", () => {
  it("reads backtick identifiers and AUTO_INCREMENT", () => {
    const t = one("CREATE TABLE `order items` (`id` INT NOT NULL AUTO_INCREMENT, `qty` INT, PRIMARY KEY (`id`));", "mysql");
    expect(t.name).toBe("order items");
    expect(col(t, "id").autoIncrement).toBe(true);
    expect(t.primaryKey).toEqual(["id"]);
  });

  it("reads inline enum('a','b')", () => {
    const c = col(one("CREATE TABLE t (`status` enum('new','done') NOT NULL);", "mysql"), "status");
    expect(c.type).toBe("enum");
    expect(c.enumValues).toEqual(["new", "done"]);
  });

  it("maps tinyint(1) to boolean", () => {
    expect(col(one("CREATE TABLE t (flag tinyint(1) NOT NULL);", "mysql"), "flag").type).toBe("boolean");
  });

  it("keeps plain tinyint as a 1-byte integer", () => {
    const c = col(one("CREATE TABLE t (n tinyint);", "mysql"), "n");
    expect(c.type).toBe("integer");
    expect(c.intBytes).toBe(1);
  });

  it("handles INT UNSIGNED", () => {
    const c = col(one("CREATE TABLE t (n INT UNSIGNED NOT NULL);", "mysql"), "n");
    expect(c.type).toBe("integer");
    expect(c.rawType.toLowerCase()).toContain("unsigned");
    expect(intMax(c)).toBe(4_294_967_295);
  });

  it("ignores ENGINE=InnoDB table options and KEY lines", () => {
    const t = one("CREATE TABLE t (id INT AUTO_INCREMENT, a INT, KEY idx_a (a), PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;", "mysql");
    expect(t.columns.map((c) => c.name)).toEqual(["id", "a"]);
    expect(t.primaryKey).toEqual(["id"]);
  });

  it("ignores a COMMENT clause and charset", () => {
    const c = col(one("CREATE TABLE t (n varchar(10) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL COMMENT 'hello');", "mysql"), "n");
    expect(c.nullable).toBe(false);
    expect(c.maxLength).toBe(10);
  });
});

describe("parseDDL: SQLite", () => {
  it("treats INTEGER PRIMARY KEY as auto-increment", () => {
    const c = col(one("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT);", "sqlite"), "id");
    expect(c.autoIncrement).toBe(true);
  });

  it("does not treat INTEGER PRIMARY KEY as auto-increment for Postgres", () => {
    expect(col(one("CREATE TABLE t (id INTEGER PRIMARY KEY);", "postgres"), "id").autoIncrement).toBe(false);
  });

  it("reads AUTOINCREMENT", () => {
    const c = col(one("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, n TEXT);", "sqlite"), "id");
    expect(c.autoIncrement).toBe(true);
    expect(c.primaryKey).toBe(true);
  });
});

describe("parseDDL: SQL Server", () => {
  const sql = `CREATE TABLE [dbo].[Orders] (
    [Id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    [Ref] UNIQUEIDENTIFIER NOT NULL,
    [Name] NVARCHAR(50) NULL,
    [Paid] BIT NOT NULL
  );`;

  it("reads [bracket] identifiers and schema prefix", () => {
    const t = one(sql, "sqlserver");
    expect(t.name).toBe("Orders");
    expect(t.columns.map((c) => c.name)).toEqual(["Id", "Ref", "Name", "Paid"]);
  });

  it("reads IDENTITY(1,1) as auto-increment", () => {
    expect(col(one(sql, "sqlserver"), "Id").autoIncrement).toBe(true);
  });

  it("maps NVARCHAR(50), UNIQUEIDENTIFIER and BIT", () => {
    const t = one(sql, "sqlserver");
    expect(col(t, "Name").maxLength).toBe(50);
    expect(col(t, "Name").nullable).toBe(true);
    expect(col(t, "Ref").type).toBe("uuid");
    expect(col(t, "Paid").type).toBe("boolean");
  });

  it("parses ;-separated batches (GO lines are replaced by the loader)", () => {
    const tables = parseDDL("CREATE TABLE [a] ([id] INT);\n;\nCREATE TABLE [b] ([id] INT);", "sqlserver");
    expect(tables.map((t) => t.name)).toEqual(["a", "b"]);
  });
});

describe("tokenize", () => {
  it("distinguishes identifiers, quoted identifiers, strings and numbers", () => {
    const toks = tokenize(`select "Q", 'it''s', 12.5, [br]`);
    expect(toks.map((t) => t.k)).toEqual(["id", "qid", "p", "str", "p", "num", "p", "qid"]);
    expect(toks[3]!.v).toBe("it's");
  });

  it("does not treat ARRAY[...] or int[] as bracket identifiers", () => {
    const toks = tokenize("ARRAY['a'] int[]");
    expect(toks.some((t) => t.k === "qid")).toBe(false);
  });

  it("turns a dollar-quoted body into one string token", () => {
    const toks = tokenize("x $fn$ a; b $fn$ y");
    expect(toks.map((t) => t.k)).toEqual(["id", "str", "id"]);
  });
});

describe("guessDialect", () => {
  it("detects sqlite", () => {
    expect(guessDialect("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);")).toBe("sqlite");
    expect(guessDialect("CREATE TABLE t (id INT) WITHOUT ROWID;")).toBe("sqlite");
  });
  it("detects sql server", () => {
    expect(guessDialect("CREATE TABLE t (id INT IDENTITY(1,1));")).toBe("sqlserver");
    expect(guessDialect("CREATE TABLE t (n NVARCHAR(10));\nGO\n")).toBe("sqlserver");
  });
  it("detects mysql", () => {
    expect(guessDialect("CREATE TABLE `t` (id INT);")).toBe("mysql");
    expect(guessDialect("CREATE TABLE t (id INT AUTO_INCREMENT) ENGINE=InnoDB;")).toBe("mysql");
  });
  it("defaults to postgres", () => {
    expect(guessDialect("CREATE TABLE t (id SERIAL PRIMARY KEY);")).toBe("postgres");
  });
});

describe("typemap", () => {
  it("intMax by width and signedness", () => {
    expect(intMax({ intBytes: 1, rawType: "tinyint" })).toBe(127);
    expect(intMax({ intBytes: 1, rawType: "tinyint unsigned" })).toBe(255);
    expect(intMax({ intBytes: 2, rawType: "smallint" })).toBe(32_767);
    expect(intMax({ intBytes: 2, rawType: "smallint unsigned" })).toBe(65_535);
    expect(intMax({ intBytes: 3, rawType: "mediumint" })).toBe(8_388_607);
    expect(intMax({ intBytes: 4, rawType: "int" })).toBe(2_147_483_647);
    expect(intMax({ intBytes: 4, rawType: "int unsigned" })).toBe(4_294_967_295);
    expect(intMax({ intBytes: 8, rawType: "bigint" })).toBe(Number.MAX_SAFE_INTEGER);
    expect(intMax({ rawType: "integer" })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("decimalMax for numeric(p,s)", () => {
    expect(decimalMax({ precision: 5, scale: 2 })).toBe(999);
    expect(decimalMax({ precision: 10, scale: 2 })).toBe(99_999_999);
    expect(decimalMax({ precision: 2, scale: 2 })).toBe(0.99);
    expect(decimalMax({ precision: 3, scale: 5 })).toBe(0.99);
    expect(decimalMax({ precision: 5 })).toBe(99_999);
    expect(decimalMax({})).toBe(1e12);
    expect(decimalMax({ precision: 30, scale: 0 })).toBe(10 ** 15 - 1);
  });

  it("mapSqlType covers the main families", () => {
    expect(mapSqlType("serial")).toMatchObject({ type: "integer", intBytes: 4, autoIncrement: true });
    expect(mapSqlType("bigserial")).toMatchObject({ intBytes: 8, autoIncrement: true });
    expect(mapSqlType("numeric", ["8"])).toMatchObject({ type: "decimal", precision: 8, scale: 0 });
    expect(mapSqlType("money")).toMatchObject({ type: "decimal", precision: 19, scale: 2 });
    expect(mapSqlType("char", [])).toMatchObject({ type: "text", maxLength: 1 });
    expect(mapSqlType("varchar", ["max"])).toEqual({ type: "text" });
    expect(mapSqlType("jsonb").type).toBe("json");
    expect(mapSqlType("bytea").type).toBe("bytes");
    expect(mapSqlType("text[]").type).toBe("text");
    expect(mapSqlType("bit", ["8"]).type).not.toBe("boolean");
    expect(mapSqlType("datetime2").type).toBe("datetime");
    expect(mapSqlType("something_odd").type).toBe("text");
  });
});
