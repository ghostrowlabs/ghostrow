import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testAuthority } from "../helpers/license.js";

/**
 * A real MySQL 8.4 server (mysql-memory-server downloads and runs it locally; no Docker).
 * Runs when MYSQL_TESTS=1, so ordinary test runs stay fast and offline.
 */
const enabled = process.env.MYSQL_TESTS === "1";
const authority = testAuthority();
process.env.GHOSTROW_PUBLIC_KEYS = authority.publicKeys;
process.env.GHOSTROW_HOME = mkdtempSync(join(tmpdir(), "gr-mysql-"));
process.env.GHOSTROW_MACHINE_ID = "mysql-test-machine";

const work = mkdtempSync(join(tmpdir(), "gr-mysql-work-"));

describe.runIf(enabled)("MySQL 8.4 (live server)", () => {
  let stop: () => Promise<void>;
  let url: string;
  let mysql: typeof import("mysql2/promise");
  let conn: import("mysql2/promise").Connection;
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
  const one = async (sql: string) => Number(((await conn.query(sql))[0] as Record<string, unknown>[])[0]!.n);

  beforeAll(async () => {
    const { createDB } = await import("mysql-memory-server");
    const db = await createDB({ version: "8.4.x", logLevel: "ERROR" });
    stop = () => db.stop();
    url = `mysql://${db.username}@127.0.0.1:${db.port}/${db.dbName}`;
    mysql = await import("mysql2/promise");
    conn = await mysql.createConnection({ host: "127.0.0.1", port: db.port, user: db.username, database: db.dbName, multipleStatements: true });
    await conn.query(readFileSync(join(import.meta.dirname, "..", "fixtures", "shop.mysql.sql"), "utf8"));
    ({ run } = await import("../../src/cli/program.js"));
    const { writeState } = await import("../../src/license/store.js");
    const { machineFingerprint } = await import("../../src/license/fingerprint.js");
    const lic = authority.license("max");
    const lid = JSON.parse(Buffer.from(lic.split(".")[1]!, "base64url").toString()).lid as string;
    writeState({ license: lic, activation: authority.activation(lid, machineFingerprint(), "max"), machineId: "m", machineLabel: "t", activatedAt: new Date().toISOString(), lastCheck: new Date().toISOString() });
  }, 600_000);

  afterAll(async () => {
    await conn?.end();
    await stop?.();
  });

  it("reads the schema: enum, tinyint(1) boolean, CHECK and composite UNIQUE", async () => {
    let out = "";
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
    const r = await run(["node", "ghostrow", "seed", "--db", url, "--dry-run", "--json", "--rules", join(work, "my.rules.yaml")]);
    o.mockRestore();
    expect(r.code).toBe(0);
    const j = JSON.parse(out);
    const col = (t: string, c: string) => j.columns.find((x: { table: string; column: string }) => x.table === t && x.column === c);
    expect(col("customers", "nic").meaning).toBe("national_id_lk");
    expect(col("customers", "is_verified").meaning).toBe("boolean");
    expect(j.rules.some((x: { kind: string; table: string }) => x.kind === "unique" && x.table === "customers")).toBe(true);
    expect(j.rules.some((x: { kind: string }) => x.kind === "sum")).toBe(true);
  });

  it("inserts consistent rows twice in transactions", async () => {
    for (const seed of ["1", "2"]) {
      const r = await cli("seed", "--db", url, "--rows", "1200", "--seed", seed, "-q", "--rules", join(work, "my.rules.yaml"));
      expect(r.code, r.err).toBe(0);
    }
    expect(await one("SELECT count(*) AS n FROM order_lines")).toBe(2400);
    expect(await one("SELECT count(*) AS n FROM order_lines l LEFT JOIN orders o ON o.id = l.order_id WHERE o.id IS NULL")).toBe(0);
    expect(await one("SELECT count(*) AS n FROM orders o WHERE o.total <> (SELECT coalesce(sum(amount), 0) FROM order_lines l WHERE l.order_id = o.id)")).toBe(0);
    expect(await one("SELECT count(*) AS n FROM customers WHERE status NOT IN ('active','pending','closed')")).toBe(0);
    await conn.query("INSERT INTO tenants (name, country_code) VALUES ('After Ghostrow', 'LK')");
  }, 300_000);

  it("twins the database into files", async () => {
    const r = await cli("twin", "--from", url, "--out", join(work, "twin"), "--scale", "0.25", "-q", "--rules", join(work, "my.rules.yaml"));
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(work, "twin", "order_lines.csv"), "utf8").split("\n").length).toBeGreaterThan(400);
  }, 300_000);
});
