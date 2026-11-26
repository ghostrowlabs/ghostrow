import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../license/store.js";
import { filesFor, MODEL_KEYS, platformId, verifyManifest, type Manifest } from "./manifest.js";

/** The model Ghostrow uses by default, and where its releases live. */
export const DEFAULT_MODEL = "gr-col-1";
export const MODEL_RELEASE_BASE = "https://github.com/ghostrowlabs/ghostrow/releases/download";

/** `GHOSTROW_MODEL_URL` points pulls at another folder of release files (a test server, a mirror). */
export function releaseUrl(name: string): string {
  return (process.env.GHOSTROW_MODEL_URL ?? `${MODEL_RELEASE_BASE}/model-${name}`).replace(/\/+$/, "");
}

export function modelsDir(): string {
  return join(homeDir(), "models");
}

export function modelDir(name = DEFAULT_MODEL): string {
  return join(modelsDir(), name);
}

export function runtimeDir(name = DEFAULT_MODEL): string {
  return join(modelDir(name), "runtime", platformId());
}

export interface Installed {
  name: string;
  dir: string;
  manifest: Manifest;
  /** Runtime files for this platform are present. */
  runtime: boolean;
}

/**
 * The installed model, if its manifest still verifies. File hashes are checked at pull time;
 * at run time only presence is checked, so a run doesn't hash 150 MB.
 */
export function installedModel(name = DEFAULT_MODEL, keys: Record<string, string> = MODEL_KEYS): Installed | null {
  const dir = modelDir(name);
  const mf = join(dir, "manifest.grm");
  if (!existsSync(mf)) return null;
  const v = verifyManifest(readFileSync(mf, "utf8"), keys);
  if (!v.ok) return null;
  const files = filesFor(v.manifest);
  const present = (f: (typeof files)[number]) => existsSync(f.role === "runtime" ? join(runtimeDir(name), f.install_as ?? f.name) : join(dir, f.name));
  if (!files.filter((f) => f.role !== "runtime").every(present)) return null;
  const rt = files.filter((f) => f.role === "runtime");
  return { name, dir, manifest: v.manifest, runtime: rt.length > 0 && rt.every(present) };
}
