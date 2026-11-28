"""Greedy answers from a trained rule model for every held-out prompt (GPU, transformers).

    cd cli/training/rules && uv run python ../../eval/rules/generate.py runs/gr-rules-1-0.5b/merged out.jsonl

Development check only: the numbers in RESULTS.md come from the exported ONNX model run by the
CLI's own decoder (eval/rules/rules_eval.ts), so what is measured is what ships.
"""

import json
import sys
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = Path(__file__).resolve().parent
SYSTEM = "You read one database table, its related tables and any application code for it, and list the data rules the table's rows must follow. One rule per line, or none."


def main() -> None:
    model_dir, out = sys.argv[1], sys.argv[2]
    src = Path(sys.argv[3]) if len(sys.argv) > 3 else HERE / "heldout.jsonl"
    tok = AutoTokenizer.from_pretrained(model_dir)
    tok.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(model_dir, dtype=torch.bfloat16, device_map={"": 0}).eval()
    items = [json.loads(l) for l in src.read_text(encoding="utf8").splitlines() if l.strip()]
    prompts = [i.get("prompt") or f"<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n{i['user']}<|im_end|>\n<|im_start|>assistant\n" for i in items]
    end = tok.convert_tokens_to_ids("<|im_end|>")
    with open(out, "w", encoding="utf8") as f:
        for b in range(0, len(items), 16):
            enc = tok(prompts[b : b + 16], return_tensors="pt", padding=True, add_special_tokens=False).to("cuda")
            with torch.no_grad():
                gen = model.generate(**enc, max_new_tokens=160, do_sample=False, eos_token_id=end, pad_token_id=tok.pad_token_id)
            for i, g in zip(items[b : b + 16], gen):
                text = tok.decode(g[enc.input_ids.shape[1] :], skip_special_tokens=True).strip()
                f.write(json.dumps({"id": i["id"], "output": text}) + "\n")
    print(f"{len(items)} answers -> {out}")


if __name__ == "__main__":
    main()
