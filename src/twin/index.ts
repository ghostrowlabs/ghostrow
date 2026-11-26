import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunContext } from "../cli/context.js";
import { invalidInput } from "../cli/errors.js";
import type { TwinOptions } from "../cli/handlers.js";
import { fmt, note, out, warn } from "../cli/output.js";
import { insertAll, openConnector, type Connector } from "../connect/registry.js";
import { parseDbUrl } from "../connect/types.js";
import { prepare } from "../engine/pipeline.js";
import { measureDatabase, shapeOf } from "../engine/sampling.js";
import { existingUniqueRows, violationsError } from "../engine/index.js";
import { requireDatabase, requireMode } from "../entitlements.js";
import { exportRows } from "../export/format.js";
import { generateSeed } from "../gen/seed.js";
import { validate } from "../gen/validate.js";
import { resolveEntitlements } from "../license/gate.js";

/**
 * `ghostrow twin` (Max): measure a database on this machine — row counts, null rates,
 * distributions, how many children each parent has — and generate a synthetic copy with
 * the same shape. No real row is copied; personal fields get synthetic values, and a
 * category value is reused only if at least 5 rows share it.
 */
export async function runTwin(ctx: RunContext, opts: TwinOptions): Promise<void> {
  const ent = await resolveEntitlements();
  for (const n of ent.notices) warn(`note: ${n}`);
  requireMode(ent, "twin");
  if (opts.to) requireDatabase(ent, parseDbUrl(opts.to).kind);

  const prep = await prepare(ctx, ent, { db: opts.from });
  const source = prep.connector!;
  let target: Connector | null = null;
  try {
    note(ctx, `measuring     ${source.label} (${prep.schema.tables.length} tables, read-only)`);
    const profiles = await measureDatabase(source, prep.schema, prep.plan);
    await source.close();

    const tableRows: Record<string, number> = {};
    for (const [name, p] of profiles) tableRows[name] = Math.max(p.rows > 0 ? 1 : 0, Math.round(p.rows * opts.scale));
    const idStart: Record<string, number> = {};
    if (opts.to) {
      target = await openConnector(opts.to);
      const targetSchema = await target.inspect();
      const missing = prep.schema.tables.filter((t) => !targetSchema.tables.some((x) => x.name === t.name));
      if (missing.length) throw invalidInput(`The target database is missing ${missing.length} table(s): ${missing.slice(0, 5).map((t) => t.name).join(", ")}. Create the schema there first (for example with your migrations).`);
      for (const t of prep.schema.tables) {
        const pk = t.primaryKey.length === 1 ? t.columns.find((c) => c.name === t.primaryKey[0]) : undefined;
        if (pk?.type === "integer") idStart[t.name] = (await target.maxValue(t, pk.name)) + 1;
      }
    }
    const seed = ctx.seed ?? 0;
    const existing = target ? await existingUniqueRows(target, prep.schema, prep.plan) : undefined;
    const output = generateSeed({ schema: prep.schema, plan: prep.plan, seed, tableRows, idStart, profiles, ...(existing ? { existing } : {}) });
    const v = validate(output, prep.plan);
    if (v.violations.length) throw violationsError(v);

    let where: string;
    const files: string[] = [];
    if (target) {
      await insertAll(target, output);
      where = `inserted into ${target.label}`;
    } else {
      const dir = resolve(opts.out!);
      files.push(...exportRows(output, dir, opts.format, prep.schema.dialect));
      where = `wrote ${files.length} ${opts.format.toUpperCase()} file${files.length === 1 ? "" : "s"} to ${opts.out}`;
    }

    // Shape report: aggregate statistics only.
    const report = output.map(({ table, rows }) => {
      const p = profiles.get(table.name)!;
      const synth = shapeOf(table, rows, prep.plan);
      return {
        table: table.name,
        sourceRows: p.rows,
        twinRows: rows.length,
        columns: table.columns.map((c) => {
          const a = p.columns.get(c.name);
          const b = synth.get(c.name);
          const mid = (q?: number[]) => (q && q.length ? q[Math.floor(q.length / 2)] : null);
          return { column: c.name, nullRate: [round3(a?.nullRate), round3(b?.nullRate)], median: [mid(a?.quantiles), mid(b?.quantiles)], categories: a?.categories?.length ?? 0 };
        }),
      };
    });
    if (opts.out) writeFileSync(join(resolve(opts.out), "twin-report.json"), `${JSON.stringify({ engine: prep.plan.engine, scale: opts.scale, seed, tables: report }, null, 2)}\n`);

    const lines = [`ghostrow twin · ${prep.schema.source} → ${target ? target.label : opts.out} · scale ${opts.scale} · ${ent.label}`];
    for (const r of report) lines.push(`  ${r.table.padEnd(28)} ${fmt(r.sourceRows).padStart(10)} measured → ${fmt(r.twinRows).padStart(10)} synthetic`);
    lines.push(`  ${where}${opts.out ? " (+ twin-report.json)" : ""}`);
    lines.push(`  ${fmt(v.rows)} rows, 0 violations · no source row copied; categories reused only when shared by ≥5 rows`);
    out(ctx, { text: lines.join("\n"), json: { ok: true, seed, scale: opts.scale, rows: v.rows, violations: 0, tables: report, files } });
  } finally {
    await source.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
  }
}

const round3 = (x?: number) => (x === undefined ? null : Math.round(x * 1000) / 1000);
