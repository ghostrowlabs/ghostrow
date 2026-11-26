import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * Signed tokens, verified offline. Mirrors the site's src/lib/licensing/token.ts exactly:
 * `<PREFIX>.<base64url(JSON)>.<base64url(Ed25519 signature over "<PREFIX>.<payload>")>`.
 *   GR1  license key · GRA1 machine activation · GRR1 revocation list
 */

export const PREFIX = { license: "GR1", activation: "GRA1", revocations: "GRR1" } as const;
export type TokenKind = keyof typeof PREFIX;

const plan = z.enum(["free", "plus", "pro", "max"]);
const iso = z.iso.datetime({ offset: true });

export const licensePayloadSchema = z.object({
  v: z.literal(1),
  kid: z.string(),
  lid: z.string(),
  plan,
  seats: z.number().int().min(1),
  mps: z.number().int().min(1).nullable(),
  modes: z.array(z.enum(["seed", "haunt", "twin"])),
  code_aware: z.boolean(),
  ci: z.boolean(),
  byok: z.boolean(),
  licensee: z.object({ name: z.string(), company: z.string().optional() }),
  issued_at: iso,
  updates_until: iso.nullable(),
});

export const activationPayloadSchema = z.object({
  v: z.literal(1),
  kid: z.string(),
  lid: z.string(),
  mid: z.string(),
  fp: z.string(),
  plan,
  issued_at: iso,
  expires_at: iso,
  grace_until: iso,
});

export const revocationsPayloadSchema = z.object({
  v: z.literal(1),
  kid: z.string(),
  issued_at: iso,
  revoked: z.array(z.object({ lid: z.string(), at: iso })),
});

export type LicensePayload = z.infer<typeof licensePayloadSchema>;
export type ActivationPayload = z.infer<typeof activationPayloadSchema>;
export type RevocationsPayload = z.infer<typeof revocationsPayloadSchema>;

const schemas = { license: licensePayloadSchema, activation: activationPayloadSchema, revocations: revocationsPayloadSchema };
type PayloadOf<K extends TokenKind> = z.infer<(typeof schemas)[K]>;

export type PublicKeys = Record<string, KeyObject>;
export type VerifyResult<K extends TokenKind> = { ok: true; payload: PayloadOf<K> } | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" };

export function verifyToken<K extends TokenKind>(kind: K, token: string, keys: PublicKeys): VerifyResult<K> {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX[kind]) return { ok: false, reason: "malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = schemas[kind].safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const key = keys[parsed.data.kid];
  if (!key) return { ok: false, reason: "unknown_key" };
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
  return ok ? { ok: true, payload: parsed.data as PayloadOf<K> } : { ok: false, reason: "bad_signature" };
}

/** SPKI DER (base64) → Ed25519 public key. */
export function publicKeyFromBase64(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("license public key must be Ed25519");
  return key;
}
