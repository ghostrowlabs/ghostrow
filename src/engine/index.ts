import { resolve } from "node:path";
import type { RunContext } from "../cli/context.js";
import { constraintUnsatisfied, invalidInput } from "../cli/errors.js";
import type { SeedOptions } from "../cli/handlers.js";
import { fmt, note, out, warn } from "../cli/output.js";
import { insertAll, type Connector, type Row } from "../connect/registry.js";
import type { SchemaModel } from "../connect/types.js";
import { enforceSeedLimit, type Entitlements } from "../entitlements.js";
import { exportRows } from "../export/format.js";
import { generateSeed, rowCounts, type GenOutput } from "../gen/seed.js";
import { validate, type Validation } from "../gen/validate.js";
import { resolveEntitlements } from "../license/gate.js";
import { describeMeaning, type Plan } from "./infer.js";
import { prepare } from "./pipeline.js";
import { writeRulesFile } from "./rulesfile.js";

/**
 * `ghostrow seed`: read the schema → infer meanings and rules → apply the rules file →
 * check plan limits → generate (seeded, parents first) → validate every row →
 * insert in one transaction, or write files. Works offline; Free needs no key.
 */
export async function runSeed(ctx: RunContext, opts: SeedOptions): Promise<void> {
  const ent = await resolveEntitlements();
  for (const n of ent.notices) warn(`note: ${n}`);
  if (!opts.dryRun && !opts.out && !ctx.db) throw invalidInput("Say where the rows go: --out <dir> to write files, or --db <url> to insert into a database.");
  const prep = await prepare(ctx, ent);
  const { schema, plan, connector } = prep;
  try {
    const tableRows = Object.fromEntries(opts.table.map((t) => [t.slice(0, t.lastIndexOf("=")), Number(t.slice(t.lastIndexOf("=") + 1))]));
    for (const name of Object.keys(tableRows)) if (!schema.tables.some((t) => t.name === name)) throw invalidInput(`--table ${name}: no such table. Tables: ${schema.tables.map((t) => t.name).join(", ")}.`);
    const counts = rowCounts(schema, plan, { ...(opts.rows !== undefined ? { rows: opts.rows } : {}), tableRows });
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (!opts.dryRun) enforceSeedLimit(ent, schema.tables.length, total);
    else if (ent.seedLimit && (schema.tables.length > ent.seedLimit.tables || total > ent.seedLimit.rows)) {
      note(ctx, `note: generating this needs more than Free's ${ent.seedLimit.tables} tables / ${fmt(ent.seedLimit.rows)} rows. A dry run is fine; activate a license to write rows.`);
    }

    const rulesPath = resolve(ctx.rules);
    if (opts.dryRun) {
      writeRulesFile(rulesPath, plan, schema);
      reportDryRun(ctx, schema, plan, counts, ent, ctx.rules);
      return;
    }

    const idStart: Record<string, number> = {};
    if (connector) {
      for (const t of schema.tables) {
        const pk = t.primaryKey.length === 1 ? t.columns.find((c) => c.name === t.primaryKey[0]) : undefined;
        if (pk && pk.type === "integer") idStart[t.name] = (await connector.maxValue(t, pk.name)) + 1;
      }
    }
    const existing = connector ? await existingUniqueRows(connector, schema, plan) : undefined;
    const seed = ctx.seed ?? 0;
    const output = generateSeed({ schema, plan, seed, ...(opts.rows !== undefined ? { rows: opts.rows } : {}), tableRows, idStart, ...(existing ? { existing } : {}) });
    const v = validate(output, plan);
    if (v.violations.length) throw violationsError(v);
    writeRulesFile(rulesPath, plan, schema);

    let where: string;
    let files: string[] = [];
    // --out wins over --db: the database is only read (schema, samples, next ids), never written.
    if (connector && !opts.out) {
      await insertAll(connector, output);
      where = `inserted into ${connector.label}`;
    } else {
      files = exportRows(output, resolve(opts.out!), opts.format, schema.dialect);
      where = `wrote ${files.length} ${opts.format.toUpperCase()} file${files.length === 1 ? "" : "s"} to ${opts.out}`;
    }
    out(ctx, {
      text: summary(schema, output, v, where, seed, ent),
      json: { ok: true, plan: ent.plan, seed, rows: v.rows, violations: 0, tables: output.map((o) => ({ table: o.table.name, rows: o.rows.length })), files, rulesFile: ctx.rules, checked: v.checked },
    });
  } finally {
    await connector?.close().catch(() => undefined);
  }
}

