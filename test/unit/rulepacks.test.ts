import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { infer } from "../../src/engine/infer.js";
import { extendsOf, loadPacks, packLabel } from "../../src/engine/rulepacks.js";
import { mergeRules, readRulesFile, writeRulesFile } from "../../src/engine/rulesfile.js";
import { generateSeed } from "../../src/gen/seed.js";
import { validate } from "../../src/gen/validate.js";
import { freeEntitlements, paidEntitlements } from "../../src/entitlements.js";

const schema: SchemaModel = {
  dialect: "postgres",
  source: "t.sql",
  tables: parseDDL(`
    CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(100) NOT NULL, ref1 VARCHAR(30));
    CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id), total NUMERIC(10,2) NOT NULL, channel VARCHAR(10));
  `),
};

let dir: string;
let path: string;
const root = mkdtempSync(join(tmpdir(), "ghostrow-packs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  dir = mkdtempSync(join(root, "case-"));
  mkdirSync(join(dir, "packs"));
  path = join(dir, "ghostrow.rules.yaml");
});

const write = (rel: string, text: string) => writeFileSync(join(dir, rel), text, "utf8");
async function run() {
  const file = readRulesFile(path);
  const packs = (await loadPacks(file, path)).map((pack) => ({ pack, label: packLabel(pack.ref, path) }));
  const merged = mergeRules(infer(schema), schema, file, packs);
  writeRulesFile(path, merged.plan, schema);
  return merged;
}

const SHOP_PACK = `
tables:
  customers:
    columns:
      ref1: { meaning: sku }
  orders:
    rows: 40
    columns:
      channel: { values: [web, store] }
  invoices:
    columns:
      number: { meaning: sku }
rules:
  - { id: team:min-total, kind: check, table: orders, expr: "total >= 5" }
  - { id: team:invoices, kind: check, table: invoices, expr: "amount > 0" }
`;

