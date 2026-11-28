/**
 * Assemble a model release: the ONNX model (and its external weights file, if any), tokenizer,
 * model.json, ONNX Runtime's native library for each platform the CLI ships on, and a signed
 * manifest (GRM1) listing them all. Used for gr-col-1 (column meanings) and gr-rules-1 (rules).
 *
 *   npx tsx training/tools/release.ts [artifacts=training/artifacts/gr-col-1] [version=1.0.0]
 *     → training/release/<name>/   (upload every file there as assets of the GitHub release model-<name>)
 *
 * Signs with the Ed25519 key in $GHOSTROW_MODEL_SIGNING_KEY (default ~/.ghostrow-signing/model-signing.pem).
 * The matching public key is MODEL_KEYS in src/model/manifest.ts.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { MANIFEST_PREFIX, MODEL_KEYS, verifyManifest, type Manifest } from "../../src/model/manifest.js";

const cli = join(import.meta.dirname, "..", "..");
const artifacts = process.argv[2] ?? join(cli, "training", "artifacts", "gr-col-1");
const version = process.argv[3] ?? "1.0.0";
const info = JSON.parse(readFileSync(join(artifacts, "model.json"), "utf8"));
const out = join(cli, "training", "release", info.name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ort = join(cli, "node_modules", "onnxruntime-node", "bin", "napi-v6");
const RUNTIME: Record<string, string[]> = {
  "win32-x64": ["win32/x64/onnxruntime_binding.node", "win32/x64/onnxruntime.dll"],
  "win32-arm64": ["win32/arm64/onnxruntime_binding.node", "win32/arm64/onnxruntime.dll"],
  "linux-x64": ["linux/x64/onnxruntime_binding.node", "linux/x64/libonnxruntime.so.1"],
  "linux-arm64": ["linux/arm64/onnxruntime_binding.node", "linux/arm64/libonnxruntime.so.1"],
  "darwin-arm64": ["darwin/arm64/onnxruntime_binding.node", "darwin/arm64/libonnxruntime.1.dylib"],
};

const files: Manifest["files"] = [];
const add = (src: string, name: string, role: Manifest["files"][number]["role"], extra: { platform?: string; install_as?: string } = {}) => {
  copyFileSync(src, join(out, name));
  const h = createHash("sha256");
  const fd = openSync(src, "r");
  const chunk = Buffer.alloc(1 << 24);
  for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0; ) h.update(chunk.subarray(0, n));
  closeSync(fd);
  files.push({ name, role, ...extra, size: statSync(src).size, sha256: h.digest("hex") });
};
add(join(artifacts, "model.onnx"), "model.onnx", "model");
if (existsSync(join(artifacts, "model.onnx.data"))) add(join(artifacts, "model.onnx.data"), "model.onnx.data", "weights");
add(join(artifacts, "tokenizer.json"), "tokenizer.json", "tokenizer");
add(join(artifacts, "model.json"), "model.json", "info");
for (const [platform, paths] of Object.entries(RUNTIME)) {
  for (const p of paths) add(join(ort, p), `ort-${platform}-${basename(p)}`, "runtime", { platform, install_as: basename(p) });
}

const kid = Object.keys(MODEL_KEYS)[0]!;
const task: Manifest["task"] = info.task ?? "column-meaning";
const manifest: Manifest = { v: 1, kid, name: info.name, version, task, feature_version: info.feature_version ?? info.format_version, released_at: new Date().toISOString(), files };
const key = createPrivateKey(readFileSync(process.env.GHOSTROW_MODEL_SIGNING_KEY ?? join(homedir(), ".ghostrow-signing", "model-signing.pem")));
const payload = Buffer.from(JSON.stringify(manifest)).toString("base64url");
const token = `${MANIFEST_PREFIX}.${payload}.${sign(null, Buffer.from(`${MANIFEST_PREFIX}.${payload}`), key).toString("base64url")}`;
if (!verifyManifest(token).ok) throw new Error("the signing key doesn't match MODEL_KEYS in src/model/manifest.ts");
writeFileSync(join(out, "manifest.grm"), `${token}\n`);
for (const f of files) console.log(`${f.name.padEnd(42)} ${(f.size / 1e6).toFixed(1).padStart(7)} MB  ${f.sha256.slice(0, 16)}`);
console.log(`signed manifest (${kid}) → ${out}`);
