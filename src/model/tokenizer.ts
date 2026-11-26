/**
 * A byte-level BPE tokenizer that reads a Hugging Face `tokenizer.json` (the ModernBERT one):
 * NFC, added tokens split out first, GPT-2 pre-tokenizer regex, byte → unicode mapping, BPE
 * merges by rank, then `[CLS] … [SEP]`. Kept small on purpose: no dependency, and its output is
 * checked against the Python tokenizer on the held-out set (eval/tokenizer-golden.json).
 */

interface TokenizerJson {
  normalizer?: { type: string } | null;
  added_tokens: { id: number; content: string; special: boolean }[];
  model: { type: string; vocab: Record<string, number>; merges: (string | [string, string])[] };
}

const PRETOKENIZE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

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

export class BpeTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly ranks = new Map<string, number>();
  private readonly added: Map<string, number>;
  private readonly addedRe: RegExp | null;
  private readonly byteMap = bytesToUnicode();
  private readonly cache = new Map<string, number[]>();
  readonly cls: number;
  readonly sep: number;
  readonly pad: number;

  constructor(json: TokenizerJson) {
    if (json.model.type !== "BPE") throw new Error(`unsupported tokenizer model ${json.model.type}`);
    this.vocab = new Map(Object.entries(json.model.vocab));
    json.model.merges.forEach((m, i) => this.ranks.set(Array.isArray(m) ? `${m[0]} ${m[1]}` : m, i));
    this.added = new Map(json.added_tokens.map((t) => [t.content, t.id]));
    const plain = json.added_tokens.filter((t) => !t.special).map((t) => t.content).sort((a, b) => b.length - a.length);
    this.addedRe = plain.length ? new RegExp(plain.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
    const id = (s: string) => {
      const v = this.added.get(s) ?? this.vocab.get(s);
      if (v === undefined) throw new Error(`tokenizer has no ${s}`);
      return v;
    };
    this.cls = id("[CLS]");
    this.sep = id("[SEP]");
    this.pad = id("[PAD]");
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
    if (this.cache.size < 50_000) this.cache.set(word, ids);
    return ids;
  }

  private encodePlain(text: string, out: number[]): void {
    for (const m of text.matchAll(PRETOKENIZE)) {
      const mapped = [...Buffer.from(m[0], "utf8")].map((b) => this.byteMap[b]).join("");
      out.push(...this.bpe(mapped));
    }
  }

  /** Token ids with `[CLS]` and `[SEP]`, truncated to `maxLen`. */
  encode(text: string, maxLen = 128): number[] {
    const s = text.normalize("NFC");
    const ids: number[] = [];
    if (this.addedRe) {
      let last = 0;
      for (const m of s.matchAll(this.addedRe)) {
        this.encodePlain(s.slice(last, m.index), ids);
        ids.push(this.added.get(m[0])!);
        last = m.index! + m[0].length;
      }
      this.encodePlain(s.slice(last), ids);
    } else this.encodePlain(s, ids);
    return [this.cls, ...ids.slice(0, maxLen - 2), this.sep];
  }
}
