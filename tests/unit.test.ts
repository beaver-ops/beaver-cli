import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DbAccessRow } from "../src/api";
import { parseFlags } from "../src/cli";
import { apiUrl, configDir } from "../src/config";
import { FileStore } from "../src/credentials";
import { expiryLabel, statusLabel } from "../src/format";
import { ensureMachineKey, fingerprint, machineName, readMachineKey } from "../src/keys";
import { findExecutable } from "../src/commands/sql";
import { assetName, checksumOf, installKind } from "../src/commands/update";
import { resolveDb } from "../src/resolve";
import { formatResult } from "../src/sql";
import { editDistance, suggest } from "../src/suggest";
import { table } from "../src/ui";
import { compareVersions, VERSION } from "../src/version";
import { testCli } from "./helpers";

const row = (database: string, ref: string, over: Partial<DbAccessRow> = {}): DbAccessRow => ({
  grantId: ref,
  ref,
  database,
  cluster: { name: "general-db", provider: "do", engine: "pg" },
  environment: { projectName: "Orders", name: "Production", projectSlug: "orders", slug: "production" },
  level: "read",
  allowSchema: false,
  expiresAt: null,
  status: "active",
  login: { id: "l1", pgUser: "u_ly", status: "active" },
  connect: { gateway: { host: "db.beaverops.ai", port: 2222 }, sshUser: "ly", pgUser: "u_ly", database, clusterHost: "h", clusterPort: 25060, localPort: 15432, sslMode: "require", engine: "pg" },
  ...over,
});

describe("command line", () => {
  it("prints help, command help and suggestions for typos", async () => {
    const t = testCli({});
    expect(await t.run("help")).toBe(0);
    expect(t.stdout()).toContain(`Beaver Ops CLI ${VERSION}`);
    expect(t.stdout()).toMatch(/db connect <db>…\s+Open a tunnel/);
    t.reset();
    expect(await t.run("db", "connect", "--help")).toBe(0);
    expect(t.stdout()).toContain("Usage: beaver db connect <db>… [options]");
    expect(t.stdout()).toContain("--port <port>");
    t.reset();
    expect(await t.run("help", "db", "list")).toBe(0);
    expect(t.stdout()).toContain("Alias: beaver db ls");
    t.reset();
    expect(await t.run("db", "conect", "orders_db")).toBe(2);
    expect(t.stderr()).toContain('Unknown command "db conect". Did you mean "db connect"?');
    t.reset();
    expect(await t.run("lgoin")).toBe(2);
    expect(t.stderr()).toContain('Did you mean "login"?');
    t.reset();
    expect(await t.run("frobnicate")).toBe(2);
    expect(t.stderr()).not.toContain("Did you mean");
    t.reset();
    expect(await t.run("db", "list", "--jsn")).toBe(2);
    expect(t.stderr()).toContain('Did you mean "--json"?');
    t.reset();
    expect(await t.run("db", "connect")).toBe(2);
    expect(t.stderr()).toContain("Usage: beaver db connect <db>");
    t.reset();
    expect(await t.run("--version")).toBe(0);
    expect(t.stdout().trim()).toBe(VERSION);
  });

  it("parses flags with values, = and --", () => {
    const specs = [{ name: "port", value: "port", help: "" }, { name: "json", help: "" }];
    expect(parseFlags(["a", "--port", "1", "--json"], specs)).toEqual({ args: ["a"], flags: { port: "1", json: true } });
    expect(parseFlags(["--port=2", "--", "--json"], specs)).toEqual({ args: ["--json"], flags: { port: "2" } });
    expect(() => parseFlags(["--port"], specs)).toThrow("--port needs a value");
  });

  it("says Not signed in for commands that need a session", async () => {
    const t = testCli({});
    expect(await t.run("db", "list")).toBe(1);
    expect(t.stderr()).toContain("Not signed in. Run: beaver login");
  });

  it("suggests close names only", () => {
    expect(editDistance("conect", "connect")).toBe(1);
    expect(editDistance("ocnnect", "connect")).toBe(1);
    expect(suggest("orders_d", ["orders_db", "saas"])).toBe("orders_db");
    expect(suggest("xyz", ["orders_db", "saas"])).toBeNull();
  });
});

