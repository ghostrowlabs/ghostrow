"""Held-out evaluation of the exported model (model alone, no rule engine), in Python.

    cd training && uv run python ../eval/model_eval.py [--model artifacts/gr-col-1]

Measures, on eval/heldout.csv:
  - accuracy of the rule engine (gr-schema-1) — the baseline
  - accuracy of the fp32 and the int8 ONNX model (argmax over all meanings)
  - the same on "unseen names": held-out columns whose name never appears in training data
  - CPU latency of the int8 model with onnxruntime (1 thread and all threads)
Writes eval/results/<model>.model.json. The CLI pipeline (model proposes, deterministic
engine decides) is measured separately by eval/cli_eval.ts.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import statistics
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

EVAL = Path(__file__).resolve().parent
TRAIN = EVAL.parent / "training"


def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(line) for line in p.read_text(encoding="utf8").splitlines() if line]


def name_key(s: str) -> str:
    return s.lower().replace("_", "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(TRAIN / "artifacts" / "gr-col-1"))
    args = ap.parse_args()
    mdir = Path(args.model)
    info = json.loads((mdir / "model.json").read_text())
    labels = info["labels"]

    held = list(csv.DictReader((EVAL / "heldout.csv").open(encoding="utf8")))
    texts = {(r["source"], r["table"], r["column"]): r["text"] for r in load_jsonl(TRAIN / "data" / "public.jsonl") if r["split"] == "eval"}
    train_names = {name_key(r["column"]) for r in load_jsonl(TRAIN / "data" / "synth.jsonl")}
    train_names |= {name_key(r["column"]) for r in load_jsonl(TRAIN / "data" / "public.jsonl") if r["split"] == "train"}

    tok = Tokenizer.from_file(str(mdir / "tokenizer.json"))
    enc = [tok.encode(texts[(r["source"], r["table"], r["column"])]).ids[: info["max_len"]] for r in held]
    golden = [{"text": texts[(r["source"], r["table"], r["column"])], "ids": e} for r, e in zip(held, enc)]
    (EVAL / "tokenizer-golden.json").write_text(json.dumps(golden[:200]) + "\n")

    def batches(items, size):
        for i in range(0, len(items), size):
            chunk = items[i : i + size]
            n = max(len(x) for x in chunk)
            ids = np.full((len(chunk), n), tok.token_to_id("[PAD]"), dtype=np.int64)
            mask = np.zeros((len(chunk), n), dtype=np.int64)
            for j, x in enumerate(chunk):
                ids[j, : len(x)] = x
                mask[j, : len(x)] = 1
            yield ids, mask

    def predict(path: Path, threads: int = 0) -> list[str]:
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        out = []
        for ids, mask in batches(enc, 64):
            logits = s.run(["logits"], {"input_ids": ids, "attention_mask": mask})[0]
            out += [labels[i] for i in logits.argmax(-1)]
        return out

    gold = [r["label"] for r in held]
    rule = [r["rule"] for r in held]
    unseen = [name_key(r["column"]) not in train_names for r in held]
    systems = {"rule_engine": rule}
    if (mdir / "model.fp32.onnx").exists():
        systems["model_fp32"] = predict(mdir / "model.fp32.onnx")
    systems["model_int8"] = predict(mdir / "model.onnx")

    def acc(pred, mask=None):
        idx = [i for i in range(len(gold)) if mask is None or mask[i]]
        right = sum(pred[i] == gold[i] for i in idx)
        return {"correct": right, "total": len(idx), "accuracy": round(right / len(idx), 4) if idx else None}

    result = {"held_out_columns": len(gold), "unseen_name_columns": sum(unseen), "systems": {}}
    for name, pred in systems.items():
        result["systems"][name] = {"all": acc(pred), "unseen_names": acc(pred, unseen), "by_source": {}}
        for src in sorted({r["source"] for r in held}):
            result["systems"][name]["by_source"][src] = acc(pred, [r["source"] == src for r in held])
    per = defaultdict(lambda: {"support": 0, "rule_engine": 0, "model_int8": 0})
    for i, g in enumerate(gold):
        per[g]["support"] += 1
        per[g]["rule_engine"] += rule[i] == g
        per[g]["model_int8"] += systems["model_int8"][i] == g
    result["per_meaning"] = dict(sorted(per.items(), key=lambda kv: -kv[1]["support"]))
    result["disagreements"] = [
        {"source": r["source"], "table": r["table"], "column": r["column"], "label": g, "rule_engine": rule[i], "model_int8": systems["model_int8"][i]}
        for i, (r, g) in enumerate(zip(held, gold))
        if rule[i] != g or systems["model_int8"][i] != g
    ]

    # CPU latency, int8, Python onnxruntime.
    lat = {}
    for threads in (1, 0):
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        s = ort.InferenceSession(str(mdir / "model.onnx"), so, providers=["CPUExecutionProvider"])
        one = []
        for x in enc[:200]:
            ids, mask = next(batches([x], 1))
            t = time.perf_counter()
            s.run(["logits"], {"input_ids": ids, "attention_mask": mask})
            one.append((time.perf_counter() - t) * 1000)
        t = time.perf_counter()
        for ids, mask in batches(enc, 64):
            s.run(["logits"], {"input_ids": ids, "attention_mask": mask})
        total = (time.perf_counter() - t) * 1000
        lat["1_thread" if threads == 1 else "all_threads"] = {
            "single_column_ms_p50": round(statistics.median(one), 2),
            "single_column_ms_p95": round(sorted(one)[int(len(one) * 0.95)], 2),
            "batched_64_ms_per_column": round(total / len(enc), 2),
        }
    result["cpu_latency_python_ort"] = lat
    result["machine"] = {"cpu": platform.processor(), "logical_cpus": os.cpu_count(), "os": platform.platform(), "onnxruntime": ort.__version__}
    result["model"] = {k: info[k] for k in ("name", "base", "quantization", "feature_version")}
    result["model"]["variant"] = mdir.name
    result["model"]["onnx_int8_mb"] = round((mdir / "model.onnx").stat().st_size / 1e6, 1)
    out = EVAL / "results" / f"{mdir.name}.model.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, indent=1) + "\n")
    for name, r in result["systems"].items():
        print(f"{name:12} all {r['all']['accuracy']:.4f} ({r['all']['correct']}/{r['all']['total']})  unseen names {r['unseen_names']['accuracy']} ({r['unseen_names']['correct']}/{r['unseen_names']['total']})")
    print(json.dumps(lat))
    print(f"-> {out}")


if __name__ == "__main__":
    main()
