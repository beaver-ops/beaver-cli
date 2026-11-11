// The CLI end to end: `beaver login` against a stand-in Beaver Ops (device flow, tokens, keys, db-access),
// then `beaver db connect` through a stand-in DB gateway (tests/gateway.ts, same protocol as the real one) to a local echo "database",
// with the gateway's host key pinned and access revoked while the tunnel is open.
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbGateway } from "./gateway";
import { CLUSTER, FakeBeaver, FakeGatewayApi, fakeClickhouse, fakePostgres, freePort, keyPair, roundTrip } from "./fakes";
import { VERSION } from "../src/version";
import { testCli, type TestCli } from "./helpers";

describe("beaver CLI end to end through the DB gateway", () => {
  const hostKey = keyPair();
  let echo: NetServer;
  let echoPort = 0;
  let gateway: DbGateway;
  let gatewayPort = 0;
  let http: HttpServer;
  let apiPort = 0;
  let localPort = 0;
  let beaver: FakeBeaver;
  let t: TestCli;

  const clickhouse = fakeClickhouse("ch-secret");
  const postgres = fakePostgres("pg-secret");
  let chPort = 0;
  let pgPort = 0;
  const listen = async (server: NetServer | HttpServer) => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };

  beforeAll(async () => {
    echo = createServer((s) => s.pipe(s));
    echoPort = await listen(echo);
    chPort = await listen(clickhouse.server);
    pgPort = await listen(postgres.server);
  });
  afterAll(async () => {
    await new Promise<void>((r) => echo.close(() => r()));
    clickhouse.server.close();
    postgres.server.close();
  });

  /** A row like the default one, for another database / server. */
  const row = (database: string, connect: Record<string, unknown>, more: Record<string, unknown> = {}) => {
    const base = beaver.base()[0] as { connect: Record<string, unknown> };
    return { ...base, grantId: `g_${database}`, ref: `shop/production/${database}`, database, login: { id: `l_${database}`, pgUser: "u_son", status: "active" }, ...more, connect: { ...base.connect, database, ...connect } };
  };
  const clickhouseRow = async () => row("saas", { engine: "clickhouse", clusterPort: chPort, localPort: await freePort(), sslMode: "disable" }, { cluster: { name: "analytics", provider: "do", engine: "clickhouse" } });
  const postgresRow = async () => row("orders_db", { clusterPort: pgPort, localPort: await freePort(), sslMode: "disable" }, { cluster: { name: "orders-db", provider: "do", engine: "pg" } });
  /** Piped stdin for the next command (ended, unless no text). */
  const input = (text?: string) => {
    const s = new PassThrough();
    if (text !== undefined) s.end(text);
    t.ctx.stdin = s;
  };

  beforeEach(async () => {
    localPort = await freePort();
    beaver = new FakeBeaver(() => gatewayPort, () => echoPort, () => localPort);
    beaver.hostKeys = [hostKey.public.trim()];
    gateway = new DbGateway({
      hostKeys: [hostKey.private],
      api: new FakeGatewayApi(beaver),
      allowedPorts: [echoPort, chPort, pgPort],
      recheckMs: 200,
      testResolve: async (host) => (host === CLUSTER ? ["127.0.0.1"] : []),
      testAllowAddresses: ["127.0.0.1"],
    });
    gatewayPort = await gateway.listen(0, "127.0.0.1");
    http = createHttpServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const [status, body] = await beaver.handle(req, raw ? JSON.parse(raw) : {});
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    apiPort = (http.address() as AddressInfo).port;
    t = testCli({ BEAVER_API_URL: `http://127.0.0.1:${apiPort}`, BEAVER_ACCESS_CHECK_MS: "100", BEAVER_RECONNECT_DELAYS_MS: "50" });
  });
  afterEach(async () => {
    await gateway.close();
    await new Promise<void>((r) => http.close(() => r()));
  });

  it("logs in with the device flow, saves the token, registers this machine's key and lists databases", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    const out = t.stdout();
    expect(out).toContain("First copy your one-time code: KQ7M-4TXP");
    expect(out).toContain("Open https://beaver.test/app/cli?code=KQ7M-4TXP");
    expect(out).toContain("✓ Signed in as Son (Acme)");
    expect(out).toContain("✓ Token saved to test store");
    expect(out).toMatch(/✓ SSH key for this (Mac|PC|machine) registered\n {2}beaver-cli · Sons-MacBook-Pro \(SHA256:…/);
    expect(out).toContain("You can open 1 database:");
    expect(out).toContain("Next: beaver db connect shop_db");
    expect([...t.store.secrets.values()][0]).toMatch(/^bcli_/);
    expect(beaver.keys.size).toBe(1);

    t.reset();
    expect(await t.run("db", "list")).toBe(0);
    expect(t.stdout()).toMatch(/DATABASE\s+ENGINE\s+PROJECT · ENV\s+LEVEL\s+EXPIRES\s+STATUS\nshop_db\s+Postgres\s+Shop · Production\s+read\s+—\s+active/);
    t.reset();
    expect(await t.run("whoami")).toBe(0);
    expect(t.stdout()).toContain("Son · son@example.com");
    t.reset();
    expect(await t.run("db", "info", "shop_db")).toBe(0);
    expect(t.stdout()).toContain(`Port       ${localPort}`);
    expect(t.stdout()).toContain("Ref        shop/production/shop_db");

    t.reset();
    expect(await t.run("logout")).toBe(0);
    expect(t.store.secrets.size).toBe(0);
    expect(beaver.keys.size).toBe(0);
    expect(await t.run("db", "list")).toBe(1);
    expect(t.stderr()).toContain("Not signed in. Run: beaver login");
  });

  it("refuses a denied login", async () => {
    beaver.denied = true;
    expect(await t.run("login", "--no-browser")).toBe(1);
    expect(t.stderr()).toContain("Sign-in denied in the browser.");
    expect(t.store.secrets.size).toBe(0);
  });

  it("opens a tunnel through the gateway, moves off a busy port, and closes on Ctrl+C", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    t.reset();
    // Something else already listens on the usual port.
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(localPort, "127.0.0.1", r));
    const run = t.start("db", "connect", "shop_db");
    const [, port] = await t.waitFor(/Port {7}(\d+)/);
    expect(Number(port)).not.toBe(localPort);
    expect(t.stdout()).toContain(`(${localPort} was busy)`);
    expect(t.stdout()).toContain("✓ Tunnel open through 127.0.0.1 (Ctrl+C to close)");
    expect(t.stdout()).toContain("User       u_son");
    expect(await roundTrip(Number(port), "SELECT 1")).toBe("SELECT 1");
    run.interrupt();
    expect(await run.done).toBe(0);
    expect(t.stdout()).toContain("✓ Tunnel closed");
    await new Promise<void>((r) => squatter.close(() => r()));
  });

  it("closes the tunnel once the access ends while it is open", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    const run = t.start("db", "connect", "shop_db", "--port", String(localPort));
    await t.waitFor(/Tunnel open/);
    expect(await roundTrip(localPort, "ping")).toBe("ping");
    beaver.granted = false;
    expect(await run.done).toBe(1);
    expect(t.stderr()).toContain("Your access to shop_db ended (revoked or expired). The tunnel is closed.");
  });

  it("refuses a gateway whose host key isn't the pinned one, and remembers the first one when none is pinned", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    beaver.hostKeys = [keyPair().public.trim()];
    t.reset();
    expect(await t.run("db", "connect", "shop_db")).toBe(1);
    expect(t.stderr()).toContain("presented a host key this CLI doesn't trust");

    // Nothing pinned: trust on first use, then that key only.
    beaver.hostKeys = [];
    const first = t.start("db", "connect", "shop_db");
    await t.waitFor(/Tunnel open/);
    first.interrupt();
    expect(await first.done).toBe(0);
    // Another key on the same address later: refused.
    const samePort = gatewayPort;
    await gateway.close();
    gateway = new DbGateway({ hostKeys: [keyPair().private], api: new FakeGatewayApi(beaver), allowedPorts: [echoPort], testResolve: async () => ["127.0.0.1"], testAllowAddresses: ["127.0.0.1"] });
    gatewayPort = await gateway.listen(samePort, "127.0.0.1");
    t.reset();
    expect(await t.run("db", "connect", "shop_db")).toBe(1);
    expect(t.stderr()).toContain("presented a host key this CLI doesn't trust");
  });

  it("doctor checks each link and says what to fix", async () => {
    expect(await t.run("doctor")).toBe(1);
    expect(t.stderr()).toContain("Not signed in");
    expect(await t.run("login", "--no-browser")).toBe(0);
    t.reset();
    expect(await t.run("doctor")).toBe(0);
    expect(t.stdout()).toContain("✓ Signed in as son@example.com");
    expect(t.stdout()).toMatch(/✓ SSH key SHA256:….{4} registered/);
    expect(t.stdout()).toContain("✓ 1 database granted");
    expect(t.stdout()).toContain("host key trusted, this machine's key accepted");
    expect(t.stdout()).toContain("Everything looks good.");

    // The key was removed on the web.
    beaver.keys.clear();
    t.reset();
    expect(await t.run("doctor")).toBe(1);
    expect(t.stderr()).toContain("isn't on your account");
  });

  /** Waits until stdout + stderr match. */
  const waitOutput = async (re: RegExp, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = (t.stdout() + t.stderr()).match(re);
      if (m) return m;
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}; stdout:\n${t.stdout()}\nstderr:\n${t.stderr()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** Stops the gateway and starts another one on the same port (same host key). */
  const restartGateway = async (gap?: () => Promise<void>) => {
    const samePort = gatewayPort;
    await gateway.close();
    await gap?.();
    gateway = new DbGateway({ hostKeys: [hostKey.private], api: new FakeGatewayApi(beaver), allowedPorts: [echoPort, chPort, pgPort], testResolve: async () => ["127.0.0.1"], testAllowAddresses: ["127.0.0.1"] });
    gatewayPort = await gateway.listen(samePort, "127.0.0.1");
  };

  it("keeps the local port through a gateway restart, reconnects, and holds connections made meanwhile", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    const run = t.start("db", "connect", "shop_db", "--port", String(localPort));
    await t.waitFor(/Tunnel open/);
    expect(await roundTrip(localPort, "before")).toBe("before");
    let queued: Promise<string> | undefined;
    await restartGateway(async () => {
      await waitOutput(/Lost the connection to 127\.0\.0\.1 .*Reconnecting; the local ports stay open\./);
      await waitOutput(/still offline/);
      // An app connecting while the gateway is down waits for the new connection.
      queued = roundTrip(localPort, "during");
    });
    await waitOutput(/✓ Reconnected to 127\.0\.0\.1/);
    expect(await queued).toBe("during");
    expect(await roundTrip(localPort, "after")).toBe("after");
    run.interrupt();
    expect(await run.done).toBe(0);
  });

  it("tells a gateway that can't reach Beaver Ops from a real refusal, and re-registers a key deleted on the web", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    const run = t.start("db", "connect", "shop_db", "--port", String(localPort));
    await t.waitFor(/Tunnel open/);
    // The gateway refuses every key for a while, but Beaver Ops still lists the access: keep trying.
    beaver.gatewayCantReachBeaver = true;
    await restartGateway();
    await waitOutput(/still offline \(The DB gateway refused this machine's key/);
    beaver.gatewayCantReachBeaver = false;
    await waitOutput(/✓ Reconnected/);
    expect(await roundTrip(localPort, "ok")).toBe("ok");

    // The key removed on the web: refused, registered again, reconnected.
    t.reset();
    beaver.keys.clear();
    await restartGateway();
    await waitOutput(/✓ Reconnected/);
    expect(beaver.keys.size).toBe(1);
    expect(await roundTrip(localPort, "again")).toBe("again");
    run.interrupt();
    expect(await run.done).toBe(0);
  });

  it("gives up when the gateway keeps refusing although the access is listed", async () => {
    t.ctx.env.BEAVER_DENIED_GIVE_UP_MS = "300";
    expect(await t.run("login", "--no-browser")).toBe(0);
    const run = t.start("db", "connect", "shop_db");
    await t.waitFor(/Tunnel open/);
    beaver.gatewayCantReachBeaver = true;
    await restartGateway();
    expect(await run.done).toBe(1);
    expect(t.stderr()).toContain("The gateway keeps refusing this machine's key for shop_db although Beaver Ops still lists your access, so the tunnel is closed. Run: beaver doctor");
  });

  it("connects several databases in one command", async () => {
    beaver.more = [await clickhouseRow(), await postgresRow()];
    expect(await t.run("login", "--no-browser")).toBe(0);
    t.reset();
    const run = t.start("db", "connect", "shop_db", "saas", "orders_db", "saas");
    await t.waitFor(/Tunnel open through 127\.0\.0\.1 to 3 databases/);
    await t.waitFor(/orders_db  Postgres/);
    const out = t.stdout();
    expect(out).toMatch(/shop_db  Postgres · Shop · Production/);
    expect(out).toMatch(/saas  ClickHouse/);
    const pgPorts = [...out.matchAll(/Port {7}(\d+)/g)].map((m) => Number(m[1]));
    const [, chLocal] = out.match(/HTTP port {2}(\d+)/)!;
    expect(pgPorts).toHaveLength(2);
    expect(await roundTrip(pgPorts[0], "shop")).toBe("shop");
    const res = await fetch(`http://127.0.0.1:${chLocal}/?database=saas`, { method: "POST", headers: { "X-ClickHouse-User": "u_son", "X-ClickHouse-Key": "ch-secret" }, body: "SELECT 1" });
    expect(await res.json()).toMatchObject({ data: [[1]] });
    run.interrupt();
    expect(await run.done).toBe(0);
    expect(t.stdout()).toContain("✓ Tunnels closed");

    t.reset();
    expect(await t.run("db", "connect", "shop_db", "saas", "--port", "4000")).toBe(2);
    expect(t.stderr()).toContain("--port and --native-port work with one database at a time.");
  });

  it("db query on ClickHouse: password from env, --remember, formats, errors, a saved password that stopped working", async () => {
    beaver.more = [await clickhouseRow()];
    expect(await t.run("login", "--no-browser")).toBe(0);
    const saved = `127.0.0.1:${apiPort}/db-login/l_saas`;
    input("");
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT 1")).toBe(1);
    expect(t.stderr()).toContain("No password for u_son: run in a terminal to type it, set BEAVER_DB_PASSWORD, or save it with --remember.");

    t.ctx.env.BEAVER_DB_PASSWORD = "wrong";
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT 1")).toBe(1);
    expect(t.stderr()).toContain("ClickHouse refused the password of u_son. Forgot it? beaver db password saas");

    t.ctx.env.BEAVER_DB_PASSWORD = "ch-secret";
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT count() FROM events", "--format", "csv", "--remember")).toBe(0);
    expect(t.stdout()).toBe("count()\n1843221\n");
    expect(t.stderr()).toContain("✓ Password saved to test store");
    expect([...t.store.secrets.entries()].find(([k]) => k.endsWith("/db-login/l_saas"))?.[1]).toBe("ch-secret");
    expect(clickhouse.seen.at(-1)).toEqual({ sql: "SELECT count() FROM events", database: "saas" });

    // The saved one from now on; TSV when piped; JSON; the server's own FORMAT; statements without rows.
    delete t.ctx.env.BEAVER_DB_PASSWORD;
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT name, note FROM events")).toBe(0);
    expect(t.stdout()).toBe('name\tnote\nsignup\thas, a "comma"\nlogin\t\\N\n');
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT name, note FROM events", "-f", "json")).toBe(0);
    expect(JSON.parse(t.stdout())).toEqual([{ name: "signup", note: 'has, a "comma"' }, { name: "login", note: null }]);
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT name, note FROM events", "-f", "csv")).toBe(0);
    expect(t.stdout()).toContain('signup,"has, a ""comma"""\nlogin,\n');
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT 1 FORMAT Pretty")).toBe(0);
    expect(t.stdout()).toBe("┏━━━┓\n┃ 1 ┃\n┗━━━┛\n");
    t.reset();
    input("INSERT INTO events VALUES ('x')");
    expect(await t.run("db", "query", "saas", "-")).toBe(0);
    expect(t.stdout()).toBe("OK\n");
    t.reset();
    expect(await t.run("db", "query", "saas", "SELEC 1")).toBe(1);
    expect(t.stderr()).toContain("Code: 62. DB::Exception: Syntax error");
    expect(t.stderr()).not.toContain("(version");
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT 1", "--format", "xml")).toBe(2);
    expect(t.stderr()).toContain("--format must be one of table, csv, tsv, json");

    // The password was reset elsewhere: the saved one is refused and forgotten.
    t.store.secrets.set(saved, "old");
    t.reset();
    expect(await t.run("db", "query", "saas", "SELECT 1")).toBe(1);
    expect(t.stderr()).toContain("The saved one was removed from this machine.");
    expect(t.store.secrets.has(saved)).toBe(false);
  });

  it("db shell on ClickHouse runs piped statements, keeps going after an error and exits 1", async () => {
    beaver.more = [await clickhouseRow()];
    expect(await t.run("login", "--no-browser")).toBe(0);
    t.ctx.env.BEAVER_DB_PASSWORD = "ch-secret";
    input("SELECT 1;\n\nSELEC oops;\nSELECT count()\n  FROM events;\nSELECT name, note FROM events");
    t.reset();
    expect(await t.run("db", "shell", "saas", "--format", "csv")).toBe(1);
    expect(t.stdout()).toBe('1\n1\ncount()\n1843221\nname,note\nsignup,"has, a ""comma"""\nlogin,\n');
    expect(t.stderr()).toContain("✗ Code: 62. DB::Exception: Syntax error");
    expect(clickhouse.seen.map((s) => s.sql)).toContain("SELECT count()\n  FROM events");

    input("SELECT 1;\n\\q\nSELECT count() FROM events;\n");
    t.reset();
    expect(await t.run("db", "shell", "saas")).toBe(0);
    expect(t.stdout()).toBe("1\n1\n");
  });

  it("db query on Postgres through the pg driver; db shell needs psql", async () => {
    beaver.more = [await postgresRow()];
    expect(await t.run("login", "--no-browser")).toBe(0);
    t.ctx.env.BEAVER_DB_PASSWORD = "pg-secret";
    t.reset();
    expect(await t.run("db", "query", "orders_db", "SELECT name, total FROM orders", "-f", "table")).toBe(0);
    expect(t.stdout()).toBe("name  │ total\n──────┼──────\nalice │ 3\nbob   │ NULL\n(2 rows)\n");
    expect(postgres.queries.at(-1)).toBe("SELECT name, total FROM orders");
    t.reset();
    expect(await t.run("db", "query", "orders_db", "INSERT INTO orders VALUES (1), (2), (3)")).toBe(0);
    expect(t.stdout()).toBe("INSERT 3\n");
    t.reset();
    expect(await t.run("db", "query", "orders_db", "SELEC 1")).toBe(1);
    expect(t.stderr()).toContain('syntax error at or near "SELEC" (at character 1)');
    t.ctx.env.BEAVER_DB_PASSWORD = "nope";
    t.reset();
    expect(await t.run("db", "query", "orders_db", "SELECT name FROM orders")).toBe(1);
    expect(t.stderr()).toContain("Postgres refused the password of u_son. Forgot it? beaver db password orders_db");

    t.ctx.env.PATH = "";
    t.reset();
    expect(await t.run("db", "shell", "orders_db")).toBe(1);
    expect(t.stderr()).toContain("beaver db shell opens psql for Postgres, and it isn't installed.");
    expect(t.stderr()).toContain('Without it: beaver db query orders_db "SELECT …"');
  });

  it("db password resets the password, shows it once and saves it with --remember", async () => {
    expect(await t.run("login", "--no-browser")).toBe(0);
    input("");
    t.reset();
    expect(await t.run("db", "password", "shop_db")).toBe(2);
    expect(t.stderr()).toContain("Resetting a password needs a confirmation: run it in a terminal, or add --yes.");
    expect(beaver.resets).toBe(0);
    t.reset();
    expect(await t.run("db", "password", "shop_db", "--yes")).toBe(0);
    expect(t.stdout()).toContain("✓ New password for u_son on general-db (shown once):\n\n  new-password-1\n");
    expect(t.stdout()).toContain("Save it now: Beaver Ops doesn't keep it.");
    expect(beaver.calls).toContain("POST /api/me/db-logins/l1/reset-password");
    t.reset();
    expect(await t.run("db", "password", "shop_db", "-y", "--remember")).toBe(0);
    expect(t.stdout()).toContain("new-password-2");
    expect(t.store.secrets.get(`127.0.0.1:${apiPort}/db-login/l1`)).toBe("new-password-2");
  });

  // The single binary (`bun build --compile`, set BEAVER_BINARY to it): ssh2 + fetch under Bun, for real.
  it.runIf(!!process.env.BEAVER_BINARY)("the compiled binary queries ClickHouse and Postgres through the gateway", async () => {
    beaver.more = [await clickhouseRow(), await postgresRow()];
    const token = `bcli_${"b".repeat(43)}`;
    beaver.tokens.set(token, { revoked: false });
    const run = (env: Record<string, string>, ...argv: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((resolve) => {
        const child = spawn(process.env.BEAVER_BINARY!, argv, {
          env: { ...process.env, HOME: t.dir, BEAVER_CONFIG_DIR: join(t.dir, "bin-config"), BEAVER_API_URL: `http://127.0.0.1:${apiPort}`, BEAVER_TOKEN: token, NO_COLOR: "1", ...env },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("exit", (code) => resolve({ code: code ?? 1, out, err }));
      });
    const v = await run({}, "--version");
    expect(v.out.trim()).toBe(VERSION);
    const q = await run({ BEAVER_DB_PASSWORD: "ch-secret" }, "db", "query", "saas", "SELECT count() FROM events", "--format", "csv");
    expect(q.err).toBe("");
    expect(q.out).toBe("count()\n1843221\n");
    expect(q.code).toBe(0);
    const p = await run({ BEAVER_DB_PASSWORD: "pg-secret" }, "db", "query", "orders_db", "SELECT name, total FROM orders", "--format", "csv");
    expect(p.err).toBe("");
    expect(p.out).toBe("name,total\nalice,3\nbob,\n");
    expect(beaver.keys.size).toBe(1);
  }, 30_000);
});
