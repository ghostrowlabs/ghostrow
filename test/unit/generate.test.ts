import { describe, expect, it } from "vitest";
import { loadSchema } from "../../src/connect/load.js";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { GhostrowError } from "../../src/cli/errors.js";
import { infer } from "../../src/engine/infer.js";
import { generateSeed, insertOrder, rowCounts, type GenOutput, type Row } from "../../src/gen/seed.js";
import { validate } from "../../src/gen/validate.js";

const shop = loadSchema("test/fixtures/shop.sql");
const shopPlan = infer(shop);

const rowsOf = (out: GenOutput, table: string): Row[] => {
  const t = out.find((o) => o.table.name === table);
  if (!t) throw new Error(`no table ${table}`);
  return t.rows;
};
const schemaOf = (sql: string): SchemaModel => ({ dialect: "postgres", source: "t.sql", tables: parseDDL(sql) });
const gen = (schema: SchemaModel, rows: number, seed = 1, extra: object = {}) => generateSeed({ schema, plan: infer(schema), seed, rows, ...extra });

function expectExit2(fn: () => unknown) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GhostrowError);
  expect((err as GhostrowError).exitCode).toBe(2);
}

describe("generateSeed on the shop fixture", () => {
  const out500 = generateSeed({ schema: shop, plan: shopPlan, seed: 7, rows: 500 });

  it("has zero violations at 500 rows", () => {
    const v = validate(out500, shopPlan);
    expect(v.violations).toEqual([]);
    expect(v.rows).toBeGreaterThan(500);
    expect(v.checked.foreignKeys).toBeGreaterThan(0);
  });

  it("has zero violations at 3000 rows", () => {
    const out = generateSeed({ schema: shop, plan: shopPlan, seed: 11, rows: 3000 });
    expect(validate(out, shopPlan).violations).toEqual([]);
  }, 60_000);

  it("is deterministic: same seed gives deep-equal output", () => {
    const again = generateSeed({ schema: shop, plan: shopPlan, seed: 7, rows: 500 });
    expect(again).toEqual(out500);
  });

  it("different seeds give different output", () => {
    const other = generateSeed({ schema: shop, plan: shopPlan, seed: 8, rows: 500 });
    expect(other).not.toEqual(out500);
    expect(rowsOf(other, "customers").map((r) => r.email)).not.toEqual(rowsOf(out500, "customers").map((r) => r.email));
  });

  it("every foreign key value exists in its parent", () => {
    for (const t of shop.tables) {
      for (const fk of t.foreignKeys) {
        const parents = new Set(rowsOf(out500, fk.refTable).map((p) => String(p[fk.refColumns[0]!])));
        for (const r of rowsOf(out500, t.name)) expect(parents.has(String(r[fk.columns[0]!])), `${t.name}.${fk.columns[0]}`).toBe(true);
      }
    }
  });

  it("orders.total equals the sum of its lines to 2 decimals", () => {
    const sums = new Map<unknown, number>();
    for (const l of rowsOf(out500, "order_lines")) sums.set(l.order_id, (sums.get(l.order_id) ?? 0) + Math.round(Number(l.amount) * 100));
    for (const o of rowsOf(out500, "orders")) expect(Number(o.total)).toBeCloseTo((sums.get(o.id) ?? 0) / 100, 2);
  });

  it("order_lines.amount = quantity * unit_price", () => {
    for (const l of rowsOf(out500, "order_lines")) expect(Math.abs(Number(l.quantity) * Number(l.unit_price) - Number(l.amount))).toBeLessThan(0.005);
  });

  it("order_lines.unit_price equals the product's price", () => {
    const price = new Map(rowsOf(out500, "products").map((p) => [p.id, Number(p.price)]));
    for (const l of rowsOf(out500, "order_lines")) expect(Number(l.unit_price)).toBe(price.get(l.product_id));
  });

  it("customers (tenant_id, email) is unique", () => {
    const seen = new Set<string>();
    for (const c of rowsOf(out500, "customers")) {
      const k = `${c.tenant_id}|${String(c.email).toLowerCase()}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("NIC values are 9 digits + V/X or 12 digits", () => {
    const nics = rowsOf(out500, "customers").map((c) => c.nic).filter((n) => n !== null && n !== undefined);
    expect(nics.length).toBeGreaterThan(0);
    for (const n of nics) expect(String(n)).toMatch(/^(\d{9}[VX]|\d{12})$/);
  });

  it("subscriptions.ends_at is after starts_at", () => {
    for (const s of rowsOf(out500, "subscriptions")) expect(String(s.ends_at) > String(s.starts_at)).toBe(true);
  });

  it("respects products CHECKs (price > 0, stock >= 0) and status values", () => {
    for (const p of rowsOf(out500, "products")) {
      expect(Number(p.price)).toBeGreaterThan(0);
      expect(Number(p.stock)).toBeGreaterThanOrEqual(0);
    }
    for (const c of rowsOf(out500, "customers")) expect(["active", "pending", "closed"]).toContain(c.status);
  });

  it("fills NOT NULL columns", () => {
    for (const t of shop.tables) {
      for (const c of t.columns) {
        if (c.nullable || c.autoIncrement) continue;
        for (const r of rowsOf(out500, t.name)) expect(r[c.name], `${t.name}.${c.name}`).not.toBeNull();
      }
    }
  });
});

describe("rowCounts", () => {
  it("gives leaf tables `rows` and each parent level about a third", () => {
    const c = rowCounts(shop, shopPlan, { rows: 900 });
    expect(c.get("order_lines")).toBe(900);
    expect(c.get("subscriptions")).toBe(900);
    expect(c.get("orders")).toBe(300);
    expect(c.get("products")).toBe(300);
    expect(c.get("customers")).toBe(100);
    expect(c.get("tenants")).toBe(34);
  });

  it("lets --table overrides win", () => {
    const c = rowCounts(shop, shopPlan, { rows: 900, tableRows: { orders: 7 } });
    expect(c.get("orders")).toBe(7);
  });

  it("defaults to 500 leaf rows", () => {
    expect(rowCounts(shop, shopPlan, {}).get("order_lines")).toBe(500);
  });

  it("caps a one-to-one child at its parent's count", () => {
    const s = schemaOf("CREATE TABLE a (id serial PRIMARY KEY); CREATE TABLE b (id serial PRIMARY KEY, a_id int NOT NULL UNIQUE REFERENCES a(id));");
    const c = rowCounts(s, infer(s), { rows: 90 });
    expect(c.get("b")!).toBeLessThanOrEqual(c.get("a")!);
  });
});

describe("generateSeed: unsatisfiable and cyclic schemas", () => {
  it("throws exit 2 when a unique enum-like column needs more rows than values", () => {
    const s = schemaOf("CREATE TABLE t (id serial PRIMARY KEY, kind varchar(10) NOT NULL UNIQUE CHECK (kind IN ('a','b','c')));");
    expectExit2(() => gen(s, 20));
  });

  it("generates when a unique enum column has enough values", () => {
    const s = schemaOf("CREATE TABLE t (id serial PRIMARY KEY, kind varchar(10) NOT NULL UNIQUE CHECK (kind IN ('a','b','c')));");
    const out = gen(s, 3);
    expect(rowsOf(out, "t").map((r) => r.kind).sort()).toEqual(["a", "b", "c"]);
  });

  const cycle = (nullable: boolean) =>
    schemaOf(`
      CREATE TABLE a (id serial PRIMARY KEY, b_id int ${nullable ? "" : "NOT NULL"} REFERENCES b(id));
      CREATE TABLE b (id serial PRIMARY KEY, a_id int NOT NULL REFERENCES a(id));`);

  it("throws exit 2 for a cycle through NOT NULL foreign keys", () => {
    const s = cycle(false);
    expectExit2(() => insertOrder(s, infer(s)));
    expectExit2(() => gen(s, 10));
  });

  it("breaks a cycle at a nullable foreign key", () => {
    const s = cycle(true);
    const { order, deferred } = insertOrder(s, infer(s));
    expect(order.map((t) => t.name)).toEqual(["a", "b"]);
    expect([...deferred]).toEqual(["fk:a.b_id"]);
    const out = gen(s, 20);
    const v = validate(out, infer(s));
    expect(v.violations).toEqual([]);
    for (const r of rowsOf(out, "a")) expect(r.b_id).toBeNull();
    for (const r of rowsOf(out, "b")) expect(rowsOf(out, "a").some((p) => p.id === r.a_id)).toBe(true);
  });

  it("handles a self-referencing nullable foreign key", () => {
    const s = schemaOf("CREATE TABLE employees (id serial PRIMARY KEY, name varchar(60) NOT NULL, manager_id int REFERENCES employees(id));");
    const out = gen(s, 40);
    const emps = rowsOf(out, "employees");
    expect(emps).toHaveLength(40);
    expect(validate(out, infer(s)).violations).toEqual([]);
    const ids = new Set(emps.map((e) => e.id));
    for (const e of emps) if (e.manager_id !== null && e.manager_id !== undefined) expect(ids.has(e.manager_id)).toBe(true);
  });

  it("orders parents before children", () => {
    const { order } = insertOrder(shop, shopPlan);
    const idx = (n: string) => order.findIndex((t) => t.name === n);
    expect(idx("tenants")).toBeLessThan(idx("customers"));
    expect(idx("customers")).toBeLessThan(idx("orders"));
    expect(idx("orders")).toBeLessThan(idx("order_lines"));
    expect(idx("products")).toBeLessThan(idx("order_lines"));
  });
});

describe("generateSeed: existing rows", () => {
  it("never produces unique values that collide with existing rows", () => {
    const s = schemaOf("CREATE TABLE users (id serial PRIMARY KEY, email varchar(100) NOT NULL UNIQUE, code varchar(5) NOT NULL UNIQUE CHECK (code IN ('a','b','c','d','e')));");
    const plan = infer(s);
    const base = generateSeed({ schema: s, plan, seed: 3, rows: 3 });
    const existing = new Map<string, Row[]>([["users", [...rowsOf(base, "users"), { id: 100, email: "taken@example.org", code: "e" }]]]);
    const out = generateSeed({ schema: s, plan, seed: 3, rows: 1, existing, idStart: { users: 101 } });
    const row = rowsOf(out, "users")[0]!;
    const takenEmails = new Set([...existing.get("users")!].map((r) => r.email));
    const takenCodes = new Set([...existing.get("users")!].map((r) => r.code));
    expect(takenEmails.has(row.email)).toBe(false);
    expect(takenCodes.has(row.code)).toBe(false);
  });

  it("fails with exit 2 when existing rows exhaust the only allowed unique values", () => {
    const s = schemaOf("CREATE TABLE t (id serial PRIMARY KEY, code varchar(5) NOT NULL UNIQUE CHECK (code IN ('a','b')));");
    const existing = new Map<string, Row[]>([["t", [{ id: 1, code: "a" }, { id: 2, code: "b" }]]]);
    expectExit2(() => generateSeed({ schema: s, plan: infer(s), seed: 1, rows: 1, existing, idStart: { t: 3 } }));
  });

  it("starts ids at idStart", () => {
    const s = schemaOf("CREATE TABLE t (id serial PRIMARY KEY, name varchar(20) NOT NULL);");
    const out = generateSeed({ schema: s, plan: infer(s), seed: 1, rows: 3, idStart: { t: 50 } });
    expect(rowsOf(out, "t").map((r) => r.id)).toEqual([50, 51, 52]);
  });
});
