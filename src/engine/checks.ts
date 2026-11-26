import { tokenize } from "../connect/ddl.js";

/**
 * CHECK constraints: parsed into an expression tree that the generator plans from
 * (column ranges, allowed values, lengths, column comparisons) and the validator
 * evaluates against every generated row. Handles the forms databases print back,
 * including Postgres's `(status)::text = ANY ((ARRAY['a'::text, …])::text[])`.
 */

type Tok = ReturnType<typeof tokenize>[number];

export type Operand =
  | { k: "col"; name: string }
  | { k: "lit"; value: string | number | null }
  | { k: "fn"; name: string; arg: Operand }
  | { k: "list"; items: Operand[] }
  | { k: "neg"; arg: Operand };

export type Expr =
  | { k: "and" | "or"; items: Expr[] }
  | { k: "not"; arg: Expr }
  | { k: "cmp"; op: "<" | "<=" | ">" | ">=" | "=" | "<>"; left: Operand; right: Operand }
  | { k: "in"; left: Operand; items: Operand[]; negate: boolean }
  | { k: "between"; left: Operand; lo: Operand; hi: Operand }
  | { k: "null"; arg: Operand; negate: boolean }
  | { k: "like"; arg: Operand; pattern: string; negate: boolean }
  | { k: "regex"; arg: Operand; pattern: string; negate: boolean };

const kw = (t: Tok | undefined, ...w: string[]) => t !== undefined && t.k === "id" && w.includes(t.v.toLowerCase());

