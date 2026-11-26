import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchema } from "../../src/connect/load.js";
import { ENGINE_VERSION, infer } from "../../src/engine/infer.js";
import { exportRows } from "../../src/export/format.js";
import { generateSeed } from "../../src/gen/seed.js";

/**
 * Golden output: the shop schema with --seed 42 must produce these exact bytes on every
 * machine. If a change is intentional, bump ENGINE_VERSION and update the hashes.
 */
const GOLDEN: Record<string, Record<string, string>> = {
  "1.0": {
    csv: "c21c6a9959e15de9e3aa79c78bdb413533b96c97ebc1b1e79e1f1afd432277b1",
    sql: "e8955e8dd6ae95226e0a185858a8ee1cad4d16b2a2a4e8013548fe417022cab4",
    json: "fc08440d76ea4f977d71d9aa5da1a937c43f95b0a1b7ee553235a1d18d546065",
  },
};

function digest(format: "csv" | "sql" | "json"): string {
  const schema = loadSchema(join(import.meta.dirname, "..", "fixtures", "shop.sql"));
  const out = generateSeed({ schema, plan: infer(schema), seed: 42, rows: 500 });
  const dir = mkdtempSync(join(tmpdir(), "gr-golden-"));
  const files = exportRows(out, dir, format, schema.dialect).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(f));
  return h.digest("hex");
}

describe("golden output", () => {
  for (const format of ["csv", "sql", "json"] as const) {
    it(`shop.sql --seed 42 → identical ${format} bytes`, () => {
      expect(digest(format)).toBe(GOLDEN[ENGINE_VERSION]![format]);
    });
  }
});
