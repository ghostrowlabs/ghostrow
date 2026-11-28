/**
 * Checks the CLI's Qwen tokenizer (src/rulemodel/tokenizer.ts) against the Python tokenizer on
 * every held-out prompt and a few awkward strings (eval/rules/tokenizer-golden.json).
 *
 *   npx tsx eval/rules/tokenizer_check.ts <dir with tokenizer.json>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QwenTokenizer } from "../../src/rulemodel/tokenizer.js";

const tok = new QwenTokenizer(JSON.parse(readFileSync(join(process.argv[2]!, "tokenizer.json"), "utf8")));
const gold = JSON.parse(readFileSync(new URL("./tokenizer-golden.json", import.meta.url), "utf8")) as { text: string; ids: number[] }[];
let bad = 0;
for (const g of gold) {
  const ids = tok.encode(g.text);
  const same = ids.length === g.ids.length && ids.every((x, i) => x === g.ids[i]);
  const round = tok.decode(g.ids) === g.text.replace(/<\|[a-z_]+\|>/g, "");
  if (!same || !round) {
    bad++;
    if (bad <= 3) console.log("mismatch:", JSON.stringify(g.text.slice(0, 80)), same ? "(decode)" : "(encode)");
  }
}
console.log(`${gold.length - bad}/${gold.length} texts tokenize and decode exactly as in Python`);
process.exit(bad ? 1 : 0);
