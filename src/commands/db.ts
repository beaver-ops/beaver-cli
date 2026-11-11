// beaver db list / connect / info.
import type { Api, DbAccess, DbAccessRow } from "../api";
import type { Command } from "../cli";
import type { Context } from "../context";
import { CliError, NotSignedInError } from "../errors";
import { engineLabel, expiryLabel, levelLabel, placeLabel, shortDate, statusLabel } from "../format";
import { ensureKeyRegistered, ensureMachineKey } from "../keys";
import { resolveDb } from "../resolve";
import { signedInApi } from "../session";
import { openTunnel, type Forward, type OpenForward, type Tunnel } from "../tunnel";
import { table, type Ui } from "../ui";

/** How to name a row on the command line: its database name, or its ref when that name is taken twice. */
export function formatDb(row: DbAccessRow, rows: DbAccessRow[]): string {
  return rows.filter((r) => r.database === row.database).length > 1 ? row.ref : row.database;
}

const shellArg = (v: string) => (/^[A-Za-z0-9_./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);

export const dbList: Command = {
  name: "db list",
  aliases: ["db ls"],
  group: "Databases",
  usage: "db list",
  summary: "Databases you can open",
  flags: [{ name: "json", help: "Print JSON" }],
  async run(ctx, ui, { flags }) {
    const access = await (await signedInApi(ctx)).dbAccess();
    if (flags.json) {
      ui.out(JSON.stringify(access.rows, null, 2));
      return 0;
    }
    if (!access.rows.length) {
      ui.out("You have no database access yet. A workspace admin grants it per database.");
      return 0;
    }
    const now = ctx.now();
    const lines = table(
      ["DATABASE", "ENGINE", "PROJECT · ENV", "LEVEL", "EXPIRES", "STATUS"],
      access.rows.map((r) => [formatDb(r, access.rows), engineLabel(r.cluster.engine), placeLabel(r), levelLabel(r), expiryLabel(r.expiresAt, now), statusLabel(r.status)]),
    );
    ui.out(ui.bold(lines[0]));
    for (const l of lines.slice(1)) ui.out(l);
    return 0;
  },
};

/** The forwards of a row: Postgres' port, or ClickHouse's HTTP + native ones. */
export function forwardsOf(row: DbAccessRow, ports: { port?: number; nativePort?: number } = {}): Forward[] {
  const c = row.connect;
  const out: Forward[] = [{ label: c.engine === "clickhouse" ? "http" : "pg", local: ports.port ?? c.localPort, host: c.clusterHost, port: c.clusterPort }];
  if (c.engine === "clickhouse" && c.nativePort) out.push({ label: "native", local: ports.nativePort ?? c.localNativePort ?? 19000, host: c.clusterHost, port: c.nativePort });
  return out;
}

function portFlag(v: string | boolean | undefined, name: string): number | undefined {
  if (v === undefined || v === false) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`--${name} must be a port number (1–65535)`, 2);
  return n;
}

/** The lines `db connect` / `db info` print: what to type into an app. */
export function connectionLines(ui: Ui, row: DbAccessRow, rows: DbAccessRow[], ports: { local: number; preferred: number; label: string }[]): string[] {
  const c = row.connect;
  const name = formatDb(row, rows);
  const busy = (p: { local: number; preferred: number }) => (p.local !== p.preferred ? ui.dim(` (${p.preferred} was busy)`) : "");
  const lines = [`  ${"Host".padEnd(11)}localhost`];
  const main = ports.find((p) => p.label !== "native")!;
  if (c.engine === "clickhouse") {
    const native = ports.find((p) => p.label === "native");
    lines.push(`  ${"HTTP port".padEnd(11)}${String(main.local).padEnd(13)}${ui.dim("(DBeaver, TablePlus, curl, JS/Python clients)")}${busy(main)}`);
    if (native) lines.push(`  ${"Native".padEnd(11)}${String(native.local).padEnd(13)}${ui.dim("(clickhouse-client)")}${busy(native)}`);
  } else {
    lines.push(`  ${"Port".padEnd(11)}${main.local}${busy(main)}`);
  }
  lines.push(`  ${"Database".padEnd(11)}${c.database}`, `  ${"User".padEnd(11)}${c.pgUser}`);
  if (c.engine === "pg") lines.push(`  ${"SSL mode".padEnd(11)}${c.sslMode}`);
  lines.push(`  ${"Password".padEnd(11)}the one shown when you were granted access ${ui.dim(`· forgot it? beaver db password ${shellArg(name)}`)}`);
  return lines;
}

