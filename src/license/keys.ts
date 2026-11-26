import { publicKeyFromBase64, type PublicKeys } from "./token.js";

declare const __GHOSTROW_PUBLIC_KEYS__: string | undefined;
declare const __GHOSTROW_API_URL__: string | undefined;

/**
 * The license public keys are built into the CLI (esbuild `define`, from LICENSE_PUBLIC_KEYS
 * at release time). Only an unbundled source run (tests, `npm run dev`) may take them from the
 * environment, so a released build can't be pointed at someone else's signing key.
 */
const BUILT_IN = typeof __GHOSTROW_PUBLIC_KEYS__ === "string" ? __GHOSTROW_PUBLIC_KEYS__ : null;

let cache: PublicKeys | null = null;

export function publicKeys(): PublicKeys {
  if (cache) return cache;
  const json = BUILT_IN ?? process.env.GHOSTROW_PUBLIC_KEYS ?? "{}";
  const map = JSON.parse(json) as Record<string, string>;
  cache = Object.fromEntries(Object.entries(map).map(([kid, b64]) => [kid, publicKeyFromBase64(b64)]));
  return cache;
}

export function hasKeys(): boolean {
  return Object.keys(publicKeys()).length > 0;
}

/** The licensing API. `GHOSTROW_API_URL` can point a build at a test server; tokens are still verified with the built-in keys. */
export function apiBase(): string {
  const built = typeof __GHOSTROW_API_URL__ === "string" ? __GHOSTROW_API_URL__ : "https://ghostrow.com";
  return (process.env.GHOSTROW_API_URL ?? built).replace(/\/+$/, "");
}
