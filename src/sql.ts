// SQL through the tunnel: ClickHouse over its HTTP interface (nothing to install),
// Postgres with the `pg` driver. Results come back as columns + rows, printed as a table, CSV, TSV or JSON.
import pg from "pg";
import { CliError } from "./errors";

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  /** The server's own output (a `FORMAT …` clause of ClickHouse): printed as is. */
  raw?: string;
  /** `INSERT 0 3`, `OK`: statements without rows. */
  summary?: string;
};

export interface SqlSession {
  readonly engine: "pg" | "clickhouse";
  query(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

/** The login / password was refused: a remembered password is forgotten, the person is told how to reset it. */
export class WrongPasswordError extends CliError {}

export type SessionTarget = { port: number; user: string; password: string; database: string };

export function clickhouseSession(t: SessionTarget, fetchImpl: typeof fetch): SqlSession {
  return {
    engine: "clickhouse",
    async query(sql) {
      const url = `http://127.0.0.1:${t.port}/?database=${encodeURIComponent(t.database)}&default_format=JSONCompact&output_format_json_quote_64bit_integers=0`;
      let res: Response;
      try {
        res = await fetchImpl(url, { method: "POST", headers: { "X-ClickHouse-User": t.user, "X-ClickHouse-Key": t.password }, body: sql });
      } catch (err) {
        throw new CliError(`The tunnel to ClickHouse failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      if (!res.ok) {
        const message = text.trim().replace(/\s*\(version [^)]*\)\s*$/, "");
        if (res.status === 401 || res.status === 403 || /Code: 516\b/.test(text)) throw new WrongPasswordError(`ClickHouse refused the password of ${t.user}.`);
        throw new CliError(message || `ClickHouse answered ${res.status}`);
      }
      if (!text.trim()) return { columns: [], rows: [], summary: "OK" };
      if (res.headers.get("x-clickhouse-format") !== "JSONCompact") return { columns: [], rows: [], raw: text };
      const body = JSON.parse(text) as { meta: { name: string }[]; data: unknown[][] };
      return { columns: body.meta.map((m) => m.name), rows: body.data };
    },
    async close() {},
  };
}

export async function pgSession(t: SessionTarget & { sslMode: "require" | "disable" }): Promise<SqlSession> {
  // `require` like psql: encrypted, the certificate isn't checked (the host is localhost through the tunnel).
  const client = new pg.Client({ host: "127.0.0.1", port: t.port, user: t.user, password: t.password, database: t.database, ssl: t.sslMode === "require" ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 15_000 });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "28P01" || e.code === "28000") throw new WrongPasswordError(`Postgres refused the password of ${t.user}.`);
    throw new CliError(`Couldn't connect to Postgres through the tunnel: ${e.message ?? String(err)}`);
  }
  return {
    engine: "pg",
    async query(sql) {
      let res: pg.QueryArrayResult | pg.QueryArrayResult[];
      try {
        res = (await client.query({ text: sql, rowMode: "array" })) as unknown as pg.QueryArrayResult | pg.QueryArrayResult[];
      } catch (err) {
        const e = err as { message?: string; position?: string };
        throw new CliError(`${e.message ?? String(err)}${e.position ? ` (at character ${e.position})` : ""}`);
      }
      // Several statements: the last one's result, like psql -c.
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      if (!last.fields?.length) return { columns: [], rows: [], summary: [last.command, last.rowCount].filter((x) => x !== null && x !== undefined).join(" ") || "OK" };
      return { columns: last.fields.map((f) => f.name), rows: last.rows };
    },
    async close() {
      await client.end().catch(() => {});
    },
  };
}

export type OutputFormat = "table" | "csv" | "tsv" | "json";
export const OUTPUT_FORMATS: OutputFormat[] = ["table", "csv", "tsv", "json"];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString("hex")}`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : cell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const tsvCell = (v: unknown) => (v === null || v === undefined ? "\\N" : cell(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n"));
const jsonValue = (v: unknown) => (v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `\\x${v.toString("hex")}` : typeof v === "bigint" ? v.toString() : v);

/** Lines to print for a result. Tables cut cells at 60 characters (use another format for everything). */
export function formatResult(r: QueryResult, format: OutputFormat): string {
  if (r.raw !== undefined) return r.raw.replace(/\n$/, "");
  if (!r.columns.length) return r.summary ?? "OK";
  if (format === "csv") return [r.columns.map(csvCell).join(","), ...r.rows.map((row) => row.map(csvCell).join(","))].join("\n");
  if (format === "tsv") return [r.columns.join("\t"), ...r.rows.map((row) => row.map(tsvCell).join("\t"))].join("\n");
  if (format === "json") return JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, jsonValue(row[i])]))), null, 2);
  const cut = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s).replace(/\n/g, "↵");
  const cells = r.rows.map((row) => row.map((v) => cut(cell(v))));
  const widths = r.columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join(" │ ").trimEnd();
  const out = [line(r.columns), widths.map((w) => "─".repeat(w)).join("─┼─"), ...cells.map(line)];
  out.push(`(${r.rows.length} row${r.rows.length === 1 ? "" : "s"})`);
  return out.join("\n");
}
