# gr-rules-1: evaluation results

Measured 2026-11-27 and 2026-11-28. Every figure on this page comes from the answer files in
`eval/rules/results/`, scored with `eval/rules/score.ts`, and can be reproduced with the commands
in `training/rules/README.md`. Nothing here is an estimate.

**Labels.** 20 of the dev split's labels are cross-column CHECK constraints that the schemas'
own authors declared (AdventureWorks and GitLab). They were removed from the schema before anything
saw it. Every other label was written by one labeller, an AI assistant (Claude), following
`LABELING.md`. No independent human has reviewed them yet. The labels are in `labels.jsonl`.

## For ghostrow.com (/model and /research)

The paragraphs in this section are written to be quoted as they are.

**What it is.** gr-rules-1 is Ghostrow's second on-device model. It is Qwen2.5-0.5B-Instruct
(Apache-2.0), fine-tuned with QLoRA to read one table at a time (its columns, keys and checks, its
parent and child tables, and with `--code` the application code that names its columns) and write
the data rules it sees: orderings (`placed_at <= shipped_at`), sums of child rows, products
(`amount = quantity * unit_price`), values copied from a parent, and limits, lengths and allowed
values stated in validator code. It never sees values from a database. It ships as int4 ONNX
weights (318 MB, 330 MB with the tokenizer) and runs on the CPU after a one-time
`ghostrow model pull gr-rules-1`.

**How it is used.** The model proposes and the generator decides. A proposed rule is used only
if all of these hold:

1. every token of the line was at least 90% likely;
2. a deterministic check passes: the columns exist, their types fit, the foreign key the rule
   needs is declared, and it does not contradict or loop with a rule already in the plan;
3. limits and allowed values appear only in code that was actually read;
4. a small seeded trial sample generates and validates with the rule in place.

What survives is an ordinary rule in `ghostrow.rules.yaml`, which you can switch off. Without the
model, or with `--no-model`, the hand-written heuristics run as before.

**How it was trained.** It was trained only on synthetic data, on an NVIDIA RTX 4070. Our own
generator built 11,000 schemas. In those schemas every rule is known because the generator put it
there. The examples cover orders and lines, payments, bookings, ranges, parts of a whole,
inventory and validated entities, with distractor columns and many naming styles. They also
include validator code in 13 styles: Zod, Pydantic, Django, Laravel, class-validator, Joi, Yup,
Rails, Marshmallow, Bean Validation, Go tags, .NET DataAnnotations and SQLAlchemy. No public
schema or code was used for training.

**How it was evaluated.** The held-out set is real public schemas and validator code that the
model never saw.

- The dev split was used to choose the model and the confidence threshold. It is 158 tables from
  Chinook, Sakila, Northwind, pubs, AdventureWorks, Saleor, Healthchecks, Umami and GitLab.
- The test split was labelled before any model output existed for it. It is 118 tables from
  Hoppscotch, Airflow, Superset, Wagtail and cal.com, plus code from Pterodactyl, NetBox, the
  FastAPI template, JHipster, Clean Architecture, node-express-boilerplate and Spree.

On the test split, the current heuristics found 70.8% of the 72 cross-column rules, with 96.2%
precision. With gr-rules-1 added, Ghostrow found 76.4% at 88.7% precision. Of the 52 rules stated
in validator code, the heuristics found 1. The model found 12 (23.1%), at 75.0% precision. So the
model adds recall, mostly for code rules, and costs some precision. Every number is
on these small sets: one rule is 1.4 points of cross-column recall on test.

## The chosen model

Choice rule, fixed before any candidate was scored on test: pick the candidate and threshold
with the best F1 for heuristics plus model ("combined") on the dev split. Dev has no code
cases, so the threshold is tuned for cross-column rules.

### Dev (158 tables, 77 rules, 20 declared by the schemas' authors)

| System | Precision | Recall | tp / fp / fn |
| --- | --- | --- | --- |
| Heuristics (current CLI) | 93.0% | 68.8% | 53 / 4 / 24 |
| 0.5B v1 alone, p ≥ 0.90 | 93.1% | 70.1% | 54 / 4 / 23 |
| **0.5B v1 + heuristics, p ≥ 0.90 (shipped)** | **90.1%** | **83.1%** | 64 / 7 / 13 |
| 0.5B v2 + heuristics, p ≥ 0.95 | 91.2% | 80.5% | 62 / 6 / 15 |
| 1.5B + heuristics, p ≥ 0.95 | 84.4% | 84.4% | 65 / 12 / 12 |

Each candidate's threshold was its best on dev, from 0, 0.8, 0.85, 0.9 and 0.95. The dev F1
scores are 0.865 for the 0.5B v1, 0.855 for the 0.5B v2 and 0.844 for the 1.5B.

### Test (118 tables, 124 rules: 72 cross-column, 52 from code)

| System | All P | All R | Cross P | Cross R | Code P | Code R |
| --- | --- | --- | --- | --- | --- | --- |
| Heuristics (current CLI) | 96.3% | 41.9% | 96.2% | 70.8% | 100% | 1.9% |
| **0.5B v1 + heuristics, p ≥ 0.90 (shipped)** | **85.9%** | **54.0%** | **88.7%** | **76.4%** | **75.0%** | **23.1%** |
| 0.5B v2 + heuristics, p ≥ 0.95 | 86.8% | 53.2% | 90.3% | 77.8% | 71.4% | 19.2% |
| 1.5B + heuristics, p ≥ 0.95 | 91.1% | 58.1% | 91.8% | 77.8% | 88.9% | 30.8% |

