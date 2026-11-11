// Stand-ins for the end-to-end tests: Beaver Ops' API (device flow, tokens, keys, db-access, password
// reset) in memory, and the gateway's view of it. The DB gateway is tests/gateway.ts.
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect as tcpConnect, createServer, type AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { AuthorizeAnswer, AuthorizeRequest, GatewayApi } from "./gateway";
import { fingerprint } from "../src/keys";

export const CLUSTER = "cluster.test";

/** ed25519 pairs that both parse (ssh2 makes a malformed one about once in 256). */
export function keyPair() {
  for (;;) {
    const p = ssh2.utils.generateKeyPairSync("ed25519");
    if (!(ssh2.utils.parseKey(p.private) instanceof Error) && !(ssh2.utils.parseKey(p.public) instanceof Error)) return p;
  }
}

/** Beaver Ops as the CLI sees it, in memory. */
export class FakeBeaver {
  approve = true;
  denied = false;
  hostKeys: string[] = [];
  devices = new Map<string, { polls: number; issued: boolean }>();
  tokens = new Map<string, { revoked: boolean }>();
  keys = new Map<string, { token: string; publicKey: string }>();
  granted = true;
  calls: string[] = [];
  /** More rows (a ClickHouse server…), each reachable at its connect.clusterHost:clusterPort. */
  more: Record<string, unknown>[] = [];
  resets = 0;
  gatewayCantReachBeaver = false;
  constructor(
    public gatewayPort: () => number,
    public echoPort: () => number,
    public localPort: () => number,
  ) {}

  rows(): Record<string, unknown>[] {
    if (!this.granted) return [];
    return [...this.base(), ...this.more];
  }

  base(): Record<string, unknown>[] {
    return [
      {
        grantId: "g1",
        ref: "shop/production/shop_db",
        database: "shop_db",
        cluster: { name: "general-db", provider: "do", engine: "pg" },
        environment: { projectName: "Shop", name: "Production", projectSlug: "shop", slug: "production" },
        level: "read",
        allowSchema: false,
        expiresAt: null,
        grantedAt: "2026-11-10T03:00:00.000Z",
        grantedBy: { name: "Ly Tran", email: "ly@example.com" },
        lastConnectedAt: null,
        status: "active",
        login: { id: "l1", pgUser: "u_son", status: "active" },
        connect: {
          gateway: { host: "127.0.0.1", port: this.gatewayPort() },
          sshUser: "son",
          pgUser: "u_son",
          database: "shop_db",
          clusterHost: CLUSTER,
          clusterPort: this.echoPort(),
          localPort: this.localPort(),
          sslMode: "require",
          engine: "pg",
        },
      },
    ];
  }

  liveToken(req: IncomingMessage): string | null {
    const t = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    return this.tokens.get(t) && !this.tokens.get(t)!.revoked ? t : null;
  }

