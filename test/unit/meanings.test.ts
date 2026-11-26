import { describe, expect, it } from "vitest";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { infer } from "../../src/engine/infer.js";
import { words } from "../../src/engine/meanings.js";

const SQL = `
CREATE TABLE countries (id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL);
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  country_id INTEGER NOT NULL REFERENCES countries(id),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(30),
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  nic VARCHAR(12) CHECK (length(nic) IN (10, 12)),
  status VARCHAR(20) NOT NULL,
  country_code CHAR(2),
  is_active BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL
);
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(32) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  quantity INTEGER NOT NULL
);
CREATE TABLE weird (
  id SERIAL PRIMARY KEY,
  email INTEGER,
  phone_number INTEGER
);
`;

const schema: SchemaModel = { dialect: "postgres", source: "test.sql", tables: parseDDL(SQL, "postgres") };
const plan = infer(schema);
const meaning = (table: string, column: string) => {
  const c = plan.columns.find((x) => x.table === table && x.column === column);
  if (!c) throw new Error(`no ${table}.${column}`);
  return c;
};

describe("infer: column meanings", () => {
  it.each([
    ["customers", "email", "email"],
    ["customers", "phone", "phone"],
    ["customers", "first_name", "first_name"],
    ["customers", "last_name", "last_name"],
    ["products", "sku", "sku"],
    ["products", "price", "money"],
    ["products", "quantity", "quantity"],
    ["customers", "created_at", "datetime"],
    ["customers", "status", "status"],
    ["customers", "country_code", "country_code"],
    ["customers", "id", "id"],
  ])("%s.%s is %s", (table, column, expected) => {
    expect(meaning(table, column).meaning).toBe(expected);
  });

  it("gives a bare name column a table-dependent meaning", () => {
    expect(meaning("countries", "name").meaning).toBe("country");
  });

  it("gives FK columns the reference meaning with confidence 1", () => {
    const c = meaning("customers", "country_id");
    expect(c.meaning).toBe("reference");
    expect(c.confidence).toBe(1);
    expect(c.evidence).toContain("countries");
  });

  it("recognises a Sri Lankan NIC from the name and a length 10/12 CHECK", () => {
    const c = meaning("customers", "nic");
    expect(c.meaning).toBe("national_id_lk");
    expect(c.evidence).toContain("CHECK");
  });

  it("recognises a boolean column named is_active", () => {
    expect(meaning("customers", "is_active").meaning).toBe("boolean");
  });

  it("lets the declared type veto a name: an integer column named email is not an email", () => {
    expect(meaning("weird", "email").meaning).not.toBe("email");
    expect(meaning("weird", "email").meaning).toBe("integer");
    expect(meaning("weird", "phone_number").meaning).not.toBe("phone");
  });

  it("produces one entry per column with confidence between 0 and 1", () => {
    const total = schema.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(plan.columns).toHaveLength(total);
    for (const c of plan.columns) {
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic", () => {
    expect(infer(schema)).toEqual(infer(schema));
  });

  it("uses sampled values to confirm an email column and to keep categories", () => {
    const t = parseDDL("CREATE TABLE u (id int PRIMARY KEY, contact varchar(100), tier varchar(20));")[0]!;
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, contact: `p${i}@x.org`, tier: i % 2 ? "gold" : "silver" }));
    const p = infer({ dialect: "postgres", source: "s", tables: [t] }, new Map([["u", rows]]));
    expect(p.columns.find((c) => c.column === "contact")!.meaning).toBe("email");
    const tier = p.columns.find((c) => c.column === "tier")!;
    expect(tier.meaning).toBe("status");
    expect(tier.values).toEqual(["gold", "silver"]);
  });
});

describe("words()", () => {
  it("splits snake_case", () => {
    expect(words("ORDER_TOTAL")).toEqual(["order", "total"]);
    expect(words("created_at")).toEqual(["created", "at"]);
  });
  it("splits camelCase and PascalCase", () => {
    expect(words("createdAt")).toEqual(["created", "at"]);
    expect(words("FirstName")).toEqual(["first", "name"]);
  });
  it("splits acronym boundaries", () => {
    expect(words("userIDNumber")).toEqual(["user", "id", "number"]);
    expect(words("HTTPStatus")).toEqual(["http", "status"]);
  });
  it("splits kebab and space separators and drops empties", () => {
    expect(words("a-b c__d")).toEqual(["a", "b", "c", "d"]);
    expect(words("")).toEqual([]);
  });
});
