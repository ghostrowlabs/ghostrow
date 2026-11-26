import { freeEntitlements, paidEntitlements, type Entitlements } from "../entitlements.js";
import { RELEASE_DATE } from "../version.js";
import { api } from "./client.js";
import { machineFingerprint } from "./fingerprint.js";
import { publicKeys } from "./keys.js";
import { readState, writeState, clearState, type LicenseState } from "./store.js";
import { verifyToken, type LicensePayload } from "./token.js";

const DAY = 86_400_000;
/** Check in quietly once a week when online. */
const CHECK_EVERY = 7 * DAY;

/**
 * The plan this run gets:
 *  1. GHOSTROW_CI_TOKEN (Max): verified with ghostrow.com on each run; CI runners aren't machines.
 *  2. An activated license on this machine: both tokens verified offline with the built-in keys,
 *     the activation must match this machine, and it must be inside its activation period
 *     (30 days) or its 14-day grace. A quiet check-in renews it when online.
 *  3. Otherwise Free. Ghostrow never deletes data or rules when it falls back.
 */
export async function resolveEntitlements(options: { quiet?: boolean } = {}): Promise<Entitlements> {
  const ci = process.env.GHOSTROW_CI_TOKEN?.trim();
  if (ci) return fromCiToken(ci);
  const state = readState();
  if (!state) return freeEntitlements();
  return fromState(state, options);
}

async function fromCiToken(token: string): Promise<Entitlements> {
  const r = await api.ci(token, 15_000);
  if (!r.ok) {
    const why = r.err.status === 0 ? "the license server couldn't be reached" : r.err.message;
    return freeEntitlements([`GHOSTROW_CI_TOKEN was not accepted (${why}). Running at Free limits.`]);
  }
  const v = verifyToken("license", r.data.license, publicKeys());
  if (!v.ok || !v.payload.ci) return freeEntitlements(["GHOSTROW_CI_TOKEN returned a license this build can't verify. Running at Free limits."]);
  const late = updatesNotice(v.payload);
  if (late) return freeEntitlements([late]);
  return paidEntitlements(v.payload, "ci");
}

export function updatesNotice(p: LicensePayload): string | null {
  if (p.updates_until === null || p.plan === "free") return null;
  if (Date.parse(p.updates_until) >= Date.parse(`${RELEASE_DATE}T00:00:00Z`)) return null;
  return `This version (released ${RELEASE_DATE}) came out after your license's updates ended (${p.updates_until.slice(0, 10)}). It runs at Free limits; reinstall an earlier version or renew updates from your account.`;
}

async function fromState(state: LicenseState, options: { quiet?: boolean }): Promise<Entitlements> {
  const keys = publicKeys();
  const lic = verifyToken("license", state.license, keys);
  const act = verifyToken("activation", state.activation, keys);
  if (!lic.ok || !act.ok || act.payload.lid !== lic.payload.lid) {
    return freeEntitlements(["The saved license on this machine isn't valid for this build. Run `ghostrow activate <key>` again."]);
  }
  if (act.payload.fp !== machineFingerprint()) {
    return freeEntitlements(["The saved activation belongs to a different machine. Run `ghostrow activate <key>` on this one."]);
  }
  let license = lic.payload;
  let activation = act.payload;
  const now = Date.now();

  // Quiet check-in: weekly, or whenever the activation has expired.
  const stale = now - Date.parse(state.lastCheck) > CHECK_EVERY || now > Date.parse(activation.expires_at);
  if (stale) {
    const result = await checkIn(state, now > Date.parse(activation.expires_at) ? 10_000 : 4_000);
    if (result === "removed") return freeEntitlements(["This machine was removed from your license. Run `ghostrow activate <key>` to add it again."]);
    if (result === "revoked") return freeEntitlements(["This license is no longer active (refunded or revoked). Running at Free limits."]);
    if (result === "suspended") return freeEntitlements(["This license is paused while a payment dispute is open. Running at Free limits."]);
    if (typeof result === "object") {
      license = result.license;
      activation = result.activation;
    }
  }
  if (revoked(state, license.lid)) return freeEntitlements(["This license is on the revocation list. Running at Free limits."]);

  const notices: string[] = [];
  if (now > Date.parse(activation.grace_until)) {
    return freeEntitlements([`This machine hasn't checked in with ghostrow.com since ${activation.issued_at.slice(0, 10)}, past the 30-day activation and 14-day grace period. Running at Free limits until it can check in.`]);
  }
  if (now > Date.parse(activation.expires_at) && !options.quiet) {
    notices.push(`Offline grace period: connect to the internet before ${activation.grace_until.slice(0, 10)} to keep ${license.plan}.`);
  }
  const late = updatesNotice(license);
  if (late) return freeEntitlements([late]);
  return paidEntitlements(license, "license", notices);
}

function revoked(state: LicenseState, lid: string): boolean {
  if (!state.revocations) return false;
  const v = verifyToken("revocations", state.revocations, publicKeys());
  return v.ok && v.payload.revoked.some((r) => r.lid === lid);
}

type CheckResult = "offline" | "removed" | "revoked" | "suspended" | { license: LicensePayload; activation: ReturnType<typeof parseActivation> & object };

function parseActivation(token: string) {
  const v = verifyToken("activation", token, publicKeys());
  return v.ok ? v.payload : null;
}

/** Refresh the activation and the revocation list. Never throws; offline is fine. */
export async function checkIn(state: LicenseState, timeoutMs = 4_000): Promise<CheckResult> {
  const r = await api.refresh(state.activation, timeoutMs);
  if (!r.ok) {
    if (r.err.error === "machine_removed" || r.err.error === "invalid_activation") {
      clearState();
      return "removed";
    }
    if (r.err.error === "license_revoked") {
      clearState();
      return "revoked";
    }
    if (r.err.error === "license_suspended") return "suspended";
    return "offline";
  }
  const lic = verifyToken("license", r.data.license ?? state.license, publicKeys());
  const act = parseActivation(r.data.activation);
  if (!lic.ok || !act) return "offline";
  const next: LicenseState = { ...state, license: r.data.license ?? state.license, activation: r.data.activation, lastCheck: new Date().toISOString(), ...(r.data.machines ? { machines: r.data.machines } : {}) };
  const rev = await api.revocations(timeoutMs);
  if (rev.ok && verifyToken("revocations", rev.data.revocations, publicKeys()).ok) next.revocations = rev.data.revocations;
  writeState(next);
  return { license: lic.payload, activation: act };
}

export const _test = { DAY };
