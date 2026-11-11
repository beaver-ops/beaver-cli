// A minimal stand-in for the Beaver Ops DB gateway, for the CLI's end-to-end tests. It speaks the same
// protocol as the real one (Beaver Ops' gateway/server.ts) as far as the CLI can tell:
//   - an SSH server that accepts public keys only, asking the API (`authorize`) about the key's fingerprint
//     and the SSH user, and checking the signature is by that key;
//   - nothing but `direct-tcpip` channels (no shell / exec / sftp / reverse forwarding), each one asked about
//     again with its destination, which must be exactly a target the API named;
//   - every open tunnel checked again every `recheckMs` and closed once denied (or unverifiable 3 times).
// The real gateway's own rules (address block list, Droplet hops, limits) are tested in Beaver Ops itself.
import { createHash, timingSafeEqual } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { Server, utils, type Connection } from "ssh2";

export type AuthorizeRequest = { fingerprint: string; username: string; destHost?: string; destPort?: number };
export type AuthorizeTarget = { host: string; port: number };
export type AuthorizeAnswer = { allow: true; userId: string; targets: AuthorizeTarget[]; expiresAt: string | null } | { allow: false; reason: string };
export interface GatewayApi {
  authorize(req: AuthorizeRequest): Promise<AuthorizeAnswer>;
  event(event: Record<string, unknown>): Promise<void>;
}

export type FakeGatewayOptions = {
  hostKeys: (string | Buffer)[];
  api: GatewayApi;
  /** Destination ports a tunnel may ask for. */
  allowedPorts: number[];
  recheckMs?: number;
  /** Where a granted host name is (the tests point every cluster at 127.0.0.1). */
  testResolve?: (host: string) => Promise<string[]>;
  /** Accepted for parity with the real gateway's test options; this one only ever connects to what testResolve gives. */
  testAllowAddresses?: string[];
};

/** `SHA256:<base64 without padding>`, as `ssh-keygen -lf` prints it. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

type Tunnel = { fingerprint: string; username: string; destHost: string; destPort: number; failures: number; close(): void };

export class DbGateway {
  readonly server: Server;
  private readonly tunnels = new Set<Tunnel>();
  private readonly connections = new Set<Connection>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: FakeGatewayOptions) {
    this.server = new Server({ hostKeys: o.hostKeys, ident: "beaver-db-gateway" }, (client) => this.onConnection(client));
    this.server.on("error", () => undefined);
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        this.timer = setInterval(() => void this.recheck(), this.o.recheckMs ?? 30_000);
        this.timer.unref();
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.tunnels) t.close();
    for (const c of this.connections) c.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  openTunnels(): number {
    return this.tunnels.size;
  }

  private onConnection(client: Connection) {
    this.connections.add(client);
    const session: { username: string | null; fingerprint: string | null } = { username: null, fingerprint: null };
    client.on("error", () => undefined);
    client.on("close", () => this.connections.delete(client));

    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      void (async () => {
        const fingerprint = fingerprintOf(ctx.key.data);
        let allowed = false;
        try {
          allowed = (await this.o.api.authorize({ fingerprint, username: ctx.username })).allow;
        } catch {
          // Beaver Ops unreachable: refuse, like the real gateway.
        }
        if (!allowed) return ctx.reject(["publickey"]);
        if (!ctx.signature || !ctx.blob) return ctx.accept();
        const parsed = utils.parseKey(ctx.key.data);
        const key = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!key || key instanceof Error) return ctx.reject(["publickey"]);
        const expected = key.getPublicSSH();
        if (expected.length !== ctx.key.data.length || !timingSafeEqual(expected, ctx.key.data) || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
          return ctx.reject(["publickey"]);
        }
        session.username = ctx.username;
        session.fingerprint = fingerprint;
        ctx.accept();
      })().catch(() => ctx.reject(["publickey"]));
    });

    client.on("session", (_accept, reject) => reject());
    client.on("request", (_accept, reject) => reject?.());

    client.on("tcpip", (accept, reject, info) => {
      const { username, fingerprint } = session;
      if (!username || !fingerprint) return reject();
      const destHost = info.destIP.toLowerCase();
      const destPort = info.destPort;
      void (async () => {
        if (!this.o.allowedPorts.includes(destPort)) return reject();
        const answer = await this.o.api.authorize({ fingerprint, username, destHost, destPort }).catch(() => null);
        if (!answer?.allow || !answer.targets.some((t) => t.host.toLowerCase() === destHost && t.port === destPort)) return reject();
        const [address] = (await this.o.testResolve?.(destHost)) ?? [];
        if (!address) return reject();
        const socket = await new Promise<Socket | null>((resolve) => {
          const s = tcpConnect({ host: address, port: destPort });
          s.once("connect", () => resolve(s));
          s.once("error", () => resolve(null));
        });
        if (!socket) return reject();
        const channel = accept();
        let done = false;
        const tunnel: Tunnel = {
          fingerprint,
          username,
          destHost,
          destPort,
          failures: 0,
          close: () => {
            if (done) return;
            done = true;
            this.tunnels.delete(tunnel);
            socket.destroy();
            try {
              channel.close();
            } catch {
              // Already closed.
            }
          },
        };
        socket.pipe(channel).pipe(socket);
        socket.on("close", tunnel.close);
        socket.on("error", tunnel.close);
        channel.on("close", tunnel.close);
        channel.on("error", tunnel.close);
        this.tunnels.add(tunnel);
      })().catch(() => {
        try {
          reject();
        } catch {
          // Already answered.
        }
      });
    });
  }

  /** Asks again for every open tunnel; closes the denied ones (and the ones the API can't vouch for 3 times in a row). */
  async recheck(): Promise<void> {
    await Promise.all(
      [...this.tunnels].map(async (t) => {
        try {
          const answer = await this.o.api.authorize({ fingerprint: t.fingerprint, username: t.username, destHost: t.destHost, destPort: t.destPort });
          t.failures = 0;
          if (!answer.allow || !answer.targets.some((x) => x.host.toLowerCase() === t.destHost && x.port === t.destPort)) t.close();
        } catch {
          t.failures += 1;
          if (t.failures >= 3) t.close();
        }
      }),
    );
  }
}
