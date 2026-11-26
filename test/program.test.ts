import { describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/program.js";

function silence(fn: () => Promise<unknown>): () => void {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  void fn();
  return () => {
    out.mockRestore();
    err.mockRestore();
  };
}

describe("command surface", () => {
  it("prints the version and exits 0", async () => {
    const cleanup = silence(() => run(["node", "ghostrow", "--version"]));
    const { code } = await run(["node", "ghostrow", "--version"]);
    cleanup();
    expect(code).toBe(0);
  });

  it("shows help for every advertised command", async () => {
    const { code } = await run(["node", "ghostrow", "--help"]);
    expect(code).toBe(0);
  });

  it("rejects an unknown format with exit 1", async () => {
    const cleanup = silence(() =>
      run(["node", "ghostrow", "seed", "--schema", "shop.sql", "--format", "xml"]),
    );
    const { code } = await run(["node", "ghostrow", "seed", "--schema", "shop.sql", "--format", "xml"]);
    cleanup();
    expect(code).toBe(1);
  });

  it("rejects seed with no data source (exit 1)", async () => {
    const { code } = await run(["node", "ghostrow", "seed", "--rows", "100"]);
    expect(code).toBe(1);
  });

  it("rejects a malformed --table (exit 1)", async () => {
    const { code } = await run(["node", "ghostrow", "seed", "--schema", "s.sql", "--table", "orders=abc"]);
    expect(code).toBe(1);
  });

  it("rejects seed with a bad --rows (exit 1)", async () => {
    const { code } = await run(["node", "ghostrow", "seed", "--schema", "s.sql", "--rows", "-5"]);
    expect(code).toBe(1);
  });

  it("twin requires --from and a target (exit 1)", async () => {
    expect((await run(["node", "ghostrow", "twin", "--from", "sqlite:prod.db"])).code).toBe(1);
    expect((await run(["node", "ghostrow", "twin"])).code).toBe(1);
  });

  it("rejects a bad --scale (exit 1)", async () => {
    expect((await run(["node", "ghostrow", "twin", "--from", "s.db", "--out", "x/", "--scale", "0"])).code).toBe(1);
  });

  it("haunt is a Pro/Max mode: Free gets exit 4", async () => {
    const { code } = await run(["node", "ghostrow", "haunt", "--schema", "test/fixtures/shop.sql"]);
    expect(code).toBe(4);
  });

  it("license commands: a bad key is a license problem (exit 4); an empty key is invalid input (exit 1)", async () => {
    expect((await run(["node", "ghostrow", "activate", "GR1.not-a-key.sig"])).code).toBe(4);
    expect((await run(["node", "ghostrow", "activate", ""])).code).toBe(1);
  });

  it("reports a milestone-not-ready message for seed (exit 1)", async () => {
    const { code } = await run(["node", "ghostrow", "seed", "--schema", "shop.sql", "--seed", "42"]);
    expect(code).toBe(1);
  });

  it("repeats --table (regression: collector must survive the first call)", async () => {
    // Reaching the engine's not-ready message (not "prev is not iterable") proves the repeat worked.
    const { code } = await run([
      "node",
      "ghostrow",
      "seed",
      "--schema",
      "shop.sql",
      "--table",
      "orders=500",
      "--table",
      "customers=50",
    ]);
    expect(code).toBe(1);
  });
});
