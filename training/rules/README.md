# gr-rules-1: the rule-proposal model

`gr-rules-1` is a small instruct model (Qwen2.5 Instruct, Apache-2.0, fine-tuned with QLoRA)
that reads one table at a time, with its parent and child tables and any application code that
names its columns, and proposes data rules between columns: orderings, sums, products, copies,
and limits and allowed values stated in code. **The model proposes; the generator decides.**
Every proposal must pass, in the CLI (`src/rulemodel/propose.ts`):

1. a confidence gate: every token of the line at least `ACCEPT` likely (chosen on the dev split);
2. the deterministic check (`checkProposal` in `src/rulemodel/format.ts`): columns exist, types
   fit, the foreign key the rule needs is declared, nothing it contradicts or makes circular is
   already in the plan, limits and allowed values only from code that was actually read;
3. a trial run: a small seeded sample is generated and validated with the rule in the plan.

What survives is an ordinary rule in `ghostrow.rules.yaml`. Without the model (or with
`--no-model`), the hand-written heuristics in `src/engine/rules.ts` and `src/code/` run as before.

## Format

The prompt and answer format is `src/rulemodel/format.ts` (`tablePrompt`, `answerText`), and the
code excerpt is `codeContext` in `src/rulemodel/code.ts`. Training data is built with those same
functions, so the CLI and the training data can't drift apart. Answer lines:

```
order placed_at <= shipped_at          sum total = order_lines.amount
product amount = quantity * unit_price copy unit_price = products.price
min quantity 1    max discount 100     minlen sku 3   maxlen sku 32   len country 2
values status draft|sent|paid          none
```

## Data

| Part | Where | Labels |
| --- | --- | --- |
| Synthetic schemas and code | `tools/synth.ts` → `data/synth.jsonl` (47,957 table prompts from 11,000 schemas) | ground truth: every rule is decided by the generator, never by the heuristics |
| Synthetic test | `tools/synth.ts 400 424242` → `data/synth-test.jsonl` | ground truth, another seed; loss only |
| Real held-out set | `../../eval/rules/` (dev 158 tables, test 118 tables) | declared CHECKs (objective) and hand labels by Claude; never used for training |

The synthetic generator assembles schemas from scenarios (orders and lines, payments and refunds,
bookings, contracts, tickets, timesheets, inventory, ranges named from arbitrary stems, parts of a
whole, validated entities) with many naming styles and distractors (tax and shipping columns,
refunds of a payment, unrelated dates, a usage and its limit, declared CHECKs the answer must not
repeat). Validator code is written in 13 styles: Zod, Pydantic, Django, Laravel, class-validator,
Joi, Yup, Rails, Marshmallow, Bean Validation, Go validator tags, .NET DataAnnotations and
SQLAlchemy `@validates`. No public schema or code is used for training.

## Reproduce

The shipped 1.0.0 is the "0.5B v1" run in `../../eval/rules/RESULTS.md`: Qwen2.5-0.5B-Instruct,
2 epochs on 38,757 table prompts made by an earlier revision of `tools/synth.ts`. That revision
was not kept. The commands below make the current data (47,957 prompts, the "v2" runs). A 0.5B
trained on it scored slightly lower on dev, so dev did not choose it.

Needs Python 3.12 with uv, Node 20+, an NVIDIA GPU with bf16 (trained on an RTX 4070, 12 GB).

```sh
cd cli
npx tsx training/rules/tools/synth.ts 11000 1 training/rules/data/synth.jsonl
npx tsx training/rules/tools/synth.ts 400 424242 training/rules/data/synth-test.jsonl
cd training/rules && uv sync
uv run python train.py --base Qwen/Qwen2.5-0.5B-Instruct --epochs 2 --out runs/gr-rules-1-0.5b
# remove "rope_scaling": null from runs/gr-rules-1-0.5b/merged/config.json, then:
uv run python export.py runs/gr-rules-1-0.5b/merged artifacts/gr-rules-1-0.5b-int4 int4 1.0.0
cd ../.. && npx tsx eval/rules/heldout.ts
npx tsx eval/rules/tokenizer_check.ts training/rules/artifacts/gr-rules-1-0.5b-int4
npx tsx eval/rules/run_onnx.ts training/rules/artifacts/gr-rules-1-0.5b-int4 eval/rules/results/<name>.jsonl
npx tsx eval/rules/score.ts eval/rules/results/<name>.jsonl --split dev --min-p 0.9
npx tsx training/tools/release.ts training/rules/artifacts/gr-rules-1-0.5b-int4 1.0.0   # signed release files
```

`export.py` uses the ONNX Runtime GenAI model builder to write one decoder graph with a KV cache
and int4 weights; the CLI runs it with plain `onnxruntime-node` (the runtime gr-col-1 already
ships) and its own greedy loop and tokenizer (`src/rulemodel/model.ts`, `tokenizer.ts`).
