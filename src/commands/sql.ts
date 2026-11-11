// beaver db query / db shell: a tunnel on free local ports, then SQL.
// ClickHouse: over HTTP, with a built-in shell (history, multi-line, \q). Postgres: `pg` for queries,
// `psql` for the shell (not bundled: the CLI says how to install it).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { DbAccessRow } from "../api";
import type { Command } from "../cli";
import { ensureConfigDir } from "../config";
import type { Context } from "../context";
import { CliError } from "../errors";
import { dbPassword, forgetPassword, rememberPassword } from "../passwords";
import { resolveDb } from "../resolve";
import { signedInApi } from "../session";
import { clickhouseSession, formatResult, OUTPUT_FORMATS, pgSession, WrongPasswordError, type OutputFormat, type SqlSession } from "../sql";
import type { Tunnel } from "../tunnel";
import type { Ui } from "../ui";
import { formatDb, openDbTunnel } from "./db";

const REMEMBER_FLAG = { name: "remember", help: "Save the password on this machine (Keychain) once it works" };

function outputFormat(ctx: Context, v: string | boolean | undefined): OutputFormat {
  if (v === undefined || v === true) return ctx.stdout.isTTY ? "table" : "tsv";
  if (!OUTPUT_FORMATS.includes(v as OutputFormat)) throw new CliError(`--format must be one of ${OUTPUT_FORMATS.join(", ")}`, 2);
  return v as OutputFormat;
}

type Open = { row: DbAccessRow; rows: DbAccessRow[]; tunnel: Tunnel; session: SqlSession };

/** Tunnel on free ports + an SQL session with the person's password (asked, env, or remembered). */
async function openSql(ctx: Context, ui: Ui, input: string, remember: boolean): Promise<Open> {
  const { row, access, tunnel } = await openDbTunnel(ctx, ui, input, { port: 0, nativePort: 0 });
  try {
    const { password, remembered } = await dbPassword(ctx, row);
    const port = tunnel.forwards.find((f) => f.label !== "native")!.local;
    const target = { port, user: row.connect.pgUser, password, database: row.connect.database };
    let session: SqlSession;
    try {
      session = row.connect.engine === "clickhouse" ? clickhouseSession(target, ctx.fetch) : await pgSession({ ...target, sslMode: row.connect.sslMode });
      // ClickHouse has no connection to check the password with: one cheap query does it.
      if (session.engine === "clickhouse") await session.query("SELECT 1");
    } catch (err) {
      if (err instanceof WrongPasswordError) {
        if (remembered) await forgetPassword(ctx, row);
        throw new CliError(`${err.message}${remembered ? " The saved one was removed from this machine." : ""} Forgot it? beaver db password ${formatDb(row, access.rows)}`);
      }
      throw err;
    }
    // stderr: stdout is the result (CSV piped into a file…).
    if (remember && !remembered) ui.err(`${ui.green("✓")} Password saved to ${await rememberPassword(ctx, row, password)}`);
    return { row, rows: access.rows, tunnel, session };
  } catch (err) {
    await tunnel.close();
    throw err;
  }
}

async function readAll(ctx: Context): Promise<string> {
  let text = "";
  for await (const chunk of ctx.stdin) text += chunk.toString();
  return text;
}

export const dbQuery: Command = {
  name: "db query",
  group: "Databases",
  usage: 'db query <db> "<sql>"',
  summary: "Run one query and print the result",
  help: 'The SQL is one argument (quote it), or - to read it from stdin. Output: a table in a terminal, TSV when\npiped; --format csv / tsv / json / table to choose. The password: BEAVER_DB_PASSWORD, one saved with\n--remember, or asked.\n\nExample: beaver db query saas "SELECT count() FROM events" --format csv',
  args: 2,
  flags: [{ name: "format", short: "f", value: "table|csv|tsv|json", help: "Output format" }, REMEMBER_FLAG],
  async run(ctx, ui, { args, flags }) {
    const format = outputFormat(ctx, flags.format);
    const sql = args[1] === "-" ? await readAll(ctx) : args[1];
    if (!sql.trim()) throw new CliError("No SQL given.", 2);
    const { session, tunnel } = await openSql(ctx, ui, args[0], !!flags.remember);
    try {
      ui.out(formatResult(await session.query(sql), format));
      return 0;
    } finally {
      await session.close();
      await tunnel.close();
    }
  },
};

/** `psql` on the PATH, or null. */
export function findExecutable(ctx: Pick<Context, "env" | "platform">, name: string): string | null {
  const exts = ctx.platform === "win32" ? (ctx.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (ctx.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (dir && existsSync(file)) return file;
    }
  }
  return null;
}

const PSQL_INSTALL = "Install psql: brew install libpq && brew link --force libpq (macOS) · sudo apt install postgresql-client (Debian/Ubuntu) · https://www.postgresql.org/download/";

