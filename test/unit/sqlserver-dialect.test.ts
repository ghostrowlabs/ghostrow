import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchema } from "../../src/connect/load.js";
import { infer } from "../../src/engine/infer.js";
import { sqlScript } from "../../src/export/format.js";
import { generateSeed } from "../../src/gen/seed.js";
import { validate } from "../../src/gen/validate.js";

/** SQL Server DDL in, SQL Server script out (the live test needs MSSQL_TEST_URL). */
describe("SQL Server dialect", () => {
  const schema = loadSchema(join(import.meta.dirname, "..", "fixtures", "shop.mssql.sql"));

  it("reads IDENTITY, NVARCHAR, BIT, UNIQUEIDENTIFIER, CHECK and composite UNIQUE", () => {
    expect(schema.dialect).toBe("sqlserver");
    const customers = schema.tables.find((t) => t.name === "customers")!;
    const col = (n: string) => customers.columns.find((c) => c.name === n)!;
    expect(col("id").autoIncrement).toBe(true);
    expect(col("first_name").maxLength).toBe(60);
    expect(col("is_verified").type).toBe("boolean");
    expect(col("external_id").type).toBe("uuid");
    expect(customers.uniques).toContainEqual(["tenant_id", "email"]);
    expect(customers.checks.some((c) => /LEN\(nic\)/i.test(c))).toBe(true);
  });

  it("generates valid rows and a T-SQL script with IDENTITY_INSERT and bit literals", () => {
    const plan = infer(schema);
    const out = generateSeed({ schema, plan, seed: 5, rows: 300 });
    expect(validate(out, plan).violations).toEqual([]);
    const script = sqlScript(out, "sqlserver");
    expect(script).toMatch(/^BEGIN TRANSACTION;/m);
    expect(script).toContain("SET IDENTITY_INSERT [customers] ON;");
    expect(script).toMatch(/INSERT INTO \[customers\] \(\[id\], \[tenant_id\]/);
    expect(script).not.toMatch(/\bTRUE\b|\bFALSE\b/);
    expect(script).toMatch(/^COMMIT;/m);
  });
});
