# gr-col-1: evaluation results

(The rule model, gr-rules-1, has its own page: [`rules/RESULTS.md`](rules/RESULTS.md).)

Measured 2026-11-27. Every figure on this page comes from the files in `eval/results/` and can be
reproduced with the commands in `training/README.md`. Nothing here is an estimate.

**Labels.** The held-out labels were written against `eval/LABELING.md` by one labeller, an AI
assistant (Claude) working with the Ghostrow team, in two passes, with the rule engine's answer
visible. The second pass, over all 505 columns, changed 6 labels that broke the guide. It was made
after the first results had been seen, so this page reports both. No independent human review has
been done yet. All labels are in `heldout.csv` (first pass: `heldout-first-pass.csv`).

## For ghostrow.com (/model and /research)

The paragraphs in this section are written to be quoted as they are.

**What it is.** gr-col-1 is Ghostrow's first schema model. It is a 32-million-parameter encoder
(Ettin-encoder-32m, a ModernBERT-architecture model, MIT licence) that we fine-tuned to read one
column's schema text (the table and column names, the declared type, key and null flags, and
the names of nearby columns) and propose which of 56 meanings it holds, such as email,
currency code, token or status. It never sees values from a database. It ships as a 32.5 MB int8
ONNX file and runs on the CPU of the machine running Ghostrow, after a one-time
`ghostrow model pull`.

**How it is used.** The model proposes and the deterministic engine decides. Ghostrow uses a
proposal only when the model is at least 50% sure and the meaning fits the column's declared type.
Foreign keys and meanings pinned in `ghostrow.rules.yaml` are never changed. Rows still come from
the seeded generator and are validated against the schema's constraints, so the same schema,
model and seed always give the same rows. `--no-model` turns it off for a run.

**How it was trained.** The model was fine-tuned on an NVIDIA RTX 4070 in bf16, for 3 epochs over
90,840 column examples, in 298 seconds. The training data has two parts. One is 81,863 columns
from 6,000 synthetic tables made by our own generator, where every column's meaning is known
because it was generated from it. The other is up to 6,000 columns from each of 16 public
schemas under permissive licences (MIT, BSD, Apache-2.0). For those, the label is the rule
engine's meaning, kept only when its confidence is at least 0.6 and weighted half as much. Every
public file is pinned to a commit and listed with its licence and SHA-256.

**How it was evaluated.** The held-out set is 505 columns from five public schemas that were never
used for training: Chinook, Sakila, Umami, Healthchecks and Koel. It is every column in them that
is not a declared foreign key (those are always decided by the constraint). Each column was
labelled against a written guide (`eval/LABELING.md`); the labels are published in
`eval/heldout.csv`. We compare the full CLI pipeline with the model against Ghostrow's rule engine
(gr-schema-1) on the same columns.

**Results.**

| On 505 held-out columns | Rule engine (gr-schema-1) | With gr-col-1 |
| --- | --- | --- |
| Correct meaning, full CLI pipeline | 83.4% (421) | 89.9% (454) |
| Model alone, int8, no type check | n/a | 90.3% (456) |
| 151 columns whose name never appears in training data | 76.8% (116) | 79.5% (120), model alone |

With the first-pass labels the same runs scored 84.6% (427) and 91.1% (460).

With the model, the pipeline changed 65 of the rule engine's meanings: 43 changes fixed a wrong
meaning, 10 replaced a correct meaning with a wrong one, and 12 replaced one wrong meaning with
another. By meaning, the model alone (int8) did best against the rule engine on categories
(status: 26 to 39 of 46 correct), opaque codes (1 to 9 of 13), JSON stored as text (7 to 11 of
12) and secrets and hashes (token: 4 to 8 of 18). It did worse than the rule engine on free text
(22 to 16 of 26) and on plain numbers (6 to 4 of 8).

**Speed.** On an Intel Core i7-13700K, through the CLI (onnxruntime-node, batches of 32), the model
step took 0.37 seconds for Chinook's 53 columns, including loading the model, and 20.2 seconds for
GitLab's 12,878 columns: 1.57 ms per column. With Python onnxruntime, one column at a time takes
3.2 ms (median of three runs; 2.9 to 3.3 ms).

**Limits.** The held-out set is small (505 columns from five schemas), it was labelled by a single
labeller in two passes, with the rule engine's answer visible, which favours the baseline, and it
has not been independently reviewed. Accuracy on the 151 columns with names unseen in training is
79.5%, well below the overall figure: much of the gain comes from naming patterns the training data
covers. The runtime is available for Windows (x64, arm64), Linux (x64, arm64) and macOS on Apple
silicon; on Intel Macs Ghostrow uses the rule engine.

## Both models we trained

We trained two models on the same data and report both. The ModernBERT-base model was trained
first with the recipe fixed in `training/train.py`. It was as accurate, but its CPU time was high
and varied widely between runs on the same machine. We then trained the 32M model with the same
data and a learning rate of 1e-4 instead of 5e-5, and ship it because its CPU time is low and
steady.

| | ModernBERT-base (149M) | Ettin-encoder-32m (shipped as gr-col-1) |
| --- | --- | --- |
| int8 ONNX size | 150.6 MB | 32.5 MB |
| Training time on the RTX 4070 | 863 s | 298 s |
| Held-out, model alone, int8 | 90.3% (456/505) | 90.3% (456/505) |
| Held-out, model alone, fp32 | 89.5% (452/505) | 89.7% (453/505) |
| Held-out, unseen names, int8 | 78.8% (119/151) | 79.5% (120/151) |
| Held-out, full CLI pipeline | 89.9% (454/505) | 89.9% (454/505) |
| CPU, one column, 1 thread, median (3 runs, min–max) | 25.6 ms (24.5–99.4) | 4.1 ms (3.6–4.3) |
| CPU, batched, all threads, per column (3 runs, min–max) | 96.7 ms (8.9–105.1) | 1.5 ms (1.5–1.7) |

Rule engine on the same set: 83.4% (421/505); unseen names 76.8% (116/151). CPU figures are from
`results/*.latency-python.json`: three runs alternating the two models on a machine with other
processes running.

By source, model alone (int8, shipped model) vs rule engine: Chinook 98.1% vs 96.2% (53 columns),
Sakila 95.3% vs 92.2% (64), Umami 90.8% vs 83.4% (229), Healthchecks 84.3% vs 78.6% (140),
Koel 89.5% vs 52.6% (19).

## Files

- `heldout.csv`: the 505 labelled columns, with the rule engine's meaning and whether they agree
- `heldout-first-pass.csv`: the labels before the second pass
- `LABELING.md`: the labelling guide
- `results/ettin-32m.json`, `results/modernbert-base.json`: full results (pipeline, model alone,
  per meaning, every disagreement, training log); `*.first-pass-labels.json`: the same with the
  first-pass labels
- `results/*.latency-python.json`: the three CPU latency runs; `results/ettin-32m.latency.json`:
  CLI latency on Chinook and GitLab
- `tokenizer-golden.json`: token ids from the Python tokenizer; the CLI's tokenizer matches all 200