/** Existing rows of tables with unique columns (read-only, capped), so new values avoid them. */
export async function existingUniqueRows(c: Connector, schema: SchemaModel, plan: Plan): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  for (const t of schema.tables) {
    if (!plan.rules.some((r) => r.kind === "unique" && r.enabled && r.table === t.name)) continue;
    const rows = await c.readRows(t, 500_000);
    if (rows.length) out.set(t.name, rows);
  }
  return out;
}

export function violationsError(v: Validation) {
  const first = v.violations.slice(0, 8).map((x) => `  ${x.table} row ${x.row}: ${x.rule}`);
  return constraintUnsatisfied(
    `${v.violations.length}${v.violations.length >= 200 ? "+" : ""} generated row(s) would break a rule, so nothing was written:\n${first.join("\n")}`,
    "Check the rule in ghostrow.rules.yaml (switch it off with enabled: false), or adjust row counts.",
  );
}

function summary(schema: SchemaModel, output: GenOutput, v: Validation, where: string, seed: number, ent: Entitlements): string {
  const fks = output.reduce((n, o) => n + o.table.foreignKeys.length, 0);
  const lines = [`ghostrow seed · ${schema.source} · seed ${seed} · ${ent.label}`];
  for (const o of output) lines.push(`  ${o.table.name.padEnd(28)} ${fmt(o.rows.length).padStart(9)} rows`);
  lines.push(`  ${where}`);
  lines.push(`  wrote ${fmt(v.rows)} rows, ${v.violations.length} violations · ${fks} foreign key${fks === 1 ? "" : "s"}, ${v.checked.uniques} unique, ${v.checked.checks} check, ${v.checked.orderings + v.checked.sums} cross-column rules verified`);
  return lines.join("\n");
}

function reportDryRun(ctx: RunContext, schema: SchemaModel, plan: Plan, counts: Map<string, number>, ent: Entitlements, rulesFile: string): void {
  const fks = schema.tables.reduce((n, t) => n + t.foreignKeys.length, 0);
  const lines = [`read schema   ${schema.tables.length} table${schema.tables.length === 1 ? "" : "s"}, ${fks} foreign key${fks === 1 ? "" : "s"} (${schema.source}, ${ent.label})`];
  let first = true;
  for (const t of schema.tables) {
    for (const c of plan.columns.filter((x) => x.table === t.name)) {
      const col = t.columns.find((x) => x.name === c.column)!;
      const flags = [col.primaryKey ? "primary key" : null, col.unique ? "unique" : null, c.values ? `one of ${c.values.slice(0, 5).join("/")}${c.values.length > 5 ? "/…" : ""}` : null, c.pattern ? `matches /${c.pattern}/` : null].filter(Boolean);
      const sum = plan.rules.find((r) => r.kind === "sum" && r.enabled && r.table === t.name && r.column === c.column);
      const product = plan.rules.find((r) => r.kind === "product" && r.enabled && r.table === t.name && r.column === c.column);
      const what = sum && sum.kind === "sum" ? `sum of ${sum.childTable}.${sum.childColumn}` : product && product.kind === "product" ? `${product.factors[0]} × ${product.factors[1]}` : describeMeaning(c);
      lines.push(`${first ? "understood   " : "             "} ${`${t.name}.${c.column}`.padEnd(32)} ${[what, ...flags].join(", ")}  (${c.confidence.toFixed(2)}, ${c.evidence})`);
      first = false;
    }
  }
  const shown = plan.rules.filter((r) => r.kind !== "fk" && r.kind !== "unique");
  first = true;
  for (const r of shown) {
    lines.push(`${first ? "rules        " : "             "} ${r.enabled ? "" : "[off] "}${r.table}: ${r.expr}  (${r.evidence})`);
    first = false;
  }
  lines.push(`rows          ${[...counts.entries()].map(([t, n]) => `${t} ${fmt(n)}`).join(", ")} (with the current --rows)`);
  lines.push(`rules         saved to ${rulesFile}`);
  out(ctx, {
    text: lines.join("\n"),
    json: {
      tables: schema.tables.length,
      foreignKeys: fks,
      columns: plan.columns,
      rules: plan.rules.map((r) => ({ id: r.id, kind: r.kind, table: r.table, expr: r.expr, evidence: r.evidence, enabled: r.enabled, source: r.source })),
      rows: Object.fromEntries(counts),
      rulesFile,
    },
  });
}

export type { Connector };