/** Remove `::type`, `::type[]`, `::character varying(20)` casts and a leading CHECK keyword. */
function clean(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.k === "op" && t.v === "::") {
      i++;
      while (kw(tokens[i + 1], "varying", "precision", "with", "without", "time", "zone")) i++;
      if (tokens[i + 1]?.v === "(") {
        let d = 0;
        do {
          i++;
          if (tokens[i]?.v === "(") d++;
          if (tokens[i]?.v === ")") d--;
        } while (d > 0 && i < tokens.length);
      }
      while (tokens[i + 1]?.v === "[" && tokens[i + 2]?.v === "]") i += 2;
      continue;
    }
    out.push(t);
  }
  if (kw(out[0], "check")) out.shift();
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly t: Tok[]) {}
  private peek(o = 0) {
    return this.t[this.i + o];
  }
  private next() {
    return this.t[this.i++];
  }
  private eat(v: string) {
    if (this.peek()?.v.toLowerCase() === v) {
      this.i++;
      return true;
    }
    return false;
  }
  done() {
    return this.i >= this.t.length;
  }
  or(): Expr {
    const items = [this.and()];
    while (kw(this.peek(), "or")) {
      this.i++;
      items.push(this.and());
    }
    return items.length === 1 ? items[0]! : { k: "or", items };
  }
  and(): Expr {
    const items = [this.not()];
    while (kw(this.peek(), "and")) {
      this.i++;
      items.push(this.not());
    }
    return items.length === 1 ? items[0]! : { k: "and", items };
  }
  not(): Expr {
    if (kw(this.peek(), "not")) {
      this.i++;
      return { k: "not", arg: this.not() };
    }
    return this.predicate();
  }
  predicate(): Expr {
    // A parenthesised boolean expression, if what follows the paren isn't just an operand.
    if (this.peek()?.v === "(") {
      const save = this.i;
      this.i++;
      try {
        const inner = this.or();
        if (this.eat(")")) {
          if (!this.isOperatorAhead()) return inner;
        }
      } catch {
        /* fall back to reading an operand */
      }
      this.i = save;
    }
    const left = this.operand();
    const t = this.peek();
    if (kw(t, "is")) {
      this.i++;
      const negate = this.eat("not");
      if (!this.eat("null")) throw new Error("IS without NULL");
      return { k: "null", arg: left, negate };
    }
    let negate = false;
    if (kw(t, "not")) {
      negate = true;
      this.i++;
    }
    if (kw(this.peek(), "between")) {
      this.i++;
      const lo = this.operand();
      if (!this.eat("and")) throw new Error("BETWEEN without AND");
      const hi = this.operand();
      const e: Expr = { k: "between", left, lo, hi };
      return negate ? { k: "not", arg: e } : e;
    }
    if (kw(this.peek(), "in")) {
      this.i++;
      const list = this.operand();
      return { k: "in", left, items: list.k === "list" ? list.items : [list], negate };
    }
    if (kw(this.peek(), "like", "ilike")) {
      this.i++;
      const p = this.operand();
      return { k: "like", arg: left, pattern: p.k === "lit" ? String(p.value) : "", negate };
    }
    const op = this.next();
    if (!op) throw new Error("expected operator");
    if (op.v === "~" || op.v === "~*" || (op.v === "!" && this.peek()?.v === "~")) {
      if (op.v === "!") this.i++;
      const p = this.operand();
      return { k: "regex", arg: left, pattern: p.k === "lit" ? String(p.value) : "", negate: op.v === "!" };
    }
    const map: Record<string, "<" | "<=" | ">" | ">=" | "=" | "<>"> = { "<": "<", "<=": "<=", ">": ">", ">=": ">=", "=": "=", "<>": "<>", "!=": "<>" };
    const cmp = map[op.v];
    if (!cmp) throw new Error(`unsupported operator ${op.v}`);
    // `= ANY (ARRAY[…])` / `<> ALL (ARRAY[…])`
    if (kw(this.peek(), "any", "some", "all")) {
      const all = kw(this.next(), "all");
      const list = this.operand();
      const items = list.k === "list" ? list.items : [list];
      if (cmp === "=" && !all) return { k: "in", left, items, negate: false };
      if (cmp === "<>" && all) return { k: "in", left, items, negate: true };
      throw new Error("unsupported ANY/ALL");
    }
    return { k: "cmp", op: cmp, left, right: this.operand() };
  }
  private isOperatorAhead() {
    const t = this.peek();
    return t !== undefined && (t.k === "op" || kw(t, "between", "in", "like", "ilike", "is")) && !kw(t, "and", "or");
  }
  operand(): Operand {
    const t = this.next();
    if (!t) throw new Error("unexpected end");
    if (t.v === "(") {
      // A list, or a parenthesised operand.
      const items: Operand[] = [this.operand()];
      while (this.eat(",")) items.push(this.operand());
      if (!this.eat(")")) throw new Error("unclosed (");
      return items.length === 1 ? items[0]! : { k: "list", items };
    }
    if (t.k === "op" && t.v === "-") {
      const a = this.operand();
      return a.k === "lit" && typeof a.value === "number" ? { k: "lit", value: -a.value } : { k: "neg", arg: a };
    }
    if (t.k === "num") return { k: "lit", value: Number(t.v) };
    if (t.k === "str") return { k: "lit", value: t.v };
    if (kw(t, "null")) return { k: "lit", value: null };
    if (kw(t, "true")) return { k: "lit", value: 1 };
    if (kw(t, "false")) return { k: "lit", value: 0 };
    if (kw(t, "array") && this.peek()?.v === "[") {
      this.i++;
      const items: Operand[] = [];
      if (this.peek()?.v !== "]") {
        items.push(this.operand());
        while (this.eat(",")) items.push(this.operand());
      }
      this.eat("]");
      return { k: "list", items };
    }
    if (t.k === "id" || t.k === "qid") {
      if (this.peek()?.v === "(" && t.k === "id") {
        this.i++;
        const arg = this.peek()?.v === ")" ? ({ k: "lit", value: null } as Operand) : this.operand();
        while (this.eat(",")) this.operand();
        this.eat(")");
        return { k: "fn", name: t.v.toLowerCase(), arg };
      }
      // table.column → column
      let name = t.v;
      while (this.peek()?.v === "." && (this.peek(1)?.k === "id" || this.peek(1)?.k === "qid")) {
        this.i++;
        name = this.next()!.v;
      }
      return { k: "col", name };
    }
    throw new Error(`unexpected ${t.v}`);
  }
}

