// The tunnel `ssh -N -L …` would open, in-process with ssh2: one SSH connection
// to the DB gateway with this machine's key, the gateway's host key pinned, and a local listener per
// forward on 127.0.0.1 (the usual port, or the next free one). The gateway still decides everything: it
// asks Beaver Ops on every tunnel and closes it once access is revoked or expires.
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import ssh2 from "ssh2";
import type { Context } from "./context";
import { readJson, writeJson } from "./config";
import { CliError } from "./errors";

/**
 * Host keys of known gateways, shipped with the CLI (`host:port` → `ssh-ed25519 AAAA…`), used with the
 * ones `/api/me/db-access` returns. Fill in production's once its key is published.
 */
export const PINNED_GATEWAY_HOST_KEYS: Record<string, string[]> = {};

export type Forward = { label: string; local: number; host: string; port: number };
export type OpenForward = Forward & { local: number; preferred: number };

export type TunnelOptions = {
  gateway: { host: string; port: number };
  username: string;
  privateKey: string;
  /** `ssh-ed25519 AAAA…` lines the gateway's key must be one of (empty: trust on first use, remembered). */
  hostKeys: string[];
  forwards: Forward[];
  /** Exact ports only (`--port`): fail instead of moving to a free one. */
  strictPorts?: boolean;
  readyTimeoutMs?: number;
  /** A connection the gateway refused to forward (access ended or not applied yet). */
  onRefused?: (forward: Forward, message: string) => void;
  /** Keep the local ports and connect again when the connection drops (`db connect`). */
  reconnect?: boolean;
  /** Reconnecting: what happens, for the person watching. */
  onEvent?: (e: TunnelEvent) => void;
  /** Reconnecting and the gateway refused the key: keep trying ("retry") or give up ("stop", the default). */
  onDenied?: () => Promise<"retry" | "stop">;
  retryDelaysMs?: number[];
  keepaliveMs?: number;
};

export type TunnelEvent =
  | { type: "down"; message: string }
  | { type: "retry"; attempt: number; inMs: number; message: string }
  | { type: "up"; downMs: number };

/** Why a tunnel ended: closed here, by the gateway, an error, or (reconnecting) refused for good. */
export type TunnelEnd = { reason: "local" | "remote" | "error" | "denied" | "hostkey"; message?: string };

export type Tunnel = {
  forwards: OpenForward[];
  /** Resolves when the SSH connection ends (with why, when it wasn't us). */
  closed: Promise<TunnelEnd>;
  /** Forwards refused by the gateway so far (an access ended while the tunnel was open). */
  refusals: () => number;
  close: () => Promise<void>;
};

const blobOf = (line: string) => line.trim().split(/\s+/)[1] ?? "";

/** The keys to pin for a gateway: the API's, the CLI's own, or the one seen first (remembered). */
export function pinnedKeys(ctx: Pick<Context, "env" | "platform">, gateway: { host: string; port: number }, fromApi: string[]): { keys: string[]; trustOnFirstUse: boolean } {
  const id = `${gateway.host}:${gateway.port}`;
  const keys = [...new Set([...fromApi, ...(PINNED_GATEWAY_HOST_KEYS[id] ?? [])].map(blobOf).filter(Boolean))];
  if (keys.length) return { keys, trustOnFirstUse: false };
  const seen = readJson<Record<string, string>>(ctx, "known_gateways.json")?.[id];
  return seen ? { keys: [seen], trustOnFirstUse: false } : { keys: [], trustOnFirstUse: true };
}

export function rememberGatewayKey(ctx: Pick<Context, "env" | "platform">, gateway: { host: string; port: number }, blob: string): void {
  const all = readJson<Record<string, string>>(ctx, "known_gateways.json") ?? {};
  writeJson(ctx, "known_gateways.json", { ...all, [`${gateway.host}:${gateway.port}`]: blob });
}

