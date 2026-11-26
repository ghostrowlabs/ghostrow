"""Export the fine-tuned model to ONNX and quantize it to int8 for CPU.

    uv run python export.py [--run runs/gr-col-1] [--out artifacts/gr-col-1]

Writes model.fp32.onnx (reference only, not shipped), model.onnx (dynamic int8 weights),
tokenizer.json and model.json (labels, sequence length, feature version).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSequenceClassification

ROOT = Path(__file__).resolve().parent


def feature_version() -> int:
    src = (ROOT.parent / "src" / "model" / "features.ts").read_text(encoding="utf8")
    return int(re.search(r"FEATURE_VERSION = (\d+)", src).group(1))


class Wrapped(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_ids, attention_mask):
        return self.m(input_ids=input_ids, attention_mask=attention_mask).logits


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=str(ROOT / "runs" / "gr-col-1"))
    ap.add_argument("--out", default=str(ROOT / "artifacts" / "gr-col-1"))
    ap.add_argument("--name", default="gr-col-1", help="model name the CLI sees")
    args = ap.parse_args()
    run, out = Path(args.run), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((run / "training.json").read_text())
    model = AutoModelForSequenceClassification.from_pretrained(run, attn_implementation="eager", reference_compile=False).float().eval()
    ids = torch.ones((2, 16), dtype=torch.long)
    mask = torch.ones((2, 16), dtype=torch.long)
    fp32 = out / "model.fp32.onnx"
    torch.onnx.export(
        Wrapped(model),
        (ids, mask),
        str(fp32),
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"}, "logits": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    quantize_dynamic(str(fp32), str(out / "model.onnx"), weight_type=QuantType.QInt8)
    shutil.copy(run / "tokenizer.json", out / "tokenizer.json")
    info = {
        "name": args.name,
        "variant": out.name,
        "task": "column-meaning",
        "labels": meta["labels"],
        "max_len": meta["max_len"],
        "feature_version": feature_version(),
        "base": meta["base"],
        "quantization": "dynamic int8 weights (onnxruntime)",
    }
    (out / "model.json").write_text(json.dumps(info, indent=1) + "\n")
    for f in sorted(out.iterdir()):
        print(f"{f.name:20} {f.stat().st_size / 1e6:8.1f} MB")


if __name__ == "__main__":
    main()
