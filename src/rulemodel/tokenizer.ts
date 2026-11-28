/**
 * The byte-level BPE tokenizer of the Qwen2 family, read from its Hugging Face `tokenizer.json`:
 * NFC, special tokens split out first, the Qwen2 pre-tokenizer regex, byte → unicode mapping,
 * BPE merges by rank. Decoding maps the byte characters back to UTF-8. No dependency; its
 * output is checked against the Python tokenizer (test/unit/rulemodel-tokenizer.test.ts).
 */

interface TokenizerJson {
  added_tokens: { id: number; content: string; special: boolean }[];
  model: { type: string; vocab: Record<string, number>; merges: (string | [string, string])[] };
}

// Qwen2: (?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
// The case-insensitive group is spelled out so the regex works without inline modifiers.
const PRETOKENIZE = /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const map: string[] = new Array(256);
  bs.forEach((b, i) => (map[b] = String.fromCodePoint(cs[i]!)));
  return map;
}

export class QwenTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly inverse: string[] = [];
  private readonly ranks = new Map<string, number>();
  private readonly special: Map<string, number>;
  private readonly specialIds = new Set<number>();
  private readonly specialRe: RegExp;
  private readonly byteMap = bytesToUnicode();
  private readonly byteBack = new Map<string, number>();
  private readonly cache = new Map<string, number[]>();

  constructor(json: TokenizerJson) {
    if (json.model.type !== "BPE") throw new Error(`unsupported tokenizer model ${json.model.type}`);
    this.vocab = new Map(Object.entries(json.model.vocab));
    for (const [t, id] of this.vocab) this.inverse[id] = t;
    json.model.merges.forEach((m, i) => this.ranks.set(Array.isArray(m) ? `${m[0]} ${m[1]}` : m, i));
    this.special = new Map(json.added_tokens.map((t) => [t.content, t.id]));
    for (const t of json.added_tokens) {
      this.inverse[t.id] = t.content;
      this.specialIds.add(t.id);
    }
    const all = [...this.special.keys()].sort((a, b) => b.length - a.length);
    this.specialRe = new RegExp(all.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    this.byteMap.forEach((c, b) => this.byteBack.set(c, b));
  }

  id(token: string): number {
    const v = this.special.get(token) ?? this.vocab.get(token);
    if (v === undefined) throw new Error(`tokenizer has no ${token}`);
    return v;
  }

  private bpe(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let parts = [...word];
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      const a = parts[best]!;
      const b = parts[best + 1]!;
      const next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(parts[i]!);
      }
      parts = next;
    }
    const ids = parts.map((p) => {
      const v = this.vocab.get(p);
      if (v === undefined) throw new Error(`token ${p} not in vocabulary`);
      return v;
    });
    if (this.cache.size < 100_000) this.cache.set(word, ids);
    return ids;
  }

  private encodePlain(text: string, out: number[]): void {
    for (const m of text.matchAll(PRETOKENIZE)) {
      const mapped = [...Buffer.from(m[0], "utf8")].map((b) => this.byteMap[b]).join("");
      out.push(...this.bpe(mapped));
    }
  }

  /** Token ids for a text in which special tokens (<|im_start|>, ...) appear literally. */
  encode(text: string): number[] {
    const s = text.normalize("NFC");
    const ids: number[] = [];
    let last = 0;
    for (const m of s.matchAll(this.specialRe)) {
      this.encodePlain(s.slice(last, m.index), ids);
      ids.push(this.special.get(m[0])!);
      last = m.index! + m[0].length;
    }
    this.encodePlain(s.slice(last), ids);
    return ids;
  }

  /** Text for token ids, special tokens left out. */
  decode(ids: number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      if (this.specialIds.has(id)) continue;
      for (const ch of this.inverse[id] ?? "") {
        const b = this.byteBack.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
}
