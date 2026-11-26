import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GhostrowError } from "../../src/cli/errors.js";
import { enforceSeedLimit, freeEntitlements, requireMode, type Entitlements } from "../../src/entitlements.js";
import { machineFingerprint } from "../../src/license/fingerprint.js";
import { resolveEntitlements } from "../../src/license/gate.js";
import { publicKeys } from "../../src/license/keys.js";
import { clearState, readState, writeState, type LicenseState } from "../../src/license/store.js";
import { verifyToken } from "../../src/license/token.js";
import { RELEASE_DATE } from "../../src/version.js";
import { testAuthority } from "../helpers/license.js";

// One authority per file: src/license/keys.ts caches the parsed public keys on first use.
const authority = testAuthority();
const other = testAuthority(); // same kid, different key: a forger
const DAY = 86_400_000;
const LID = "01JTESTLICENSE0000000000AB";

const saved: Record<string, string | undefined> = {};
const ENV = ["GHOSTROW_PUBLIC_KEYS", "GHOSTROW_HOME", "GHOSTROW_MACHINE_ID", "GHOSTROW_API_URL", "GHOSTROW_CI_TOKEN"] as const;
let home: string;
let fp: string;

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "ghostrow-lic-"));
  process.env.GHOSTROW_PUBLIC_KEYS = authority.publicKeys;
  process.env.GHOSTROW_HOME = home;
  process.env.GHOSTROW_MACHINE_ID = "test-machine";
  process.env.GHOSTROW_API_URL = "http://127.0.0.1:9";
  delete process.env.GHOSTROW_CI_TOKEN;
  fp = machineFingerprint();
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

function state(license: string, activation: string, over: Partial<LicenseState> = {}): LicenseState {
  return { license, activation, machineId: "00000000-0000-4000-8000-000000000001", machineLabel: "test", activatedAt: iso(Date.now()), lastCheck: iso(Date.now()), ...over };
}
const save = (s: LicenseState) => writeState(s);
const flipSignature = (token: string) => {
  const i = token.lastIndexOf(".");
  const sig = token.slice(i + 1);
  const swapped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  return `${token.slice(0, i + 1)}${swapped}`;
};

function expectFree(e: Entitlements) {
  expect(e.plan).toBe("free");
  expect(e.source).toBe("free");
  expect(e.seedLimit).toEqual({ tables: 5, rows: 10_000 });
}

describe("verifyToken", () => {
  const lic = authority.license("pro");

  it("accepts a token signed by the authority", () => {
    const keys = publicKeys();
    const r = verifyToken("license", lic, keys);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.plan).toBe("pro");
      expect(r.payload.lid).toBe(LID);
    }
  });

  it("rejects a tampered signature", () => {
    expect(verifyToken("license", flipSignature(lic), publicKeys())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload", () => {
    const [p, body, sig] = lic.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), plan: "max" })).toString("base64url");
    expect(verifyToken("license", `${p}.${edited}.${sig}`, publicKeys())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token signed by someone else's key", () => {
    expect(verifyToken("license", other.license("max"), publicKeys())).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown key id", () => {
    const r = verifyToken("license", testAuthority("elsewhere").license("pro", { kid: "elsewhere" }), publicKeys());
    expect(r).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects the wrong kind of token and garbage", () => {
    expect(verifyToken("activation", lic, publicKeys())).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("license", "nonsense", publicKeys())).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("license", "GR1.%%%.sig", publicKeys())).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("license", `GR1.${Buffer.from("{}").toString("base64url")}.AAAA`, publicKeys())).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("license", "x".repeat(5000), publicKeys())).toEqual({ ok: false, reason: "malformed" });
  });

  it("tolerates surrounding whitespace", () => {
    expect(verifyToken("license", `  ${lic}\n`, publicKeys()).ok).toBe(true);
  });
});

