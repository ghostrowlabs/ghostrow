# gr-col-1: evaluation results

Measured 2026-11-27. Every figure on this page comes from the files in `eval/results/` and can be
reproduced with the commands in `training/README.md`. Nothing here is an estimate.

**Label review: pending.** The held-out labels were drafted by one labeller and have not yet been
reviewed by a second person. Rows where the label differs from the rule engine are marked
`agrees_with_rule = no` in `heldout.csv` (78 rows). Re-run the evaluation after review before
quoting these figures.

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
`eval/heldout.csv`. We compare the full CLI pipeline with the model
against Ghostrow's rule engine (gr-schema-1) on the same columns.

**Results.**

| On 505 held-out columns | Rule engine (gr-schema-1) | With gr-col-1 |
| --- | --- | --- |
| Correct meaning, full CLI pipeline | 84.6% (427) | 91.1% (460) |
| Model alone, int8, no type check | n/a | 91.5% (462) |
| 151 columns whose name never appears in training data | 77.5% (117) | 80.1% (121), model alone |

With the model, the pipeline changed 65 of the rule engine's meanings: 43 changes fixed a wrong
meaning, 10 replaced a correct meaning with a wrong one, and 12 replaced one wrong meaning with
another. By meaning, the model alone (int8) did best against the rule engine on categories (status: 26 to 39 of 44 correct), opaque codes
(1 to 9 of 13), JSON stored as text (7 to 11 of 12) and secrets and hashes (token: 4 to 8 of 17).
It did worse than the rule engine on free text (24 to 18 of 26) and on plain numbers (6 to 4 of 8).

**Speed.** On an Intel Core i7-13700K, through the CLI (onnxruntime-node, batches of 32), the model
step took 0.37 seconds for Chinook's 53 columns, including loading the model, and 20.2 seconds for
GitLab's 12,878 columns: 1.57 ms per column. With Python onnxruntime, one column at a time takes
2.9 ms (median).

**Limits.** The held-out set is small (505 columns from five schemas), it was labelled by a
single labeller, and the labels were written with the rule engine's proposal visible, which favours the
baseline. Accuracy on the 151 columns with names unseen in training is 80.1%, well below the
overall figure: much of the gain comes from naming patterns the training data covers. The
runtime is available for Windows (x64, arm64), Linux (x64, arm64) and macOS on Apple silicon;
on Intel Macs Ghostrow uses the rule engine.

## Both models we trained

We trained two models on the same data and report both. The ModernBERT-base model was trained
first with the recipe fixed in `training/train.py`. It was accurate but too slow on a CPU (about
90 ms per column). We then trained the 32M model with the same data and a learning rate of
1e-4 instead of 5e-5, and ship it because it is about 20 times faster at the same accuracy.

| | ModernBERT-base (149M) | Ettin-encoder-32m (shipped as gr-col-1) |
| --- | --- | --- |
| int8 ONNX size | 150.6 MB | 32.5 MB |
| Training time on the RTX 4070 | 863 s | 298 s |
| Held-out, model alone, int8 | 91.5% (462/505) | 91.5% (462/505) |
| Held-out, model alone, fp32 | 90.7% (458/505) | 90.9% (459/505) |
| Held-out, unseen names, int8 | 79.5% (120/151) | 80.1% (121/151) |
| Held-out, full CLI pipeline | 91.1% (460/505) | 91.1% (460/505) |
| CPU, one column, 1 thread (median) | 96.1 ms | 4.2 ms |
| CPU, batched, all threads, per column | 90.8 ms | 1.4 ms |

Rule engine on the same set: 84.6% (427/505); unseen names 77.5% (117/151).

By source, model alone (int8, shipped model) vs rule engine: Chinook 98.1% vs 96.2% (53 columns),
Sakila 95.3% vs 92.2% (64), Umami 92.1% vs 84.7% (229), Healthchecks 85.7% vs 80.0% (140),
Koel 94.7% vs 57.9% (19).

## Files

- `heldout.csv`: the 505 labelled columns, with the rule engine's meaning and whether they agree
- `LABELING.md`: the labelling guide
- `results/ettin-32m.json`, `results/modernbert-base.json`: full results (pipeline, model alone,
  per meaning, every disagreement, training log)
- `results/ettin-32m.latency.json`: CLI latency on Chinook and GitLab
- `tokenizer-golden.json`: token ids from the Python tokenizer; the CLI's tokenizer matches all 200