describe("databases", () => {
  const rows = [row("orders_db", "orders/production/orders_db"), row("shop", "shop/production/shop"), row("shop", "shop/staging/shop")];

  it("resolves <db> by name, or by project/env/db when the name is ambiguous", () => {
    expect(resolveDb(rows, "orders_db").ref).toBe("orders/production/orders_db");
    expect(resolveDb(rows, "Shop/Staging/shop").ref).toBe("shop/staging/shop");
    expect(() => resolveDb(rows, "shop")).toThrow(/"shop" is on 2 servers. Use one of:\n {2}shop\/production\/shop\n {2}shop\/staging\/shop/);
    expect(() => resolveDb(rows, "orders_d")).toThrow('Did you mean "orders_db"?');
    expect(() => resolveDb([], "x")).toThrow("no database access");
  });

  it("formats expiry, status and tables", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    expect(expiryLabel(null, now)).toBe("—");
    expect(expiryLabel("2026-11-17T09:00:00Z", now)).toBe("in 6 days");
    expect(expiryLabel("2026-11-12T09:00:00Z", now)).toBe("tomorrow");
    expect(expiryLabel("2026-12-11T09:00:00Z", now)).toBe("11 Dec");
    expect(expiryLabel("2027-01-11T09:00:00Z", now)).toBe("11 Jan 2027");
    expect(statusLabel("pending")).toBe("applying");
    expect(table(["A", "BB"], [["xxx", "y"]])).toEqual(["A    BB", "xxx  y"]);
  });
});

