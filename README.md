# Ghostrow CLI

Real-looking data. Zero real data.

Ghostrow reads a database schema and generates consistent, realistic test data that contains no
real personal data. It runs offline, is seeded so the same seed gives the same output, and works
with Postgres, MySQL, SQL Server and SQLite.

## Install

| Method | Command |
| --- | --- |
| npm (Node.js 20 or later) | `npm i -g ghostrow` |
| Homebrew | `brew install ghostrowlabs/tap/ghostrow` |
| macOS and Linux script | `curl -fsSL https://ghostrow.com/install.sh \| sh` |
| Windows PowerShell | `irm https://ghostrow.com/install.ps1 \| iex` |
| winget | `winget install Ghostrow.Ghostrow` |
| pip (bundles the program, no Node.js needed) | `pip install ghostrow` |

Installers and archives for macOS (`.pkg`, `.tar.gz`), Linux (`.deb`, `.tar.gz`) and Windows
(`.msi`, `.zip`) are on the
[GitHub Releases](https://github.com/ghostrowlabs/ghostrow/releases) page. Each release includes a
`SHA256SUMS` file; check a download with `sha256sum -c SHA256SUMS --ignore-missing`.

The install scripts verify the checksum before installing. Set `GHOSTROW_VERSION` to pin a
version, `GHOSTROW_INSTALL` to change the install folder, and `GHOSTROW_NO_MODIFY_PATH=1` to leave
your PATH alone.

## Quickstart

```sh
# See what Ghostrow infers from your schema, without writing any rows
ghostrow seed --schema schema.sql --dry-run

# Write repeatable data to files
ghostrow seed --schema schema.sql --seed 42 --rows 5000 --out fixtures/

# Insert straight into a database
ghostrow seed --db postgres://localhost/app_test --seed 42 --rows 5000
```

## Commands

| Command | Meaning |
| --- | --- |
| `ghostrow seed` | Consistent, realistic data of any size. |
| `ghostrow haunt` | Edge-case rows plus a report of the tests they broke. (Pro, Max) |
| `ghostrow twin` | A synthetic copy with the same shape and statistics as a database. (Max) |
| `ghostrow activate <key>` | Activate this machine for your license. |
| `ghostrow deactivate` | Free this machine so you can use the seat elsewhere. |
| `ghostrow status` | Show the plan, seat, machines used and updates end date. |
| `ghostrow model pull` | Download the on-device schema model (`gr-col-1`, all plans) and verify its signature. |
| `ghostrow model status` / `model remove` | Show or delete the installed model. |

## The schema model

`ghostrow model pull` downloads `gr-col-1`, a 32 MB int8 encoder fine-tuned to read a column's
schema text (names, types, keys, nearby columns; never values) and propose what it holds. The
manifest is signed (Ed25519) and every file is checked against its SHA-256 before it is installed
in `~/.ghostrow/models`. After that it runs offline on the CPU.

The model only proposes: a proposal is used when the model is at least 50% sure and the meaning
fits the column's declared type; otherwise the rule engine's meaning stands. Rows still come from
the seeded generator and are validated against your constraints. `--no-model` turns it off for a
run. Without a model, Ghostrow uses the rule engine exactly as before. Results, method and data:
[`eval/RESULTS.md`](eval/RESULTS.md); training: [`training/README.md`](training/README.md).

## Plans

Free works without a key: up to 5 tables and 10,000 rows, on Postgres and SQLite. Plus, Pro and
Max need a license from https://ghostrow.com. Activate it with `ghostrow activate <key>`.

## License

Ghostrow is proprietary software. Use is governed by the End User License Agreement at
https://ghostrow.com/legal/eula. See `LICENSE`.

## Documentation

- Quickstart: https://ghostrow.com/docs/quickstart
- Command reference: https://ghostrow.com/docs/cli-reference
- All docs: https://ghostrow.com/docs
