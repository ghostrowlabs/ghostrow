// Usage: node render-manifests.mjs <version> <path to SHA256SUMS> <outdir>
// Writes the three winget manifests (ManifestVersion 1.6.0) for Ghostrow.Ghostrow into <outdir>.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, sumsPath, outdir] = process.argv.slice(2);
if (!version || !sumsPath || !outdir) {
  console.error("usage: node render-manifests.mjs <version> <SHA256SUMS path> <outdir>");
  process.exit(2);
}

const sums = new Map();
for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
  const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m) sums.set(m[2], m[1].toUpperCase());
}
const installer = (arch) => {
  const name = `ghostrow-${version}-windows-${arch}.zip`;
  const sha = sums.get(name);
  if (!sha) throw new Error(`${name} is not in ${sumsPath}`);
  return { url: `https://github.com/ghostrowlabs/ghostrow/releases/download/v${version}/${name}`, sha };
};
const x64 = installer("x64");
const arm64 = installer("arm64");

const id = "Ghostrow.Ghostrow";
const schema = (kind) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.1.6.0.schema.json`;

const versionYaml = `${schema("version")}

PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;

const localeYaml = `${schema("defaultLocale")}

PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Ghostrow Labs LLC
PublisherUrl: https://ghostrow.com
PackageName: Ghostrow
PackageUrl: https://ghostrow.com/download
License: Proprietary
LicenseUrl: https://ghostrow.com/legal/eula
ShortDescription: Realistic, consistent test data from your database schema.
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`;

const installerYaml = `${schema("installer")}

PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: ghostrow.exe
    PortableCommandAlias: ghostrow
Installers:
  - Architecture: x64
    InstallerUrl: ${x64.url}
    InstallerSha256: ${x64.sha}
  - Architecture: arm64
    InstallerUrl: ${arm64.url}
    InstallerSha256: ${arm64.sha}
ManifestType: installer
ManifestVersion: 1.6.0
`;

mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, `${id}.yaml`), versionYaml);
writeFileSync(join(outdir, `${id}.locale.en-US.yaml`), localeYaml);
writeFileSync(join(outdir, `${id}.installer.yaml`), installerYaml);
console.log(`wrote 3 manifests to ${outdir}`);
