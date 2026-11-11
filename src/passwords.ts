// Database passwords: Beaver Ops never keeps them. The CLI asks (hidden), or uses
// BEAVER_DB_PASSWORD, or one saved on this machine with `--remember` (Keychain etc., never the server).
import type { DbAccessRow } from "./api";
import type { Context } from "./context";
import { apiHost } from "./config";
import { deleteSecret, loadSecret, saveSecret } from "./credentials";
import { CliError } from "./errors";
import { promptHidden } from "./ui";

/** One login per cluster: the password is the same for every database on it. */
const account = (ctx: Context, row: DbAccessRow) => `${apiHost(ctx)}/db-login/${row.login.id}`;

export const rememberPassword = (ctx: Context, row: DbAccessRow, password: string) => saveSecret(ctx, account(ctx, row), password);
export const forgetPassword = (ctx: Context, row: DbAccessRow) => deleteSecret(ctx, account(ctx, row));

/** The password to use, and whether it came from this machine's store (so a refusal forgets it). */
export async function dbPassword(ctx: Context, row: DbAccessRow): Promise<{ password: string; remembered: boolean }> {
  if (ctx.env.BEAVER_DB_PASSWORD) return { password: ctx.env.BEAVER_DB_PASSWORD, remembered: false };
  const saved = await loadSecret(ctx, account(ctx, row));
  if (saved) return { password: saved, remembered: true };
  const typed = await promptHidden(ctx, `Password for ${row.connect.pgUser}: `);
  if (typed === null) {
    throw new CliError(`No password for ${row.connect.pgUser}: run in a terminal to type it, set BEAVER_DB_PASSWORD, or save it with --remember. Forgot it? beaver db password ${row.database}`);
  }
  if (!typed) throw new CliError("No password given.");
  return { password: typed, remembered: false };
}
