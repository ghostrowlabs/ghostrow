// Usage: node checksums.mjs <dir>
// Writes <dir>/SHA256SUMS in the format `sha256sum` writes: "<hex>  <filename>", sorted, LF endings.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node checksums.mjs <dir>");
  process.exit(2);
}
const abs = resolve(dir);
const names = readdirSync(abs)
  .filter((n) => n !== "SHA256SUMS" && statSync(join(abs, n)).isFile())
  .sort();
if (names.length === 0) throw new Error(`no files in ${abs}`);
const lines = names.map((n) => `${createHash("sha256").update(readFileSync(join(abs, n))).digest("hex")}  ${n}`);
writeFileSync(join(abs, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(`wrote SHA256SUMS (${names.length} files)`);
