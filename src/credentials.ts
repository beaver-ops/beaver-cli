// Where the `bcli_` token (and passwords saved with `--remember`) are kept: the macOS Keychain
// (`security`), the Secret Service on Linux (`secret-tool`, libsecret), the Windows Credential Manager
// (PowerShell PasswordVault), else a `0600` file `credentials` in the config directory. Secrets go to
// those tools on stdin, never on the command line. `BEAVER_TOKEN` (CI) wins over all of them.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context";
import { apiHost, configDir, readJson, writeJson } from "./config";

export const SERVICE = "beaver-cli";

export interface SecretStore {
  /** "macOS Keychain", "Secret Service", "Windows Credential Manager", "~/.config/beaver/credentials". */
  readonly label: string;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

type RunResult = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], input?: string, env?: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
    } catch {
      return resolve({ code: 127, stdout: "", stderr: "" });
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ code: 127, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

/** A value inside the double quotes of a `security -i` command line. */
const quoted = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

class MacKeychain implements SecretStore {
  readonly label = "macOS Keychain";
  async get(account: string) {
    const r = await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") || null : null;
  }
  async set(account: string, secret: string) {
    // `-i` reads the command from stdin, so the secret never shows in `ps`.
    const r = await run("security", ["-i"], `add-generic-password -U -s ${quoted(SERVICE)} -a ${quoted(account)} -l ${quoted("Beaver CLI")} -w ${quoted(secret)}\n`);
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  async delete(account: string) {
    await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
  }
}

class SecretService implements SecretStore {
  readonly label = "Secret Service (libsecret)";
  async get(account: string) {
    const r = await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") || null : null;
  }
  async set(account: string, secret: string) {
    const r = await run("secret-tool", ["store", "--label=Beaver CLI", "service", SERVICE, "account", account], secret);
    if (r.code !== 0) throw new Error(`secret-tool: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  async delete(account: string) {
    await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
  }
}

const VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";

class WindowsVault implements SecretStore {
  readonly label = "Windows Credential Manager";
  private ps(script: string, input?: string, account = "") {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], input, { BEAVER_ACCOUNT: account });
  }
  async get(account: string) {
    const r = await this.ps(`${VAULT}try{$c=$v.Retrieve('${SERVICE}',$env:BEAVER_ACCOUNT);$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 3}`, undefined, account);
    return r.code === 0 ? r.stdout || null : null;
  }
  async set(account: string, secret: string) {
    const r = await this.ps(
      `${VAULT}$s=[Console]::In.ReadLine();try{$v.Remove($v.Retrieve('${SERVICE}',$env:BEAVER_ACCOUNT))}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}',$env:BEAVER_ACCOUNT,$s)))`,
      `${secret}\n`,
      account,
    );
    if (r.code !== 0) throw new Error(`Credential Manager: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  async delete(account: string) {
    await this.ps(`${VAULT}try{$v.Remove($v.Retrieve('${SERVICE}',$env:BEAVER_ACCOUNT))}catch{}`, undefined, account);
  }
}

/** `credentials` (0600) in the config directory: `{ "<account>": "<secret>" }`. */
export class FileStore implements SecretStore {
  readonly label: string;
  constructor(private readonly ctx: Pick<Context, "env" | "platform">) {
    this.label = join(configDir(ctx), "credentials").replace(ctx.env.HOME ?? "\u0000", "~");
  }
  private all() {
    return readJson<Record<string, string>>(this.ctx, "credentials") ?? {};
  }
  async get(account: string) {
    return this.all()[account] ?? null;
  }
  async set(account: string, secret: string) {
    writeJson(this.ctx, "credentials", { ...this.all(), [account]: secret });
  }
  async delete(account: string) {
    const all = this.all();
    delete all[account];
    if (Object.keys(all).length) writeJson(this.ctx, "credentials", all);
    else {
      const file = join(configDir(this.ctx), "credentials");
      if (existsSync(file)) rmSync(file);
    }
  }
}

/** The OS store when it is there (it works when a probe read succeeds or finds nothing), else the file. */
async function osStore(ctx: Context): Promise<SecretStore | null> {
  if (ctx.env.BEAVER_NO_KEYCHAIN === "1") return null;
  const candidate = ctx.platform === "darwin" ? new MacKeychain() : ctx.platform === "win32" ? new WindowsVault() : ctx.env.DBUS_SESSION_BUS_ADDRESS ? new SecretService() : null;
  if (!candidate) return null;
  const probe =
    ctx.platform === "darwin"
      ? await run("security", ["help"])
      : ctx.platform === "win32"
        ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${VAULT}exit 0`])
        : await run("secret-tool", ["--version"]);
  // `security help` exits 1 but prints its usage; a missing tool is 127.
  return probe.code === 127 ? null : candidate;
}

/**
 * The store secrets go to. Writing to the OS store can still fail (a locked keychain over SSH, no
 * Secret Service running): `saveSecret` falls back to the file then.
 */
export async function secretStore(ctx: Context): Promise<SecretStore> {
  return ctx.secretStore ?? (await osStore(ctx)) ?? new FileStore(ctx);
}

const tokenAccount = (ctx: Context) => apiHost(ctx);

/** The token of this Beaver Ops (BEAVER_TOKEN first), and where it came from. */
export async function loadToken(ctx: Context): Promise<{ token: string; from: string } | null> {
  if (ctx.env.BEAVER_TOKEN) return { token: ctx.env.BEAVER_TOKEN, from: "BEAVER_TOKEN" };
  const store = await secretStore(ctx);
  const token = await store.get(tokenAccount(ctx)).catch(() => null);
  if (token) return { token, from: store.label };
  // Saved in the file when the OS store refused it.
  if (!(store instanceof FileStore)) {
    const file = new FileStore(ctx);
    const fallback = await file.get(tokenAccount(ctx));
    if (fallback) return { token: fallback, from: file.label };
  }
  return null;
}

/** A secret saved by `saveSecret` (the OS store, else the file). */
export async function loadSecret(ctx: Context, account: string): Promise<string | null> {
  const store = await secretStore(ctx);
  const found = await store.get(account).catch(() => null);
  if (found || store instanceof FileStore) return found;
  return new FileStore(ctx).get(account);
}

/** Saves a secret, in the OS store if it takes it, else the file. Returns where it went. */
export async function saveSecret(ctx: Context, account: string, secret: string): Promise<string> {
  const store = await secretStore(ctx);
  try {
    await store.set(account, secret);
    return store.label;
  } catch {
    const file = new FileStore(ctx);
    await file.set(account, secret);
    return file.label;
  }
}

export async function deleteSecret(ctx: Context, account: string): Promise<void> {
  const store = await secretStore(ctx);
  await store.delete(account).catch(() => {});
  if (!(store instanceof FileStore)) await new FileStore(ctx).delete(account).catch(() => {});
}

export const saveToken = (ctx: Context, token: string) => saveSecret(ctx, tokenAccount(ctx), token);
export const deleteToken = (ctx: Context) => deleteSecret(ctx, tokenAccount(ctx));
