import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * Test-only license authority: a throwaway Ed25519 key pair that signs GR1/GRA1/GRR1 tokens
 * exactly like the site does. Point the CLI at it with GHOSTROW_PUBLIC_KEYS (source runs only).
 */
export function testAuthority(kid = "test") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signToken = (prefix: "GR1" | "GRA1" | "GRR1", payload: object, key: KeyObject = privateKey) => {
    const body = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    return `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`;
  };
  const license = (plan: "plus" | "pro" | "max", over: Record<string, unknown> = {}) =>
    signToken("GR1", {
      v: 1,
      kid,
      lid: over.lid ?? "01JTESTLICENSE0000000000AB",
      plan,
      seats: plan === "max" ? 5 : 1,
      mps: plan === "max" ? null : plan === "pro" ? 3 : 2,
      modes: plan === "max" ? ["seed", "haunt", "twin"] : plan === "pro" ? ["seed", "haunt"] : ["seed"],
      code_aware: plan !== "plus",
      ci: plan === "max",
      byok: plan !== "plus",
      licensee: { name: "Test User", company: "Example GmbH" },
      issued_at: new Date().toISOString(),
      updates_until: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      ...over,
    });
  const activation = (lid: string, fp: string, plan: string, over: Record<string, unknown> = {}) => {
    const now = Date.now();
    return signToken("GRA1", {
      v: 1,
      kid,
      lid,
      mid: "00000000-0000-4000-8000-000000000001",
      fp,
      plan,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30 * 86_400_000).toISOString(),
      grace_until: new Date(now + 44 * 86_400_000).toISOString(),
      ...over,
    });
  };
  return { kid, publicKeys: JSON.stringify({ [kid]: pub }), signToken, license, activation };
}