function clientHints(ui: Ui, row: DbAccessRow, ports: { local: number; label: string }[]): string[] {
  const c = row.connect;
  const main = ports.find((p) => p.label !== "native")!.local;
  if (c.engine === "clickhouse") {
    const native = ports.find((p) => p.label === "native")?.local;
    return [
      ...(native ? [`  ${ui.dim("clickhouse-client")}  clickhouse-client --host 127.0.0.1 --port ${native} --user ${c.pgUser} --database ${shellArg(c.database)} --password`] : []),
      `  ${ui.dim("curl")}               curl -u ${c.pgUser} 'http://localhost:${main}/?database=${encodeURIComponent(c.database)}' --data-binary 'SELECT 1'`,
    ];
  }
  return [`  ${ui.dim("psql")}  psql "postgresql://${encodeURIComponent(c.pgUser)}@localhost:${main}/${encodeURIComponent(c.database)}?sslmode=${c.sslMode}"`];
}

/** Resolves `<db>`, makes sure this machine's key is registered and opens the tunnel. */
export async function openDbTunnel(
  ctx: Context,
  ui: Ui,
  input: string,
  ports: { port?: number; nativePort?: number } = {},
): Promise<{ row: DbAccessRow; access: DbAccess; tunnel: Tunnel; api: Api }> {
  const api = await signedInApi(ctx);
  const access = await api.dbAccess();
  const row = resolveDb(access.rows, input);
  if (row.status === "pending") ui.warn(`${row.database}: your access is still being applied; the tunnel may be refused for a minute.`);
  if (row.status === "error") ui.warn(`${row.database}: applying your access failed and is being retried; the tunnel may be refused.`);
  const key = ensureMachineKey(ctx);
  await ensureKeyRegistered(api, ctx, key);
  let lastRefusal = 0;
  const tunnel = await openTunnel(ctx, {
    gateway: row.connect.gateway,
    username: row.connect.sshUser,
    privateKey: key.privateKey,
    hostKeys: access.gateway.hostKeys?.length ? access.gateway.hostKeys : access.gateway.hostKey ? [access.gateway.hostKey] : [],
    forwards: forwardsOf(row, ports),
    strictPorts: ports.port !== undefined || ports.nativePort !== undefined,
    onRefused: () => {
      // Once a minute at most: an app retrying in a loop would flood the terminal.
      const now = ctx.now().getTime();
      if (now - lastRefusal < 60_000) return;
      lastRefusal = now;
      ui.warn(`The gateway refused a connection to ${row.database}: your access may have ended or isn't applied yet. Run: beaver db list`);
    },
  });
  return { row, access, tunnel, api };
}

/** How often `db connect` checks that the access is still there (the gateway enforces it anyway). */
const accessCheckMs = (ctx: Context) => Number(ctx.env.BEAVER_ACCESS_CHECK_MS) || 60_000;

