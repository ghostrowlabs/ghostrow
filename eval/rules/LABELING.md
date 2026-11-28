# Held-out rules: how the answer key was written

The held-out set for gr-rules-1 is real public schemas and application code that the model was
never trained on (training data is synthetic only, `training/rules/tools/synth.ts`). Two kinds of
labels make up the answer key.

## 1. Declared by the schema's authors (objective)

Cross-column CHECK constraints of the form `a >= b` (optionally `OR a IS NULL`) are taken out of
the schema before anything sees it (`stripDeclared` in `heldout.ts`), and become labels. Nobody
here wrote them: AdventureWorks and GitLab declared them. There are 20 (all in the dev split).
CHECKs the parser keeps in another shape stay in the prompt and are `ignore` labels.

## 2. Hand-written (one labeller: Claude, an AI assistant)

Every other label was written by Claude (the AI assistant doing this work), from the prompt text
and, for code cases, the code itself. No independent human review yet. Rules, in order:

- **Only rules the CLI could use.** A rule is labelled only if it can be expressed in the rule
  format on the schema as Ghostrow parses it (for example Airflow's timestamps parse as text, so
  their orderings aren't labelled; `invoice.total = sum(unit_price × quantity)` has no single kind).
- **Orderings** are labelled when both columns are events of the same record's own process or
  the two ends of a declared range: `created_at <= updated_at`, `created_at <= deleted_at`,
  `placed_at <= shipped_at`, `start <= end`, `min_x <= max_x`, a part and its whole
  (`rejected_qty <= received_qty`). Not labelled: birth dates against anything (a person's birth is
  not part of the record's process), times of day that can cross midnight (AdventureWorks' night
  shift), usage against a limit that can change (`sms_sent` vs `sms_limit`).
- **Sums, products, copies** are labelled when the names and relations say so plainly: a header
  total over its line amounts, a line amount as quantity × unit price, a line's unit price or
  currency taken from the referenced product or order. A price *history* row is not a copy of the
  current price; a purchase price is not the product's list price.
- **Limits and allowed values** come only from code, exactly as the code states them, with the
  values visible in the code given to the model (a limit through a named constant defined
  elsewhere, like NetBox's `VLAN_VID_MAX`, is not labelled). Inclusive limits only: `> 0` on an
  integer is `min 1`; `> 0` on a decimal has no exact form and is an `also` label at `min 0`.
  A `maxlen` equal to the column's declared length changes nothing and is ignored everywhere.
- **`also`** marks rules that are true but not required (net ≤ gross amounts, a usage date after
  creation): proposing them is never a false positive, missing them never costs recall.

## Splits

- **dev** (158 tables): Chinook, Sakila, Northwind, pubs, AdventureWorks, Saleor, Healthchecks,
  Umami, 7 GitLab tables. Its results were looked at during development (after the first trained
  model), and the training data and deterministic check were changed afterwards in general ways
  (see RESULTS.md). Model choice used this split only.
- **test** (118 tables, 28 with code): Hoppscotch, Airflow, Superset, Wagtail, a seeded sample of
  35 cal.com tables, and validator code from Pterodactyl (Laravel), NetBox (Django), the FastAPI
  full-stack template (SQLModel), JHipster's sample app (Bean Validation), Clean Architecture
  (FluentValidation), node-express-boilerplate (Joi, Mongoose) and Spree (Rails). Labelled before
  any model output existed for it, and scored once per candidate model.

The schemas for code cases (except NetBox, whose models file is the schema) were written by hand
from each model's fields, with the repository's column names; they are in `code/<case>/schema.sql`.
Every downloaded file is pinned to a commit with its licence and SHA-256 (`sources.lock.json`,
`../../training/sources.lock.json`).
