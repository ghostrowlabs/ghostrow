/** Resolved global options shared by every command handler. */
export interface RunContext {
  /** `--db <url>`: a live Postgres/MySQL/SQLite/SQL Server connection string. */
  db?: string;
  /** `--schema <file>`: a DDL file or ORM models instead of a live database. */
  schema?: string;
  /** `--code <dir>`: application code to read for validation rules (Pro, Max). */
  codeDir?: string;
  /** `--rules <file>`: the rules file to read and update. Default `ghostrow.rules.yaml`. */
  rules: string;
  /** `--seed <n>`: a deterministic seed. Same seed → same output. */
  seed?: number;
  quiet: boolean;
  json: boolean;
  /** `--no-model`: use the rule engine only, even when a model is installed. */
  noModel?: boolean;
}

export function parseSeed(value: string, argLabel: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 32 - 1) throw new Error(`${argLabel} must be a non-negative integer; got "${value}".`);
  return n;
}
