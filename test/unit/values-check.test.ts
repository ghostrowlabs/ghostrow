import { describe, expect, it } from "vitest";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { allowedValues } from "../../src/engine/domains.js";
import { infer } from "../../src/engine/infer.js";
import { mergeRules } from "../../src/engine/rulesfile.js";
import { generateSeed } from "../../src/gen/seed.js";
import { validate } from "../../src/gen/validate.js";

const schema: SchemaModel = {
  dialect: "postgres",
  source: "t.sql",
  tables: parseDDL(`CREATE TABLE tickets (id SERIAL PRIMARY KEY, status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'pending', 'closed', 'spam')));`),
};
const col = schema.tables[0]!.columns.find((c) => c.name === "status")!;

const withValues = (values: string[]) =>
  mergeRules(infer(schema), schema, { tables: { tickets: { columns: { status: { meaning: "status", values } } } } });

describe("values: in the rules file against CHECK (... IN (...))", () => {
  it("allowedValues: your values win, narrowed to the CHECK list", () => {
    expect(allowedValues(col, { values: ["open", "pending", "closed", "spam"] }, ["open", "closed"])).toEqual(["open", "closed"]);
    expect(allowedValues(col, { values: ["open", "pending", "closed", "spam"] }, ["open", "bogus"])).toEqual(["open"]);
    expect(allowedValues(col, { values: ["open", "closed"] }, ["bogus"])).toEqual(["open", "closed"]);
    expect(allowedValues(col, { values: ["open", "closed"] }, undefined)).toEqual(["open", "closed"]);
    expect(allowedValues(col, { notValues: ["spam"] }, ["open", "spam"])).toEqual(["open"]);
  });

  it("generates only your values when the CHECK allows them", () => {
    const { plan, notes } = withValues(["open", "closed"]);
    expect(notes).toEqual([]);
    const out = generateSeed({ schema, plan, seed: 1, rows: 300 });
    const seen = new Set(out[0]!.rows.map((r) => r.status));
    expect([...seen].sort()).toEqual(["closed", "open"]);
    expect(validate(out, plan).violations).toEqual([]);
  });

  it("leaves out values the CHECK forbids, with a note, and rows stay valid", () => {
    const { plan, notes } = withValues(["open", "archived"]);
    expect(notes.some((n) => n.includes("tickets.status") && n.includes("archived"))).toBe(true);
    const out = generateSeed({ schema, plan, seed: 2, rows: 200 });
    expect(new Set(out[0]!.rows.map((r) => r.status))).toEqual(new Set(["open"]));
    expect(validate(out, plan).violations).toEqual([]);
  });

  it("falls back to the CHECK list when none of your values pass, with a note", () => {
    const { plan, notes } = withValues(["archived"]);
    expect(notes.some((n) => n.includes("none of your values"))).toBe(true);
    const out = generateSeed({ schema, plan, seed: 3, rows: 200 });
    for (const r of out[0]!.rows) expect(["open", "pending", "closed", "spam"]).toContain(r.status);
  });
});
