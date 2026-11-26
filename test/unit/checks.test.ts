import { describe, expect, it } from "vitest";
import { evaluate, parseCheck, planChecks, type ColumnLimits } from "../../src/engine/checks.js";

const ev = (expr: string, row: Record<string, unknown>) => {
  const tree = parseCheck(expr);
  if (!tree) throw new Error(`could not parse: ${expr}`);
  return evaluate(tree, row);
};
const limits = (expr: string, col: string): ColumnLimits => {
  const { plan, parsed } = planChecks([expr]);
  expect(parsed[0]!.understood).toBe(true);
  const l = plan.limits.get(col);
  if (!l) throw new Error(`no limits for ${col}`);
  return l;
};

describe("parseCheck + evaluate", () => {
  it("evaluates comparisons", () => {
    expect(ev("price > 0", { price: 5 })).toBe(true);
    expect(ev("price > 0", { price: 0 })).toBe(false);
    expect(ev("price >= 0", { price: 0 })).toBe(true);
    expect(ev("a <> b", { a: 1, b: 2 })).toBe(true);
    expect(ev("a != b", { a: 2, b: 2 })).toBe(false);
  });

  it("returns null (unknown) when a column is NULL", () => {
    expect(ev("price > 0", { price: null })).toBeNull();
    expect(ev("price > 0", {})).toBeNull();
    expect(ev("x BETWEEN 1 AND 5", { x: null })).toBeNull();
    expect(ev("s IN ('a','b')", { s: null })).toBeNull();
    expect(ev("s LIKE '%@%'", { s: null })).toBeNull();
  });

  it("applies three-valued AND / OR / NOT", () => {
    expect(ev("a > 0 AND b > 0", { a: 1, b: null })).toBeNull();
    expect(ev("a > 0 AND b > 0", { a: -1, b: null })).toBe(false);
    expect(ev("a > 0 OR b > 0", { a: 1, b: null })).toBe(true);
    expect(ev("a > 0 OR b > 0", { a: -1, b: null })).toBeNull();
    expect(ev("NOT (a > 0)", { a: null })).toBeNull();
    expect(ev("NOT (a > 0)", { a: -1 })).toBe(true);
  });

  it("evaluates BETWEEN inclusively", () => {
    expect(ev("x BETWEEN 1 AND 5", { x: 1 })).toBe(true);
    expect(ev("x BETWEEN 1 AND 5", { x: 5 })).toBe(true);
    expect(ev("x BETWEEN 1 AND 5", { x: 6 })).toBe(false);
    expect(ev("x NOT BETWEEN 1 AND 5", { x: 6 })).toBe(true);
  });

  it("evaluates IN and NOT IN", () => {
    expect(ev("status IN ('a','b')", { status: "a" })).toBe(true);
    expect(ev("status IN ('a','b')", { status: "c" })).toBe(false);
    expect(ev("status NOT IN ('a','b')", { status: "c" })).toBe(true);
  });

  it("evaluates IS NULL / IS NOT NULL (never unknown)", () => {
    expect(ev("c IS NULL", { c: null })).toBe(true);
    expect(ev("c IS NOT NULL", { c: null })).toBe(false);
    expect(ev("c IS NULL OR c > 0", { c: null })).toBe(true);
    expect(ev("c IS NULL OR c > 0", { c: -3 })).toBe(false);
  });

  it("evaluates length functions", () => {
    expect(ev("length(nic) IN (10, 12)", { nic: "123456789V" })).toBe(true);
    expect(ev("length(nic) IN (10, 12)", { nic: "12345" })).toBe(false);
    expect(ev("char_length(code) = 3", { code: "ABC" })).toBe(true);
  });

  it("evaluates LIKE with % and _", () => {
    expect(ev("email LIKE '%@%'", { email: "a@b.c" })).toBe(true);
    expect(ev("email LIKE '%@%'", { email: "nope" })).toBe(false);
    expect(ev("code LIKE 'A_C'", { code: "ABC" })).toBe(true);
    expect(ev("email NOT LIKE '%@%'", { email: "nope" })).toBe(true);
  });

  it("evaluates regex checks", () => {
    expect(ev("code ~ '^[A-Z]{3}$'", { code: "ABC" })).toBe(true);
    expect(ev("code ~ '^[A-Z]{3}$'", { code: "abc" })).toBe(false);
  });

  it("compares column to column and strings lexically", () => {
    expect(ev("ends_at > starts_at", { ends_at: "2024-02-01", starts_at: "2024-01-01" })).toBe(true);
    expect(ev("ends_at > starts_at", { ends_at: "2024-01-01", starts_at: "2024-01-01" })).toBe(false);
  });

  it("strips Postgres casts and parses ANY(ARRAY[...])", () => {
    const expr = "((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))";
    expect(ev(expr, { status: "a" })).toBe(true);
    expect(ev(expr, { status: "z" })).toBe(false);
    expect(ev(expr, { status: null })).toBeNull();
  });

  it("handles negative literals and parenthesised groups", () => {
    expect(ev("t >= -10 AND (t <= 10 OR t = 99)", { t: 99 })).toBe(true);
    expect(ev("t >= -10 AND (t <= 10 OR t = 99)", { t: 50 })).toBe(false);
  });

  it("accepts a leading CHECK keyword", () => {
    expect(ev("CHECK (a > 1)", { a: 2 })).toBe(true);
  });

  it("returns null for unparseable input", () => {
    expect(parseCheck("")).toBeNull();
    expect(parseCheck("a >")).toBeNull();
    expect(parseCheck("a > 1 garbage")).toBeNull();
    expect(parseCheck("a @@ b")).toBeNull();
    expect(parseCheck("(a > 1")).toBeNull();
  });

  it("matches column names case-insensitively on rows", () => {
    expect(ev("Price > 0", { price: 3 })).toBe(true);
  });
});

