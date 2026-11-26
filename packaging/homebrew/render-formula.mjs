// Usage: node render-formula.mjs <version> <path to SHA256SUMS>   (prints the formula to stdout)
import { readFileSync } from "node:fs";

const [version, sumsPath] = process.argv.slice(2);
if (!version || !sumsPath) {
  console.error("usage: node render-formula.mjs <version> <SHA256SUMS path>");
  process.exit(2);
}

const sums = new Map();
for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
  const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m) sums.set(m[2], m[1].toLowerCase());
}
const asset = (os, arch) => {
  const name = `ghostrow-${version}-${os}-${arch}.tar.gz`;
  const sha = sums.get(name);
  if (!sha) throw new Error(`${name} is not in ${sumsPath}`);
  return { url: `https://github.com/ghostrowlabs/ghostrow/releases/download/v${version}/${name}`, sha };
};
const block = (os, arch) => {
  const a = asset(os, arch);
  return `      url "${a.url}"\n      sha256 "${a.sha}"`;
};

process.stdout.write(`class Ghostrow < Formula
  desc "Realistic, consistent test data from your database schema"
  homepage "https://ghostrow.com"
  version "${version}"
  license :cannot_represent

  on_macos do
    on_arm do
${block("macos", "arm64")}
    end
    on_intel do
${block("macos", "x64")}
    end
  end

  on_linux do
    on_arm do
${block("linux", "arm64")}
    end
    on_intel do
${block("linux", "x64")}
    end
  end

  def install
    bin.install "ghostrow"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ghostrow --version")
  end
end
`);
