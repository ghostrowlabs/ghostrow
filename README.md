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

## Your own AI provider (Pro, Max)

Optional and off unless `GHOSTROW_AI_PROVIDER` is set. For the columns the built-in engine is
least sure about, Ghostrow sends schema text only (table names, column names and types; never
rows, samples or code) to the provider you choose, checks each answer against the column type and
marks every change in `ghostrow.rules.yaml`. A misconfigured provider only prints a warning.

| `GHOSTROW_AI_PROVIDER` | Settings | Default model |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-5-mini` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `bedrock` | `AWS_REGION` (or the profile's region). Credentials from the usual AWS chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, `AWS_PROFILE` (static keys, `credential_process`, IAM Identity Center after `aws sso login`), web identity, ECS/EKS container credentials, EC2 instance role. Or a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`. Uses the Converse API. | Amazon Nova Lite via the region's cross-Region inference profile, e.g. `us.amazon.nova-lite-v1:0` |
| `vertex` | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (default `global`). Credentials: `GOOGLE_APPLICATION_CREDENTIALS` (service account key), `gcloud auth application-default login`, the metadata server on Google Cloud, or a token in `GOOGLE_OAUTH_ACCESS_TOKEN`. | `gemini-2.5-flash` |
| `azure` | `AZURE_OPENAI_ENDPOINT` (`https://<resource>.openai.azure.com`), `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_KEY` or a Microsoft Entra token in `AZURE_OPENAI_AD_TOKEN`, `AZURE_OPENAI_API_VERSION` (default `2024-10-21`). | your deployment |

`GHOSTROW_AI_MODEL` overrides the model (on Azure, the deployment). Role-assuming AWS profiles
aren't resolved by Ghostrow itself: run `eval "$(aws configure export-credentials --format env)"`
first, or point the profile at a `credential_process`.

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
