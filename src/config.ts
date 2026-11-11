// Where the CLI keeps its files (`~/.config/beaver`, or $XDG_CONFIG_HOME/beaver, %APPDATA%\beaver on
// Windows, $BEAVER_CONFIG_DIR) and which Beaver Ops it talks to ($BEAVER_API_URL, default app.beaverops.ai).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "./context";
import { CliError } from "./errors";

export const DEFAULT_API_URL = "https://app.beaverops.ai";

export function configDir(ctx: Pick<Context, "env" | "platform">): string {
  if (ctx.env.BEAVER_CONFIG_DIR) return ctx.env.BEAVER_CONFIG_DIR;
  if (ctx.platform === "win32" && ctx.env.APPDATA) return join(ctx.env.APPDATA, "beaver");
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.env.HOME || homedir(), ".config"), "beaver");
}

/** The config directory, created 0700. */
export function ensureConfigDir(ctx: Pick<Context, "env" | "platform">): string {
  const dir = configDir(ctx);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (ctx.platform !== "win32") chmodSync(dir, 0o700);
  return dir;
}

export function apiUrl(ctx: Pick<Context, "env">): string {
  const raw = (ctx.env.BEAVER_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`BEAVER_API_URL is not a URL: ${raw}`);
  }
  // Tokens only travel over HTTPS (plain HTTP for a local server while developing).
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new CliError(`BEAVER_API_URL must be https:// (got ${raw})`);
  return raw;
}

/** `app.beaverops.ai` (the account name secrets are kept under). */
export const apiHost = (ctx: Pick<Context, "env">) => new URL(apiUrl(ctx)).host;

/** A small JSON file in the config directory (0600). */
export function readJson<T>(ctx: Pick<Context, "env" | "platform">, name: string): T | null {
  const file = join(configDir(ctx), name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(ctx: Pick<Context, "env" | "platform">, name: string, value: unknown): void {
  const file = join(ensureConfigDir(ctx), name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (ctx.platform !== "win32") chmodSync(file, 0o600);
}
