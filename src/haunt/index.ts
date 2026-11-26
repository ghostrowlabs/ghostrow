import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunContext } from "../cli/context.js";
import { hauntFoundFailures, invalidInput } from "../cli/errors.js";
import type { HauntOptions } from "../cli/handlers.js";
import { fmt, note, out } from "../cli/output.js";
import { openConnector, type Connector } from "../connect/registry.js";
import type { SchemaModel } from "../connect/types.js";
import { violationsError } from "../engine/index.js";
import { prepare } from "../engine/pipeline.js";
import { requireMode } from "../entitlements.js";
import { exportRows } from "../export/format.js";
import { applySums, generateSeed, type GenOutput } from "../gen/seed.js";
import { validate } from "../gen/validate.js";
import { resolveEntitlements } from "../license/gate.js";
import { buildCases, type HauntCase } from "./cases.js";
import { failedTests } from "./parse.js";

/**
 * `ghostrow haunt` (Pro, Max): generate edge-case rows inside your schema's limits and, with
 * --tests, run your test command to see which rows break which tests.
 *
 * With --db the rows go into that database (and are removed again after a --tests run);
 * with --schema they are written as CSV to ./ghostrow-haunt/ and the path is passed to your
 * tests as GHOSTROW_HAUNT_DIR. Each test run also gets GHOSTROW_HAUNT_CASES (the case list).
 *
 * Attribution: one run on clean data (baseline), one with every case; if new tests fail,
 * the cases are re-run in groups to find which group each failing test reacts to.
 */

const BASE_ROWS = 30;
const MAX_GROUP_RUNS = 8;
/** Test runs spent narrowing failures down (after the baseline and the full run). */
const MAX_RUNS = 40;
const TEST_TIMEOUT_MS = 20 * 60_000;

interface TestRun {
  label: string;
  cases: string[];
  exitCode: number;
  failed: string[];
  durationMs: number;
}

