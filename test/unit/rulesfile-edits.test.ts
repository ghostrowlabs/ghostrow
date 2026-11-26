import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { infer } from "../../src/engine/infer.js";
import { mergeRules, readRulesFile, writeRulesFile } from "../../src/engine/rulesfile.js";
import { generateSeed } from "../../src/gen/seed.js";
import { validate } from "../../src/gen/validate.js";

const schema: SchemaModel = {
  dialect: "postgres",
  source: "t.sql",
  tables: parseDDL(`
    CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(100) NOT NULL, note VARCHAR(100));
    CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id), total NUMERIC(10,2) NOT NULL);
  `),
};

let dir: string;
let path: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ghostrow-rules-edits-"));
  path = join(dir, "ghostrow.rules.yaml");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const merged = () => mergeRules(infer(schema), schema, readRulesFile(path));
const append = (text: string) => writeFileSync(path, readFileSync(path, "utf8") + text, "utf8");

describe("hand-added rules with a custom id", () => {
  it("keeps and applies a check rule with a custom id and no source, across rewrites", () => {
    writeRulesFile(path, infer(schema), schema);
    append(`  - id: big-orders\n    kind: check\n    table: orders\n    expr: "total >= 100"\n`);
    const { plan, notes } = merged();
    expect(notes).toEqual([]);
    const r = plan.rules.find((x) => x.id === "big-orders");
    expect(r).toMatchObject({ kind: "check", table: "orders", source: "rules file", enabled: true });

    const out = generateSeed({ schema, plan, seed: 4, rows: 200 });
    for (const row of out.find((o) => o.table.name === "orders")!.rows) expect(Number(row.total)).toBeGreaterThanOrEqual(100);
    expect(validate(out, plan).violations).toEqual([]);

    writeRulesFile(path, plan, schema);
    const again = parse(readFileSync(path, "utf8"));
    expect(again.rules.find((x: { id: string }) => x.id === "big-orders")).toMatchObject({ expr: "total >= 100", source: "rules file" });
    expect(merged().plan.rules.some((x) => x.id === "big-orders")).toBe(true);
  });

  it("warns about a hand-added rule it can't use instead of dropping it silently", () => {
    writeRulesFile(path, infer(schema), schema);
    append(`  - id: no-expr\n    kind: check\n    table: orders\n  - id: no-table\n    kind: check\n    table: ghosts\n    expr: "a > 0"\n`);
    const { notes } = merged();
    expect(notes.some((n) => n.includes("no-expr") && n.includes('"expr"'))).toBe(true);
    expect(notes.some((n) => n.includes("no-table") && n.includes("ghosts"))).toBe(true);
  });

  it("still drops a stale inferred rule (source: schema) that no longer applies", () => {
    writeRulesFile(path, infer(schema), schema);
    append(`  - id: check:orders.9\n    kind: check\n    table: orders\n    expr: CHECK (total > 5)\n    source: schema\n`);
    const { plan, notes } = merged();
    expect(plan.rules.some((x) => x.id === "check:orders.9")).toBe(false);
    expect(notes).toEqual([]);
  });
});

describe("comments in the rules file", () => {
  it("keeps your comments on tables, columns and rules when the file is rewritten", () => {
    writeRulesFile(path, infer(schema), schema);
    let text = readFileSync(path, "utf8");
    text = text.replace("\ntables:\n", "\n# Reviewed by the data team\ntables:\n");
    text = text.replace(/(\n {6}note:\n {8}meaning: )(\w+)/, "$1$2 # free text, keep short");
    text = text.replace("\n  customers:\n", "\n  # People who buy\n  customers:\n");
    text += "  # Our own rule\n  - id: user:orders.big\n    kind: check\n    table: orders\n    expr: total >= 1\n";
    writeFileSync(path, text, "utf8");

    const { plan } = merged();
    writeRulesFile(path, plan, schema);
    writeRulesFile(path, merged().plan, schema); // twice: comments must not pile up
    const out = readFileSync(path, "utf8");
    expect(out).toContain("# Reviewed by the data team");
    expect(out).toContain("# free text, keep short");
    expect(out).toContain("# People who buy");
    expect(out).toContain("# Our own rule");
    expect(out.match(/# Our own rule/g)).toHaveLength(1);
    expect(out.match(/# Ghostrow rules/g)).toHaveLength(1);
    expect(out.indexOf("# Our own rule")).toBeLessThan(out.indexOf("id: user:orders.big"));
    expect(parse(out).rules.some((r: { id: string }) => r.id === "user:orders.big")).toBe(true);
  });

  it("keeps a comment you add under the header, and doesn't duplicate a 1.0.0 header", () => {
    const old = [
      "# Ghostrow rules (gr-schema-1). Review and commit this file with your code.",
      "# Change a column's meaning, add \"values\", set \"rows\" per table, switch a rule off with",
      "# \"enabled: false\", or add your own:  - { kind: check, table: orders, expr: \"total >= 0\" }",
      "# Your edits are kept on every run. Same schema + rules + --seed = same rows.",
      "# Owner: payments team",
      "",
    ].join("\n");
    writeRulesFile(path, infer(schema), schema);
    const body = readFileSync(path, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n");
    writeFileSync(path, old + body, "utf8");
    writeRulesFile(path, merged().plan, schema);
    const out = readFileSync(path, "utf8");
    expect(out.match(/# Ghostrow rules/g)).toHaveLength(1);
    expect(out).not.toContain("# Your edits are kept on every run.");
    expect(out.match(/# Owner: payments team/g)).toHaveLength(1);
  });
});
