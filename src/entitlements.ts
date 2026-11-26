import { licenseProblem } from "./cli/errors.js";
import type { DbKind } from "./connect/types.js";

/**
 * What a run may do. Mirrors the site's plan matrix (src/config/plans.ts): the signed license
 * carries the paid features; Free is what runs without a license.
 */
export type PlanId = "free" | "plus" | "pro" | "max";
export type Mode = "seed" | "haunt" | "twin";

export interface Entitlements {
  plan: PlanId;
  /** "Free", "Pro (Example GmbH)", "Max · CI" … */
  label: string;
  source: "free" | "license" | "ci";
  seedLimit: { tables: number; rows: number } | null;
  databases: DbKind[];
  modes: Mode[];
  codeAware: boolean;
  byok: boolean;
  ci: boolean;
  /** Messages to show once, e.g. "offline for 40 days: running at Free limits". */
  notices: string[];
}

export const PLAN_NAMES: Record<PlanId, string> = { free: "Free", plus: "Plus", pro: "Pro", max: "Max" };
const ALL_DBS: DbKind[] = ["postgres", "mysql", "sqlite", "sqlserver"];

export function freeEntitlements(notices: string[] = []): Entitlements {
  return { plan: "free", label: "Free", source: "free", seedLimit: { tables: 5, rows: 10_000 }, databases: ["postgres", "sqlite"], modes: ["seed"], codeAware: false, byok: false, ci: false, notices };
}

export function paidEntitlements(p: { plan: PlanId; modes: Mode[]; code_aware: boolean; byok: boolean; ci: boolean; licensee?: { name: string; company?: string } }, source: "license" | "ci", notices: string[] = []): Entitlements {
  if (p.plan === "free") return freeEntitlements(notices);
  const who = p.licensee?.company ?? p.licensee?.name;
  return {
    plan: p.plan,
    label: `${PLAN_NAMES[p.plan]}${source === "ci" ? " · CI" : ""}${who ? ` (${who})` : ""}`,
    source,
    seedLimit: null,
    databases: ALL_DBS,
    modes: p.modes.length ? p.modes : ["seed"],
    codeAware: p.code_aware,
    byok: p.byok,
    ci: p.ci,
    notices,
  };
}

const UPGRADE = "https://ghostrow.com/pricing";

export function requireMode(e: Entitlements, mode: Mode): void {
  if (e.modes.includes(mode)) return;
  const need = mode === "twin" ? "Max" : "Pro or Max";
  throw licenseProblem(`\`ghostrow ${mode}\` needs a ${need} license (this machine runs ${e.label}).`, e.plan === "free" ? `Activate one with \`ghostrow activate <key>\`, or see ${UPGRADE}.` : `Upgrade from your account: ghostrow.com/account/licenses`);
}

export function requireCodeAware(e: Entitlements): void {
  if (!e.codeAware) throw licenseProblem(`Reading application code (--code) needs a Pro or Max license (this machine runs ${e.label}).`, `See ${UPGRADE}.`);
}

export function requireDatabase(e: Entitlements, kind: DbKind): void {
  if (e.databases.includes(kind)) return;
  const name = { mysql: "MySQL", sqlserver: "SQL Server", postgres: "Postgres", sqlite: "SQLite" }[kind];
  throw licenseProblem(`${name} needs a paid license; Free works with Postgres and SQLite.`, `See ${UPGRADE}.`);
}

/** Free limits: 5 tables and 10,000 rows per run. Exceeding them is a license problem (exit 4). */
export function enforceSeedLimit(e: Entitlements, tables: number, rows: number): void {
  const lim = e.seedLimit;
  if (!lim) return;
  if (tables > lim.tables) throw licenseProblem(`Free generates up to ${lim.tables} tables; this schema has ${tables}.`, `Use a smaller schema, or activate a Plus, Pro or Max license (${UPGRADE}).`);
  if (rows > lim.rows) throw licenseProblem(`Free generates up to ${lim.rows.toLocaleString("en-US")} rows per run; this run would write ${rows.toLocaleString("en-US")}.`, `Lower --rows, or activate a Plus, Pro or Max license (${UPGRADE}).`);
}
