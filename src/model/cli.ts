import type { RunContext } from "../cli/context.js";
import { invalidInput } from "../cli/errors.js";
import { note, out } from "../cli/output.js";
import { platformId } from "./manifest.js";
import { pullModel, removeModel } from "./pull.js";
import { DEFAULT_MODEL, installedModel, releaseUrl } from "./store.js";

/** `ghostrow model pull`: download and verify the schema model (all plans; needs a connection once). */
export async function runModelPull(ctx: RunContext): Promise<void> {
  let r;
  try {
    r = await pullModel(DEFAULT_MODEL, (line) => note(ctx, `model         ${line}`));
  } catch (e) {
    throw invalidInput(e instanceof Error ? e.message : String(e), `Ghostrow keeps working without the model; the rule engine is used.`);
  }
  const m = r.manifest;
  out(ctx, {
    text: [
      `Installed ${m.name} ${m.version} in ${r.dir}`,
      `  ${r.downloaded.length} file(s) downloaded, ${r.kept.length} already up to date; signature and SHA-256 verified.`,
      r.runtime ? "  The model runs on this machine. Schema text only: no rows or values are read by it." : `  This release has no runtime for ${platformId()}; seed uses the rule engine on this machine.`,
    ].join("\n"),
    json: { model: m.name, version: m.version, dir: r.dir, downloaded: r.downloaded, kept: r.kept, runtime: r.runtime, platform: platformId() },
  });
}

export async function runModelStatus(ctx: RunContext): Promise<void> {
  const inst = installedModel();
  out(ctx, {
    text: inst
      ? `${inst.manifest.name} ${inst.manifest.version} installed in ${inst.dir}${inst.runtime ? "" : ` (no runtime for ${platformId()}: not used)`}.\nTurn it off for one run with --no-model.`
      : `No model installed. Seed uses the rule engine (gr-schema-1).\nRun \`ghostrow model pull\` to download ${DEFAULT_MODEL} from ${releaseUrl(DEFAULT_MODEL)}.`,
    json: inst ? { installed: true, model: inst.manifest.name, version: inst.manifest.version, dir: inst.dir, runtime: inst.runtime, platform: platformId() } : { installed: false, model: DEFAULT_MODEL },
  });
}

export async function runModelRemove(ctx: RunContext): Promise<void> {
  const removed = removeModel();
  out(ctx, { text: removed ? `Removed ${DEFAULT_MODEL}.` : "No model was installed.", json: { removed } });
}
