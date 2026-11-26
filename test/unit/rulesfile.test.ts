/* eslint-disable @typescript-eslint/no-explicit-any -- these tests edit parsed YAML documents of any shape */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { infer } from "../../src/engine/infer.js";
import { mergeRules, readRulesFile, writeRulesFile } from "../../src/engine/rulesfile.js";

const schema: SchemaModel = {
  dialect: "postgres",
  source: "t.sql",
  tables: parseDDL(`
    CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(100) NOT NULL, note VARCHAR(100), starts_at DATE, ends_at DATE);
    CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id), total NUMERIC(10,2) NOT NULL);
  `),
};

let dir: string;
let path: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ghostrow-rules-"));
  path = join(dir, "ghostrow.rules.yaml");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fresh = () => infer(schema);
const edit = (fn: (doc: any) => void) => {
  const doc = parse(readFileSync(path, "utf8"));
  fn(doc);
  writeFileSync(path, stringify(doc), "utf8");
};
const merged = () => mergeRules(fresh(), schema, readRulesFile(path));

describe("rules file", () => {
  it("returns null when the file does not exist", () => {
    expect(readRulesFile(join(dir, "missing.yaml"))).toBeNull();
  });

  it("writes a reviewable file with a header, engine, tables and rules", () => {
    writeRulesFile(path, fresh(), schema);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("# Ghostrow rules")).toBe(true);
    const doc = parse(text);
    expect(doc.engine).toMatch(/^gr-schema-1\//);
    expect(Object.keys(doc.tables)).toEqual(["customers", "orders"]);
    expect(doc.tables.customers.columns.email.meaning).toBe("email");
    expect(doc.rules.length).toBeGreaterThan(0);
  });

  it("round-trips unchanged when nothing was edited", () => {
    writeRulesFile(path, fresh(), schema);
    const { plan, notes } = merged();
    expect(notes).toEqual([]);
    expect(plan.columns).toEqual(fresh().columns);
    expect(plan.rules.map((r) => r.id)).toEqual(fresh().rules.map((r) => r.id));
  });

  it("keeps a column meaning edit and pins it", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.tables.customers.columns.note.meaning = "city";
    });
    const c = merged().plan.columns.find((x) => x.table === "customers" && x.column === "note")!;
    expect(c.meaning).toBe("city");
    expect(c.pinned).toBe(true);
    expect(c.confidence).toBe(1);
    expect(c.evidence).toBe("set in rules file");
  });

  it("does not pin a column whose meaning was left alone", () => {
    writeRulesFile(path, fresh(), schema);
    const email = merged().plan.columns.find((x) => x.column === "email")!;
    expect(email.pinned).toBeUndefined();
  });

  it("keeps edited values for a column", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.tables.customers.columns.note.values = ["x", "y"];
    });
    const c = merged().plan.columns.find((x) => x.column === "note")!;
    expect(c.values).toEqual(["x", "y"]);
    expect(c.pinned).toBe(true);
  });

  it("reports an unknown meaning in a note and ignores it", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.tables.customers.columns.note.meaning = "banana";
    });
    const { plan, notes } = merged();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("customers.note");
    expect(notes[0]).toContain("banana");
    const c = plan.columns.find((x) => x.column === "note")!;
    expect(c.meaning).not.toBe("banana");
    expect(c.pinned).toBeUndefined();
  });

  it("switches a rule off with enabled: false", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.rules.find((r: any) => r.id === "fk:orders.customer_id").enabled = false;
    });
    const { plan } = merged();
    expect(plan.rules.find((r) => r.id === "fk:orders.customer_id")!.enabled).toBe(false);
    expect(plan.rules.find((r) => r.id === "order:customers.starts_at<=ends_at")!.enabled).toBe(true);
  });

  it("applies rows: per table", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.tables.orders.rows = 42;
      d.tables.customers.rows = 7.9;
    });
    const { plan } = merged();
    expect(plan.rows).toEqual({ orders: 42, customers: 7 });
  });

  it("adds a user check rule", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.rules.push({ kind: "check", table: "orders", expr: "total >= 0" });
    });
    const { plan } = merged();
    const added = plan.rules.find((r) => r.kind === "check" && r.source === "rules file");
    expect(added).toMatchObject({ kind: "check", table: "orders", check: "total >= 0", enabled: true, evidence: "added in rules file" });
  });

  it("keeps a user check rule across a write/read cycle and honours its enabled flag", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.rules.push({ id: "user:orders.1", kind: "check", table: "orders", expr: "total >= 0", enabled: false });
    });
    const first = merged().plan;
    writeRulesFile(path, first, schema);
    const again = merged().plan;
    const r = again.rules.find((x) => x.id === "user:orders.1");
    expect(r).toBeDefined();
    expect(r!.enabled).toBe(false);
    expect((r as { check: string }).check).toBe("total >= 0");
  });

  it("notes that only check rules can be added by hand", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.rules.push({ id: "user:x", kind: "sum", table: "orders" });
    });
    const { notes } = merged();
    expect(notes.some((n) => n.includes("only \"check\" rules"))).toBe(true);
  });

  it("ignores a user rule for a table that does not exist", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.rules.push({ kind: "check", table: "ghosts", expr: "a > 0" });
    });
    expect(merged().plan.rules.some((r) => r.table === "ghosts")).toBe(false);
  });

  it("ignores edits for tables and columns that no longer exist", () => {
    writeRulesFile(path, fresh(), schema);
    edit((d) => {
      d.tables.old_table = { rows: 5, columns: { x: { meaning: "email" } } };
      d.tables.customers.columns.gone = { meaning: "email" };
    });
    const { plan, notes } = merged();
    expect(notes).toEqual([]);
    expect(plan.rows).toEqual({});
    expect(plan.columns.some((c) => c.column === "gone")).toBe(false);
  });

  it("drops stale rules that point at columns no longer in the schema", () => {
    const smaller: SchemaModel = { ...schema, tables: parseDDL("CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(100) NOT NULL);") };
    const plan = infer(schema);
    plan.rules.push({ id: "order:customers.x<=y", kind: "order", table: "customers", earlier: "x", later: "y", strict: false, expr: "", evidence: "", source: "inferred", enabled: true });
    const out = mergeRules(plan, smaller, {}).plan;
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.rules.every((x) => x.table === "customers")).toBe(true);
    expect(out.rules.some((x) => x.id === "order:customers.x<=y")).toBe(false);
    expect(out.rules.some((x) => x.id === "fk:orders.customer_id")).toBe(false);
  });

  it("returns the plan untouched with no file", () => {
    const p = fresh();
    const { plan, notes } = mergeRules(p, schema, null);
    expect(plan).toBe(p);
    expect(notes).toEqual([]);
  });

  it("throws a clear error on invalid YAML", () => {
    writeFileSync(path, "tables: [unclosed\n  - : :\n", "utf8");
    expect(() => readRulesFile(path)).toThrow(/not valid YAML/);
  });

  it("treats a non-object YAML document as no file", () => {
    writeFileSync(path, "just a string\n", "utf8");
    expect(readRulesFile(path)).toBeNull();
  });
});