**The test split favours the 1.5B, and dev favours the 0.5B v1.** We keep the 0.5B v1 because of
the choice rule. It is also a third the size and about three times as fast. The 1.5B's lead on
test comes mostly from code rules (16 vs 12 found). Dev has no code rules, so it could not show
that lead. A future dev split with code cases is the fair way to settle it.

**Invalid proposals.** The share of lines rejected after the confidence gate, as unreadable or
by the deterministic check:

| Model | Dev, no gate | Dev, at its threshold | Test, no gate | Test, at its threshold |
| --- | --- | --- | --- | --- |
| 0.5B v1 | 67.7% (201 / 297) | 39.2% (38 / 97) | 53.1% (136 / 256) | 25.5% (25 / 98) |
| 0.5B v2 | 57.9% | 22.1% | 47.4% | 23.2% |
| 1.5B | 47.6% | 7.1% | 37.2% | 21.2% |

These lines never reach a plan; the check exists for them. The trial run (step 4 above) is not
part of the scorer, so the shipped CLI can only drop more, never add.

**The gate costs code recall.** Without the gate, the 1.5B combined finds 78.2% of all test rules,
at 74.6% precision. Of the 92 code-kind lines the 1.5B wrote on test, 67 had a lowest-token
probability below 0.95. A separate threshold for code rules would need
a dev split with code to set it.

### Latency and size (0.5B v1, int4, CPU only)

Measured on a desktop Intel Core i7-13700K (24 logical cores), Windows 11 and Node 24 with
onnxruntime-node, over the 158 dev tables. The test is one prompt per table with greedy decoding.
No laptop has been measured yet. The 4-thread figure is the same desktop limited to 4 threads,
not a laptop measurement.

| Threads | Total for 158 tables | Median per table | p95 | Max | Model load |
| --- | --- | --- | --- | --- | --- |
| default (all cores) | 71.3 s | — | — | — | 0.9 s |
| 4 | 96.1 s | 0.48 s | 1.41 s | 2.38 s | 0.9 s |

Tables the CLI would not ask about are skipped: one with fewer than two comparable columns and
no code, for example. End to end, `ghostrow seed --dry-run` on the 5-table shop fixture took
4.7 s with the model, 3.1 s of it in the rule model. It ran through `npx tsx` and the
standalone `ghostrow.exe` alike.

The download on Windows x64 is 361 MB: 317.4 MB of weights, 11.4 MB of tokenizer and the 32 MB
ONNX Runtime for that platform. Every file is SHA-256 checked against an Ed25519-signed manifest.
For comparison, the 1.5B would be 998 MB. It took about 1.6 s per table on the same machine, but that was
measured while a training run used the GPU, so it is only a rough figure.

## Training runs

All runs use QLoRA (4-bit NF4 base, bf16 compute), LoRA rank 32 and alpha 64 on every linear
layer, lr 2e-4, about 8,000 tokens per batch, and loss on answer tokens only. They ran on one RTX
4070 (12 GB).

| Run | Base | Examples | Epochs | Steps | Time | Synthetic test loss |
| --- | --- | --- | --- | --- | --- | --- |
| **0.5B v1 (shipped)** | Qwen2.5-0.5B-Instruct | 38,757 | 2 | 1,894 | 63 min | 0.0072 |
| 0.5B v2 | Qwen2.5-0.5B-Instruct | 47,957 | 2 | 2,412 | 175 min | 0.0051 |
| 1.5B | Qwen2.5-1.5B-Instruct | 47,957 | 1.5 | 1,809 | 263 min | 0.0045 |

The v2 data comes from a later revision of the generator, with more scenarios and distractors. The synthetic test set is 1,784 table prompts
from 400 schemas, generated with a different seed. A lower loss there did not mean better
results on real schemas: v2 beats v1 on synthetic loss but not on dev.

## What changed after dev results were seen

Dev was looked at during development, which is its purpose. These changes were made after
seeing it:

- The training data generator gained more scenarios and distractors. That became the v2 data.
- The deterministic check was tightened. It now handles composite-key date orderings, allows
  limits only from code, treats declared limits and lengths as redundant, rejects copying
  unbounded text into a bounded column, and rejects circular sums and copies. The circular case
  was found in an end-to-end run, where the model proposed `products.price = sum of
  order_lines.unit_price`.

One change came after the test split had been scored. The check had wrongly rejected a code
limit stricter than a weaker declared one (`min 1` over a declared `min 0`). The fix is general,
and the test numbers above were re-scored with it. They did not change, because the affected
NetBox lines were already below the confidence gate.

## Limits

- The test set is small: 118 tables and 124 rules. One labeller wrote most of the labels.
- No laptop latency yet.
- The model sees one table, its neighbours, and code excerpts that are at most 1,600 characters.
  A rule that spans tables further apart, or code that names a constant defined elsewhere, is
  out of reach.
- Rule kinds the CLI cannot express are out of scope. One example is a total equal to the sum of
  quantity times price over the lines.

## Files

| File | What |
| --- | --- |
| `heldout.ts`, `heldout.jsonl` | case list and the table prompts, with declared checks stripped and heuristic answers |
| `cases.json`, `code/`, `sources.lock.json` | the public schemas and code, each pinned with its licence and SHA-256 |
| `labels.jsonl`, `LABELING.md` | the answer key and how it was written |
| `score.ts` | scoring (heuristics, model, combined; `--split`, `--min-p`) |
| `run_onnx.ts` | runs an exported model through the CLI's own decoder and writes answers with per-line confidence and timing |
| `results/onnx-*-{dev,test}.jsonl` | the answer files the tables above were scored from |
