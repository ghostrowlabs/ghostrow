// Usage: node archive.mjs <version> <os: linux|macos|windows> <arch: x64|arm64> <binary> <outdir>
// Writes ghostrow-<version>-<os>-<arch>.tar.gz (linux, macos) or .zip (windows) containing the
// binary (as ghostrow / ghostrow.exe), LICENSE and README.md at the top level.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [version, os, arch, binary, outdir] = process.argv.slice(2);
if (!version || !os || !arch || !binary || !outdir) {
  console.error("usage: node archive.mjs <version> <linux|macos|windows> <x64|arm64> <binary> <outdir>");
  process.exit(2);
}
if (!["linux", "macos", "windows"].includes(os)) throw new Error(`unknown os: ${os}`);
if (!["x64", "arm64"].includes(arch)) throw new Error(`unknown arch: ${arch}`);
if (!existsSync(binary)) throw new Error(`binary not found: ${binary}`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(outdir);
mkdirSync(out, { recursive: true });

const staging = mkdtempSync(join(tmpdir(), "ghostrow-archive-"));
try {
  const exeName = os === "windows" ? "ghostrow.exe" : "ghostrow";
  copyFileSync(binary, join(staging, exeName));
  if (os !== "windows") chmodSync(join(staging, exeName), 0o755);
  copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  copyFileSync(join(root, "README.md"), join(staging, "README.md"));

  if (os === "windows") {
    const dest = join(out, `ghostrow-${version}-windows-${arch}.zip`);
    rmSync(dest, { force: true });
    const ps = "Compress-Archive -Path (Join-Path $env:GR_STAGING '*') -DestinationPath $env:GR_DEST -Force";
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      stdio: "inherit",
      env: { ...process.env, GR_STAGING: staging, GR_DEST: dest },
    });
    console.log(`wrote ${dest}`);
  } else {
    const name = `ghostrow-${version}-${os}-${arch}.tar.gz`;
    const dest = join(out, name);
    // Relative archive name plus cwd: GNU tar on Windows reads "C:\..." as a remote host.
    execFileSync("tar", ["-czf", name, "-C", staging, "ghostrow", "LICENSE", "README.md"], { stdio: "inherit", cwd: out });
    console.log(`wrote ${dest}`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