/** Listens on 127.0.0.1:port, or the next free port after it (then any free port) unless strict. */
async function listenNear(server: Server, port: number, strict: boolean): Promise<number> {
  const attempt = (p: number) =>
    new Promise<number | null>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(null);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, "127.0.0.1");
    });
  const candidates = strict ? [port] : [port, ...Array.from({ length: 10 }, (_, i) => port + i + 1).filter((p) => p < 65536), 0];
  for (const p of candidates) {
    const got = await attempt(p);
    if (got !== null) return got;
  }
  throw new CliError(`Local port ${port} is in use. Pick another with --port`);
}

/** Why connecting failed: the gateway said no, its host key is wrong, or the network (worth retrying). */
export type ConnectFailure = "denied" | "hostkey" | "transient";

export class TunnelConnectError extends CliError {
  constructor(
    message: string,
    readonly kind: ConnectFailure,
  ) {
    super(message);
  }
}

/** One SSH connection to the gateway: key auth, the host key checked against the pins. */
function connectGateway(ctx: Pick<Context, "env" | "platform">, o: TunnelOptions): Promise<ssh2.Client> {
  const pins = pinnedKeys(ctx, o.gateway, o.hostKeys);
  const client = new ssh2.Client();
  let seenKey: string | null = null;
  let mismatch = false;
  return new Promise<ssh2.Client>((resolve, reject) => {
    const fail = (err: Error & { level?: string }) => {
      client.removeAllListeners("ready");
      client.on("error", () => {});
      client.end();
      if (mismatch) {
        reject(
          new TunnelConnectError(
            `The DB gateway ${o.gateway.host} presented a host key this CLI doesn't trust (${seenKey?.slice(0, 16)}…). Refusing to connect: this can mean someone is intercepting the connection. Run beaver update, or ask your Beaver Ops admin.`,
            "hostkey",
          ),
        );
      } else if (err.level === "client-authentication") {
        reject(new TunnelConnectError("The DB gateway refused this machine's key: no live access for it right now. Run: beaver doctor", "denied"));
      } else if (err.level === "client-timeout") {
        reject(new TunnelConnectError(`Timed out connecting to ${o.gateway.host}:${o.gateway.port}. A firewall may block that port. Run: beaver doctor`, "transient"));
      } else {
        reject(new TunnelConnectError(`Couldn't connect to the DB gateway ${o.gateway.host}:${o.gateway.port}: ${err.message}`, "transient"));
      }
    };
    client.once("ready", () => {
      client.off("error", fail);
      if (pins.trustOnFirstUse && seenKey) rememberGatewayKey(ctx, o.gateway, seenKey);
      resolve(client);
    });
    client.once("error", fail);
    client.connect({
      host: o.gateway.host,
      port: o.gateway.port,
      username: o.username,
      privateKey: o.privateKey,
      readyTimeout: o.readyTimeoutMs ?? 15_000,
      keepaliveInterval: o.keepaliveMs ?? 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        seenKey = key.toString("base64");
        if (pins.trustOnFirstUse) return true;
        mismatch = !pins.keys.includes(seenKey);
        return !mismatch;
      },
    });
  });
}

/** Waits between reconnect attempts: quick at first, then every 30 s. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** A clock jump this big between two ticks means the machine slept: the SSH connection is likely dead. */
const SLEEP_JUMP_MS = 30_000;

/**
 * Connects to the gateway (key auth, pinned host key) and opens the local listeners. With `reconnect`,
 * the listeners stay when the connection drops (sleep, network change, gateway restart): it connects
 * again with backoff, and connections made meanwhile wait for it.
 */
