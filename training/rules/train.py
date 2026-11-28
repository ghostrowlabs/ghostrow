"""QLoRA fine-tune of a small instruct model into gr-rules-1, the rule-proposal model.

    uv run python train.py --base Qwen/Qwen2.5-0.5B-Instruct --out runs/gr-rules-1-0.5b

The base model is loaded in 4-bit (NF4, bf16 compute), LoRA adapters (r=32) are trained on
every linear layer, and the loss covers the answer tokens only. Data: data/synth.jsonl (ground
truth from tools/synth.ts). data/synth-test.jsonl (another seed) is only used for the loss
printed at the end; the real held-out set (../../eval/rules/) is never read here.
After training the adapters are merged into the bf16 base and saved to <out>/merged.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

ROOT = Path(__file__).resolve().parent
END = "<|im_end|>\n"


def load(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf8").splitlines() if l.strip()]


def encode(tok, ex: dict, max_len: int) -> tuple[list[int], list[int]]:
    p = tok(ex["prompt"], add_special_tokens=False).input_ids
    a = tok(ex["answer"] + END, add_special_tokens=False).input_ids
    ids = (p + a)[:max_len]
    labels = ([-100] * len(p) + a)[:max_len]
    return ids, labels


def batches(items: list[tuple[list[int], list[int]]], tokens: int, rng: random.Random, shuffle: bool):
    """Length-bucketed batches of at most `tokens` padded tokens."""
    order = sorted(range(len(items)), key=lambda i: len(items[i][0]))
    out, cur, longest = [], [], 0
    for i in order:
        n = len(items[i][0])
        if cur and max(longest, n) * (len(cur) + 1) > tokens:
            out.append(cur)
            cur, longest = [], 0
        cur.append(i)
        longest = max(longest, n)
    if cur:
        out.append(cur)
    if shuffle:
        rng.shuffle(out)
    return out


def collate(items, idx, pad: int, device):
    n = max(len(items[i][0]) for i in idx)
    ids = torch.full((len(idx), n), pad, dtype=torch.long)
    lab = torch.full((len(idx), n), -100, dtype=torch.long)
    mask = torch.zeros((len(idx), n), dtype=torch.long)
    for r, i in enumerate(idx):
        a, b = items[i]
        ids[r, : len(a)] = torch.tensor(a)
        lab[r, : len(b)] = torch.tensor(b)
        mask[r, : len(a)] = 1
    return ids.to(device), lab.to(device), mask.to(device)


def answer_loss(model, ids, mask, lab) -> tuple[torch.Tensor, int]:
    """Cross-entropy on answer tokens only. The LM head runs on those positions alone: with a
    152k-token vocabulary, logits for every position would not fit in 12 GB."""
    inner = model.get_base_model()
    h = inner.model(input_ids=ids, attention_mask=mask).last_hidden_state
    sel = lab[:, 1:] != -100
    logits = inner.lm_head(h[:, :-1][sel]).float()
    return torch.nn.functional.cross_entropy(logits, lab[:, 1:][sel]), int(sel.sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--out", default=str(ROOT / "runs" / "gr-rules-1-0.5b"))
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--batch-tokens", type=int, default=8000)
    ap.add_argument("--max-len", type=int, default=768)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0, help="train on the first N examples only (smoke test)")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.base)
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id

    train = load(ROOT / "data" / "synth.jsonl")
    if args.limit:
        train = train[: args.limit]
    test = load(ROOT / "data" / "synth-test.jsonl")
    tr = [encode(tok, e, args.max_len) for e in train]
    te = [encode(tok, e, args.max_len) for e in test]
    print(f"{len(tr)} training examples, {sum(len(a) for a, _ in tr)} tokens; {len(te)} synthetic test examples")

    q = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(args.base, quantization_config=q, dtype=torch.bfloat16, device_map={"": 0}, attn_implementation="sdpa")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True, gradient_checkpointing_kwargs={"use_reentrant": False})
    lora = LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM", target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0, betas=(0.9, 0.999))
    epoch_batches = batches(tr, args.batch_tokens, rng, True)
    total = math.ceil(len(epoch_batches) * args.epochs)
    warm = max(10, total // 30)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * max(0.0, 0.5 * (1 + math.cos(math.pi * min(1.0, s / total)))))
    print(f"{total} steps ({len(epoch_batches)} per epoch)")

    def evaluate() -> float:
        model.eval()
        tot, n = 0.0, 0
        with torch.no_grad():
            for idx in batches(te, args.batch_tokens, rng, False):
                ids, lab, mask = collate(te, idx, pad, "cuda")
                loss, k = answer_loss(model, ids, mask, lab)
                tot += float(loss) * k
                n += k
        model.train()
        return tot / max(n, 1)

    model.train()
    step, t0, run = 0, time.time(), 0.0
    log = open(out / "train.log", "a", encoding="utf8")
    while step < total:
        for idx in batches(tr, args.batch_tokens, rng, True):
            if step >= total:
                break
            ids, lab, mask = collate(tr, idx, pad, "cuda")
            loss, _ = answer_loss(model, ids, mask, lab)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            run = 0.98 * run + 0.02 * float(loss) if step else float(loss)
            step += 1
            if step % 50 == 0 or step == total:
                msg = f"step {step}/{total} loss {run:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s"
                print(msg, flush=True)
                log.write(msg + "\n")
                log.flush()
    test_loss = evaluate()
    msg = f"synthetic test loss {test_loss:.4f} after {time.time() - t0:.0f}s"
    print(msg)
    log.write(msg + "\n")
    model.save_pretrained(out / "adapter")

    # Merge into the bf16 base (not the 4-bit one) for export.
    del model
    torch.cuda.empty_cache()
    from peft import PeftModel

    base = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16)
    merged = PeftModel.from_pretrained(base, out / "adapter").merge_and_unload()
    merged.save_pretrained(out / "merged", safe_serialization=True)
    tok.save_pretrained(out / "merged")
    (out / "run.json").write_text(json.dumps({"base": args.base, "epochs": args.epochs, "lr": args.lr, "rank": args.rank, "batch_tokens": args.batch_tokens, "train_examples": len(tr), "steps": total, "synthetic_test_loss": test_loss, "seconds": round(time.time() - t0)}, indent=1))
    print(f"merged model -> {out / 'merged'}")


if __name__ == "__main__":
    main()
