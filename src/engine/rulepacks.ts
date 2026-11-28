import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { RulesFile } from "./rulesfile.js";

/**
 * Shared rule packs (Max): `extends:` in ghostrow.rules.yaml names other rules files, by path
 * (relative to the file that names it) or by https URL. A pack has the same format as a rules
 * file. Packs apply in order, each after the packs it extends, and your own file applies last,
 * so your edits always win. A pack that can't be read stops the run: the same rules must give
 * the same rows, so a missing pack is never skipped silently.
 *
 * Fetching a pack only downloads it. Nothing about your schema or data is sent.
 */

export interface LoadedPack {
  /** As written in `extends:`, resolved: an absolute path or an https URL. */
  ref: string;
  file: RulesFile;
}

const MAX_DEPTH = 5;
const MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 15_000;

/** The `extends:` entries of a rules file, as a list. */
export function extendsOf(file: RulesFile | null): string[] {
  const e = file?.extends;
  if (e === undefined || e === null) return [];
  const list = Array.isArray(e) ? e : [e];
  return list.map((x) => {
    if (typeof x !== "string" || !x.trim()) throw new Error(`"extends" must be a path or an https URL, or a list of them; got ${JSON.stringify(x)}.`);
    return x.trim();
  });
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

function resolveRef(ref: string, base: string): string {
  if (isUrl(ref)) {
    if (!ref.toLowerCase().startsWith("https://")) throw new Error(`Rule pack ${ref}: only https URLs are allowed.`);
    return ref;
  }
  // Relative to the file that names it: a folder for local files, the URL for remote packs.
  if (isUrl(base)) return new URL(ref, base).toString();
  return resolve(base, ref);
}

async function readPack(ref: string): Promise<RulesFile> {
  let text: string;
  if (isUrl(ref)) {
    let res: Response;
    try {
      res = await fetch(ref, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    } catch (e) {
      throw new Error(`Rule pack ${ref} could not be downloaded: ${e instanceof Error ? e.message : String(e)}.`);
    }
    if (!res.ok) throw new Error(`Rule pack ${ref} could not be downloaded: HTTP ${res.status}.`);
    text = await res.text();
  } else {
    if (!existsSync(ref)) throw new Error(`Rule pack ${ref} does not exist.`);
    text = readFileSync(ref, "utf8");
  }
  if (text.length > MAX_BYTES) throw new Error(`Rule pack ${ref} is larger than 1 MB.`);
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`Rule pack ${ref} is not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`Rule pack ${ref} is not a rules file (expected "tables", "rules" or "extends").`);
  return doc as RulesFile;
}

/**
 * Load every pack the rules file extends, depth first, in the order they apply.
 * `rulesPath` is the rules file itself; relative entries resolve against its folder.
 */
export async function loadPacks(file: RulesFile | null, rulesPath: string): Promise<LoadedPack[]> {
  const out: LoadedPack[] = [];
  const seen = new Set<string>();
  async function visit(refs: string[], base: string, depth: number, chain: string[]): Promise<void> {
    for (const raw of refs) {
      const ref = resolveRef(raw, base);
      if (chain.includes(ref)) throw new Error(`Rule pack ${ref} extends itself (${[...chain, ref].join(" -> ")}).`);
      if (seen.has(ref)) continue;
      if (depth > MAX_DEPTH) throw new Error(`Rule packs are nested more than ${MAX_DEPTH} levels deep at ${ref}.`);
      const pack = await readPack(ref);
      await visit(extendsOf(pack), isUrl(ref) ? ref : dirname(ref), depth + 1, [...chain, ref]);
      seen.add(ref);
      out.push({ ref, file: pack });
    }
  }
  await visit(extendsOf(file), dirname(resolve(rulesPath)), 1, [resolve(rulesPath)]);
  return out;
}

/** "packs/shop.yaml" rather than a long absolute path, for notes and evidence. */
export function packLabel(ref: string, rulesPath: string): string {
  if (isUrl(ref)) return ref;
  const base = dirname(resolve(rulesPath));
  return ref.startsWith(base) ? ref.slice(base.length + 1).replace(/\\/g, "/") : ref;
}
