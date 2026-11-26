import type { Rng } from "./prng.js";

/**
 * Generate a string that matches a regular expression from application code, e.g.
 * /^[A-Z]{3}-\d{4}$/ → "QKD-0381". Supports what validators use in practice: literals,
 * classes ([A-Z0-9_-], \d \w \s .), groups with alternation, and the ? * + {n} {n,m}
 * quantifiers. Returns null for constructs it can't honour (back-references, lookarounds).
 */

type Node = { k: "lit"; c: string } | { k: "set"; chars: string } | { k: "alt"; options: Node[][] } | { k: "rep"; node: Node; min: number; max: number };

const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const WORD = UPPER + LOWER + DIGITS + "_";
const PRINTABLE = UPPER + LOWER + DIGITS + " -_.";

class P {
  i = 0;
  constructor(readonly s: string) {}
  alt(): Node[][] {
    const options: Node[][] = [this.seq()];
    while (this.s[this.i] === "|") {
      this.i++;
      options.push(this.seq());
    }
    return options;
  }
  seq(): Node[] {
    const out: Node[] = [];
    while (this.i < this.s.length && this.s[this.i] !== "|" && this.s[this.i] !== ")") {
      const atom = this.atom();
      if (atom) out.push(this.quant(atom));
    }
    return out;
  }
  quant(node: Node): Node {
    const c = this.s[this.i];
    let min = 1;
    let max = 1;
    if (c === "?") [min, max] = [0, 1];
    else if (c === "*") [min, max] = [0, 4];
    else if (c === "+") [min, max] = [1, 5];
    else if (c === "{") {
      const m = /^\{(\d*)(,(\d*))?\}/.exec(this.s.slice(this.i));
      if (!m) return node;
      min = m[1] ? Number(m[1]) : 0;
      max = m[2] ? (m[3] ? Number(m[3]) : min + 5) : min;
      this.i += m[0].length - 1;
    } else return node;
    this.i++;
    if (this.s[this.i] === "?" || this.s[this.i] === "+") this.i++; // lazy/possessive
    return { k: "rep", node, min, max };
  }
  atom(): Node | null {
    const c = this.s[this.i++]!;
    if (c === "^" || c === "$") return null;
    if (c === "(") {
      if (this.s[this.i] === "?") {
        if (this.s[this.i + 1] === ":") this.i += 2;
        else if (this.s[this.i + 1] === "<" && /[A-Za-z]/.test(this.s[this.i + 2] ?? "")) this.i = this.s.indexOf(">", this.i) + 1;
        else throw new Error("lookaround");
      }
      const options = this.alt();
      if (this.s[this.i++] !== ")") throw new Error("unclosed group");
      return { k: "alt", options };
    }
    if (c === "[") return this.cls();
    if (c === ".") return { k: "set", chars: PRINTABLE };
    if (c === "\\") return this.escape(false) as Node;
    return { k: "lit", c };
  }
  escape(inClass: boolean): Node | string {
    const c = this.s[this.i++]!;
    const map: Record<string, string> = { d: DIGITS, w: WORD, s: " " };
    if (map[c]) return inClass ? map[c] : { k: "set", chars: map[c] };
    if (/[DWSbB]/.test(c)) {
      if (c === "b" || c === "B") return inClass ? "" : { k: "lit", c: "" };
      throw new Error("negated class escape");
    }
    if (/[1-9]/.test(c)) throw new Error("back-reference");
    const lit = c === "n" ? "\n" : c === "t" ? "\t" : c;
    return inClass ? lit : { k: "lit", c: lit };
  }
  cls(): Node {
    let negate = false;
    if (this.s[this.i] === "^") {
      negate = true;
      this.i++;
    }
    let chars = "";
    let first = true;
    while (this.i < this.s.length && (this.s[this.i] !== "]" || first)) {
      first = false;
      let c = this.s[this.i++]!;
      if (c === "\\") {
        chars += this.escape(true) as string;
        continue;
      }
      if (this.s[this.i] === "-" && this.s[this.i + 1] !== "]" && this.i + 1 < this.s.length) {
        const end = this.s[this.i + 1]!;
        this.i += 2;
        for (let x = c.charCodeAt(0); x <= end.charCodeAt(0) && x - c.charCodeAt(0) < 200; x++) chars += String.fromCharCode(x);
        continue;
      }
      chars += c;
      c = "";
    }
    this.i++; // ]
    if (negate) chars = [...PRINTABLE].filter((x) => !chars.includes(x)).join("");
    return { k: "set", chars: chars || "x" };
  }
}

function emit(nodes: Node[], rng: Rng): string {
  let s = "";
  for (const n of nodes) {
    if (n.k === "lit") s += n.c;
    else if (n.k === "set") s += n.chars[rng.int(0, n.chars.length - 1)] ?? "";
    else if (n.k === "alt") s += emit(rng.pick(n.options), rng);
    else {
      const times = rng.int(n.min, n.max);
      for (let t = 0; t < times; t++) s += emit([n.node], rng);
    }
  }
  return s;
}

export function compilePattern(pattern: string): Node[][] | null {
  try {
    const p = new P(pattern);
    const options = p.alt();
    return p.i >= pattern.length ? options : null;
  } catch {
    return null;
  }
}

export function sampleRegex(pattern: string, rng: Rng): string | null {
  const compiled = compilePattern(pattern);
  if (!compiled) return null;
  for (let i = 0; i < 5; i++) {
    const s = emit(rng.pick(compiled), rng);
    try {
      if (new RegExp(pattern).test(s)) return s;
    } catch {
      return s;
    }
  }
  return null;
}
