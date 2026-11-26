"""Download the public schemas listed in sources.json at their pinned commits.

    uv run python fetch_public.py            -> data/public/<id>/<path>, sources.lock.json

Every downloaded file is recorded in sources.lock.json with its repository, commit,
licence, split and sha256, so the dataset can be rebuilt byte for byte. The files are
only parsed as data (never executed).
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "public"


def tree(repo: str, sha: str) -> list[str]:
    # gh uses the signed-in token when there is one (higher rate limit); plain API otherwise.
    try:
        raw = subprocess.run(["gh", "api", f"repos/{repo}/git/trees/{sha}?recursive=1"], check=True, capture_output=True).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        with urllib.request.urlopen(f"https://api.github.com/repos/{repo}/git/trees/{sha}?recursive=1") as r:
            raw = r.read()
    data = json.loads(raw)
    if data.get("truncated"):
        print(f"warning: tree for {repo} is truncated", file=sys.stderr)
    return [e["path"] for e in data["tree"] if e["type"] == "blob"]


def main() -> None:
    sources = json.loads((ROOT / "sources.json").read_text())["sources"]
    lock = []
    for s in sources:
        if not s["include"]:
            continue
        paths = [p for p in tree(s["repo"], s["sha"]) if any(re.search(rx, p) for rx in s["include"])]
        paths = [p for p in paths if not any(x in p for x in s.get("exclude", []))]
        paths = [p for p in paths if not re.search(r"(^|/)(ee|jh)/", p)]
        for p in sorted(paths):
            dest = OUT / s["id"] / p
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                url = f"https://raw.githubusercontent.com/{s['repo']}/{s['sha']}/{p}"
                with urllib.request.urlopen(url) as r:
                    dest.write_bytes(r.read())
            digest = hashlib.sha256(dest.read_bytes()).hexdigest()
            lock.append({"source": s["id"], "repo": s["repo"], "commit": s["sha"], "path": p, "license": s["license"], "split": s["split"], "sha256": digest})
        print(f"{s['id']:14} {s['split']:6} {len(paths):4} file(s)")
    (ROOT / "sources.lock.json").write_text(json.dumps(lock, indent=1) + "\n")
    print(f"{len(lock)} files recorded in sources.lock.json")


if __name__ == "__main__":
    main()
