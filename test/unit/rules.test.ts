import { describe, expect, it } from "vitest";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { detectRules, type Rule } from "../../src/engine/rules.js";

const schemaOf = (sql: string): SchemaModel => ({ dialect: "postgres", source: "t.sql", tables: parseDDL(sql) });
const kind = <K extends Rule["kind"]>(rules: Rule[], k: K) => rules.filter((r): r is Extract<Rule, { kind: K }> => r.kind === k);

describe("detectRules: ordering", () => {
  const rules = detectRules(
    schemaOf(`CREATE TABLE t (
      id int PRIMARY KEY,
      created_at timestamp, updated_at timestamp,
      starts_at timestamp, ends_at timestamp,
      valid_from date, valid_to date,
      customer_id int, total numeric(10,2)
    );`),
  );
  const orders = kind(rules, "order");

  it("pairs created_at / updated_at", () => {
    expect(orders.some((o) => o.earlier === "created_at" && o.later === "updated_at")).toBe(true);
  });
  it("pairs starts_at / ends_at", () => {
    expect(orders.some((o) => o.earlier === "starts_at" && o.later === "ends_at")).toBe(true);
  });
  it("pairs valid_from / valid_to", () => {
    expect(orders.some((o) => o.earlier === "valid_from" && o.later === "valid_to")).toBe(true);
  });
  it("does not pair customer_id with total (no false positive)", () => {
    expect(orders.some((o) => [o.earlier, o.later].includes("customer_id") || [o.earlier, o.later].includes("total"))).toBe(false);
  });
  it("is inferred, enabled and non-strict", () => {
    for (const o of orders) {
      expect(o.enabled).toBe(true);
      expect(o.source).toBe("inferred");
      expect(o.strict).toBe(false);
    }
  });
  it("does not pair a date with a numeric column of a different stem", () => {
    const r = detectRules(schemaOf("CREATE TABLE t (id int, started_at timestamp, ended_on timestamp);"));
    expect(kind(r, "order")).toHaveLength(0);
  });
});

const SHOP = `
CREATE TABLE products (id SERIAL PRIMARY KEY, sku varchar(20) UNIQUE, price numeric(10,2) NOT NULL);
CREATE TABLE orders (id SERIAL PRIMARY KEY, total numeric(12,2) NOT NULL);
CREATE TABLE order_lines (
  id SERIAL PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  product_id int NOT NULL REFERENCES products(id),
  quantity int NOT NULL,
  unit_price numeric(10,2) NOT NULL,
  amount numeric(12,2) NOT NULL
);
CREATE TABLE memberships (a int, b int, code varchar(5), UNIQUE (a, b), PRIMARY KEY (a, code));
`;

describe("detectRules: aggregates, products, copies", () => {
  const rules = detectRules(schemaOf(SHOP));

  it("detects quantity x unit_price = amount", () => {
    const p = kind(rules, "product");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ table: "order_lines", column: "amount", factors: ["quantity", "unit_price"] });
  });

  it("detects orders.total = sum of order_lines.amount", () => {
    const s = kind(rules, "sum");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ table: "orders", column: "total", childTable: "order_lines", childColumn: "amount", childFk: ["order_id"], parentKey: ["id"] });
  });

  it("detects order_lines.unit_price copied from products.price", () => {
    const c = kind(rules, "copy");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ table: "order_lines", column: "unit_price", refColumn: "price", fk: "fk:order_lines.product_id" });
  });

  it("does not infer a sum when the parent has no total-like column", () => {
    const r = detectRules(schemaOf("CREATE TABLE a (id int PRIMARY KEY, name text); CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id), amount numeric(8,2));"));
    expect(kind(r, "sum")).toHaveLength(0);
  });
});

describe("detectRules: fk, unique, check", () => {
  const rules = detectRules(schemaOf(SHOP));

  it("emits fk rules with resolved referenced columns", () => {
    const fks = kind(rules, "fk");
    expect(fks.map((f) => f.id).sort()).toEqual(["fk:order_lines.order_id", "fk:order_lines.product_id"]);
    expect(fks[0]!.refColumns).toEqual(["id"]);
  });

  it("emits unique rules for primary keys, column UNIQUE and composite UNIQUE", () => {
    const u = kind(rules, "unique").map((r) => `${r.table}:${r.columns.join("+")}`);
    expect(u).toContain("products:id");
    expect(u).toContain("products:sku");
    expect(u).toContain("memberships:a+b");
    expect(u).toContain("memberships:a+code");
  });

  it("labels the primary key evidence", () => {
    const pk = kind(rules, "unique").find((r) => r.table === "products" && r.columns.join() === "id")!;
    expect(pk.evidence).toBe("PRIMARY KEY");
    const sku = kind(rules, "unique").find((r) => r.columns.join() === "sku")!;
    expect(sku.evidence).toBe("declared UNIQUE");
  });

  it("does not duplicate a single-column unique that is also the primary key", () => {
    const r = detectRules(schemaOf("CREATE TABLE t (id int PRIMARY KEY UNIQUE);"));
    expect(kind(r, "unique")).toHaveLength(1);
  });

  it("emits check rules for CHECKs and enum columns", () => {
    const r = detectRules(schemaOf("CREATE TYPE mood AS ENUM ('a','b'); CREATE TABLE t (id int, m mood, n int CHECK (n > 0));"));
    const checks = kind(r, "check");
    expect(checks.map((c) => c.id).sort()).toEqual(["check:t.1", "values:t.m"]);
    expect(checks.find((c) => c.id === "values:t.m")!.check).toBe("m IN ('a', 'b')");
  });

  it("gives every rule a unique id", () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
