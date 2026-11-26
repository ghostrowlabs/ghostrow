// Bundles the CLI to dist/bin/ghostrow.js (ESM). npm dependencies stay external and install normally.
//
// Built in at bundle time:
//   version        from package.json
//   release date   GHOSTROW_RELEASE_DATE (YYYY-MM-DD), default today (UTC)
//   public keys    LICENSE_PUBLIC_KEYS (JSON kid → SPKI base64). Required for a release build.
//   API URL        GHOSTROW_BUILD_API_URL, default https://ghostrow.com
//
//   node esbuild.config.mjs            release build (needs LICENSE_PUBLIC_KEYS)
//   node esbuild.config.mjs --local    local build: keys from ../.env.local, API http://localhost:3100
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { ortPlugin } from "./scripts/ort-plugin.mjs";

const local = process.argv.includes("--local");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

if (local && existsSync(new URL("../.env.local", import.meta.url))) process.loadEnvFile(new URL("../.env.local", import.meta.url));
const keys = process.env.LICENSE_PUBLIC_KEYS;
if (!keys) {
  console.error("LICENSE_PUBLIC_KEYS is required: the CLI verifies license keys with the public keys built into it.");
  process.exit(1);
}
JSON.parse(keys);
const releaseDate = process.env.GHOSTROW_RELEASE_DATE ?? new Date().toISOString().slice(0, 10);
const apiUrl = process.env.GHOSTROW_BUILD_API_URL ?? (local ? "http://localhost:3100" : "https://ghostrow.com");

const result = await build({
  entryPoints: ["src/bin/ghostrow.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  outbase: "src",
  // npm dependencies stay external; onnxruntime-node (a dev dependency) is bundled without its native library.
  external: Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]),
  plugins: [ortPlugin],
  // onnxruntime-node is CommonJS and requires Node built-ins; give the ESM bundle a real `require`.
  banner: { js: 'import { createRequire as __ghostrowCreateRequire } from "node:module"; const require = __ghostrowCreateRequire(import.meta.url);' },
  sourcemap: false,
  legalComments: "none",
  define: {
    __GHOSTROW_VERSION__: JSON.stringify(pkg.version),
    __GHOSTROW_RELEASE_DATE__: JSON.stringify(releaseDate),
    __GHOSTROW_PUBLIC_KEYS__: JSON.stringify(keys),
    __GHOSTROW_API_URL__: JSON.stringify(apiUrl),
    __GHOSTROW_BUNDLED__: "true",
  },
  logLevel: "warning",
});

if (result.errors.length > 0) process.exit(1);
console.log(`built dist/bin/ghostrow.js ${pkg.version} (${releaseDate}, ${apiUrl}${local ? ", local keys" : ""})`);