export async function openTunnel(ctx: Pick<Context, "env" | "platform">, o: TunnelOptions): Promise<Tunnel> {
  let client = await connectGateway(ctx, o);

  const sockets = new Set<Socket>();
  const forwards: OpenForward[] = [];
  const servers: Server[] = [];
  let refused = 0;
  let closing = false;
  let finished = false;
  /** Set while reconnecting: resolves with the new connection (or null once the tunnel is over). */
  let reconnecting: Promise<ssh2.Client | null> | null = null;
  let wake: (() => void) | null = null;
  let finish: (r: TunnelEnd) => void = () => {};
  const closed = new Promise<TunnelEnd>((resolve) => {
    finish = (r) => {
      if (finished) return;
      finished = true;
      clearInterval(sleepWatch);
      for (const s of servers) s.close();
      for (const s of sockets) s.destroy();
      resolve(r);
    };
  });

  const delays = o.retryDelaysMs?.length ? o.retryDelaysMs : RECONNECT_DELAYS_MS;
  const pause = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });

  const reconnect = async (why: string): Promise<ssh2.Client | null> => {
    o.onEvent?.({ type: "down", message: why });
    const downAt = Date.now();
    let lastFailure = why;
    for (let attempt = 1; !closing; attempt++) {
      const wait = delays[Math.min(attempt - 1, delays.length - 1)];
      o.onEvent?.({ type: "retry", attempt, inMs: wait, message: lastFailure });
      await pause(wait);
      if (closing) break;
      try {
        const next = await connectGateway(ctx, o);
        if (closing) {
          next.end();
          break;
        }
        o.onEvent?.({ type: "up", downMs: Date.now() - downAt });
        return next;
      } catch (err) {
        const e = err as TunnelConnectError;
        lastFailure = e.message;
        if (e.kind === "hostkey") {
          finish({ reason: "hostkey", message: e.message });
          return null;
        }
        // The gateway refuses keys when Beaver Ops can't be reached too: the caller checks which it is.
        if (e.kind === "denied" && (await (o.onDenied?.() ?? Promise.resolve("stop"))) === "stop") {
          finish({ reason: "denied", message: e.message });
          return null;
        }
      }
    }
    finish({ reason: "local" });
    return null;
  };

  const watch = (c: ssh2.Client) => {
    let lastError: string | undefined;
    c.on("error", (err) => (lastError = err.message));
    c.on("close", () => {
      if (c !== client || finished) return;
      for (const s of sockets) s.destroy();
      if (closing) return finish({ reason: "local" });
      const why = lastError ?? "the gateway closed the connection";
      if (!o.reconnect) return finish(lastError ? { reason: "error", message: lastError } : { reason: "remote" });
      reconnecting = reconnect(why).then((next) => {
        reconnecting = null;
        if (next) {
          client = next;
          watch(next);
        }
        return next;
      });
    });
  };
  watch(client);

  // After a sleep the old connection looks open until keepalives time out: drop it now.
  let lastTick = Date.now();
  const sleepWatch = setInterval(() => {
    const now = Date.now();
    if (o.reconnect && now - lastTick > SLEEP_JUMP_MS && !reconnecting) client.end();
    lastTick = now;
  }, 5_000);
  sleepWatch.unref();

  /** The connection to forward on: the current one, or the next one while reconnecting. */
  const current = async (): Promise<ssh2.Client | null> => (reconnecting ? reconnecting : finished ? null : client);

  try {
    for (const f of o.forwards) {
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        void current().then((c) => {
          if (!c || socket.destroyed) return socket.destroy();
          c.forwardOut("127.0.0.1", socket.remotePort ?? 0, f.host, f.port, (err, channel) => {
            if (err) {
              refused++;
              socket.destroy();
              o.onRefused?.(f, err.message);
              return;
            }
            socket.pipe(channel).pipe(socket);
            channel.on("close", () => socket.destroy());
            socket.on("close", () => channel.close());
          });
        });
      });
      servers.push(server);
      const local = await listenNear(server, f.local, !!o.strictPorts);
      forwards.push({ ...f, local, preferred: f.local });
    }
  } catch (err) {
    closing = true;
    for (const s of servers) s.close();
    client.end();
    finish({ reason: "local" });
    throw err;
  }

  return {
    forwards,
    closed,
    refusals: () => refused,
    close: async () => {
      closing = true;
      wake?.();
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      client.end();
      if (!reconnecting) setTimeout(() => finish({ reason: "local" }), 1_000).unref();
      await closed;
    },
  };
}
