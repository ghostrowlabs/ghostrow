/**
 * Deterministic pseudo-randomness. No Date.now(), no Math.random(), no locale.
 * A seed plus a stable per-(table.column) key derives an independent, repeatable
 * stream, so the same `--seed` yields byte-identical output on every machine.
 */

/** FNV-1a over the UTF-8 bytes of `s`. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mix a 32-bit stream into an initial state (splits a seed into independent sub-streams). */
export function subStream(seed: number, key: string): number {
  let s = (seed >>> 0) ^ fnv1a(key);
  s = Math.imul(s, 0x9e3779b9) >>> 0;
  s = Math.imul(s ^ (s >>> 15), 0x85ebca6b) >>> 0;
  s ^= s >>> 13;
  s = Math.imul(s, 0xc2b2ae35) >>> 0;
  s ^= s >>> 16;
  return s >>> 0;
}

/**
 * mulberry32: a compact, fast 32-bit PRNG with good statistical properties.
 * Returns a function that yields the next unsigned 32-bit int.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent stream for one logical purpose. */
export function streamFor(seed: number, key: string): () => number {
  return mulberry32(subStream(seed, key));
}

/** Pick the nth of n items using a 0..1 value — stable across machines. */
export function pick<T>(values: readonly T[], r: number): T {
  if (values.length === 0) throw new Error("pick from an empty set");
  // Clamp the float to a valid index (Math.floor of a float times length).
  const i = Math.min(values.length - 1, Math.floor(r * values.length));
  const v = values[i];
  return (v === undefined ? values[0] : v) as T;
}

/**
 * SHA-256 hex (lowercase) of `s` — used for the license machine fingerprint,
 * and for stable surrogate keys derived from ordinal slots.
 */
export async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** A small helper around one deterministic stream. */
export class Rng {
  private readonly next: () => number;
  constructor(seed: number, key: string) {
    this.next = streamFor(seed, key);
  }
  /** 0 ≤ x < 1 */
  float(): number {
    return this.next();
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(values: readonly T[]): T {
    return pick(values, this.next());
  }
  /** Earlier items are likelier (rough Zipf), for realistic skew. */
  skewed<T>(values: readonly T[], power = 1.6): T {
    return pick(values, this.next() ** power);
  }
  digits(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += String(Math.floor(this.next() * 10));
    return s;
  }
  alnum(n: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"): string {
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(this.next() * alphabet.length)]!;
    return s;
  }
}
