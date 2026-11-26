import { describe, expect, it } from "vitest";
import { Rng } from "../../src/engine/prng.js";
import { compilePattern, sampleRegex } from "../../src/engine/regex.js";

const PATTERNS = [
  String.raw`^[A-Z]{3}-\d{4}$`,
  String.raw`^(GB|DE)\d{9}$`,
  String.raw`^[a-z0-9_]{3,12}$`,
  String.raw`^\+94\d{9}$`,
  String.raw`^[A-F0-9]{8}$`,
];

describe("sampleRegex", () => {
  for (const pattern of PATTERNS) {
    it(`generates strings matching ${pattern}`, () => {
      const re = new RegExp(pattern);
      for (let seed = 1; seed <= 50; seed++) {
        const s = sampleRegex(pattern, new Rng(seed, "t.c"));
        expect(s).not.toBeNull();
        expect(re.test(s!), `${s} should match ${pattern}`).toBe(true);
      }
    });
  }

  it("is deterministic for the same seed and key", () => {
    const a = Array.from({ length: 10 }, (_, i) => sampleRegex(PATTERNS[0]!, new Rng(42 + i, "k")));
    const b = Array.from({ length: 10 }, (_, i) => sampleRegex(PATTERNS[0]!, new Rng(42 + i, "k")));
    expect(a).toEqual(b);
  });

  it("varies across seeds", () => {
    const set = new Set(Array.from({ length: 30 }, (_, i) => sampleRegex(PATTERNS[0]!, new Rng(i, "k"))));
    expect(set.size).toBeGreaterThan(20);
  });

  it("differs across keys with the same seed", () => {
    const a = sampleRegex(PATTERNS[4]!, new Rng(7, "a"));
    const b = sampleRegex(PATTERNS[4]!, new Rng(7, "b"));
    expect(a).not.toBe(b);
  });

  it("returns null for back-references", () => {
    expect(sampleRegex(String.raw`(a)\1`, new Rng(1, "k"))).toBeNull();
  });

  it("returns null for lookarounds", () => {
    expect(sampleRegex(String.raw`^(?=.*\d)[a-z0-9]{6}$`, new Rng(1, "k"))).toBeNull();
    expect(sampleRegex(String.raw`^(?!foo)[a-z]{3}$`, new Rng(1, "k"))).toBeNull();
    expect(sampleRegex(String.raw`(?<=a)b`, new Rng(1, "k"))).toBeNull();
  });

  it("returns null for negated class escapes and unclosed groups", () => {
    expect(sampleRegex(String.raw`\D+`, new Rng(1, "k"))).toBeNull();
    expect(sampleRegex("(abc", new Rng(1, "k"))).toBeNull();
  });

  it("supports optional, star, plus, and non-capturing groups", () => {
    const re = /^(?:ab)+c?d*$/;
    for (let seed = 0; seed < 30; seed++) {
      const s = sampleRegex("^(?:ab)+c?d*$", new Rng(seed, "k"));
      expect(s).not.toBeNull();
      expect(re.test(s!)).toBe(true);
    }
  });

  it("supports negated classes", () => {
    const re = /^[^0-9]{4}$/;
    for (let seed = 0; seed < 20; seed++) expect(re.test(sampleRegex("^[^0-9]{4}$", new Rng(seed, "k"))!)).toBe(true);
  });

  it("honours escaped literals", () => {
    expect(sampleRegex(String.raw`^a\.b\-c$`, new Rng(1, "k"))).toBe("a.b-c");
  });

  it("compilePattern is null for unsupported constructs and non-null otherwise", () => {
    expect(compilePattern("^[A-Z]{2}$")).not.toBeNull();
    expect(compilePattern(String.raw`(a)\1`)).toBeNull();
  });
});
