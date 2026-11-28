import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { filesFor, MODEL_KEYS, platformId, verifyManifest, type Manifest, type ManifestFile } from "./manifest.js";
import { DEFAULT_MODEL, modelDir, releaseUrl, runtimeDir } from "./store.js";

export interface PullResult {
  manifest: Manifest;
  downloaded: string[];
  kept: string[];
  runtime: boolean;
  dir: string;
}

async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

async function get(url: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, { redirect: "follow", headers: { "user-agent": "ghostrow-cli" } });
  } catch (e) {
    throw new Error(`Couldn't reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!r.ok) throw new Error(`${url} answered ${r.status}.`);
  return r;
}

/**
 * Download a model release: the signed manifest first, then each file this machine needs.
 * Nothing is installed unless the manifest verifies with a built-in key and every file matches
 * its size and SHA-256. Files already present with the right hash are kept.
 */
export async function pullModel(name = DEFAULT_MODEL, progress: (line: string) => void = () => undefined, keys: Record<string, string> = MODEL_KEYS): Promise<PullResult> {
  const base = releaseUrl(name);
  const token = (await (await get(`${base}/manifest.grm`)).text()).trim();
  const v = verifyManifest(token, keys);
  if (!v.ok) throw new Error(`The model manifest from ${base} didn't verify (${v.reason.replace("_", " ")}). Nothing was installed.`);
  const m = v.manifest;
  if (m.name !== name) throw new Error(`The manifest is for ${m.name}, not ${name}. Nothing was installed.`);
  const task = ({ "gr-col-1": "column-meaning", "gr-rules-1": "rule-proposal" } as Record<string, string>)[name];
  if (task && m.task !== task) throw new Error(`The manifest for ${name} is for the task ${m.task}, not ${task}. Nothing was installed.`);
  const dir = modelDir(name);
  const rt = runtimeDir(name);
  mkdirSync(rt, { recursive: true });
  const target = (f: ManifestFile) => (f.role === "runtime" ? join(rt, f.install_as ?? f.name) : join(dir, f.name));
  const files = filesFor(m);
  const downloaded: string[] = [];
  const kept: string[] = [];
  for (const f of files) {
    const dest = target(f);
    if (existsSync(dest) && statSync(dest).size === f.size && (await hashFile(dest)) === f.sha256) {
      kept.push(f.name);
      continue;
    }
    progress(`downloading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)`);
    const tmp = `${dest}.part`;
    const r = await get(`${base}/${f.name}`);
    if (!r.body) throw new Error(`Empty response for ${f.name}.`);
    const h = createHash("sha256");
    let size = 0;
    const body = Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (c: Buffer) => {
      h.update(c);
      size += c.length;
      if (size > f.size) body.destroy(new Error(`${f.name} is larger than the manifest says.`));
    });
    try {
      await pipeline(body, createWriteStream(tmp));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    const digest = h.digest("hex");
    if (size !== f.size || digest !== f.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`${f.name} doesn't match the signed manifest (size ${size}, sha256 ${digest.slice(0, 12)}…). Nothing more was installed.`);
    }
    renameSync(tmp, dest);
    downloaded.push(f.name);
  }
  // The manifest goes in last: an interrupted pull leaves no model that looks installed.
  writeFileSync(join(dir, "manifest.grm"), `${token}\n`);
  return { manifest: m, downloaded, kept, runtime: files.some((f) => f.role === "runtime"), dir };
}

export function removeModel(name = DEFAULT_MODEL): boolean {
  const dir = modelDir(name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export { platformId };
