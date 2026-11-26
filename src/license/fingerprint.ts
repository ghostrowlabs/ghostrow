import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform, release, userInfo } from "node:os";

/**
 * This machine's fingerprint: SHA-256 of the operating system's machine ID, as 64 hex
 * characters. The raw ID never leaves the machine, and the server hashes the fingerprint
 * again with a per-license salt before storing it.
 */
export function machineFingerprint(): string {
  const override = process.env.GHOSTROW_MACHINE_ID; // tests and containers with no stable ID
  const id = override ?? osMachineId() ?? `${hostname()}:${safeUser()}`;
  return createHash("sha256").update(`ghostrow-machine/v1:${id}`).digest("hex");
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

function osMachineId(): string | null {
  try {
    switch (platform()) {
      case "linux":
        for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
          try {
            const v = readFileSync(p, "utf8").trim();
            if (v) return v;
          } catch {
            /* next */
          }
        }
        return null;
      case "darwin": {
        const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 3000 });
        return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
      }
      case "win32": {
        const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 3000, windowsHide: true });
        return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function machineLabel(): string {
  return hostname().slice(0, 80) || "This machine";
}

export function osLabel(): string {
  const p = platform();
  const name = p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : p;
  return `${name} ${release()}`.slice(0, 40);
}
