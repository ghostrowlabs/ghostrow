"""Export a merged gr-rules-1 model to ONNX for the CLI: int4 weights (MatMulNBits), CPU.

    uv run python export.py runs/gr-rules-1-1.5b/merged artifacts/gr-rules-1-1.5b-int4

Uses the ONNX Runtime GenAI model builder (onnxruntime-genai): one decoder graph with a KV cache
(GroupQueryAttention, the CPU contrib ops that ship in every onnxruntime build, onnxruntime-node
included). The CLI runs that graph with its own greedy loop, so no GenAI runtime is needed there.
"""

import json
import shutil
import sys
from pathlib import Path

import onnxruntime_genai.models as _models

# The builder imports its parts as top-level modules ("from builders import ..."), from its own folder.
sys.path.insert(0, str(Path(_models.__file__).parent))
from builders import base  # noqa: E402

# transformers 4.57 always sets config.rope_scaling (None for Qwen2.5); the builder iterates it.
_init = base.Model.make_config_init


def _make_config_init(self, config):
    if getattr(config, "rope_scaling", 0) is None:
        config.rope_scaling = {"rope_type": "default"}
    return _init(self, config)


base.Model.make_config_init = _make_config_init


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    precision = sys.argv[3] if len(sys.argv) > 3 else "int4"
    version = sys.argv[4] if len(sys.argv) > 4 else "dev"
    out.mkdir(parents=True, exist_ok=True)
    import runpy

    sys.argv = ["builder", "-i", str(src), "-o", str(out), "-p", precision, "-e", "cpu", "-c", str(src.parent / "onnx-cache"), "--extra_options", "int4_accuracy_level=4"]
    try:
        runpy.run_module("onnxruntime_genai.models.builder", run_name="__main__")
    except SystemExit as e:
        if e.code:
            raise
    # The CLI reads the tokenizer itself (byte-level BPE, tokenizer.json).
    for f in ["tokenizer.json", "tokenizer_config.json"]:
        if (src / f).exists() and not (out / f).exists():
            shutil.copy(src / f, out / f)
    # What the CLI's decoder needs to know (src/rulemodel/model.ts), from the builder's config.
    dec = json.loads((out / "genai_config.json").read_text())["model"]
    run = json.loads((src.parent / "run.json").read_text()) if (src.parent / "run.json").exists() else {}
    info = {
        "name": "gr-rules-1",
        "task": "rule-proposal",
        "version": version,
        "base": run.get("base"),
        "format_version": 1,
        "layers": dec["decoder"]["num_hidden_layers"],
        "kv_heads": dec["decoder"]["num_key_value_heads"],
        "head_size": dec["decoder"]["head_size"],
        "eos": dec["eos_token_id"] if isinstance(dec["eos_token_id"], list) else [dec["eos_token_id"]],
        "max_new_tokens": 160,
        "precision": precision,
    }
    (out / "model.json").write_text(json.dumps(info, indent=1) + "\n")
    size =sum(p.stat().st_size for p in out.iterdir() if p.is_file())
    print(json.dumps({"out": str(out), "files": sorted(p.name for p in out.iterdir()), "bytes": size}, indent=1))


if __name__ == "__main__":
    main()