  async handle(req: IncomingMessage, body: Record<string, unknown>): Promise<[number, unknown]> {
    const key = `${req.method} ${req.url}`;
    this.calls.push(key);
    const err = (status: number, code: string) => [status, { error: { code, message: code } }] as [number, unknown];
    if (key === "POST /api/cli/device") {
      const deviceCode = `dc_${this.devices.size}_${"x".repeat(30)}`;
      this.devices.set(deviceCode, { polls: 0, issued: false });
      return [200, { deviceCode, userCode: "KQ7M-4TXP", verificationUri: "https://beaver.test/app/cli", verificationUriComplete: "https://beaver.test/app/cli?code=KQ7M-4TXP", expiresIn: 600, interval: 0 }];
    }
    if (key === "POST /api/cli/token") {
      const d = this.devices.get(String(body.deviceCode));
      if (!d || d.issued) return err(400, "expired_token");
      if (this.denied) return err(400, "access_denied");
      // Approved in the browser after the CLI's second poll.
      if (++d.polls < 2 || !this.approve) return err(400, "authorization_pending");
      d.issued = true;
      const token = `bcli_${String(this.tokens.size).padStart(43, "a")}`;
      this.tokens.set(token, { revoked: false });
      return [200, { token, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), user: { name: "Son", email: "son@example.com" } }];
    }
    const token = this.liveToken(req);
    if (!token) return err(401, "unauthorized");
    if (key === "GET /api/cli/session") {
      return [200, { user: { id: "u1", email: "son@example.com", name: "Son" }, workspaces: [{ id: "w1", name: "Acme" }], session: { id: "t1", name: "beaver-cli · Sons-MacBook-Pro", last4: token.slice(-4), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000 * 90).toISOString() }, minCliVersion: "1.0.0" }];
    }
    if (key === "DELETE /api/cli/session") {
      this.tokens.get(token)!.revoked = true;
      for (const [fp, k] of this.keys) if (k.token === token) this.keys.delete(fp);
      return [200, { ok: true }];
    }
    if (key === "GET /api/me/ssh-keys") return [200, { keys: [...this.keys.entries()].map(([fp]) => ({ id: fp, name: "beaver-cli", fingerprint: fp, source: "cli" })) }];
    if (key === "POST /api/me/ssh-keys") {
      if (body.source !== "cli") return err(400, "cli_key_needs_cli");
      const fp = fingerprint(String(body.publicKey));
      const existed = this.keys.has(fp);
      this.keys.set(fp, { token, publicKey: String(body.publicKey) });
      return [existed ? 200 : 201, { key: { id: fp, name: body.name, fingerprint: fp, source: "cli" } }];
    }
    if (req.method === "POST" && /^\/api\/me\/db-logins\/[^/]+\/reset-password$/.test(req.url ?? "")) {
      this.resets++;
      return [200, { pgUser: "u_son", password: `new-password-${this.resets}` }];
    }
    if (key === "GET /api/me/db-access") {
      return [200, { rows: this.rows(), gateway: { host: "127.0.0.1", port: this.gatewayPort(), hostKey: this.hostKeys[0] ?? null, hostKeys: this.hostKeys }, minCliVersion: "1.0.0" }];
    }
    return err(404, "not_found");
  }
}

/** The gateway's view of Beaver Ops: a key registered by a live token, with the grant still there. */
export class FakeGatewayApi implements GatewayApi {
  constructor(private readonly beaver: FakeBeaver) {}
  async authorize(req: AuthorizeRequest): Promise<AuthorizeAnswer> {
    // The gateway can't reach Beaver Ops: it refuses every key.
    if (this.beaver.gatewayCantReachBeaver) throw new Error("fetch failed");
    const k = this.beaver.keys.get(req.fingerprint);
    if (!k || this.beaver.tokens.get(k.token)?.revoked) return { allow: false, reason: "unknown_key" };
    if (!this.beaver.granted || req.username !== "son") return { allow: false, reason: "no_access" };
    const targets = this.beaver.rows().flatMap((r) => {
      const c = (r as { connect: { clusterHost: string; clusterPort: number; nativePort?: number } }).connect;
      return [{ host: c.clusterHost, port: c.clusterPort }, ...(c.nativePort ? [{ host: c.clusterHost, port: c.nativePort }] : [])];
    });
    if (req.destHost !== undefined && !targets.some((x) => x.host === req.destHost && x.port === req.destPort)) return { allow: false, reason: "destination_not_granted" };
    return { allow: true, userId: "u1", targets, expiresAt: null };
  }
  async event() {}
}

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

export const roundTrip = (port: number, text: string) =>
  new Promise<string>((resolve, reject) => {
    const s = tcpConnect({ host: "127.0.0.1", port });
    s.once("error", reject);
    s.once("data", (d) => {
      resolve(d.toString());
      s.end();
    });
    s.write(text);
  });


