import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * A model release is described by one signed manifest, `GRM1.<base64url(JSON)>.<base64url(sig)>`,
 * the same shape as the license tokens: Ed25519 over "GRM1.<payload>". It lists every file with
 * its size and SHA-256, so a download is accepted only if the manifest verifies with a key built
 * into the CLI and every file matches it.
 */
export const MANIFEST_PREFIX = "GRM1";

/** Model signing public keys (SPKI DER, base64). The private key never leaves the release machine. */
export const MODEL_KEYS: Record<string, string> = {
  "grm-2026-11": "MCowBQYDK2VwAyEAAVRsWyMIWke1v84PwS+NsssyBsl+Jh42wDASVy0k9VQ=",
};

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const manifestSchema = z.object({
  v: z.literal(1),
  kid: z.string(),
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string(),
  task: z.literal("column-meaning"),
  feature_version: z.number().int(),
  released_at: z.iso.datetime({ offset: true }),
  files: z.array(
    z.object({
      name: z.string().regex(/^[A-Za-z0-9._-]+$/),
      role: z.enum(["model", "tokenizer", "info", "runtime"]),
      /** `win32-x64`, `linux-x64`, …: runtime files only. */
      platform: z.string().optional(),
      /** Name to give the file on disk (runtime files keep their library names). */
      install_as: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      size: z.number().int().positive(),
      sha256: sha,
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = Manifest["files"][number];

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" };

function keyObjects(keys: Record<string, string>): Record<string, KeyObject> {
  return Object.fromEntries(Object.entries(keys).map(([kid, b64]) => [kid, createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" })]));
}

export function verifyManifest(token: string, keys: Record<string, string> = MODEL_KEYS): ManifestResult {
  if (typeof token !== "string" || token.length > 65_536) return { ok: false, reason: "malformed" };
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== MANIFEST_PREFIX) return { ok: false, reason: "malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const key = keyObjects(keys)[parsed.data.kid];
  if (!key) return { ok: false, reason: "unknown_key" };
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
  return ok ? { ok: true, manifest: parsed.data } : { ok: false, reason: "bad_signature" };
}

export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** This machine's runtime platform name, as used in manifests. */
export function platformId(): string {
  return `${process.platform}-${process.arch}`;
}

/** The files this machine needs: the model, its tokenizer and info, and this platform's runtime. */
export function filesFor(m: Manifest, platform = platformId()): ManifestFile[] {
  return m.files.filter((f) => f.role !== "runtime" || f.platform === platform);
}