describe("resolveEntitlements", () => {
  it("no saved state gives Free", async () => {
    clearState();
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.databases).toEqual(["postgres", "sqlite"]);
    expect(e.modes).toEqual(["seed"]);
    expect(e.codeAware).toBe(false);
    expect(e.notices).toEqual([]);
  });

  it("valid Max license gives all modes and features", async () => {
    save(state(authority.license("max"), authority.activation(LID, fp, "max")));
    const e = await resolveEntitlements();
    expect(e.plan).toBe("max");
    expect(e.source).toBe("license");
    expect(e.seedLimit).toBeNull();
    expect(e.modes).toEqual(["seed", "haunt", "twin"]);
    expect(e.codeAware).toBe(true);
    expect(e.byok).toBe(true);
    expect(e.ci).toBe(true);
    expect(e.databases).toHaveLength(4);
    expect(e.label).toContain("Max");
    expect(e.label).toContain("Example GmbH");
    expect(e.notices).toEqual([]);
  });

  it("Pro has haunt but not twin", async () => {
    save(state(authority.license("pro"), authority.activation(LID, fp, "pro")));
    const e = await resolveEntitlements();
    expect(e.plan).toBe("pro");
    expect(e.modes).toEqual(["seed", "haunt"]);
    expect(e.modes).not.toContain("twin");
    expect(e.ci).toBe(false);
  });

  it("Plus is seed only without code awareness", async () => {
    save(state(authority.license("plus"), authority.activation(LID, fp, "plus")));
    const e = await resolveEntitlements();
    expect(e.plan).toBe("plus");
    expect(e.modes).toEqual(["seed"]);
    expect(e.codeAware).toBe(false);
    expect(e.seedLimit).toBeNull();
  });

  it("an activation for a different machine gives Free with a notice", async () => {
    save(state(authority.license("max"), authority.activation(LID, "f".repeat(64), "max")));
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.notices.join(" ")).toMatch(/different machine/);
  });

  it("an activation for a different license id gives Free", async () => {
    save(state(authority.license("max"), authority.activation("01JOTHERLICENSE00000000000", fp, "max")));
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.notices[0]).toMatch(/isn't valid/);
  });

  it("a tampered license token gives Free", async () => {
    save(state(flipSignature(authority.license("max")), authority.activation(LID, fp, "max")));
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.notices).toHaveLength(1);
  });

  it("a tampered activation token gives Free", async () => {
    save(state(authority.license("max"), flipSignature(authority.activation(LID, fp, "max"))));
    expectFree(await resolveEntitlements());
  });

  it("a token signed by another key gives Free", async () => {
    save(state(other.license("max"), other.activation(LID, fp, "max")));
    expectFree(await resolveEntitlements());
  });

  it("an activation past its grace period gives Free and mentions the 14-day grace", async () => {
    const now = Date.now();
    const act = authority.activation(LID, fp, "max", {
      issued_at: iso(now - 60 * DAY),
      expires_at: iso(now - 30 * DAY),
      grace_until: iso(now - 16 * DAY),
    });
    save(state(authority.license("max"), act, { lastCheck: iso(now - 60 * DAY) }));
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.notices.join(" ")).toMatch(/14-day grace/);
  });

  it("an expired activation still inside grace stays paid with an offline-grace notice", async () => {
    const now = Date.now();
    const act = authority.activation(LID, fp, "max", {
      issued_at: iso(now - 35 * DAY),
      expires_at: iso(now - 5 * DAY),
      grace_until: iso(now + 9 * DAY),
    });
    save(state(authority.license("max"), act, { lastCheck: iso(now - 35 * DAY) }));
    const e = await resolveEntitlements();
    expect(e.plan).toBe("max");
    expect(e.notices.join(" ")).toMatch(/Offline grace/);
  });

  it("the offline-grace notice is suppressed when quiet", async () => {
    const now = Date.now();
    const act = authority.activation(LID, fp, "pro", { issued_at: iso(now - 35 * DAY), expires_at: iso(now - 5 * DAY), grace_until: iso(now + 9 * DAY) });
    save(state(authority.license("pro"), act, { lastCheck: iso(now - 35 * DAY) }));
    const e = await resolveEntitlements({ quiet: true });
    expect(e.plan).toBe("pro");
    expect(e.notices).toEqual([]);
  });

  it("a license whose updates ended before this release gives Free with a notice", async () => {
    const before = Date.parse(`${RELEASE_DATE}T00:00:00Z`) - 10 * DAY;
    save(state(authority.license("max", { updates_until: iso(before) }), authority.activation(LID, fp, "max")));
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.notices.join(" ")).toContain("updates ended");
  });

  it("a license whose updates run past this release stays paid", async () => {
    const after = Date.parse(`${RELEASE_DATE}T00:00:00Z`) + 10 * DAY;
    save(state(authority.license("max", { updates_until: iso(after) }), authority.activation(LID, fp, "max")));
    expect((await resolveEntitlements()).plan).toBe("max");
  });

  it("a perpetual license (updates_until null) stays paid", async () => {
    save(state(authority.license("pro", { updates_until: null }), authority.activation(LID, fp, "pro")));
    expect((await resolveEntitlements()).plan).toBe("pro");
  });

  it("a license on a signed revocation list gives Free", async () => {
    const list = authority.signToken("GRR1", { v: 1, kid: authority.kid, issued_at: iso(Date.now()), revoked: [{ lid: LID, at: iso(Date.now()) }] });
    save(state(authority.license("max"), authority.activation(LID, fp, "max"), { revocations: list }));
    const e = await resolveEntitlements();
    expectFree(e);
    expect(e.notices.join(" ")).toMatch(/revocation list/);
  });

  it("a revocation list for other licenses does not affect this one", async () => {
    const list = authority.signToken("GRR1", { v: 1, kid: authority.kid, issued_at: iso(Date.now()), revoked: [{ lid: "01JSOMEONEELSE000000000000", at: iso(Date.now()) }] });
    save(state(authority.license("max"), authority.activation(LID, fp, "max"), { revocations: list }));
    expect((await resolveEntitlements()).plan).toBe("max");
  });

  it("a forged revocation list is ignored", async () => {
    const list = other.signToken("GRR1", { v: 1, kid: other.kid, issued_at: iso(Date.now()), revoked: [{ lid: LID, at: iso(Date.now()) }] });
    save(state(authority.license("max"), authority.activation(LID, fp, "max"), { revocations: list }));
    expect((await resolveEntitlements()).plan).toBe("max");
  });

  it("an old lastCheck while offline falls back quietly to the saved paid license", async () => {
    // The API URL is unreachable, so the weekly check-in fails fast as "offline".
    save(state(authority.license("max"), authority.activation(LID, fp, "max"), { lastCheck: iso(Date.now() - 20 * DAY) }));
    const e = await resolveEntitlements();
    expect(e.plan).toBe("max");
    expect(e.notices).toEqual([]);
    expect(readState()).not.toBeNull(); // offline never clears the saved license
  });

  it("a corrupt state file is treated as no license", async () => {
    writeFileSync(join(home, "license.json"), "{ not json", "utf8");
    expect(readState()).toBeNull();
    expectFree(await resolveEntitlements());
    writeFileSync(join(home, "license.json"), JSON.stringify({ license: 1 }), "utf8");
    expectFree(await resolveEntitlements());
    clearState();
  });
});