/** ClickHouse's HTTP interface, as far as the CLI uses it: JSONCompact results, 516 on a wrong password. */
export function fakeClickhouse(password: string) {
  const seen: { sql: string; database: string | null }[] = [];
  const server = createHttpServer(async (req, res) => {
    let sql = "";
    for await (const chunk of req) sql += chunk;
    const database = new URL(req.url ?? "/", "http://x").searchParams.get("database");
    seen.push({ sql, database });
    if (req.headers["x-clickhouse-user"] !== "u_son" || req.headers["x-clickhouse-key"] !== password) {
      return res.writeHead(403).end("Code: 516. DB::Exception: u_son: Authentication failed. (AUTHENTICATION_FAILED) (version 24.8.1)\n");
    }
    const json = (meta: string[], data: unknown[][]) => res.writeHead(200, { "x-clickhouse-format": "JSONCompact" }).end(JSON.stringify({ meta: meta.map((name) => ({ name })), data }));
    if (/^SELECT 1$/i.test(sql.trim())) return json(["1"], [[1]]);
    if (/count\(\)/i.test(sql)) return json(["count()"], [[1843221]]);
    if (/FROM events/i.test(sql)) return json(["name", "note"], [["signup", 'has, a "comma"'], ["login", null]]);
    if (/FORMAT Pretty/i.test(sql)) return res.writeHead(200, { "x-clickhouse-format": "Pretty" }).end("┏━━━┓\n┃ 1 ┃\n┗━━━┛\n");
    if (/^INSERT/i.test(sql.trim())) return res.writeHead(200).end("");
    res.writeHead(400).end("Code: 62. DB::Exception: Syntax error: failed at position 1 ('SELEC'). (SYNTAX_ERROR) (version 24.8.1)\n");
  });
  return { server, seen };
}

/**
 * Enough of Postgres' wire protocol for the `pg` driver: cleartext password, simple queries (one result
 * set of text columns), errors. No TLS (the row says sslMode: disable).
 */
export function fakePostgres(password: string) {
  const queries: string[] = [];
  const msg = (type: string, body: Buffer) => {
    const head = Buffer.alloc(5);
    head.write(type, 0);
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  };
  const int32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const int16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
  };
  const cstr = (s: string) => Buffer.from(`${s}\0`);
  const ready = msg("Z", Buffer.from("I"));
  const error = (severity: string, code: string, message: string, position?: number) =>
    msg("E", Buffer.concat([cstr(`S${severity}`), cstr(`V${severity}`), cstr(`C${code}`), cstr(`M${message}`), ...(position ? [cstr(`P${position}`)] : []), Buffer.from([0])]));
  const result = (columns: string[], rows: (string | null)[][], tag: string) =>
    Buffer.concat([
      msg("T", Buffer.concat([int16(columns.length), ...columns.map((c) => Buffer.concat([cstr(c), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]))])),
      ...rows.map((r) => msg("D", Buffer.concat([int16(r.length), ...r.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)])))]))),
      msg("C", cstr(tag)),
    ]);
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          started = true;
          socket.write(msg("R", int32(3)));
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const body = buf.subarray(5, len + 1).toString().replace(/\0$/, "");
        buf = buf.subarray(len + 1);
        if (type === "p") {
          if (body !== password) {
            socket.end(error("FATAL", "28P01", 'password authentication failed for user "u_son"'));
            return;
          }
          socket.write(Buffer.concat([msg("R", int32(0)), ready]));
        } else if (type === "Q") {
          queries.push(body);
          if (/^SELECT name/i.test(body)) socket.write(Buffer.concat([result(["name", "total"], [["alice", "3"], ["bob", null]], "SELECT 2"), ready]));
          else if (/^INSERT/i.test(body)) socket.write(Buffer.concat([msg("C", cstr("INSERT 0 3")), ready]));
          else socket.write(Buffer.concat([error("ERROR", "42601", 'syntax error at or near "SELEC"', 1), ready]));
        } else if (type === "X") {
          socket.end();
          return;
        }
      }
    });
  });
  return { server, queries };
}
