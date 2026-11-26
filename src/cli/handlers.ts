import { parseSeed, type RunContext } from "./context.js";
import { invalidInput } from "./errors.js";
import { runSeed } from "../engine/index.js";
import { runHaunt } from "../haunt/index.js";
import { runTwin } from "../twin/index.js";
import { runActivate, runDeactivate, runStatus } from "../license/cli.js";

/** Loose commander `OptionValues` — every value is unknown until read. */
type Opts = Record<string, unknown>;

function opt(opts: Opts, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

export interface SeedOptions {
  rows?: number;
  /** `--table <name=n>`, repeatable. */
  table: string[];
  out?: string;
  format: "csv" | "sql" | "json";
  dryRun: boolean;
}

export interface HauntOptions {
  tests?: string;
  cases: number;
  report: string;
}

export interface TwinOptions {
  from: string;
  to?: string;
  out?: string;
  scale: number;
  format: "csv" | "sql" | "json";
}

export function buildSeedOptions(opts: Opts): SeedOptions {
  const rowsOpt = opt(opts, "rows");
  let rows: number | undefined;
  if (rowsOpt !== undefined) {
    rows = parseNumber(rowsOpt, "--rows");
    if (rows < 1) throw invalidInput("--rows must be at least 1.");
  }
  const format = opt(opts, "format") ?? "csv";
  if (format !== "csv" && format !== "sql" && format !== "json") {
    throw invalidInput(`--format must be csv, sql or json; got "${format}".`);
  }
  const rawTable = opts.table;
  const table = Array.isArray(rawTable) ? rawTable.map(String) : rawTable === undefined ? [] : [String(rawTable)];
  for (const t of table) {
    const m = /^([A-Za-z_][\w$]*|"[^"]+")=(\d+)$/.exec(t);
    if (!m || Number(m[2]) < 1) throw invalidInput(`--table must look like "name=rows", for example "orders=500"; got "${t}".`);
  }
  return { rows, table, out: opt(opts, "out"), format, dryRun: Boolean(opts.dryRun) };
}

export function buildHauntOptions(opts: Opts): HauntOptions {
  let cases = 300;
  const casesOpt = opt(opts, "cases");
  if (casesOpt !== undefined) {
    cases = parseNumber(casesOpt, "--cases");
    if (cases < 1) throw invalidInput("--cases must be at least 1.");
  }
  return { tests: opt(opts, "tests"), cases, report: opt(opts, "report") ?? "haunt-report.json" };
}

export function buildTwinOptions(opts: Opts): TwinOptions {
  let scale: number | undefined;
  const scaleOpt = opt(opts, "scale");
  if (scaleOpt !== undefined) {
    scale = Number(scaleOpt);
    if (!Number.isFinite(scale) || scale <= 0) throw invalidInput("--scale must be a positive number, for example 0.1.");
  }
  const from = opt(opts, "from");
  const to = opt(opts, "to");
  const out = opt(opts, "out");
  if (!from) throw invalidInput("twin needs --from <url>: the database to measure.");
  if (!to && !out) throw invalidInput("twin needs --to <url> or --out <dir>: where to write the synthetic copy.");
  if (to && out) throw invalidInput("Use --to <url> or --out <dir>, not both.");
  const format = opt(opts, "format") ?? "csv";
  if (format !== "csv" && format !== "sql" && format !== "json") throw invalidInput(`--format must be csv, sql or json; got "${format}".`);
  return { from, to, out, scale: scale ?? 1, format };
}

export async function seedHandler(ctx: RunContext, opts: SeedOptions): Promise<void> {
  await runSeed(ctx, opts);
}

export async function hauntHandler(ctx: RunContext, opts: HauntOptions): Promise<void> {
  await runHaunt(ctx, opts);
}

export async function twinHandler(ctx: RunContext, opts: TwinOptions): Promise<void> {
  await runTwin(ctx, opts);
}

export async function activateHandler(ctx: RunContext, key: string): Promise<void> {
  if (!key || key.length < 10) throw invalidInput("activate needs your license key, for example `ghostrow activate GR1.…`. It's in your receipt email and at ghostrow.com/account/licenses.");
  await runActivate(ctx, key);
}

export async function deactivateHandler(ctx: RunContext): Promise<void> {
  await runDeactivate(ctx);
}

export async function statusHandler(ctx: RunContext): Promise<void> {
  await runStatus(ctx);
}

function parseNumber(value: string, label: string): number {
  try {
    return parseSeed(value, label);
  } catch (e) {
    throw invalidInput(e instanceof Error ? e.message : String(e));
  }
}