describe("rule packs", () => {
  it("applies a pack named in extends: meanings, values, row counts and rules", async () => {
    write("packs/shop.yaml", SHOP_PACK);
    write("ghostrow.rules.yaml", "extends: packs/shop.yaml\n");
    const { plan, notes } = await run();
    expect(notes).toEqual([]);
    expect(plan.columns.find((c) => c.table === "customers" && c.column === "ref1")).toMatchObject({ meaning: "sku", pinned: true, evidence: "rule pack packs/shop.yaml" });
    expect(plan.columns.find((c) => c.table === "orders" && c.column === "channel")?.values).toEqual(["web", "store"]);
    expect(plan.rows.orders).toBe(40);
    expect(plan.rules.find((r) => r.id === "team:min-total")).toMatchObject({ source: "rule pack", enabled: true });
    // The pack's table that this schema doesn't have is ignored without a note.
    expect(plan.rules.some((r) => r.id === "team:invoices")).toBe(false);

    const out = generateSeed({ schema, plan, seed: 3 });
    const orders = out.find((o) => o.table.name === "orders")!.rows;
    expect(orders).toHaveLength(40);
    for (const row of orders) {
      expect(Number(row.total)).toBeGreaterThanOrEqual(5);
      if (row.channel !== null) expect(["web", "store"]).toContain(row.channel);
    }
    expect(validate(out, plan).violations).toEqual([]);
  });

  it("keeps extends in the rewritten file, marks what came from the pack, and doesn't copy pack row counts", async () => {
    write("packs/shop.yaml", SHOP_PACK);
    write("ghostrow.rules.yaml", "extends: [packs/shop.yaml]\n");
    await run();
    const doc = parse(readFileSync(path, "utf8"));
    expect(doc.extends).toEqual(["packs/shop.yaml"]);
    expect(doc.tables.customers.columns.ref1.evidence).toBe("rule pack packs/shop.yaml");
    expect(doc.tables.orders.rows).toBeUndefined();
    expect(doc.rules.find((r: { id: string }) => r.id === "team:min-total")).toMatchObject({ source: "rule pack", expr: "total >= 5" });
  });

  it("refreshes from the pack on the next run when the pack changes", async () => {
    write("packs/shop.yaml", SHOP_PACK);
    write("ghostrow.rules.yaml", "extends: packs/shop.yaml\n");
    await run();
    write("packs/shop.yaml", SHOP_PACK.replace("meaning: sku", "meaning: token").replace("rows: 40", "rows: 7").replace('"total >= 5"', '"total >= 9"'));
    const { plan } = await run();
    expect(plan.columns.find((c) => c.table === "customers" && c.column === "ref1")?.meaning).toBe("token");
    expect(plan.rows.orders).toBe(7);
    expect(plan.rules.filter((r) => r.id === "team:min-total")).toHaveLength(1);
    expect(plan.rules.find((r) => r.id === "team:min-total")).toMatchObject({ check: "total >= 9" });
  });

  it("drops a pack rule from your file once the pack no longer has it", async () => {
    write("packs/shop.yaml", SHOP_PACK);
    write("ghostrow.rules.yaml", "extends: packs/shop.yaml\n");
    await run();
    write("packs/shop.yaml", SHOP_PACK.replace(/ {2}- \{ id: team:min-total.*\n/, ""));
    const { plan } = await run();
    expect(plan.rules.some((r) => r.id === "team:min-total")).toBe(false);
  });

  it("lets your own file win: an edited meaning, your row count, and switching a pack rule off", async () => {
    write("packs/shop.yaml", SHOP_PACK);
    write("ghostrow.rules.yaml", "extends: packs/shop.yaml\n");
    await run();
    const text = readFileSync(path, "utf8")
      .replace(/ref1:\n(\s+)meaning: sku\n(\s+)confidence: 1\n(\s+)evidence: rule pack packs\/shop\.yaml\n/, "ref1:\n$1meaning: token\n")
      .replace("orders:\n", "orders:\n    rows: 12\n")
      .replace(/(id: team:min-total\n[\s\S]*?enabled:) true/, "$1 false");
    writeFileSync(path, text, "utf8");
    const { plan } = await run();
    expect(plan.columns.find((c) => c.table === "customers" && c.column === "ref1")).toMatchObject({ meaning: "token", evidence: "set in rules file" });
    expect(plan.rows.orders).toBe(12);
    expect(plan.rules.find((r) => r.id === "team:min-total")?.enabled).toBe(false);
    expect(parse(readFileSync(path, "utf8")).tables.orders.rows).toBe(12);
  });

  it("applies packs in order, each after the packs it extends; later packs win", async () => {
    write("packs/base.yaml", "tables:\n  customers:\n    columns:\n      ref1: { meaning: sku }\n");
    write("packs/team.yaml", "extends: base.yaml\ntables:\n  customers:\n    columns:\n      ref1: { meaning: token }\n");
    write("ghostrow.rules.yaml", "extends: packs/team.yaml\n");
    const file = readRulesFile(path);
    const packs = await loadPacks(file, path);
    expect(packs.map((p) => packLabel(p.ref, path))).toEqual(["packs/base.yaml", "packs/team.yaml"]);
    const { plan } = await run();
    expect(plan.columns.find((c) => c.table === "customers" && c.column === "ref1")?.meaning).toBe("token");
  });

  it("stops on a missing pack, a loop, plain http or a bad extends value", async () => {
    write("ghostrow.rules.yaml", "extends: packs/nope.yaml\n");
    await expect(loadPacks(readRulesFile(path), path)).rejects.toThrow(/does not exist/);
    write("packs/a.yaml", "extends: b.yaml\n");
    write("packs/b.yaml", "extends: a.yaml\n");
    write("ghostrow.rules.yaml", "extends: packs/a.yaml\n");
    await expect(loadPacks(readRulesFile(path), path)).rejects.toThrow(/extends itself/);
    write("ghostrow.rules.yaml", "extends: http://example.com/pack.yaml\n");
    await expect(loadPacks(readRulesFile(path), path)).rejects.toThrow(/only https/);
    expect(() => extendsOf({ extends: [42] })).toThrow(/must be a path or an https URL/);
  });

  it("is a Max feature", () => {
    expect(freeEntitlements().rulePacks).toBe(false);
    const base = { modes: ["seed" as const], code_aware: true, byok: true, ci: false };
    expect(paidEntitlements({ plan: "pro", ...base }, "license").rulePacks).toBe(false);
    expect(paidEntitlements({ plan: "max", ...base }, "license").rulePacks).toBe(true);
  });
});
