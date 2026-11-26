"""Fine-tune the column-meaning classifier.

    uv run python train.py [--base answerdotai/ModernBERT-base] [--out runs/gr-col-1] [--no-weak]

Data (see README.md):
  data/synth.jsonl   synthetic schemas, ground-truth labels (tools/synth.ts)
  data/public.jsonl  public schemas (split=train only), weak labels from the rule engine
The held-out sources (split=eval) are never read here.

The recipe was fixed before the held-out evaluation: synthetic + weak labels with rule
confidence >= 0.6, weak examples weighted 0.5, at most 6,000 columns per public source,
3 epochs, lr 5e-5, batch 32, bf16. The model selected is the last epoch.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import time
from collections import Counter
from pathlib import Path

import torch
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

ROOT = Path(__file__).resolve().parent
CLI = ROOT.parent


def meanings() -> list[str]:
    src = (CLI / "src" / "engine" / "meanings.ts").read_text(encoding="utf8")
    block = re.search(r"export const MEANINGS = \[(.*?)\] as const", src, re.S).group(1)
    return re.findall(r'"([a-z_]+)"', block)


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line]


def build(seed: int, weak: bool) -> tuple[list[tuple[str, int, float]], list[tuple[str, int, float]], list[str]]:
    labels = meanings()
    idx = {m: i for i, m in enumerate(labels)}
    rnd = random.Random(seed)
    synth = load(ROOT / "data" / "synth.jsonl")
    rows: list[tuple[str, int, float]] = [(r["text"], idx[r["label"]], 1.0) for r in synth]
    if weak:
        public = [r for r in load(ROOT / "data" / "public.jsonl") if r["split"] == "train" and r["rule_confidence"] >= 0.6]
        by_source: dict[str, list[dict]] = {}
        for r in public:
            by_source.setdefault(r["source"], []).append(r)
        for src, rs in by_source.items():
            rnd.shuffle(rs)
            rows += [(r["text"], idx[r["rule"]], 0.5) for r in rs[:6000]]
    # One copy of each (text, label).
    seen = set()
    uniq = []
    for t, y, w in rows:
        if (t, y) in seen:
            continue
        seen.add((t, y))
        uniq.append((t, y, w))
    rnd.shuffle(uniq)
    n_dev = max(1000, len(uniq) // 25)
    return uniq[n_dev:], uniq[:n_dev], labels


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="answerdotai/ModernBERT-base")
    ap.add_argument("--out", default=str(ROOT / "runs" / "gr-col-1"))
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=128)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--no-weak", action="store_true", help="synthetic data only (ablation)")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    train, dev, labels = build(args.seed, weak=not args.no_weak)
    print(f"train {len(train)}  dev {len(dev)}  labels {len(labels)}")
    print("label counts:", dict(Counter(labels[y] for _, y, _ in train).most_common()))

    tok = AutoTokenizer.from_pretrained(args.base)
    lengths = sorted(len(tok(t)["input_ids"]) for t, _, _ in train[:5000])
    print(f"token length p50 {lengths[len(lengths) // 2]}  p99 {lengths[int(len(lengths) * 0.99)]}  max {lengths[-1]}")

    model = AutoModelForSequenceClassification.from_pretrained(
        args.base,
        num_labels=len(labels),
        id2label=dict(enumerate(labels)),
        label2id={m: i for i, m in enumerate(labels)},
        attn_implementation="sdpa",
        reference_compile=False,
    ).cuda()

    def collate(batch):
        enc = tok([b[0] for b in batch], padding=True, truncation=True, max_length=args.max_len, return_tensors="pt")
        enc["labels"] = torch.tensor([b[1] for b in batch])
        enc["weights"] = torch.tensor([b[2] for b in batch])
        return enc

    dl = DataLoader(train, batch_size=args.batch, shuffle=True, collate_fn=collate)
    dev_dl = DataLoader(dev, batch_size=128, collate_fn=collate)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * len(dl)
    sched = get_linear_schedule_with_warmup(opt, int(steps * 0.06), steps)
    log = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for i, b in enumerate(dl):
            b = {k: v.cuda() for k, v in b.items()}
            w = b.pop("weights")
            y = b.pop("labels")
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = model(**b).logits
            loss = (torch.nn.functional.cross_entropy(logits.float(), y, reduction="none") * w).sum() / w.sum()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            total += loss.item()
            if i % 500 == 0:
                print(f"epoch {epoch + 1} step {i}/{len(dl)} loss {loss.item():.4f}  {time.time() - t0:.0f}s", flush=True)
        model.eval()
        right = n = 0
        with torch.no_grad():
            for b in dev_dl:
                b = {k: v.cuda() for k, v in b.items()}
                b.pop("weights")
                y = b.pop("labels")
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    pred = model(**b).logits.argmax(-1)
                right += (pred == y).sum().item()
                n += len(y)
        entry = {"epoch": epoch + 1, "train_loss": total / len(dl), "dev_accuracy": right / n, "seconds": round(time.time() - t0)}
        log.append(entry)
        print(entry, flush=True)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    tok.save_pretrained(out)
    meta = {
        "base": args.base,
        "labels": labels,
        "max_len": args.max_len,
        "weak_labels": not args.no_weak,
        "train_examples": len(train),
        "dev_examples": len(dev),
        "epochs": args.epochs,
        "lr": args.lr,
        "batch": args.batch,
        "seed": args.seed,
        "gpu": torch.cuda.get_device_name(0),
        "precision": "bf16 autocast",
        "torch": torch.__version__,
        "log": log,
        "train_seconds": round(time.time() - t0),
    }
    (out / "training.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(f"saved {out}")


if __name__ == "__main__":
    main()