describe("entitlements helpers", () => {
  const free = freeEntitlements();
  const paid: Entitlements = { ...free, plan: "plus", label: "Plus", source: "license", seedLimit: null, modes: ["seed"], databases: ["postgres", "mysql", "sqlite", "sqlserver"] };

  function exitOf(fn: () => void): number | null {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(GhostrowError);
      return (e as GhostrowError).exitCode;
    }
    return null;
  }

  it("enforceSeedLimit allows the Free maximum", () => {
    expect(exitOf(() => enforceSeedLimit(free, 5, 10_000))).toBeNull();
  });
  it("enforceSeedLimit: 6 tables on Free is exit 4", () => {
    expect(exitOf(() => enforceSeedLimit(free, 6, 100))).toBe(4);
  });
  it("enforceSeedLimit: 10,001 rows on Free is exit 4", () => {
    expect(exitOf(() => enforceSeedLimit(free, 1, 10_001))).toBe(4);
  });
  it("enforceSeedLimit: paid never throws", () => {
    expect(exitOf(() => enforceSeedLimit(paid, 500, 50_000_000))).toBeNull();
  });
  it("the error message names the limit", () => {
    try {
      enforceSeedLimit(free, 6, 1);
    } catch (e) {
      expect((e as GhostrowError).message).toContain("5 tables");
      expect((e as GhostrowError).hint).toBeTruthy();
    }
  });
  it("requireMode passes for an included mode", () => {
    expect(exitOf(() => requireMode(free, "seed"))).toBeNull();
  });
  it("requireMode: haunt and twin on Free are exit 4", () => {
    expect(exitOf(() => requireMode(free, "haunt"))).toBe(4);
    expect(exitOf(() => requireMode(free, "twin"))).toBe(4);
  });
  it("requireMode: twin on Pro asks for Max", () => {
    const pro: Entitlements = { ...paid, plan: "pro", label: "Pro", modes: ["seed", "haunt"] };
    expect(exitOf(() => requireMode(pro, "haunt"))).toBeNull();
    try {
      requireMode(pro, "twin");
      expect.unreachable();
    } catch (e) {
      expect((e as GhostrowError).exitCode).toBe(4);
      expect((e as GhostrowError).message).toContain("Max");
    }
  });
});
