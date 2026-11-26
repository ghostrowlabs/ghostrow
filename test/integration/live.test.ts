import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testAuthority } from "../helpers/license.js";

/**
 * Live databases, end to end through the CLI entry point: Postgres (PGlite, real Postgres
 * compiled to WebAssembly, behind a local socket) and SQLite files.
 */

const authority = testAuthority();
const home = mkdtempSync(join(tmpdir(), "gr-live-"));
process.env.GHOSTROW_PUBLIC_KEYS = authority.publicKeys;
process.env.GHOSTROW_HOME = home;
process.env.GHOSTROW_MACHINE_ID = "live-test-machine";
process.env.GHOSTROW_API_URL = "http://127.0.0.1:9";

const { run } = await import("../../src/cli/program.js");
const { writeState } = await import("../../src/license/store.js");
const { machineFingerprint } = await import("../../src/license/fingerprint.js");
const { loadSqlJs } = await import("../../src/connect/sqlite.js");

const SHOP = readFileSync(join(import.meta.dirname, "..", "fixtures", "shop.sql"), "utf8");
const work = mkdtempSync(join(tmpdir(), "gr-live-work-"));

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  try {
    const { code } = await run(["node", "ghostrow", ...args]);
    return { code, out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

function activate(plan: "plus" | "pro" | "max") {
  const lic = authority.license(plan);
  const lid = JSON.parse(Buffer.from(lic.split(".")[1]!, "base64url").toString()).lid as string;
  writeState({ license: lic, activation: authority.activation(lid, machineFingerprint(), plan), machineId: "m", machineLabel: "test", activatedAt: new Date().toISOString(), lastCheck: new Date().toISOString() });
}

describe("Postgres (PGlite)", () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let url: string;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(SHOP);
    const port = 54_000 + Math.floor(Math.random() * 900);
    server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
    await server.start();
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    activate("max");
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await db?.close();
  });

  const count = async (t: string) => Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n);

  it("reads the live schema in a dry run", async () => {
    const r = await cli("seed", "--db", url, "--dry-run", "--json", "--rules", join(work, "pg.rules.yaml"));
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.tables).toBe(6);
    expect(j.columns.find((c: { table: string; column: string }) => c.table === "customers" && c.column === "nic").meaning).toBe("national_id_lk");
    expect(j.rules.some((x: { kind: string }) => x.kind === "sum")).toBe(true);
  });

  it("inserts consistent rows in one transaction, twice, without collisions", async () => {
    for (const seed of ["1", "2"]) {
      const r = await cli("seed", "--db", url, "--rows", "1500", "--seed", seed, "-q", "--rules", join(work, "pg.rules.yaml"));
      expect(r.code, r.err).toBe(0);
    }
    expect(await count("order_lines")).toBe(3000);
    const orphans = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM order_lines l LEFT JOIN orders o ON o.id = l.order_id WHERE o.id IS NULL");
    expect(orphans.rows[0]!.n).toBe(0);
    const totals = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders o WHERE o.total <> (SELECT coalesce(sum(amount), 0) FROM order_lines l WHERE l.order_id = o.id)");
    expect(totals.rows[0]!.n).toBe(0);
    const dupes = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM (SELECT tenant_id, email FROM customers GROUP BY 1, 2 HAVING count(*) > 1) d");
    expect(dupes.rows[0]!.n).toBe(0);
    // Sequences moved past the explicit ids, so the application can still insert.
    await db.query("INSERT INTO tenants (name, country_code) VALUES ('After Ghostrow', 'LK')");
  }, 120_000);

  it("haunt inserts edge cases, runs the tests, reports, and cleans up", async () => {
    const before = await count("customers");
    const script = join(work, "names.test.mjs");
    writeFileSync(
      script,
      `import pg from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("pg")).href)};
const c = new pg.Client({ connectionString: process.env.TEST_DB });
await c.connect();
const r = await c.query("SELECT first_name FROM customers");
await c.end();
const bad = r.rows.some((x) => /[^\\x00-\\xff]/.test(x.first_name));
console.log(bad ? "FAIL test/names.spec.ts > prints customer names" : "ok");
process.exit(bad ? 1 : 0);`,
    );
    process.env.TEST_DB = url;
    const report = join(work, "haunt-report.json");
    const r = await cli("haunt", "--db", url, "--tests", `node "${script}"`, "--cases", "60", "--report", report, "-q");
    expect(r.code, r.err).toBe(3);
    const j = JSON.parse(readFileSync(report, "utf8"));
    expect(j.failures[0].test).toBe("test/names.spec.ts > prints customer names");
    expect(j.failures[0].columns).toContain("customers.first_name");
    expect(await count("customers")).toBe(before);
  }, 300_000);

  it("twin measures Postgres and writes a synthetic copy that copies no row", async () => {
    // Sentinel values no generator produces: if any reaches the copy, a row was copied.
    await db.query("INSERT INTO customers (tenant_id, first_name, last_name, email, nic, status, created_at) VALUES (1, 'Sentinelfirst', 'Sentinellast', 'sentinel.person@source.invalid', '199912345678', 'active', '2020-01-01 00:00:00')");
    const out = join(work, "twin-pg");
    const r = await cli("twin", "--from", url, "--out", out, "--scale", "0.5", "--seed", "4", "-q");
    expect(r.code, r.err).toBe(0);
    const twin = readFileSync(join(out, "customers.csv"), "utf8");
    expect(twin.split("\n").length).toBeGreaterThan(10);
    expect(twin).not.toMatch(/Sentinel|source\.invalid|199912345678/);
    expect(existsSync(join(out, "twin-report.json"))).toBe(true);
  }, 120_000);
});

describe("SQLite files", () => {
  async function makeDb(path: string) {
    const SQL = await loadSqlJs();
    const d = new SQL.Database();
    d.run(SHOP.replace(/SERIAL PRIMARY KEY/gi, "INTEGER PRIMARY KEY"));
    writeFileSync(path, d.export());
    d.close();
  }

  it("seeds a file, then twins it into another file", async () => {
    activate("max");
    const src = join(work, "shop.db");
    const dst = join(work, "twin.db");
    await makeDb(src);
    await makeDb(dst);
    let r = await cli("seed", "--db", src, "--rows", "800", "--seed", "3", "-q", "--rules", join(work, "lite.rules.yaml"));
    expect(r.code, r.err).toBe(0);
    r = await cli("twin", "--from", src, "--to", dst, "--scale", "2", "-q", "--rules", join(work, "lite.rules.yaml"));
    expect(r.code, r.err).toBe(0);
    const SQL = await loadSqlJs();
    const d = new SQL.Database(readFileSync(dst));
    const n = Number(d.exec("SELECT count(*) FROM order_lines")[0]!.values[0]![0]);
    const orphans = Number(d.exec("SELECT count(*) FROM order_lines l LEFT JOIN orders o ON o.id = l.order_id WHERE o.id IS NULL")[0]!.values[0]![0]);
    d.close();
    expect(n).toBe(1600);
    expect(orphans).toBe(0);
  }, 120_000);

  it("Free refuses MySQL and twin with exit 4", async () => {
    writeFileSync(join(home, "license.json"), "{}");
    expect((await cli("seed", "--db", "mysql://u:p@127.0.0.1:3306/shop", "--out", work)).code).toBe(4);
    expect((await cli("twin", "--from", join(work, "shop.db"), "--out", join(work, "x"))).code).toBe(4);
  });
});
