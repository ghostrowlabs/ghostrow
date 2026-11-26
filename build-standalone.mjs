// Standalone executable for the current OS/arch: one file with Node built in (Node "single
// executable application"). Run on each OS in CI (.github/workflows/release.yml).
//
//   node build-standalone.mjs [--local]   → dist/standalone/ghostrow(.exe)
//
// Needs LICENSE_PUBLIC_KEYS like the npm build (or --local for the dev keys).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";

const local = process.argv.includes("--local");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
if (local && existsSync(new URL("../.env.local", import.meta.url))) process.loadEnvFile(new URL("../.env.local", import.meta.url));
const keys = process.env.LICENSE_PUBLIC_KEYS;
if (!keys) throw new Error("LICENSE_PUBLIC_KEYS is required.");
const out = join("dist", "standalone");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. One CommonJS file with every dependency inside.
await build({
  entryPoints: ["src/bin/ghostrow.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: join(out, "ghostrow.cjs"),
  external: ["pg-native", "cloudflare:sockets"],
  legalComments: "none",
  define: {
    __GHOSTROW_VERSION__: JSON.stringify(pkg.version),
    __GHOSTROW_RELEASE_DATE__: JSON.stringify(process.env.GHOSTROW_RELEASE_DATE ?? new Date().toISOString().slice(0, 10)),
    __GHOSTROW_PUBLIC_KEYS__: JSON.stringify(keys),
    __GHOSTROW_API_URL__: JSON.stringify(process.env.GHOSTROW_BUILD_API_URL ?? (local ? "http://localhost:3100" : "https://ghostrow.com")),
    "import.meta.url": "__importMetaUrl",
  },
  inject: [join("scripts", "import-meta-url.js")],
  logLevel: "warning",
});

// 2. The SEA blob, with the SQLite wasm as an asset.
const wasm = require.resolve("sql.js/dist/sql-wasm.wasm");
writeFileSync(
  join(out, "sea-config.json"),
  JSON.stringify({ main: join(out, "ghostrow.cjs"), output: join(out, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets: { "sql-wasm.wasm": wasm } }),
);
execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });

// 3. Copy this Node binary and inject the blob.
const exe = join(out, process.platform === "win32" ? "ghostrow.exe" : "ghostrow");
copyFileSync(process.execPath, exe);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe]);
const postject = join("node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
const args = [exe, "NODE_SEA_BLOB", join(out, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
execFileSync(postject, args, { stdio: "inherit", shell: process.platform === "win32" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe]);
for (const f of ["sea-prep.blob", "sea-config.json"]) rmSync(join(out, f));
console.log(`built ${exe}`);
