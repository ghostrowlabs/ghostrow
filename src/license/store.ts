import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local license state in ~/.ghostrow (or $GHOSTROW_HOME). Holds the license key, this
 * machine's activation token and the last signed revocation list. Never your data or schema.
 */
export interface LicenseState {
  /** GR1 license key. */
  license: string;
  /** GRA1 activation for this machine. */
  activation: string;
  machineId: string;
  machineLabel: string | null;
  activatedAt: string;
  lastCheck: string;
  /** Machines in use / limit, as of the last check (null = unlimited). */
  machines?: { active: number; limit: number | null };
  /** GRR1 revocation list from the last check. */
  revocations?: string;
}

export function homeDir(): string {
  return process.env.GHOSTROW_HOME ?? join(homedir(), ".ghostrow");
}

const file = () => join(homeDir(), "license.json");

export function readState(): LicenseState | null {
  try {
    if (!existsSync(file())) return null;
    const s = JSON.parse(readFileSync(file(), "utf8")) as LicenseState;
    return typeof s.license === "string" && typeof s.activation === "string" ? s : null;
  } catch {
    return null;
  }
}

export function writeState(s: LicenseState): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(s, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file(), 0o600);
  } catch {
    // Windows: permissions follow the user profile.
  }
}

export function clearState(): void {
  rmSync(file(), { force: true });
}
