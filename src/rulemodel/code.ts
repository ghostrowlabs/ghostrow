import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TableModel } from "../connect/types.js";
import { words } from "../engine/meanings.js";
import { MAX_CODE_CHARS } from "./format.js";

/**
 * Which application code the rule model reads for a table. Language-agnostic on purpose: a
 * file is relevant to a table when it names at least two of the table's columns (in any
 * spelling: unit_price, unitPrice, UnitPrice). Small files are sent whole; larger ones as the
 * lines around those names. The training data is cut with this same function.
 */

export interface CodeFile {
  file: string;
  text: string;
}

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|py|php|rb|java|kt|go|cs)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "venv", ".venv", "__pycache__", "coverage", "migrations", "target", "test", "tests", "__tests__", "spec"]);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
const norm = (s: string) => words(s).join("");
const singular = (s: string) => s.replace(/ies$/, "y").replace(/(ses|xes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
/** A line that looks like it states a constraint, in any common validator style. */
const CONSTRAINT = /\b(min|max|between|length|size|range|validates?|validator|numericality|required|in:|oneof|refine|raise|errors\.add|throw|Field\(|@Size|@Min|@Max|@Length|@IsIn|MaximumLength|MinimumLength|greater_than|less_than|gte|lte)\b|[<>]=?|=>\s*['"[]|\w\s*\*\s*\w/i;
/** Comments, doc blocks and imports: shown only if the budget is left over. */
const DOC = /^\s*(\*|\/\/|#|\/\*\*|"""|use |import |from |namespace |package )/;
const GENERIC = new Set(["id", "createdat", "updatedat", "name", "type", "data", "value"]);

export function readCodeDir(dir: string, maxFiles = 4000): CodeFile[] {
  const out: CodeFile[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 10 || out.length >= maxFiles) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (CODE_EXT.test(e.name) && !/\.(test|spec)\.\w+$/.test(e.name) && statSync(p).size < 500_000) out.push({ file: relative(process.cwd(), p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(dir, 0);
  return out;
}

/** The code blocks for one table, best first, within the prompt's code budget. */
export function codeContext(table: TableModel, files: CodeFile[], budget = MAX_CODE_CHARS): CodeFile[] {
  const cols = new Set(table.columns.map((c) => norm(c.name)).filter((n) => n.length > 1 && !GENERIC.has(n)));
  const model = singular(norm(table.name));
  const scored: { file: string; lines: string[]; hits: number[]; distinct: number; named: boolean }[] = [];
  for (const f of files) {
    const lines = f.text.replace(/\r/g, "").split("\n");
    const hits: number[] = [];
    const seen = new Set<string>();
    let named = false;
    lines.forEach((line, i) => {
      let hit = false;
      for (const m of line.matchAll(IDENT)) {
        const n = norm(m[0]);
        if (cols.has(n)) {
          seen.add(n);
          hit = true;
        } else if (singular(n) === model && model.length >= 3) named = true;
      }
      if (hit) hits.push(i);
    });
    if (seen.size >= 2 || (named && seen.size >= 1)) scored.push({ file: f.file, lines, hits, distinct: seen.size, named });
  }
  scored.sort((a, b) => b.distinct - a.distinct || Number(b.named) - Number(a.named) || a.file.localeCompare(b.file));
  const out: CodeFile[] = [];
  let left = budget;
  for (const s of scored.slice(0, 2)) {
    if (left < 120) break;
    const whole = s.lines.join("\n").trim();
    let text: string;
    if (whole.length <= left) text = whole;
    else {
      // Lines that state a constraint first (validators, comparisons, assignments), then the rest,
      // until the budget is spent; then printed in file order.
      const rank = (i: number) => (CONSTRAINT.test(s.lines[i]!) ? 0 : DOC.test(s.lines[i]!) ? 2 : 1);
      const order = [...s.hits].sort((a, b) => rank(a) - rank(b) || a - b);
      const keep = new Set<number>();
      let used = 0;
      for (const i of order) {
        const win = [i - 1, i, i + 1].filter((j) => j >= 0 && j < s.lines.length && !keep.has(j));
        const cost = win.reduce((n, j) => n + s.lines[j]!.trim().length + 5, 0);
        if (used + cost > left) continue;
        for (const j of win) keep.add(j);
        used += cost;
      }
      const idx = [...keep].sort((a, b) => a - b);
      const parts: string[] = [];
      idx.forEach((i, k) => {
        if (k > 0 && i !== idx[k - 1]! + 1) parts.push("...");
        parts.push(s.lines[i]!.replace(/^\s+/, (w) => w.slice(0, 8)));
      });
      text = parts.join("\n");
      if (text.length > left) text = text.slice(0, left).replace(/\n[^\n]*$/, "");
    }
    left -= text.length;
    out.push({ file: s.file, text });
  }
  return out;
}
