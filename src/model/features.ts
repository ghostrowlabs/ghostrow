import type { ColumnModel, TableModel } from "../connect/types.js";
import { words } from "../engine/meanings.js";

/**
 * The text the column-meaning model reads for one column. The training data is built with
 * this same function (training/tools/extract.ts), so what the model saw in training and
 * what it sees in the CLI can't drift apart. Schema text only: never values from the database.
 *
 *   orders . total amount | decimal numeric(10,2) | not null | near: id, customer id, created at
 */
export const FEATURE_VERSION = 1;

const MAX_NEIGHBOURS = 8;

export function columnText(table: TableModel, col: ColumnModel): string {
  const flags: string[] = [];
  if (col.primaryKey) flags.push("primary key");
  if (table.foreignKeys.some((f) => f.columns.includes(col.name))) flags.push("foreign key");
  if (col.autoIncrement) flags.push("auto");
  if (col.unique) flags.push("unique");
  if (!col.nullable) flags.push("not null");
  if (col.defaultValue) flags.push(`default ${col.defaultValue.slice(0, 24)}`);
  if (col.enumValues?.length) flags.push(`values ${col.enumValues.slice(0, 6).join(" ")}`);
  const type = [col.type, col.rawType.toLowerCase().replace(/\s+/g, " ").slice(0, 32)];
  if (col.maxLength !== undefined && !type[1]!.includes(String(col.maxLength))) type.push(`(${col.maxLength})`);
  const i = table.columns.indexOf(col);
  const near = table.columns
    .map((c, j) => ({ c, d: Math.abs(j - i) }))
    .filter(({ c }) => c !== col)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_NEIGHBOURS)
    .sort((a, b) => table.columns.indexOf(a.c) - table.columns.indexOf(b.c))
    .map(({ c }) => words(c.name).join(" "));
  return `${words(table.name).join(" ")} . ${words(col.name).join(" ")} | ${type.join(" ")} | ${flags.join(", ") || "-"} | near: ${near.join(", ")}`;
}
