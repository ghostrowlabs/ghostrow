# Labelling guide for the held-out set

The held-out set is every column that is not a declared foreign key in five public schemas
that are never used for training: Chinook (MIT), Sakila (BSD-2-Clause), Umami (MIT),
Healthchecks (BSD-3-Clause) and Koel (MIT). Declared foreign keys are left out because the
CLI always labels them `reference` from the constraint; no model decides them.

A label is the meaning in `src/engine/meanings.ts` whose value model would produce the most
realistic values for the column. When two fit, pick by what the real column holds.

- `id`: the table's own surrogate key (integer, or a text key that is not a UUID).
- `uuid`: any UUID, including `char(36)` keys and undeclared references to UUID keys.
- Undeclared references (`user_id` with no FK constraint) take the label of their type:
  `integer`, `uuid`, or `code` for short opaque strings.
- `token`: secrets, API keys, hashes, fingerprints and long opaque third-party ids (click ids).
- `code`: short opaque identifiers (external ids, access codes, version strings, key names that
  are primary keys).
- `status`: a value from a small repeated set: types, kinds, roles, levels, event names,
  environment, browser, OS and device names, HTTP methods, themes.
- `title`: the name of a thing (product, playlist, report, check, channel). People are
  `full_name`; organisations and teams are `company`; job titles are `job_title`.
- `description`: free prose written by people (descriptions, notes, messages, content).
  Machine text (stack traces, user agents, query strings) is `text`.
- `json`: JSON, including JSON stored in a text column.
- Dates: `date` for a calendar day, `datetime` for a moment, whatever the declared type.
  `birth_date` for dates of birth.
- `count`: how many times something happened (attempts, pings, sent messages, events).
  `quantity`: units of something (items ordered, stock). Limits, sizes, positions and
  coordinates are `integer`; measurements are `number`.
- `money` for amounts of money, including rental rates; `percent` for shares out of 100.
- Postgres `interval` columns have no matching meaning and are `text`.

Labels were written by reviewing every column with the rule engine's proposal visible, so
any bias favours the rule engine baseline, not the model. Rows where the label differs from
the rule engine are marked in `heldout.csv` for review.
