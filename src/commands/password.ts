// beaver db password <db>: a new password for the person's own login on that server, shown once
// (POST /api/me/db-logins/[id]/reset-password, the same as Account › Database access › Reset password).
import type { Command } from "../cli";
import { CliError } from "../errors";
import { rememberPassword } from "../passwords";
import { resolveDb } from "../resolve";
import { signedInApi } from "../session";
import { confirm } from "../ui";

export const dbPasswordCommand: Command = {
  name: "db password",
  group: "Databases",
  usage: "db password <db>",
  summary: "Reset your password for that server (shown once)",
  help: "Your login is per server: the new password works for every database you have there, and the old one\nstops working for new connections (open ones keep going). Beaver Ops doesn't keep it: save it with\n--remember (this machine's Keychain) or in your password manager.",
  args: 1,
  flags: [
    { name: "yes", short: "y", help: "Don't ask for confirmation" },
    { name: "remember", help: "Save the new password on this machine (Keychain) for db shell / db query" },
  ],
  async run(ctx, ui, { args, flags }) {
    const api = await signedInApi(ctx);
    const access = await api.dbAccess();
    const row = resolveDb(access.rows, args[0]);
    const others = [...new Set(access.rows.filter((r) => r.login.id === row.login.id && r.grantId !== row.grantId).map((r) => r.database))];
    if (!flags.yes) {
      if (!ctx.stdin.isTTY) throw new CliError("Resetting a password needs a confirmation: run it in a terminal, or add --yes.", 2);
      const also = others.length ? ` (also ${others.join(", ")})` : "";
      if (!(await confirm(ctx, `Reset the password of ${row.connect.pgUser} on ${row.cluster.name}${also}?`))) {
        ui.err("Nothing changed.");
        return 1;
      }
    }
    const res = await api.request<{ pgUser: string; password: string }>("POST", `/api/me/db-logins/${row.login.id}/reset-password`, {});
    ui.ok(`New password for ${res.pgUser} on ${row.cluster.name} (shown once):`);
    ui.out();
    ui.out(`  ${res.password}`);
    ui.out();
    const save = flags.remember || (ctx.stdin.isTTY && !flags.yes && (await confirm(ctx, "Save it in this machine's Keychain for beaver db shell / db query?")));
    if (save) ui.ok(`Saved to ${await rememberPassword(ctx, row, res.password)}`);
    else ui.out(ui.dim("Save it now: Beaver Ops doesn't keep it."));
    return 0;
  },
};
