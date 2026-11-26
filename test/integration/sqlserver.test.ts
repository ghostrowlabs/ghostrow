import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testAuthority } from "../helpers/license.js";

/**
 * A real SQL Server or Azure SQL database: set MSSQL_TEST_URL, e.g.
 * mssql://user:pass@host:1433/db (tables are created and dropped in that database).
 */
const enabled = Boolean(process.env.MSSQL_TEST_URL);
const authority = testAuthority();
process.env.GHOSTROW_PUBLIC_KEYS = authority.publicKeys;
process.env.GHOSTROW_HOME = mkdtempSync(join(tmpdir(), "gr-mssql-"));
process.env.GHOSTROW_MACHINE_ID = "mssql-test-machine";

const work = mkdtempSync(join(tmpdir(), "gr-mssql-work-"));

describe.runIf(enabled)("SQL Server (live server)", () => {
  let stop: () => Promise<void>;
  let url: string;
  let pool: import("mssql").ConnectionPool;
  let run: typeof import("../../src/cli/program.js").run;

  async function cli(...args: string[]) {
    let err = "";
    const o = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
    try {
      return { ...(await run(["node", "ghostrow", ...args])), err };
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  }
  const one = async (sql: string) => Number((await pool.request().query(sql)).recordset[0].n);

  beforeAll(async () => {
    url = process.env.MSSQL_TEST_URL!;
    const u = new URL(url);
    const sql = ((await import("mssql")) as unknown as { default: typeof import("mssql") }).default;
    pool = await new sql.ConnectionPool({ server: u.hostname, port: Number(u.port || 1433), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), options: { encrypt: true, trustServerCertificate: /localhost|127\.0\.0\.1/.test(u.hostname) } }).connect();
    const drop = "DROP TABLE IF EXISTS order_lines; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS tenants;";
    await pool.request().batch(drop);
    await pool.request().batch(readFileSync(join(import.meta.dirname, "..", "fixtures", "shop.mssql.sql"), "utf8"));
    stop = async () => {
      await pool.request().batch(drop);
    };
    ({ run } = await import("../../src/cli/program.js"));
    const { writeState } = await import("../../src/license/store.js");
    const { machineFingerprint } = await import("../../src/license/fingerprint.js");
    const lic = authority.license("max");
    const lid = JSON.parse(Buffer.from(lic.split(".")[1]!, "base64url").toString()).lid as string;
    writeState({ license: lic, activation: authority.activation(lid, machineFingerprint(), "max"), machineId: "m", machineLabel: "t", activatedAt: new Date().toISOString(), lastCheck: new Date().toISOString() });
  }, 600_000);

  afterAll(async () => {
    await stop?.();
    await pool?.close();
  });

  it("reads the schema: enum, tinyint(1) boolean, CHECK and composite UNIQUE", async () => {
    let out = "";
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
    const r = await run(["node", "ghostrow", "seed", "--db", url, "--dry-run", "--json", "--rules", join(work, "ms.rules.yaml")]);
    o.mockRestore();
    expect(r.code).toBe(0);
    const j = JSON.parse(out);
    const col = (t: string, c: string) => j.columns.find((x: { table: string; column: string }) => x.table === t && x.column === c);
    expect(col("customers", "nic").meaning).toBe("national_id_lk");
    expect(col("customers", "is_verified").meaning).toBe("boolean");
    expect(col("customers", "external_id").meaning).toBe("uuid");
    expect(j.rules.some((x: { kind: string; table: string }) => x.kind === "unique" && x.table === "customers")).toBe(true);
    expect(j.rules.some((x: { kind: string }) => x.kind === "sum")).toBe(true);
  });

  it("inserts consistent rows twice in transactions", async () => {
    for (const seed of ["1", "2"]) {
      const r = await cli("seed", "--db", url, "--rows", "1200", "--seed", seed, "-q", "--rules", join(work, "ms.rules.yaml"));
      expect(r.code, r.err).toBe(0);
    }
    expect(await one("SELECT count(*) AS n FROM order_lines")).toBe(2400);
    expect(await one("SELECT count(*) AS n FROM order_lines l LEFT JOIN orders o ON o.id = l.order_id WHERE o.id IS NULL")).toBe(0);
    expect(await one("SELECT count(*) AS n FROM orders o WHERE o.total <> (SELECT coalesce(sum(amount), 0) FROM order_lines l WHERE l.order_id = o.id)")).toBe(0);
    await pool.request().query("INSERT INTO tenants (name, country_code) VALUES (N'After Ghostrow', 'LK')");
  }, 300_000);

  it("twins the database into files", async () => {
    const r = await cli("twin", "--from", url, "--out", join(work, "twin"), "--scale", "0.25", "-q", "--rules", join(work, "ms.rules.yaml"));
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, "twin", "order_lines.csv"), "utf8").split("\n").length).toBeGreaterThan(400);
  }, 300_000);
});
