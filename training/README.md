# Ghostrow schema model: training

`gr-col-1` is a fine-tuned [ModernBERT-base](https://huggingface.co/answerdotai/ModernBERT-base)
(Apache-2.0) that reads one column's schema text and proposes one of the 56 column meanings in
`src/engine/meanings.ts`. In the CLI it only proposes: the rule engine's type checks decide, and
rows are still produced by the seeded generator (see `src/model/classify.ts`).

The model reads schema text only, built by `src/model/features.ts`: table and column name, declared
type, key/null/default flags and the names of nearby columns. Never values from a database.

## Data

| Part | Where | Labels |
| --- | --- | --- |
| Synthetic schemas | `tools/synth.ts` → `data/synth.jsonl` | ground truth: each column is generated from a known meaning |
| Public schemas | `sources.json`, `fetch_public.py` → `data/public/`, `tools/extract.ts` → `data/public.jsonl` | weak: the rule engine's meaning, kept when its confidence is at least 0.6, weighted 0.5 |
| Held-out set | the `split: "eval"` sources, `../eval/heldout.csv` | hand-labelled (`../eval/LABELING.md`), never used for training |

Every public file is pinned to a commit and listed with its licence and SHA-256 in
`sources.lock.json`. Only permissively licensed repositories are used (MIT, BSD, Apache-2.0,
PostgreSQL), and never `ee/` directories. Downloaded files are parsed as data with the CLI's own
schema readers; they are not committed.

## Reproduce

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 20+ and an NVIDIA GPU with bf16
(trained on an RTX 4070, 12 GB).

```sh
cd cli/training
uv sync                                   # PyTorch (CUDA 12.8), transformers, onnxruntime
uv run python fetch_public.py             # public schemas at pinned commits
cd .. && npx tsx training/tools/extract.ts && npx tsx training/tools/synth.ts 6000 1 && cd training
uv run python ../eval/build_heldout.py    # held-out labels
uv run python train.py                    # → runs/gr-col-1 (about 12 minutes on a 4070)
uv run python export.py                   # → artifacts/gr-col-1: ONNX fp32 and int8
uv run python ../eval/model_eval.py       # model alone vs rule engine, CPU latency
cd .. && npx tsx eval/cli_eval.ts         # the CLI pipeline end to end → eval/results/gr-col-1.json
npx tsx training/tools/release.ts         # signed release files → training/release/gr-col-1
```

The training recipe (data mix, epochs, learning rate, the CLI's acceptance threshold of 0.5) was
fixed before the held-out set was scored, and the held-out set was scored once per released model.

## Release

`tools/release.ts` writes the model, tokenizer, `model.json`, ONNX Runtime's native library for
each platform, and `manifest.grm`: a manifest of every file's size and SHA-256, signed with the
model signing key (Ed25519). The CLI verifies the signature with the public key in
`src/model/manifest.ts` and every file's hash before installing anything. Upload all of
`release/gr-col-1/` as assets of the GitHub release `model-gr-col-1`; that tag doesn't match `v*`,
so it doesn't start the CLI release workflow.