describe("planChecks", () => {
  it("price > 0 sets an exclusive min", () => {
    const l = limits("price > 0", "price");
    expect(l.min).toBe(0);
    expect(l.minInclusive).toBe(false);
  });

  it("stock >= 0 sets an inclusive min", () => {
    const l = limits("stock >= 0", "stock");
    expect(l.min).toBe(0);
    expect(l.minInclusive).toBe(true);
  });

  it("upper bounds", () => {
    const l = limits("x < 10 AND x <= 9", "x");
    expect(l.max).toBe(9);
    expect(l.maxInclusive).toBe(true);
  });

  it("flips literal-on-the-left comparisons", () => {
    const l = limits("0 < qty", "qty");
    expect(l.min).toBe(0);
    expect(l.minInclusive).toBe(false);
  });

  it("BETWEEN gives an inclusive range", () => {
    const l = limits("x BETWEEN 1 AND 5", "x");
    expect(l).toMatchObject({ min: 1, minInclusive: true, max: 5, maxInclusive: true });
  });

  it("IN gives allowed values", () => {
    expect(limits("status IN ('a','b')", "status").values).toEqual(["a", "b"]);
  });

  it("NOT IN gives forbidden values", () => {
    expect(limits("status NOT IN ('x','y')", "status").notValues).toEqual(["x", "y"]);
  });

  it("understands the Postgres printed form of IN", () => {
    const expr = "((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))";
    expect(limits(expr, "status").values).toEqual(["a", "b"]);
  });

  it("length(col) IN (10, 12) gives lengths", () => {
    expect(limits("length(nic) IN (10, 12)", "nic").lengths).toEqual([10, 12]);
  });

  it("char_length(code) = 3 gives a single length", () => {
    expect(limits("char_length(code) = 3", "code").lengths).toEqual([3]);
  });

  it("length bounds", () => {
    const l = limits("length(name) >= 2 AND length(name) < 11", "name");
    expect(l.minLength).toBe(2);
    expect(l.maxLength).toBe(10);
  });

  it("col = col comparison goes to comparisons, not limits", () => {
    const { plan, parsed } = planChecks(["ends_at > starts_at"]);
    expect(parsed[0]!.understood).toBe(true);
    expect(plan.comparisons).toEqual([{ left: "ends_at", op: ">", right: "starts_at" }]);
    expect(plan.limits.size).toBe(0);
  });

  it("x = 'a' OR x = 'b' becomes values", () => {
    expect(limits("x = 'a' OR x = 'b'", "x").values).toEqual(["a", "b"]);
  });

  it("col IS NULL OR col > 0 keeps the limit", () => {
    const l = limits("col IS NULL OR col > 0", "col");
    expect(l.min).toBe(0);
    expect(l.minInclusive).toBe(false);
  });

  it("email LIKE '%@%' sets emailLike", () => {
    expect(limits("email LIKE '%@%'", "email").emailLike).toBe(true);
  });

  it("combines several CHECKs on one column", () => {
    const { plan } = planChecks(["qty > 0", "qty <= 100"]);
    expect(plan.limits.get("qty")).toMatchObject({ min: 0, minInclusive: false, max: 100, maxInclusive: true });
  });

  it("reports unparseable input as not understood, with a null tree", () => {
    const { parsed, plan } = planChecks(["this is not sql"]);
    expect(parsed[0]!.tree).toBeNull();
    expect(parsed[0]!.understood).toBe(false);
    expect(plan.limits.size).toBe(0);
  });

  it("reports parsed-but-unplannable expressions as not understood", () => {
    const { parsed } = planChecks(["abs(a) > b"]);
    expect(parsed[0]!.tree).not.toBeNull();
    expect(parsed[0]!.understood).toBe(false);
  });
});
