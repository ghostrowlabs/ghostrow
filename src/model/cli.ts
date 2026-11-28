import type { RunContext } from "../cli/context.js";
import { invalidInput } from "../cli/errors.js";
import { note, out } from "../cli/output.js";
import { platformId } from "./manifest.js";
import { pullModel, removeModel } from "./pull.js";
import { DEFAULT_MODEL, installedModel, MODELS, releaseUrl, RULE_MODEL } from "./store.js";

const ABOUT: Record<string, string> = {
  [DEFAULT_MODEL]: "column meanings",
  [RULE_MODEL]: "rules between columns and rules from application code (optional, larger)",
};

function modelName(name: string | undefined): string {
  const n = name ?? DEFAULT_MODEL;
  if (!(MODELS as readonly string[]).includes(n)) throw invalidInput(`Unknown model "${n}". Models: ${MODELS.join(", ")}.`);
  return n;
}

/** `ghostrow model pull [name]`: download and verify an on-device model (all plans; needs a connection once). */
export async function runModelPull(ctx: RunContext, name?: string): Promise<void> {
  const n = modelName(name);
  let r;
  try {
    r = await pullModel(n, (line) => note(ctx, `model         ${line}`));
  } catch (e) {
    throw invalidInput(e instanceof Error ? e.message : String(e), `Ghostrow keeps working without the model; the rule engine is used.`);
  }
  const m = r.manifest;
  out(ctx, {
    text: [
      `Installed ${m.name} ${m.version} in ${r.dir}`,
      `  ${r.downloaded.length} file(s) downloaded, ${r.kept.length} already up to date; signature and SHA-256 verified.`,
      r.runtime
        ? m.task === "rule-proposal"
          ? "  The model runs on this machine. It reads schema text (and code with --code); every rule it proposes is checked before it is used."
          : "  The model runs on this machine. Schema text only: no rows or values are read by it."
        : `  This release has no runtime for ${platformId()}; seed uses the rule engine on this machine.`,
    ].join("\n"),
    json: { model: m.name, version: m.version, dir: r.dir, downloaded: r.downloaded, kept: r.kept, runtime: r.runtime, platform: platformId() },
  });
}

export async function runModelStatus(ctx: RunContext): Promise<void> {
  const rows = MODELS.map((n) => ({ n, inst: installedModel(n) }));
  out(ctx, {
    text: [
      ...rows.map(({ n, inst }) =>
        inst
          ? `${inst.manifest.name} ${inst.manifest.version} installed in ${inst.dir}${inst.runtime ? "" : ` (no runtime for ${platformId()}: not used)`}: ${ABOUT[n]}.`
          : `${n} not installed (${ABOUT[n]}). Run \`ghostrow model pull${n === DEFAULT_MODEL ? "" : ` ${n}`}\` to download it from ${releaseUrl(n)}.`,
      ),
      rows.some((r) => r.inst) ? "Turn the models off for one run with --no-model." : "Without a model, seed uses the rule engine (gr-schema-1).",
    ].join("\n"),
    json: Object.fromEntries(rows.map(({ n, inst }) => [n, inst ? { installed: true, version: inst.manifest.version, dir: inst.dir, runtime: inst.runtime, platform: platformId() } : { installed: false }])),
  });
}

export async function runModelRemove(ctx: RunContext, name?: string): Promise<void> {
  const n = modelName(name);
  const removed = removeModel(n);
  out(ctx, { text: removed ? `Removed ${n}.` : `${n} was not installed.`, json: { model: n, removed } });
}
