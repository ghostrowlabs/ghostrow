import type { RunContext } from "../cli/context.js";
import { invalidInput, licenseProblem } from "../cli/errors.js";
import { out } from "../cli/output.js";
import { PLAN_NAMES } from "../entitlements.js";
import { VERSION } from "../version.js";
import { api } from "./client.js";
import { machineFingerprint, machineLabel, osLabel } from "./fingerprint.js";
import { checkIn, resolveEntitlements, updatesNotice } from "./gate.js";
import { hasKeys, publicKeys } from "./keys.js";
import { clearState, readState, writeState } from "./store.js";
import { verifyToken } from "./token.js";

/** `ghostrow activate <key>`: verify the key offline, then register this machine with ghostrow.com. */
export async function runActivate(ctx: RunContext, key: string): Promise<void> {
  const token = key.trim();
  if (!hasKeys()) throw licenseProblem("This build has no license keys. Install Ghostrow from ghostrow.com, npm or Homebrew.");
  const v = verifyToken("license", token, publicKeys());
  if (!v.ok) {
    throw licenseProblem(
      v.reason === "unknown_key" ? "That license key was signed with a key this version doesn't know. Update Ghostrow, then try again." : "That license key isn't valid. Copy it again from your receipt email or ghostrow.com/account/licenses.",
    );
  }
  if (v.payload.plan === "free") throw invalidInput("Free doesn't need a key: just run `ghostrow seed`.");
  const r = await api.activate({ token, fingerprint: machineFingerprint(), label: machineLabel(), os: osLabel(), cliVersion: VERSION });
  if (!r.ok) {
    const e = r.err;
    if (e.error === "machine_limit") throw licenseProblem(e.message, `Manage machines at ghostrow.com/account/licenses/${v.payload.lid}`);
    if (e.error === "rate_limited") throw licenseProblem(`Too many activations for this license in the last hour. Try again${e.retryAfter ? ` in ${Math.ceil(e.retryAfter / 60)} minutes` : " later"}.`);
    if (e.status === 0) throw licenseProblem(e.message, "Activation needs a connection once; after that Ghostrow works offline.");
    throw licenseProblem(e.message);
  }
  const lic = verifyToken("license", r.data.license ?? token, publicKeys());
  const act = verifyToken("activation", r.data.activation, publicKeys());
  if (!lic.ok || !act.ok) throw licenseProblem("ghostrow.com sent an activation this build can't verify. Update Ghostrow and try again.");
  const now = new Date().toISOString();
  writeState({
    license: r.data.license ?? token,
    activation: r.data.activation,
    machineId: act.payload.mid,
    machineLabel: r.data.machine?.label ?? machineLabel(),
    activatedAt: now,
    lastCheck: now,
    ...(r.data.machines ? { machines: r.data.machines } : {}),
  });
  const p = lic.payload;
  const late = updatesNotice(p);
  out(ctx, {
    text: [
      `Activated ${PLAN_NAMES[p.plan]} on ${machineLabel()}.`,
      `  licensed to   ${p.licensee.company ? `${p.licensee.company} (${p.licensee.name})` : p.licensee.name}`,
      `  updates       ${p.updates_until ? `until ${p.updates_until.slice(0, 10)}` : "current version"}`,
      r.data.machines ? `  machines      ${r.data.machines.active} of ${r.data.machines.limit ?? "unlimited"} in use` : null,
      `  works offline until ${act.payload.grace_until.slice(0, 10)}; Ghostrow checks in quietly before then`,
      late ? `  note: ${late}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    json: { activated: true, plan: p.plan, license: p.lid, machine: act.payload.mid, updatesUntil: p.updates_until, graceUntil: act.payload.grace_until, machines: r.data.machines ?? null },
  });
}

/** `ghostrow deactivate`: free this machine's slot on the license. */
export async function runDeactivate(ctx: RunContext): Promise<void> {
  const state = readState();
  if (!state) {
    out(ctx, { text: "This machine isn't activated. Nothing to do.", json: { deactivated: false, reason: "not_activated" } });
    return;
  }
  const r = await api.deactivate(state.activation);
  if (!r.ok && r.err.status === 0) throw licenseProblem(`${r.err.message} The machine stays activated until it can reach ghostrow.com.`, "You can also remove it from ghostrow.com/account/licenses.");
  // invalid_activation or machine already removed: the slot is free either way.
  clearState();
  out(ctx, { text: "Deactivated. This machine's slot is free, and Ghostrow runs at Free limits here.", json: { deactivated: true } });
}

/** `ghostrow status`: plan, seat, machines used and updates end date. */
export async function runStatus(ctx: RunContext): Promise<void> {
  const state = readState();
  const checked = state && !process.env.GHOSTROW_CI_TOKEN ? await checkIn(state, 5_000) : null; // fresh machine count when online
  const e = await resolveEntitlements({ quiet: true });
  if (checked === "removed") e.notices.push("This machine was removed from your license in your account. Run `ghostrow activate <key>` to add it again.");
  if (checked === "revoked") e.notices.push("This license is no longer active (refunded or revoked).");
  if (checked === "suspended") e.notices.push("This license is paused while a payment dispute is open.");
  const fresh = readState();
  const lic = fresh ? verifyToken("license", fresh.license, publicKeys()) : null;
  const act = fresh ? verifyToken("activation", fresh.activation, publicKeys()) : null;
  const p = lic?.ok ? lic.payload : null;
  const lines = [`plan          ${e.label}`];
  if (p && e.source === "license") {
    lines.push(`license       ${p.lid}`);
    lines.push(`seat          ${p.seats === 1 ? "1 seat" : `${p.seats} seats`}, this machine: ${fresh?.machineLabel ?? machineLabel()}`);
    if (fresh?.machines) lines.push(`machines      ${fresh.machines.active} of ${fresh.machines.limit ?? "unlimited"} in use`);
    lines.push(`updates       ${p.updates_until ? `until ${p.updates_until.slice(0, 10)}` : "current version"}`);
    if (act?.ok) lines.push(`offline until ${act.payload.grace_until.slice(0, 10)} (last check ${fresh!.lastCheck.slice(0, 10)})`);
  }
  lines.push(`modes         ${e.modes.join(", ")}${e.codeAware ? " · code-aware rules" : ""}${e.byok ? " · your own AI key" : ""}${e.ci ? " · CI tokens" : ""}`);
  lines.push(`databases     ${e.databases.map((d) => ({ postgres: "Postgres", mysql: "MySQL", sqlite: "SQLite", sqlserver: "SQL Server" })[d]).join(", ")}`);
  if (e.seedLimit) lines.push(`limits        ${e.seedLimit.tables} tables, ${e.seedLimit.rows.toLocaleString("en-US")} rows per run`);
  lines.push(`version       ${VERSION}`);
  for (const n of e.notices) lines.push(`note          ${n}`);
  out(ctx, {
    text: lines.join("\n"),
    json: {
      plan: e.plan,
      source: e.source,
      license: p?.lid ?? null,
      seats: p?.seats ?? null,
      machine: fresh?.machineLabel ?? null,
      machines: fresh?.machines ?? null,
      updatesUntil: p?.updates_until ?? null,
      offlineUntil: act?.ok ? act.payload.grace_until : null,
      modes: e.modes,
      databases: e.databases,
      limits: e.seedLimit,
      notices: e.notices,
      version: VERSION,
    },
  });
}