export function parseCheck(expr: string): Expr | null {
  try {
    const p = new Parser(clean(tokenize(expr)));
    const e = p.or();
    return p.done() ? e : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ planning */

export interface ColumnLimits {
  min?: number;
  minInclusive?: boolean;
  max?: number;
  maxInclusive?: boolean;
  values?: (string | number)[];
  notValues?: (string | number)[];
  lengths?: number[];
  minLength?: number;
  maxLength?: number;
  emailLike?: boolean;
}

export interface Comparison {
  left: string;
  op: "<" | "<=" | ">" | ">=" | "=" | "<>";
  right: string;
}

export interface CheckPlan {
  limits: Map<string, ColumnLimits>;
  comparisons: Comparison[];
}

const LEN_FNS = new Set(["length", "char_length", "character_length", "len", "octet_length"]);
const PASS_FNS = new Set(["lower", "upper", "trim", "btrim", "ltrim", "rtrim", "coalesce"]);

function colOf(o: Operand): { col: string; len: boolean } | null {
  if (o.k === "col") return { col: o.name, len: false };
  if (o.k === "fn" && LEN_FNS.has(o.name)) {
    const inner = colOf(o.arg);
    return inner && !inner.len ? { col: inner.col, len: true } : null;
  }
  if (o.k === "fn" && PASS_FNS.has(o.name)) return colOf(o.arg);
  return null;
}
const litOf = (o: Operand): string | number | null | undefined => (o.k === "lit" ? o.value : o.k === "neg" && o.arg.k === "lit" && typeof o.arg.value === "number" ? -o.arg.value : undefined);
const flip: Record<Comparison["op"], Comparison["op"]> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=", "<>": "<>" };

function limitsFor(plan: CheckPlan, col: string): ColumnLimits {
  let l = plan.limits.get(col);
  if (!l) {
    l = {};
    plan.limits.set(col, l);
  }
  return l;
}

function tighten(l: ColumnLimits, len: boolean, op: Comparison["op"], v: number | string): void {
  if (len) {
    const n = Number(v);
    if (op === "=") l.lengths = [n];
    if (op === ">") l.minLength = Math.max(l.minLength ?? 0, n + 1);
    if (op === ">=") l.minLength = Math.max(l.minLength ?? 0, n);
    if (op === "<") l.maxLength = Math.min(l.maxLength ?? Infinity, n - 1);
    if (op === "<=") l.maxLength = Math.min(l.maxLength ?? Infinity, n);
    if (op === "<>" && n === 0) l.minLength = Math.max(l.minLength ?? 0, 1);
    return;
  }
  if (op === "=") l.values = [v];
  else if (op === "<>") (l.notValues ??= []).push(v);
  else if (typeof v === "number") {
    if (op === ">" || op === ">=") {
      if (l.min === undefined || v > l.min) {
        l.min = v;
        l.minInclusive = op === ">=";
      }
    } else if (l.max === undefined || v < l.max) {
      l.max = v;
      l.maxInclusive = op === "<=";
    }
  } else if (op === ">" && v === "") l.minLength = Math.max(l.minLength ?? 0, 1);
}

/** Turn one parsed CHECK into limits the generator can honour. Returns false if only partly understood. */
function collect(e: Expr, plan: CheckPlan): boolean {
  switch (e.k) {
    case "and":
      return e.items.map((x) => collect(x, plan)).every(Boolean);
    case "cmp": {
      const lc = colOf(e.left);
      const rc = colOf(e.right);
      const lv = litOf(e.right);
      const rv = litOf(e.left);
      if (lc && lv !== undefined && lv !== null) tighten(limitsFor(plan, lc.col), lc.len, e.op, lv);
      else if (rc && rv !== undefined && rv !== null) tighten(limitsFor(plan, rc.col), rc.len, flip[e.op], rv);
      else if (lc && rc && !lc.len && !rc.len) plan.comparisons.push({ left: lc.col, op: e.op, right: rc.col });
      else return false;
      return true;
    }
    case "between": {
      const c = colOf(e.left);
      const lo = litOf(e.lo);
      const hi = litOf(e.hi);
      if (!c || lo === undefined || hi === undefined || lo === null || hi === null) return false;
      tighten(limitsFor(plan, c.col), c.len, ">=", lo);
      tighten(limitsFor(plan, c.col), c.len, "<=", hi);
      return true;
    }
    case "in": {
      const c = colOf(e.left);
      const vals = e.items.map(litOf).filter((v): v is string | number => v !== undefined && v !== null);
      if (!c || vals.length !== e.items.length) return false;
      const l = limitsFor(plan, c.col);
      if (c.len) l.lengths = vals.map(Number);
      else if (e.negate) (l.notValues ??= []).push(...vals);
      else l.values = vals;
      return true;
    }
    case "or": {
      // `x = 'a' OR x = 'b'` and `x IS NULL OR <limit>` are understood.
      const nonNull = e.items.filter((x) => !(x.k === "null" && !x.negate));
      if (nonNull.length === 1) return collect(nonNull[0]!, plan);
      const values: (string | number)[] = [];
      let column: string | null = null;
      let isLen = false;
      for (const x of nonNull) {
        if (x.k === "cmp" && x.op === "=") {
          const c = colOf(x.left);
          const v = litOf(x.right);
          if (!c || v === undefined || v === null || (column !== null && (c.col !== column || c.len !== isLen))) return false;
          column = c.col;
          isLen = c.len;
          values.push(v);
        } else if (x.k === "in" && !x.negate) {
          const c = colOf(x.left);
          if (!c || (column !== null && c.col !== column)) return false;
          column = c.col;
          isLen = c.len;
          values.push(...x.items.map(litOf).filter((v): v is string | number => v !== undefined && v !== null));
        } else return false;
      }
      if (column === null) return false;
      const l = limitsFor(plan, column);
      if (isLen) l.lengths = values.map(Number);
      else l.values = values;
      return true;
    }
    case "null":
      return true;
    case "like": {
      const c = colOf(e.arg);
      if (c && !e.negate && /%@%/.test(e.pattern)) {
        limitsFor(plan, c.col).emailLike = true;
        return true;
      }
      if (c && !e.negate && /^_+$/.test(e.pattern)) {
        limitsFor(plan, c.col).lengths = [e.pattern.length];
        return true;
      }
      return false;
    }
    case "not":
      if (e.arg.k === "in" || e.arg.k === "cmp" || e.arg.k === "like" || e.arg.k === "null") {
        const inner = e.arg;
        if (inner.k === "cmp") return collect({ ...inner, op: ({ "<": ">=", "<=": ">", ">": "<=", ">=": "<", "=": "<>", "<>": "=" } as const)[inner.op] }, plan);
        if (inner.k === "in") return collect({ ...inner, negate: !inner.negate }, plan);
        return true;
      }
      return false;
    default:
      return false;
  }
}

export function planChecks(exprs: string[]): { plan: CheckPlan; parsed: { expr: string; tree: Expr | null; understood: boolean }[] } {
  const plan: CheckPlan = { limits: new Map(), comparisons: [] };
  const parsed = exprs.map((expr) => {
    const tree = parseCheck(expr);
    return { expr, tree, understood: tree ? collect(tree, plan) : false };
  });
  return { plan, parsed };
}

/* ------------------------------------------------------------------ evaluation */

function value(o: Operand, row: Record<string, unknown>): unknown {
  switch (o.k) {
    case "lit":
      return o.value;
    case "col":
      return row[o.name] ?? row[Object.keys(row).find((k) => k.toLowerCase() === o.name.toLowerCase()) ?? ""];
    case "neg": {
      const v = value(o.arg, row);
      return v === null || v === undefined ? null : -Number(v);
    }
    case "fn": {
      const v = value(o.arg, row);
      if (v === null || v === undefined) return null;
      if (LEN_FNS.has(o.name)) return String(v).length;
      if (o.name === "lower") return String(v).toLowerCase();
      if (o.name === "upper") return String(v).toUpperCase();
      if (["trim", "btrim"].includes(o.name)) return String(v).trim();
      if (o.name === "ltrim") return String(v).trimStart();
      if (o.name === "rtrim") return String(v).trimEnd();
      if (o.name === "abs") return Math.abs(Number(v));
      return undefined;
    }
    case "list":
      return undefined;
  }
}

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== "string" || typeof b !== "string") {
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** SQL three-valued logic: true, false, or null (unknown — which a CHECK treats as passing). */
export function evaluate(e: Expr, row: Record<string, unknown>): boolean | null {
  switch (e.k) {
    case "and": {
      let unknown = false;
      for (const x of e.items) {
        const r = evaluate(x, row);
        if (r === false) return false;
        if (r === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case "or": {
      let unknown = false;
      for (const x of e.items) {
        const r = evaluate(x, row);
        if (r === true) return true;
        if (r === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "not": {
      const r = evaluate(e.arg, row);
      return r === null ? null : !r;
    }
    case "cmp": {
      const c = compare(value(e.left, row), value(e.right, row));
      if (c === null) return null;
      return { "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0, "=": c === 0, "<>": c !== 0 }[e.op];
    }
    case "between": {
      const v = value(e.left, row);
      const lo = compare(v, value(e.lo, row));
      const hi = compare(v, value(e.hi, row));
      return lo === null || hi === null ? null : lo >= 0 && hi <= 0;
    }
    case "in": {
      const v = value(e.left, row);
      if (v === null || v === undefined) return null;
      const hit = e.items.some((i) => compare(v, value(i, row)) === 0);
      return e.negate ? !hit : hit;
    }
    case "null": {
      const v = value(e.arg, row);
      const isNull = v === null || v === undefined;
      return e.negate ? !isNull : isNull;
    }
    case "like": {
      const v = value(e.arg, row);
      if (v === null || v === undefined) return null;
      const re = new RegExp(`^${e.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "s");
      return e.negate ? !re.test(String(v)) : re.test(String(v));
    }
    case "regex": {
      const v = value(e.arg, row);
      if (v === null || v === undefined) return null;
      try {
        const ok = new RegExp(e.pattern).test(String(v));
        return e.negate ? !ok : ok;
      } catch {
        return null;
      }
    }
  }
}
