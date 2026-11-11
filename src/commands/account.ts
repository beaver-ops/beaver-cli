// beaver login / logout / whoami.
import { Api, ApiError, type DeviceStart, type DeviceToken } from "../api";
import type { Command } from "../cli";
import { apiHost } from "../config";
import { deleteToken, loadToken, saveToken } from "../credentials";
import { CliError, NotSignedInError } from "../errors";
import { formatDb } from "./db";
import { deleteMachineKey, ensureKeyRegistered, ensureMachineKey, machineName, readMachineKey, shortFingerprint } from "../keys";
import { signedInApi } from "../session";
import { spinner, waitForEnter } from "../ui";
import { engineLabel, levelLabel, shortDate } from "../format";

const machineWord = (platform: NodeJS.Platform) => (platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "machine");

export const login: Command = {
  name: "login",
  group: "Account",
  usage: "login",
  summary: "Sign in (opens your browser)",
  help: "Shows a one-time code, opens Beaver Ops in your browser to approve it, then saves a token for this\nmachine (Keychain when available) and registers this machine's SSH key for the DB gateway.",
  flags: [{ name: "no-browser", help: "Don't open the browser, just print the link" }],
  async run(ctx, ui, { flags }) {
    const anon = new Api(ctx, null);
    const started = await anon.request<DeviceStart>("POST", "/api/cli/device", { deviceName: machineName(ctx) });
    ui.out(ui.dim("Sign in to Beaver Ops"));
    ui.out();
    ui.out(`First copy your one-time code: ${ui.bold(started.userCode)}`);
    ui.out();
    const pretty = started.verificationUri.replace(/^https?:\/\//, "");
    const interactive = !!ctx.stdin.isTTY && !flags["no-browser"];
    if (interactive) {
      ui.out(`Press ${ui.bold("Enter")} to open ${ui.cyan(pretty)}`);
      ui.out(ui.dim(`(or open it on any device: ${started.verificationUriComplete})`));
    } else ui.out(`Open ${started.verificationUriComplete}`);
    ui.out();

    const enter = interactive ? waitForEnter(ctx) : null;
    void enter?.promise.then(() => ctx.openUrl(started.verificationUriComplete));
    const deadline = ctx.now().getTime() + started.expiresIn * 1000;
    const left = () => {
      const s = Math.max(0, Math.round((deadline - ctx.now().getTime()) / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    const stop = spinner(ctx, () => `Waiting for approval… code expires in ${left()}`);
    let interval = Math.max(1, started.interval) * 1000;
    let got: DeviceToken | null = null;
    try {
      while (!got) {
        await ctx.sleep(interval);
        try {
          got = await anon.request<DeviceToken>("POST", "/api/cli/token", { deviceCode: started.deviceCode });
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          if (err.code === "authorization_pending") continue;
          if (err.code === "slow_down") {
            interval += 5000;
            continue;
          }
          if (err.code === "access_denied") throw new CliError("Sign-in denied in the browser.");
          if (err.code === "expired_token") throw new CliError("The code expired. Run: beaver login");
          throw err;
        }
      }
    } finally {
      stop();
      enter?.cancel();
    }

    // A previous session of this machine is replaced: its key moves to the new one, then it is revoked.
    const previous = await loadToken(ctx);
    const where = await saveToken(ctx, got.token);
    const api = new Api(ctx, got.token);
    const session = await api.session();
    const ws = session.workspaces.map((w) => w.name);
    ui.ok(`Signed in as ${ui.bold(got.user.name || got.user.email)}${ws.length ? ` (${ws.join(", ")})` : ""}`);
    ui.ok(`Token saved to ${where}`);
    const key = ensureMachineKey(ctx);
    let access = null;
    try {
      await ensureKeyRegistered(api, ctx, key);
      ui.ok(`SSH key for this ${machineWord(ctx.platform)} registered`);
      ui.out(`  ${ui.dim(`${machineName(ctx)} (${shortFingerprint(key.fingerprint)})`)}`);
      access = await api.dbAccess();
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      ui.warn(err.message);
    }
    if (previous && previous.from !== "BEAVER_TOKEN" && previous.token !== got.token) {
      await new Api(ctx, previous.token).request("DELETE", "/api/cli/session").catch(() => {});
    }
    if (access) {
      ui.out();
      if (!access.rows.length) {
        ui.out("You have no database access yet. A workspace admin grants it per database.");
      } else {
        ui.out(`You can open ${access.rows.length} database${access.rows.length === 1 ? "" : "s"}:`);
        const width = Math.max(...access.rows.map((r) => formatDb(r, access!.rows).length));
        for (const r of access.rows) ui.out(ui.dim(`  ${formatDb(r, access.rows).padEnd(width)}  ${engineLabel(r.cluster.engine)} · ${levelLabel(r)}`));
        ui.out();
        ui.out(`Next: ${ui.green(`beaver db connect ${formatDb(access.rows[0], access.rows)}`)}`);
      }
    }
    return 0;
  },
};

export const logout: Command = {
  name: "logout",
  group: "Account",
  usage: "logout",
  summary: "Sign out and remove this machine's key",
  help: "Ends this machine's CLI session on Beaver Ops (its SSH key is removed there too, so open tunnels close)\nand deletes the token and the key files here.",
  async run(ctx, ui) {
    const found = await loadToken(ctx);
    if (found?.from === "BEAVER_TOKEN") throw new CliError("Signed in with BEAVER_TOKEN: unset it to sign out (revoke it in Account › CLI sessions).");
    if (found) {
      await new Api(ctx, found.token).request("DELETE", "/api/cli/session").catch((err: unknown) => {
        // Already ended on the server: nothing left to revoke there.
        if (!(err instanceof NotSignedInError)) throw err;
      });
    }
    await deleteToken(ctx);
    deleteMachineKey(ctx);
    ui.ok(found ? `Signed out of ${apiHost(ctx)}; this machine's key was removed.` : "Not signed in; nothing to do.");
    return 0;
  },
};

export const whoami: Command = {
  name: "whoami",
  group: "Account",
  usage: "whoami",
  summary: "Who you're signed in as, and this machine's key",
  flags: [{ name: "json", help: "Print JSON" }],
  async run(ctx, ui, { flags }) {
    const api = await signedInApi(ctx);
    const s = await api.session();
    const key = readMachineKey(ctx);
    if (flags.json) {
      ui.out(JSON.stringify({ user: s.user, workspaces: s.workspaces, session: s.session, key: key ? { fingerprint: key.fingerprint, path: key.path } : null, server: api.base }, null, 2));
      return 0;
    }
    const now = ctx.now();
    ui.out(`${ui.bold(s.user.name || s.user.email)}${s.user.name ? ` · ${s.user.email}` : ""}`);
    if (s.workspaces.length) ui.out(`Workspaces  ${s.workspaces.map((w) => w.name).join(", ")}`);
    ui.out(`Session     ${s.session.name} (bcli_…${s.session.last4}), ends ${shortDate(s.session.expiresAt, now)} unless used`);
    ui.out(`Key         ${key ? `${key.fingerprint}  ${ui.dim(key.path)}` : ui.yellow("none yet (made on the next beaver db connect)")}`);
    ui.out(`Server      ${api.base}`);
    return 0;
  },
};
