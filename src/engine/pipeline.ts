import { resolve } from "node:path";
import type { RunContext } from "../cli/context.js";
import { invalidInput } from "../cli/errors.js";
import { note, warn } from "../cli/output.js";
import { applyCodeRules, scanCode } from "../code/index.js";
import { loadSchema } from "../connect/load.js";
import { openConnector, type Connector } from "../connect/registry.js";
import { parseDbUrl, type SampleSet, type SchemaModel } from "../connect/types.js";
import { requireCodeAware, requireDatabase, type Entitlements } from "../entitlements.js";
import { byokConfig, refineWithByok } from "./byok.js";
import { infer, type Plan } from "./infer.js";
import { mergeRules, readRulesFile } from "./rulesfile.js";
import { refineWithModel } from "../model/classify.js";
import { installedModel } from "../model/store.js";

export interface Prepared {
  schema: SchemaModel;
  plan: Plan;
  connector: Connector | null;
  codeRules: number;
  byok: { provider: string; changed: number } | null;
  /** The schema model's part in this run, when one is installed and not turned off. */
  model: { name: string; changed: number; asked: number } | null;
}

const SAMPLE_ROWS = 50;

/**
 * The shared front half of every mode: read the schema (live database or files), sample a
 * few rows to confirm meanings, infer the plan, add rules from code (Pro, Max) and your AI
 * provider (opt-in), then apply ghostrow.rules.yaml.
 */
export async function prepare(ctx: RunContext, ent: Entitlements, source: { db?: string; schema?: string } = { db: ctx.db, schema: ctx.schema }): Promise<Prepared> {
  if (source.db && source.schema) throw invalidInput("Use --db or --schema, not both.");
  if (!source.db && !source.schema) throw invalidInput("Point Ghostrow at a database with --db <url>, or at a schema file or folder with --schema <path>.");
  let schema: SchemaModel;
  let connector: Connector | null = null;
  let samples: SampleSet | undefined;
  if (source.schema) {
    try {
      schema = loadSchema(resolve(source.schema));
    } catch (e) {
      throw invalidInput(e instanceof Error ? e.message : String(e));
    }
  } else {
    let kind;
    try {
      kind = parseDbUrl(source.db!).kind;
    } catch (e) {
      throw invalidInput(e instanceof Error ? e.message : String(e));
    }
    requireDatabase(ent, kind);
    try {
      connector = await openConnector(source.db!);
      schema = await connector.inspect();
      samples = new Map();
      for (const t of schema.tables) samples.set(t.name, await connector.readRows(t, SAMPLE_ROWS));
    } catch (e) {
      await connector?.close().catch(() => undefined);
      throw invalidInput(e instanceof Error ? e.message : String(e));
    }
  }
  if (schema.tables.length === 0) {
    await connector?.close();
    throw invalidInput(`No tables found in ${schema.source}.`);
  }

  const plan = infer(schema, samples);
  // The on-device model (all plans) proposes meanings; the rule engine's checks decide. Any failure
  // falls back to the rule engine: a missing or broken model never stops a run.
  let model: Prepared["model"] = null;
  if (!ctx.noModel) {
    const inst = installedModel();
    if (inst && !inst.runtime) note(ctx, "model         installed, but this release has no runtime for this platform; using the rule engine");
    else if (inst) {
      try {
        const r = await refineWithModel(plan, schema, inst);
        if (r) {
          model = { name: r.model, changed: r.changed, asked: r.asked };
          note(ctx, `model         ${r.model} relabelled ${r.changed} of ${r.asked} column(s) in ${r.ms} ms, on this machine`);
        }
      } catch (e) {
        warn(`model         skipped: ${e instanceof Error ? e.message : String(e)}. Using the rule engine only.`);
      }
    }
  }
  let codeRules = 0;
  if (ctx.codeDir) {
    requireCodeAware(ent);
    const found = scanCode(resolve(ctx.codeDir));
    const applied = applyCodeRules(plan, schema, found);
    codeRules = applied.applied.length;
    note(ctx, `read code     ${found.length} validator rule(s) in ${ctx.codeDir}; ${applied.applied.length} applied${applied.unmatched ? `, ${applied.unmatched} didn't match a table` : ""}`);
  }
  let byok: Prepared["byok"] = null;
  // A misconfigured provider (unknown name, missing key) never stops a run: warn and use the built-in engine.
  let cfg: ReturnType<typeof byokConfig> = null;
  try {
    cfg = byokConfig();
  } catch (e) {
    warn(`ai provider   skipped: ${e instanceof Error ? e.message : String(e)} Using the built-in engine only.`);
  }
  if (cfg) {
    if (!ent.byok) note(ctx, "GHOSTROW_AI_PROVIDER is set, but bring-your-own-key needs Pro or Max. Using the built-in engine only.");
    else {
      try {
        const r = await refineWithByok(plan, schema, cfg);
        byok = { provider: r.provider, changed: r.changed };
        note(ctx, `ai provider   ${r.provider} (${r.model}) relabelled ${r.changed} of ${r.asked} uncertain column(s); schema text only`);
      } catch (e) {
        note(ctx, `ai provider   skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  let merged;
  try {
    merged = mergeRules(plan, schema, readRulesFile(resolve(ctx.rules)));
  } catch (e) {
    await connector?.close();
    throw invalidInput(e instanceof Error ? e.message : String(e));
  }
  for (const n of merged.notes) note(ctx, `rules file    ${n}`);
  return { schema, plan: merged.plan, connector, codeRules, byok, model };
}