/** Reconnect waits (tests make them short). */
const retryDelays = (ctx: Context) =>
  (ctx.env.BEAVER_RECONNECT_DELAYS_MS ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

/** How long the gateway may keep refusing (Beaver Ops still listing the access) before `db connect` gives up. */
const deniedGiveUpMs = (ctx: Context) => Number(ctx.env.BEAVER_DENIED_GIVE_UP_MS) || 5 * 60_000;

/** Resolves once every row is gone from the person's access (revoked, expired, left the workspace). */
function accessEnded(ctx: Context, ui: Ui, api: Api, rows: DbAccessRow[], all: DbAccessRow[]): { ended: Promise<string>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const live = new Set(rows.map((r) => r.grantId));
  const ended = new Promise<string>((resolve) => {
    timer = setInterval(async () => {
      try {
        const now = await api.dbAccess();
        for (const r of rows) {
          if (!live.has(r.grantId) || now.rows.some((x) => x.grantId === r.grantId)) continue;
          live.delete(r.grantId);
          if (live.size) ui.warn(`Your access to ${formatDb(r, all)} ended (revoked or expired); the gateway refuses it now. The others stay open.`);
        }
        if (!live.size) resolve(rows.length === 1 ? `Your access to ${rows[0].database} ended (revoked or expired).` : "Your access to these databases ended (revoked or expired).");
      } catch (err) {
        if (err instanceof NotSignedInError) resolve(err.message);
        // Network hiccups: the gateway still guards the tunnel; try again next time.
      }
    }, accessCheckMs(ctx));
  });
  return { ended, stop: () => clearInterval(timer) };
}

/** The forwards of several rows behind one gateway: one per server (databases of a server share it). */
function groupForwards(rows: DbAccessRow[], ports: { port?: number; nativePort?: number }): Forward[] {
  const out: Forward[] = [];
  for (const row of rows) for (const f of forwardsOf(row, ports)) if (!out.some((o) => o.host === f.host && o.port === f.port)) out.push(f);
  return out;
}

/** The open ports of one row in its group's tunnel. */
function portsOf(row: DbAccessRow, tunnel: Tunnel): OpenForward[] {
  return forwardsOf(row).map((f) => ({ ...tunnel.forwards.find((o) => o.host === f.host && o.port === f.port)!, label: f.label }));
}

export const dbConnect: Command = {
  name: "db connect",
  group: "Databases",
  usage: "db connect <db>…",
  summary: "Open a tunnel and print how to connect (Ctrl+C to close)",
  help: "Keeps a tunnel through the DB gateway open on localhost until Ctrl+C. Point DBeaver, TablePlus, psql,\nclickhouse-client or your app at the Host / Port it prints. The usual ports are 15432 (Postgres) and\n18123 / 19000 (ClickHouse); a busy one moves to the next free port. Several databases at once:\nbeaver db connect shop_db saas (databases on the same server share a port).\n\nThe ports stay open when the connection drops (sleep, Wi-Fi change, gateway restart): it reconnects\nby itself, and apps connecting meanwhile wait for it. It stops when your access ends.",
  args: [1, 20],
  flags: [
    { name: "port", value: "port", help: "Local port (Postgres, or ClickHouse HTTP); one database only" },
    { name: "native-port", value: "port", help: "Local port for ClickHouse's native protocol; one database only" },
  ],
  async run(ctx, ui, { args, flags }) {
    const ports = { port: portFlag(flags.port, "port"), nativePort: portFlag(flags["native-port"], "native-port") };
    const api = await signedInApi(ctx);
    const access = await api.dbAccess();
    const rows = [...new Map(args.map((a) => resolveDb(access.rows, a)).map((r) => [r.grantId, r])).values()];
    if (rows.length > 1 && (ports.port !== undefined || ports.nativePort !== undefined)) throw new CliError("--port and --native-port work with one database at a time.", 2);
    for (const row of rows) {
      if (row.status === "pending") ui.warn(`${row.database}: your access is still being applied; the tunnel may be refused for a minute.`);
      if (row.status === "error") ui.warn(`${row.database}: applying your access failed and is being retried; the tunnel may be refused.`);
    }
    const key = ensureMachineKey(ctx);
    await ensureKeyRegistered(api, ctx, key);

    // One SSH connection per gateway (and gateway user).
    const groups = new Map<string, DbAccessRow[]>();
    for (const row of rows) {
      const id = `${row.connect.gateway.host}:${row.connect.gateway.port} ${row.connect.sshUser}`;
      groups.set(id, [...(groups.get(id) ?? []), row]);
    }
    const opened: { rows: DbAccessRow[]; tunnel: Tunnel }[] = [];
    try {
      for (const group of groups.values()) {
        const names = group.map((r) => r.database).join(", ");
        let deniedSince: number | null = null;
        let lastRefusal = 0;
        const first = group[0];
        const tunnel = await openTunnel(ctx, {
          gateway: first.connect.gateway,
          username: first.connect.sshUser,
          privateKey: key.privateKey,
          hostKeys: access.gateway.hostKeys?.length ? access.gateway.hostKeys : access.gateway.hostKey ? [access.gateway.hostKey] : [],
          forwards: groupForwards(group, ports),
          strictPorts: ports.port !== undefined || ports.nativePort !== undefined,
          reconnect: true,
          retryDelaysMs: retryDelays(ctx),
          onRefused: () => {
            const now = ctx.now().getTime();
            if (now - lastRefusal < 60_000) return;
            lastRefusal = now;
            ui.warn(`The gateway refused a connection to ${names}: your access may have ended or isn't applied yet. Run: beaver db list`);
          },
          onEvent: (e) => {
            if (e.type === "down") ui.warn(`Lost the connection to ${first.connect.gateway.host} (${e.message}). Reconnecting; the local ports stay open.`);
            else if (e.type === "retry" && e.attempt > 1) ui.err(ui.dim(`  still offline (${e.message}); next try in ${Math.round(e.inMs / 1000)} s`));
            else if (e.type === "up") {
              deniedSince = null;
              ui.ok(`Reconnected to ${first.connect.gateway.host}${e.downMs >= 1000 ? ` after ${Math.round(e.downMs / 1000)} s` : ""}`);
            }
          },
          // A refusal is the access ending, or the gateway not reaching Beaver Ops (retry) or the key gone (register it again).
          onDenied: async () => {
            try {
              const now = await api.dbAccess();
              if (!group.some((r) => now.rows.some((x) => x.grantId === r.grantId))) return "stop";
              await ensureKeyRegistered(api, ctx, key);
            } catch (err) {
              if (err instanceof NotSignedInError) return "stop";
              return "retry";
            }
            deniedSince ??= Date.now();
            return Date.now() - deniedSince >= deniedGiveUpMs(ctx) ? "stop" : "retry";
          },
        });
        opened.push({ rows: group, tunnel });
      }
    } catch (err) {
      await Promise.all(opened.map((o) => o.tunnel.close()));
      throw err;
    }

    const gateways = [...new Set(rows.map((r) => r.connect.gateway.host))].join(", ");
    ui.ok(`Tunnel open through ${gateways}${rows.length > 1 ? ` to ${rows.length} databases` : ""} (Ctrl+C to close)`);
    for (const { rows: group, tunnel } of opened) {
      for (const row of group) {
        const open = portsOf(row, tunnel);
        ui.out();
        if (rows.length > 1) ui.out(`${ui.bold(formatDb(row, access.rows))}  ${ui.dim(`${engineLabel(row.cluster.engine)} · ${placeLabel(row)}`)}`);
        for (const l of connectionLines(ui, row, access.rows, open)) ui.out(l);
        ui.out();
        for (const l of clientHints(ui, row, open)) ui.out(l);
        if (row.expiresAt) {
          ui.out();
          ui.out(ui.dim(`Your ${row.level} access ends ${shortDate(row.expiresAt, ctx.now())}.`));
        }
      }
    }

    const watch = accessEnded(ctx, ui, api, rows, access.rows);
    const result = await Promise.race([
      ctx.interrupted().then(() => "interrupted" as const),
      ...opened.map((o) => o.tunnel.closed.then((end) => ({ ...end, rows: o.rows }))),
      watch.ended.then((message) => ({ reason: "ended" as const, message, rows })),
    ]);
    watch.stop();
    await Promise.all(opened.map((o) => o.tunnel.close()));
    if (result === "interrupted") {
      ui.err();
      ui.ok(rows.length > 1 ? "Tunnels closed" : "Tunnel closed");
      return 0;
    }
    const names = result.rows.map((r) => formatDb(r, access.rows)).join(" ");
    if (result.reason === "ended") throw new CliError(`${result.message} The tunnel is closed. Run: beaver db list`);
    if (result.reason === "hostkey") throw new CliError(result.message ?? "The gateway's host key changed.");
    if (result.reason === "denied") throw new CliError(`The gateway keeps refusing this machine's key for ${names} although Beaver Ops still lists your access, so the tunnel is closed. Run: beaver doctor`);
    if (result.reason === "error") throw new CliError(`The tunnel failed: ${result.message}. Run: beaver db connect ${names}`);
    throw new CliError(`The gateway closed the tunnel: your access may have been revoked or expired. Run: beaver db list`);
  },
};

export const dbInfo: Command = {
  name: "db info",
  group: "Databases",
  usage: "db info <db>",
  summary: "Connection details for DBeaver / TablePlus / your app",
  args: 1,
  flags: [{ name: "json", help: "Print JSON" }],
  async run(ctx, ui, { args, flags }) {
    const access = await (await signedInApi(ctx)).dbAccess();
    const row = resolveDb(access.rows, args[0]);
    if (flags.json) {
      ui.out(JSON.stringify(row, null, 2));
      return 0;
    }
    const now = ctx.now();
    const name = formatDb(row, access.rows);
    ui.out(`${ui.bold(row.database)}  ${engineLabel(row.cluster.engine)} · ${placeLabel(row)}`);
    ui.out(`  ${"Ref".padEnd(11)}${row.ref}`);
    ui.out(`  ${"Server".padEnd(11)}${row.cluster.name}`);
    ui.out(`  ${"Level".padEnd(11)}${levelLabel(row)}`);
    ui.out(`  ${"Expires".padEnd(11)}${row.expiresAt ? shortDate(row.expiresAt, now) : "never"}  ${ui.dim(statusLabel(row.status))}`);
    ui.out();
    ui.out(`With ${ui.green(`beaver db connect ${shellArg(name)}`)} running:`);
    for (const l of connectionLines(ui, row, access.rows, forwardsOf(row).map((f) => ({ ...f, preferred: f.local })))) ui.out(l);
    ui.out();
    ui.out(ui.dim(`Through the gateway ${row.connect.gateway.host}:${row.connect.gateway.port} as ${row.connect.sshUser}, to ${row.connect.clusterHost}.`));
    return 0;
  },
};
