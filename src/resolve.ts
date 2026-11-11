// `<db>` → one row of `beaver db list`: a database name, or `project/env/db` (the row's `ref`) when the
// name is on several servers.
import type { DbAccessRow } from "./api";
import { CliError } from "./errors";
import { suggest } from "./suggest";

export function resolveDb(rows: DbAccessRow[], input: string): DbAccessRow {
  const wanted = input.trim();
  if (!wanted) throw new CliError("Which database? Run: beaver db list");
  if (wanted.includes("/")) {
    const hit = rows.find((r) => r.ref.toLowerCase() === wanted.toLowerCase());
    if (hit) return hit;
    const close = suggest(wanted, rows.map((r) => r.ref));
    throw new CliError(`No database ${JSON.stringify(wanted)} among yours.${close ? ` Did you mean ${JSON.stringify(close)}?` : ""} Run: beaver db list`);
  }
  const named = rows.filter((r) => r.database === wanted);
  const matches = named.length ? named : rows.filter((r) => r.database.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliError(`${JSON.stringify(wanted)} is on ${matches.length} servers. Use one of:\n${matches.map((r) => `  ${r.ref}`).join("\n")}`);
  }
  if (!rows.length) throw new CliError("You have no database access yet. A workspace admin grants it per database.");
  const close = suggest(wanted, [...new Set(rows.map((r) => r.database))]);
  throw new CliError(`No database ${JSON.stringify(wanted)} among yours.${close ? ` Did you mean ${JSON.stringify(close)}?` : ""} Run: beaver db list`);
}