async function psqlShell(ctx: Context, ui: Ui, input: string): Promise<number> {
  const psql = findExecutable(ctx, "psql");
  if (!psql) throw new CliError(`beaver db shell opens psql for Postgres, and it isn't installed. ${PSQL_INSTALL}\nWithout it: beaver db query ${input} "SELECT …"`);
  const { row, access, tunnel } = await openDbTunnel(ctx, ui, input, { port: 0 });
  const port = tunnel.forwards[0].local;
  const known = ctx.env.BEAVER_DB_PASSWORD ? ctx.env.BEAVER_DB_PASSWORD : null;
  ui.err(ui.dim(`Connected through ${row.connect.gateway.host}. \\q to quit.${known ? "" : ` Password: the one shown when you were granted access (forgot it? beaver db password ${formatDb(row, access.rows)}).`}`));
  // Ctrl+C belongs to psql (it cancels the query) while it runs.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(psql, [`--host=127.0.0.1`, `--port=${port}`, `--username=${row.connect.pgUser}`, `--dbname=${row.connect.database}`], {
        stdio: "inherit",
        env: { ...process.env, PGSSLMODE: row.connect.sslMode, ...(known && { PGPASSWORD: known }) },
      });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? 1));
    });
    return code;
  } finally {
    process.off("SIGINT", ignore);
    await tunnel.close();
  }
}

const HISTORY_SIZE = 500;

/** The ClickHouse shell: statements end with `;`, `\q` / `exit` / Ctrl+D leaves, Ctrl+C drops the current one. */
async function clickhouseShell(ctx: Context, ui: Ui, input: string, remember: boolean, format: OutputFormat): Promise<number> {
  const { row, session, tunnel } = await openSql(ctx, ui, input, remember);
  const historyFile = join(ensureConfigDir(ctx), "history_clickhouse");
  const history = existsSync(historyFile) ? readFileSync(historyFile, "utf8").split("\n").filter(Boolean).reverse().slice(0, HISTORY_SIZE) : [];
  const interactive = !!ctx.stdin.isTTY;
  if (interactive) ui.err(ui.dim(`Connected to ${row.database} as ${row.connect.pgUser} through ${row.connect.gateway.host}. End statements with ;  \\q to quit.`));
  const rl = createInterface({ input: ctx.stdin, output: interactive ? ctx.stdout : undefined, terminal: interactive, history, historySize: HISTORY_SIZE });
  const prompt = `${row.database} :) `;
  const more = `${" ".repeat(Math.max(0, row.database.length - 1))}:-] `;
  let buffer = "";
  let failures = 0;
  const ask = () => {
    if (!interactive) return;
    rl.setPrompt(buffer ? more : prompt);
    rl.prompt();
  };
  rl.on("SIGINT", () => {
    if (buffer) buffer = "";
    else ui.err(ui.dim("(\\q or Ctrl+D to quit)"));
    ui.err();
    ask();
  });
  try {
    ask();
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!buffer && /^(\\q|quit|exit|logout)\s*;?$/i.test(trimmed)) break;
      if (!buffer && /^(\\\?|help)\s*;?$/i.test(trimmed)) {
        ui.err("End a statement with ; to run it (several lines are fine). \\q, exit or Ctrl+D to quit. Ctrl+C drops the statement you're typing.");
        ask();
        continue;
      }
      buffer = buffer ? `${buffer}\n${line}` : line;
      if (!trimmed.endsWith(";")) {
        if (!buffer.trim()) buffer = "";
        ask();
        continue;
      }
      const sql = buffer.trim().replace(/;\s*$/, "");
      buffer = "";
      if (sql) {
        try {
          const started = Date.now();
          ui.out(formatResult(await session.query(sql), format));
          if (interactive) ui.err(ui.dim(`${((Date.now() - started) / 1000).toFixed(3)} s`));
        } catch (err) {
          if (err instanceof WrongPasswordError) throw err;
          failures++;
          ui.fail(err instanceof Error ? err.message : String(err));
        }
      }
      ask();
    }
    // Input that ends without a final `;` still runs.
    if (buffer.trim() && !interactive) {
      try {
        ui.out(formatResult(await session.query(buffer.trim().replace(/;\s*$/, "")), format));
      } catch (err) {
        failures++;
        ui.fail(err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    rl.close();
    const kept = (rl as unknown as { history?: string[] }).history;
    if (kept?.length) writeFileSync(historyFile, `${[...kept].reverse().join("\n")}\n`, { mode: 0o600 });
    await session.close();
    await tunnel.close();
  }
  return !interactive && failures ? 1 : 0;
}

export const dbShell: Command = {
  name: "db shell",
  group: "Databases",
  usage: "db shell <db>",
  summary: "Open a SQL shell on the database",
  help: "ClickHouse: a built-in shell, nothing to install (statements end with ;, history kept in the config folder).\nPostgres: opens psql through the tunnel (psql must be installed; beaver db query works without it).\nStatements can also be piped in: beaver db shell saas < queries.sql",
  args: 1,
  flags: [{ name: "format", short: "f", value: "table|csv|tsv|json", help: "Output format (ClickHouse)" }, REMEMBER_FLAG],
  async run(ctx, ui, { args, flags }) {
    const format = outputFormat(ctx, flags.format);
    // The engine decides which shell: read the row first (cheap, and the tunnel opens in the shell itself).
    const access = await (await signedInApi(ctx)).dbAccess();
    const row = resolveDb(access.rows, args[0]);
    if (row.connect.engine === "clickhouse") return clickhouseShell(ctx, ui, args[0], !!flags.remember, format);
    if (flags.remember) ui.warn("--remember applies to beaver db query on Postgres; psql asks for the password itself (or set BEAVER_DB_PASSWORD).");
    return psqlShell(ctx, ui, args[0]);
  },
};