export async function runHaunt(ctx: RunContext, opts: HauntOptions): Promise<void> {
  const ent = await resolveEntitlements();
  for (const n of ent.notices) note(ctx, `note: ${n}`);
  requireMode(ent, "haunt");
  const prep = await prepare(ctx, ent);
  const { schema, plan, connector } = prep;
  const seed = ctx.seed ?? 0;
  try {
    const idStart: Record<string, number> = {};
    if (connector) {
      for (const t of schema.tables) {
        const pk = t.primaryKey.length === 1 ? t.columns.find((c) => c.name === t.primaryKey[0]) : undefined;
        if (pk?.type === "integer") idStart[t.name] = (await connector.maxValue(t, pk.name)) + 1;
      }
    }
    // A small valid base dataset gives every case real parents to point at.
    const base = generateSeed({ schema, plan, seed, rows: BASE_ROWS, idStart });
    const nextId = new Map<string, number>();
    for (const { table, rows } of base) {
      const pk = table.primaryKey.length === 1 ? table.primaryKey[0]! : null;
      const max = pk ? Math.max(0, ...rows.map((r) => Number(r[pk])).filter(Number.isFinite)) : 0;
      nextId.set(table.name, Math.max(max, idStart[table.name] ?? 0) + 1_000);
    }
    currentPlan = plan;
    let cases = buildCases(base, plan, seed, opts.cases, nextId);
    cases = dropInvalid(base, cases, plan);
    if (cases.length === 0) throw invalidInput("No edge cases fit this schema's constraints.");

    const reportPath = resolve(opts.report);
    const casesPath = resolve(opts.report.replace(/\.json$/i, "") + ".cases.json");
    writeFileSync(casesPath, `${JSON.stringify(cases.map(publicCase), null, 2)}\n`);
    const dir = resolve("ghostrow-haunt");
    const runs: TestRun[] = [];
    let failures: { test: string; cases: string[]; columns: string[] }[] = [];

    if (!opts.tests) {
      // No tests: deliver the edge cases.
      if (connector) await load(connector, base, cases, true);
      else writeFiles(dir, schema, base, cases);
    } else {
      const env = { GHOSTROW_HAUNT_DIR: dir, GHOSTROW_HAUNT_CASES: casesPath };
      // The database connection is closed while your tests run (no locks, no held connection).
      await connector?.close();
      const exec = async (label: string, subset: HauntCase[]): Promise<TestRun> => {
        let inserted: (() => Promise<void>) | null = null;
        if (connector) {
          const c = await openConnector(ctx.db!);
          const cleanup = await load(c, base, subset, false);
          await c.close();
          inserted = async () => {
            const again = await openConnector(ctx.db!);
            try {
              await cleanup(again);
            } finally {
              await again.close();
            }
          };
        } else writeFiles(dir, schema, base, subset);
        note(ctx, `running       ${opts.tests} (${label}: ${subset.length} case${subset.length === 1 ? "" : "s"})`);
        try {
          const r = await runTests(opts.tests!, env);
          const run = { label, cases: subset.map((c) => c.id), exitCode: r.code, failed: failedTests(r.output, r.code), durationMs: r.ms };
          runs.push(run);
          return run;
        } finally {
          await inserted?.();
        }
      };
      const baseline = await exec("baseline", []);
      const all = await exec("all cases", cases);
      const before = new Set(baseline.failed);
      const newFails = all.failed.filter((t) => !before.has(t));
      if (newFails.length) {
        // Run groups of cases; split any group that still breaks a test, until each failing
        // test points at one column's cases or the run budget is spent.
        const blame = new Map<string, Set<string>>();
        let queue: { cases: HauntCase[]; tests: string[] }[] = groupCases(cases, MAX_GROUP_RUNS).map((g) => ({ cases: g, tests: newFails }));
        let budget = MAX_RUNS;
        let label = 0;
        while (queue.length && budget > 0) {
          const next: typeof queue = [];
          for (const item of queue) {
            if (budget-- <= 0) {
              for (const t of item.tests) item.cases.forEach((c) => (blame.get(t) ?? blame.set(t, new Set()).get(t)!).add(c.id));
              continue;
            }
            const r = await exec(`narrowing ${++label}`, item.cases);
            const hit = r.failed.filter((x) => item.tests.includes(x));
            if (!hit.length) continue;
            const columns = new Set(item.cases.map((c) => `${c.table}.${c.column}`));
            if (columns.size > 1) {
              for (const g of splitByColumn(item.cases)) next.push({ cases: g, tests: hit });
            } else if (item.cases.length > 1) {
              const mid = Math.ceil(item.cases.length / 2);
              next.push({ cases: item.cases.slice(0, mid), tests: hit }, { cases: item.cases.slice(mid), tests: hit });
            } else for (const t of hit) item.cases.forEach((c) => (blame.get(t) ?? blame.set(t, new Set()).get(t)!).add(c.id));
          }
          queue = next;
        }
        for (const item of queue) for (const t of item.tests) item.cases.forEach((c) => (blame.get(t) ?? blame.set(t, new Set()).get(t)!).add(c.id));
        failures = newFails.map((t) => {
          const ids = [...(blame.get(t) ?? new Set(cases.map((c) => c.id)))];
          return { test: t, cases: ids, columns: [...new Set(ids.map((id) => cases.find((c) => c.id === id)!).map((c) => `${c.table}.${c.column}`))] };
        });
      }
      if (!connector) rmSync(dir, { recursive: true, force: true });
    }

    const report = {
      engine: plan.engine,
      seed,
      source: schema.source,
      tests: opts.tests ?? null,
      summary: { cases: cases.length, tables: new Set(cases.map((c) => c.table)).size, runs: runs.length, failingTests: failures.length },
      failures,
      runs,
      cases: cases.map(publicCase),
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const lines = [`ghostrow haunt · ${schema.source} · ${fmt(cases.length)} edge cases across ${report.summary.tables} tables · ${ent.label}`];
    const kinds = new Map<string, number>();
    for (const c of cases) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    lines.push(`  ${[...kinds.entries()].slice(0, 10).map(([k, n]) => `${k} ${n}`).join(" · ")}${kinds.size > 10 ? " · …" : ""}`);
    if (!opts.tests) lines.push(connector ? `  inserted into ${connector.label}` : `  wrote CSV files to ./ghostrow-haunt/ (cases listed in ${opts.report.replace(/\.json$/i, "")}.cases.json)`);
    else if (!failures.length) lines.push(`  ${opts.tests}: no new failures across ${runs.length} runs`);
    else {
      lines.push(`  ${failures.length} test${failures.length === 1 ? "" : "s"} failed only with edge cases:`);
      for (const f of failures.slice(0, 10)) {
        const sample = cases.find((c) => c.id === f.cases[0]);
        lines.push(`  ✗ ${f.test}`);
        lines.push(`      broken by ${f.cases.length === cases.length ? "the full set (couldn't narrow it down)" : f.cases.slice(0, 6).join(", ") + (f.cases.length > 6 ? ", …" : "")}${sample ? ` e.g. ${sample.table}.${sample.column}: ${sample.description}` : ""}`);
      }
    }
    lines.push(`  report: ${opts.report}`);
    out(ctx, { text: lines.join("\n"), json: report });
    if (failures.length) throw hauntFoundFailures(`${failures.length} test${failures.length === 1 ? "" : "s"} failed with edge-case data. See ${opts.report}.`);
  } finally {
    await connector?.close().catch(() => undefined);
  }
}

function publicCase(c: HauntCase) {
  const main = c.rows[0]!.row;
  return { id: c.id, table: c.table, column: c.column, kind: c.kind, description: c.description, value: c.column === "*" ? null : jsonable(main[c.column]), rows: c.rows.length };
}

const jsonable = (v: unknown) => (v instanceof Buffer ? v.toString("hex") : v);

/** Drop any case whose rows would break a rule together with the base data. */
function dropInvalid(base: GenOutput, cases: HauntCase[], plan: Parameters<typeof validate>[1]): HauntCase[] {
  let current = cases;
  for (let pass = 0; pass < 5; pass++) {
    const { output, owner } = merge(base, current);
    const v = validate(output, plan);
    if (!v.violations.length) return current;
    const bad = new Set<string>();
    for (const x of v.violations) {
      const id = owner.get(`${x.table}#${x.row - 1}`);
      if (id) bad.add(id);
    }
    if (!bad.size) throw violationsError(v);
    current = current.filter((c) => !bad.has(c.id));
  }
  return current;
}

let currentPlan: Parameters<typeof applySums>[0] | null = null;

/** Base rows plus case rows. Parent totals are recomputed, since cases add child lines. */
function merge(base: GenOutput, cases: HauntCase[]): { output: GenOutput; owner: Map<string, string> } {
  const output: GenOutput = base.map((o) => ({ table: o.table, rows: o.rows.map((r) => ({ ...r })) }));
  const owner = new Map<string, string>();
  for (const c of cases) {
    for (const { table, row } of c.rows) {
      const t = output.find((o) => o.table.name === table)!;
      owner.set(`${table}#${t.rows.length}`, c.id);
      t.rows.push({ ...row });
    }
  }
  if (currentPlan) applySums(currentPlan, output);
  return { output, owner };
}

/**
 * Insert base + cases in one transaction. Returns a cleanup that deletes exactly those rows
 * (children first), unless `keep` is set.
 */
async function load(c: Connector, base: GenOutput, cases: HauntCase[], keep: boolean): Promise<(conn: Connector) => Promise<void>> {
  const { output: all } = merge(base, cases);
  await c.begin();
  try {
    for (const { table, rows } of all) if (rows.length) await c.insert(table, rows);
    await c.afterInsert(all.map((o) => o.table));
    await c.commit();
  } catch (e) {
    await c.rollback().catch(() => undefined);
    throw e;
  }
  if (keep) return async () => undefined;
  return async (c: Connector) => {
    await c.begin();
    try {
      for (const { table, rows } of [...all].reverse()) {
        if (!rows.length || !table.primaryKey.length) continue;
        await c.deleteRows(table, rows.map((r) => Object.fromEntries(table.primaryKey.map((k) => [k, r[k]]))));
      }
      await c.commit();
    } catch (e) {
      await c.rollback().catch(() => undefined);
      throw e;
    }
  };
}

function writeFiles(dir: string, schema: SchemaModel, base: GenOutput, cases: HauntCase[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { output } = merge(base, cases);
  exportRows(output, dir, "csv", schema.dialect);
  writeFileSync(join(dir, "cases.json"), `${JSON.stringify(cases.map(publicCase), null, 2)}\n`);
}

/** Split a group in two halves by column. */
function splitByColumn(cases: HauntCase[]): HauntCase[][] {
  const cols = [...new Set(cases.map((c) => `${c.table}.${c.column}`))];
  const half = new Set(cols.slice(0, Math.ceil(cols.length / 2)));
  return [cases.filter((c) => half.has(`${c.table}.${c.column}`)), cases.filter((c) => !half.has(`${c.table}.${c.column}`))];
}

/** Split cases into at most `max` groups, keeping a column's cases together. */
function groupCases(cases: HauntCase[], max: number): HauntCase[][] {
  const byColumn = new Map<string, HauntCase[]>();
  for (const c of cases) byColumn.set(`${c.table}.${c.column}`, [...(byColumn.get(`${c.table}.${c.column}`) ?? []), c]);
  const groups = [...byColumn.values()];
  if (groups.length <= max) return groups;
  const size = Math.ceil(groups.length / max);
  const merged: HauntCase[][] = [];
  for (let i = 0; i < groups.length; i += size) merged.push(groups.slice(i, i + size).flat());
  return merged;
}

function runTests(cmd: string, env: Record<string, string>): Promise<{ code: number; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(cmd, { shell: true, env: { ...process.env, ...env, CI: process.env.CI ?? "true", FORCE_COLOR: "0", NO_COLOR: "1" } });
    let output = "";
    const keep = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 4_000_000) output = output.slice(-2_000_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), TEST_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, output, ms: Date.now() - started });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 127, output: e.message, ms: Date.now() - started });
    });
  });
}
