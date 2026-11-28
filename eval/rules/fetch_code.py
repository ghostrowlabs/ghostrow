"""Download the held-out application code for gr-rules-1 at pinned commits.

    python eval/rules/fetch_code.py   -> eval/rules/code/<case>/<path>, eval/rules/sources.lock.json

Files are only read as text (never run). Every file is recorded with repository, commit,
licence and SHA-256. Only permissively licensed repositories.
"""
import hashlib, json, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = [
    ("pterodactyl", "pterodactyl/panel", "60a10015815835decffe4f77d15b0e7419d793b9", "MIT", ["app/Models/Allocation.php", "app/Models/Node.php", "app/Models/Server.php", "app/Models/Schedule.php", "app/Models/Location.php", "app/Models/Database.php"]),
    ("netbox", "netbox-community/netbox", "04bdbf464c380d2b4d1dc8d4f9c96fcc26f04981", "Apache-2.0", ["netbox/ipam/models/vlans.py", "netbox/dcim/models/power.py"]),
    ("fastapi-template", "fastapi/full-stack-fastapi-template", "f8c6c147b12bb1c4d3253cc1b06f8b5ef81b10dd", "MIT", ["backend/app/models.py"]),
    ("jhipster", "jhipster/jhipster-sample-app", "6b000b5d23a36c45e01472471b84a44fa2464044", "Apache-2.0", ["src/main/java/io/github/jhipster/sample/domain/BankAccount.java", "src/main/java/io/github/jhipster/sample/domain/Label.java", "src/main/java/io/github/jhipster/sample/domain/Operation.java", "src/main/java/io/github/jhipster/sample/domain/User.java"]),
    ("cleanarch", "jasontaylordev/CleanArchitecture", "f7f977156ccfbea21f5789863acb74bb79c01273", "MIT", ["src/Application/TodoItems/Commands/CreateTodoItem/CreateTodoItemCommandValidator.cs", "src/Application/TodoLists/Commands/CreateTodoList/CreateTodoListCommandValidator.cs", "src/Domain/Entities/TodoItem.cs", "src/Domain/Entities/TodoList.cs"]),
    ("express-boilerplate", "hagopj13/node-express-boilerplate", "179ae84efec61b14206d0305d941daed6c6d07f9", "MIT", ["src/validations/user.validation.js", "src/models/user.model.js"]),
    ("spree", "spree/spree", "627f0f6e8c8802664abe2d41e86c9c454a8c3dba", "BSD-3-Clause", ["spree/core/app/models/spree/price.rb", "spree/core/app/models/spree/stock_item.rb", "spree/core/app/models/spree/line_item.rb", "spree/core/app/models/spree/gift_card.rb", "spree/core/app/models/spree/store_credit.rb", "spree/core/app/models/spree/tax_rate.rb", "spree/core/app/models/spree/refund.rb"]),
]
lock = []
for case, repo, sha, lic, paths in SOURCES:
    for p in paths:
        dest = HERE / "code" / case / p
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(f"https://raw.githubusercontent.com/{repo}/{sha}/{p}") as r:
                dest.write_bytes(r.read())
        lock.append({"case": case, "repo": repo, "commit": sha, "path": p, "license": lic, "sha256": hashlib.sha256(dest.read_bytes()).hexdigest()})
(HERE / "sources.lock.json").write_text(json.dumps(lock, indent=1) + "\n")
print(len(lock), "files")
