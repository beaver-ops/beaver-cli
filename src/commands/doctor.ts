// beaver doctor: checks each link of the chain (server → sign-in → version → key → grants → gateway)
// and says what to do about the first one that is broken.
import { connect as tcpConnect } from "node:net";
import { Api, type DbAccess, type Session, type SshKey } from "../api";
import type { Command } from "../cli";
import { apiUrl } from "../config";
import { loadToken } from "../credentials";
import { CliError } from "../errors";
import { statusLabel } from "../format";
import { readMachineKey, shortFingerprint } from "../keys";
import { openTunnel } from "../tunnel";
import { VERSION } from "../version";

const reachable = (host: string, port: number, ms = 5000) =>
  new Promise<string | null>((resolve) => {
    const s = tcpConnect({ host, port });
    const done = (err: string | null) => {
      s.destroy();
      resolve(err);
    };
    s.setTimeout(ms, () => done("timed out"));
    s.once("connect", () => done(null));
    s.once("error", (e) => done(e.message));
  });

export const doctor: Command = {
  name: "doctor",
  group: "Other",
  usage: "doctor",
  summary: "Check sign-in, key, gateway and grants; explain what's wrong",
  async run(ctx, ui) {
    let problems = 0;
    const bad = (line: string, fix?: string) => {
      problems++;
      ui.fail(fix ? `${line}\n    ${fix}` : line);
    };
    ui.out(ui.dim(`beaver ${VERSION} · ${ctx.platform}-${ctx.arch} · ${apiUrl(ctx)}`));

    const found = await loadToken(ctx);
    if (!found) {
      bad("Not signed in", "Run: beaver login");
      return 1;
    }
    const api = new Api(ctx, found.token);
    let session: Session;
    try {
      session = await api.session();
    } catch (err) {
      bad(err instanceof CliError ? err.message : String(err));
      return 1;
    }
    ui.ok(`Signed in as ${session.user.email} (${session.session.name}, token in ${found.from})`);
    ui.ok(`CLI ${VERSION}${session.minCliVersion ? ` (server needs ≥ ${session.minCliVersion})` : ""}`);

    const key = readMachineKey(ctx);
    let keys: SshKey[] = [];
    try {
      keys = (await api.request<{ keys: SshKey[] }>("GET", "/api/me/ssh-keys")).keys;
    } catch (err) {
      bad(err instanceof CliError ? err.message : String(err));
    }
    const onServer = key ? keys.find((k) => k.fingerprint === key.fingerprint) : undefined;
    if (!key) bad("No SSH key on this machine yet", "Run: beaver db connect <db> (it makes and registers one)");
    else if (!onServer) bad(`This machine's key (${shortFingerprint(key.fingerprint)}) isn't on your account`, "Run: beaver db connect <db> to register it again");
    else ui.ok(`SSH key ${shortFingerprint(key.fingerprint)} registered as ${onServer.name}`);

    let access: DbAccess | null = null;
    try {
      access = await api.dbAccess();
    } catch (err) {
      bad(err instanceof CliError ? err.message : String(err));
    }
    if (access) {
      if (!access.rows.length) bad("No database access", "A workspace admin grants it per database.");
      else {
        const pending = access.rows.filter((r) => r.status !== "active");
        ui.ok(`${access.rows.length} database${access.rows.length === 1 ? "" : "s"} granted${pending.length ? ` (${pending.map((r) => `${r.database}: ${statusLabel(r.status)}`).join(", ")})` : ""}`);
      }
      const gw = access.rows[0]?.connect.gateway ?? { host: access.gateway.host, port: access.gateway.port };
      const tcp = await reachable(gw.host, gw.port);
      if (tcp) bad(`Can't reach the DB gateway ${gw.host}:${gw.port}: ${tcp}`, "A firewall or VPN may block that port.");
      else if (key && onServer && access.rows.length) {
        try {
          const t = await openTunnel(ctx, {
            gateway: gw,
            username: access.rows[0].connect.sshUser,
            privateKey: key.privateKey,
            hostKeys: access.gateway.hostKeys?.length ? access.gateway.hostKeys : access.gateway.hostKey ? [access.gateway.hostKey] : [],
            forwards: [],
          });
          await t.close();
          ui.ok(`DB gateway ${gw.host}:${gw.port} reachable, host key trusted, this machine's key accepted`);
        } catch (err) {
          bad(err instanceof CliError ? err.message : String(err));
        }
      } else ui.ok(`DB gateway ${gw.host}:${gw.port} reachable`);
    }
    ui.out();
    if (problems) ui.out(`${problems} problem${problems === 1 ? "" : "s"} found.`);
    else ui.out("Everything looks good.");
    return problems ? 1 : 0;
  },
};
