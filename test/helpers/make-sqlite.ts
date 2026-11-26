/** Create a SQLite database file from a DDL file: `npx tsx test/helpers/make-sqlite.ts schema.sql out.db` */
import { readFileSync, writeFileSync } from "node:fs";
import { loadSqlJs } from "../../src/connect/sqlite.js";

const [ddl, out] = process.argv.slice(2);
const SQL = await loadSqlJs();
const db = new SQL.Database();
db.run(readFileSync(ddl!, "utf8").replace(/SERIAL PRIMARY KEY/gi, "INTEGER PRIMARY KEY"));
writeFileSync(out!, db.export());
db.close();
