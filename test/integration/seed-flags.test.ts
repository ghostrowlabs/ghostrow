import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "gr-flags-"));
process.env.GHOSTROW_HOME = home;
process.env.GHOSTROW_API_URL = "http://127.0.0.1:9";

const { run } = await import("../../src/cli/program.js");
const { loadSqlJs } = await import("../../src/connect/sqlite.js");

const SMALL = "CREATE TABLE customers (id INTEGER PRIMARY KEY, email VARCHAR(100) NOT NULL);";
const work = mkdtempSync(join(tmpdir(), "gr-flags-work-"));

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

async function makeDb(path: string) {
  const SQL = await loadSqlJs();
  const d = new SQL.Database();
  d.run(SMALL);
  writeFileSync(path, d.export());
  d.close();
}
async function count(path: string) {
  const SQL = await loadSqlJs();
  const d = new SQL.Database(readFileSync(path));
  const n = Number(d.exec("SELECT count(*) FROM customers")[0]!.values[0]![0]);
  d.close();
  return n;
}

describe("seed flags", () => {
  it("--db with --out writes files and leaves the database untouched", async () => {
    const db = join(work, "a.db");
    const outDir = join(work, "out");
    await makeDb(db);
    const r = await cli("seed", "--db", db, "--out", outDir, "--rows", "20", "-q", "--rules", join(work, "a.rules.yaml"));
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(outDir, "customers.csv"))).toBe(true);
    expect(await count(db)).toBe(0);
  });

  it("an unknown GHOSTROW_AI_PROVIDER or a missing key warns and continues (Free, --dry-run)", async () => {
    const schema = join(work, "s.sql");
    writeFileSync(schema, SMALL);
    try {
      process.env.GHOSTROW_AI_PROVIDER = "nonsense";
      let r = await cli("seed", "--schema", schema, "--dry-run", "--rules", join(work, "s.rules.yaml"));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("ai provider   skipped");
      process.env.GHOSTROW_AI_PROVIDER = "openai";
      delete process.env.OPENAI_API_KEY;
      r = await cli("seed", "--schema", schema, "--dry-run", "-q", "--rules", join(work, "s.rules.yaml"));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("OPENAI_API_KEY");
    } finally {
      delete process.env.GHOSTROW_AI_PROVIDER;
    }
  });

  it("under --quiet, a rejected GHOSTROW_CI_TOKEN still prints the Free fallback note", async () => {
    const schema = join(work, "s.sql");
    writeFileSync(schema, SMALL);
    try {
      process.env.GHOSTROW_CI_TOKEN = "grci_not_valid";
      const r = await cli("seed", "--schema", schema, "--dry-run", "-q", "--rules", join(work, "s.rules.yaml"));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("GHOSTROW_CI_TOKEN was not accepted");
    } finally {
      delete process.env.GHOSTROW_CI_TOKEN;
    }
  }, 30_000);
});