describe("files", () => {
  it("keeps package.json's version", () => {
    expect(JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version).toBe(VERSION);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  });

  it("makes one ed25519 key per machine, 0600, and keeps it", () => {
    const t = testCli({});
    const key = ensureMachineKey(t.ctx);
    expect(key.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(key.fingerprint).toBe(fingerprint(key.publicKey));
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    if (process.platform !== "win32") {
      expect(statSync(key.path).mode & 0o777).toBe(0o600);
      expect(statSync(configDir(t.ctx)).mode & 0o777).toBe(0o700);
    }
    expect(ensureMachineKey(t.ctx).fingerprint).toBe(key.fingerprint);
    expect(readMachineKey(t.ctx)?.fingerprint).toBe(key.fingerprint);
    expect(machineName(t.ctx)).toBe("beaver-cli · Sons-MacBook-Pro");
  });

  it("stores secrets in a 0600 file when there is no keychain", async () => {
    const t = testCli({});
    const store = new FileStore(t.ctx);
    await store.set("app.beaverops.ai", "bcli_x");
    expect(await store.get("app.beaverops.ai")).toBe("bcli_x");
    if (process.platform !== "win32") expect(statSync(join(configDir(t.ctx), "credentials")).mode & 0o777).toBe(0o600);
    await store.delete("app.beaverops.ai");
    expect(await store.get("app.beaverops.ai")).toBeNull();
  });

  it("only talks to https (or a local http server)", () => {
    expect(apiUrl({ env: {} })).toBe("https://app.beaverops.ai");
    expect(apiUrl({ env: { BEAVER_API_URL: "http://127.0.0.1:3000/" } })).toBe("http://127.0.0.1:3000");
    expect(() => apiUrl({ env: { BEAVER_API_URL: "http://beaver.example.com" } })).toThrow("must be https://");
  });
});

describe("SQL results", () => {
  const r = { columns: ["id", "name", "at"], rows: [[1, "a,b", new Date("2026-01-02T03:04:05Z")], [2, null, null]] };
  it("prints a table, CSV, TSV and JSON", () => {
    expect(formatResult(r, "table")).toBe(
      ["id │ name │ at", "───┼──────┼─────────────────────────", "1  │ a,b  │ 2026-01-02T03:04:05.000Z", "2  │ NULL │ NULL", "(2 rows)"].join("\n"),
    );
    expect(formatResult(r, "csv")).toBe('id,name,at\n1,"a,b",2026-01-02T03:04:05.000Z\n2,,');
    expect(formatResult({ columns: ["x"], rows: [["a\tb\nc"], [null]] }, "tsv")).toBe("x\na\\tb\\nc\n\\N");
    expect(JSON.parse(formatResult(r, "json"))).toEqual([{ id: 1, name: "a,b", at: "2026-01-02T03:04:05.000Z" }, { id: 2, name: null, at: null }]);
    expect(formatResult({ columns: ["v"], rows: [["x".repeat(80)]] }, "table").split("\n")[2]).toHaveLength(60);
    expect(formatResult({ columns: [], rows: [], summary: "INSERT 3" }, "table")).toBe("INSERT 3");
    expect(formatResult({ columns: [], rows: [], raw: "raw\n" }, "csv")).toBe("raw");
  });

  it("finds an executable on the PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "beaver-path-"));
    writeFileSync(join(dir, "psql"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findExecutable({ env: { PATH: `/nowhere${delimiter}${dir}` }, platform: "linux" }, "psql")).toBe(join(dir, "psql"));
    expect(findExecutable({ env: { PATH: "/nowhere" }, platform: "linux" }, "psql")).toBeNull();
  });
});

describe("beaver update", () => {
  const release = (version: string, files: Record<string, Buffer | string>) => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      asked.push(u);
      if (u.endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: `v${version}`, html_url: `https://github.com/beaver-ops/beaver-cli/releases/tag/v${version}` }));
      const name = u.split("/").pop()!;
      return name in files ? new Response(files[name]) : new Response("nope", { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, asked };
  };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("names the asset of each platform and tells how the CLI was installed", () => {
    expect(assetName("darwin", "arm64")).toBe("beaver-darwin-arm64.tar.gz");
    expect(assetName("linux", "x64")).toBe("beaver-linux-x64.tar.gz");
    expect(assetName("win32", "x64")).toBe("beaver-windows-x64.zip");
    const sums = `${"a".repeat(64)}  beaver-linux-x64.tar.gz\n${"B".repeat(64)} *beaver-windows-x64.zip\n`;
    expect(checksumOf(sums, "beaver-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksumOf(sums, "beaver-windows-x64.zip")).toBe("b".repeat(64));
    expect(checksumOf(sums, "beaver-linux-x64")).toBeUndefined();
    expect(() => assetName("linux", "ia32")).toThrow("No beaver build for linux-ia32");
    expect(installKind("/opt/homebrew/Cellar/beaver/1.0.0/bin/beaver", true)).toBe("brew");
    expect(installKind("/usr/local/bin/beaver", true)).toBe("binary");
    expect(installKind("/usr/local/bin/node", false)).toBe("node");
    expect(installKind("/usr/local/bin/bun", true)).toBe("node");
  });

  it("says when it is the latest, or that a newer one is out (--check)", async () => {
    const t = testCli({});
    t.ctx.fetch = release(VERSION, {}).fetchImpl;
    expect(await t.run("update")).toBe(0);
    expect(t.stdout()).toContain(`✓ beaver ${VERSION} is the latest version.`);
    t.reset();
    t.ctx.fetch = release("99.0.0", {}).fetchImpl;
    expect(await t.run("update", "--check")).toBe(0);
    expect(t.stdout()).toContain(`beaver 99.0.0 is out (you have ${VERSION}): https://github.com/beaver-ops/beaver-cli/releases/tag/v99.0.0`);
  });

  // The release archive, made like release.yml does: `tar -czf` of a folder holding just `beaver`.
  const archiveOf = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "beaver-archive-"));
    writeFileSync(join(dir, "beaver"), content, { mode: 0o755 });
    execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "beaver"]);
    return readFileSync(join(dir, "a.tar.gz"));
  };

  it.skipIf(process.platform === "win32")("replaces a single binary after checking checksums.txt, and refuses a download that doesn't match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beaver-update-"));
    const exe = join(dir, "beaver");
    writeFileSync(exe, "old", { mode: 0o755 });
    const name = assetName(process.platform, process.arch);
    const next = archiveOf("new binary");
    const t = testCli({ BEAVER_UPDATE_EXE: exe });
    const ok = release("99.0.0", { "checksums.txt": `${sha(next)}  ${name}\n${sha(Buffer.from("x"))}  beaver-other.tar.gz\n`, [name]: next });
    t.ctx.fetch = ok.fetchImpl;
    expect(await t.run("update")).toBe(0);
    expect(t.stdout()).toContain("✓ Updated to beaver 99.0.0.");
    expect(readFileSync(exe, "utf8")).toBe("new binary");
    expect(ok.asked).toContain(`https://github.com/beaver-ops/beaver-cli/releases/download/v99.0.0/${name}`);
    expect(ok.asked).toContain("https://github.com/beaver-ops/beaver-cli/releases/download/v99.0.0/checksums.txt");
    if (process.platform !== "win32") expect(statSync(exe).mode & 0o777).toBe(0o755);

    t.reset();
    t.ctx.fetch = release("99.0.1", { "checksums.txt": `${sha(Buffer.from("other"))}  ${name}\n`, [name]: archiveOf("newer") }).fetchImpl;
    expect(await t.run("update")).toBe(1);
    expect(t.stderr()).toContain(`The download of ${name} doesn't match its checksum: not installed.`);
    expect(readFileSync(exe, "utf8")).toBe("new binary");
  });
});
