// This machine's SSH key for the DB gateway: ed25519, made once in the config
// directory (`id_ed25519`, 0600), registered on the person's account as `source: cli`. It is tied to the
// CLI session: `logout` / revoking the session removes it on the server, `logout` deletes the files.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ssh2 from "ssh2";
import type { Api, SshKey } from "./api";
import type { Context } from "./context";
import { configDir, ensureConfigDir } from "./config";

export type MachineKey = { privateKey: string; publicKey: string; fingerprint: string; path: string };

export const keyPath = (ctx: Pick<Context, "env" | "platform">) => join(configDir(ctx), "id_ed25519");

/** `SHA256:<base64 without padding>` of a public key line or blob, like `ssh-keygen -lf`. */
export function fingerprint(publicKey: string | Buffer): string {
  const blob = typeof publicKey === "string" ? Buffer.from(publicKey.trim().split(/\s+/)[1] ?? "", "base64") : publicKey;
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** `beaver-cli · Alexs-MacBook-Pro`, as long as an SSH key name may be (60). */
export const machineName = (ctx: Pick<Context, "hostname">) => `beaver-cli · ${ctx.hostname.replace(/\.local$/, "") || "this machine"}`.slice(0, 60);

function parses(key: string): boolean {
  const parsed = ssh2.utils.parseKey(key);
  return !(parsed instanceof Error) && !(Array.isArray(parsed) && parsed.length === 0);
}

/** Reads the key, or null when there is none (or it is damaged). */
export function readMachineKey(ctx: Pick<Context, "env" | "platform">): MachineKey | null {
  const path = keyPath(ctx);
  if (!existsSync(path) || !existsSync(`${path}.pub`)) return null;
  const privateKey = readFileSync(path, "utf8");
  const publicKey = readFileSync(`${path}.pub`, "utf8").trim();
  if (!parses(privateKey) || !parses(publicKey)) return null;
  return { privateKey, publicKey, fingerprint: fingerprint(publicKey), path };
}

/** The key, made now when missing. ssh2 makes a malformed ed25519 pair about once in 256: checked pairs only. */
export function ensureMachineKey(ctx: Pick<Context, "env" | "platform" | "hostname">): MachineKey {
  const existing = readMachineKey(ctx);
  if (existing) return existing;
  ensureConfigDir(ctx);
  const path = keyPath(ctx);
  for (let i = 0; i < 10; i++) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: machineName(ctx).replace(/\s+/g, "") });
    const publicKey = pair.public.trim();
    if (!parses(pair.private) || !parses(publicKey)) continue;
    writeFileSync(path, pair.private, { mode: 0o600 });
    writeFileSync(`${path}.pub`, `${publicKey}\n`, { mode: 0o644 });
    if (ctx.platform !== "win32") chmodSync(path, 0o600);
    return { privateKey: pair.private, publicKey, fingerprint: fingerprint(publicKey), path };
  }
  throw new Error("Could not generate an SSH key");
}

export function deleteMachineKey(ctx: Pick<Context, "env" | "platform">): void {
  const path = keyPath(ctx);
  for (const f of [path, `${path}.pub`]) if (existsSync(f)) rmSync(f);
}

/**
 * Makes sure the key is on the account (registering it when it isn't: first login, or it was removed on
 * the web). Returns whether it had to be registered.
 */
export async function ensureKeyRegistered(api: Api, ctx: Pick<Context, "hostname">, key: MachineKey): Promise<{ registered: boolean; key: SshKey }> {
  const { keys } = await api.request<{ keys: SshKey[] }>("GET", "/api/me/ssh-keys");
  const found = keys.find((k) => k.fingerprint === key.fingerprint);
  if (found) return { registered: false, key: found };
  const res = await api.request<{ key: SshKey }>("POST", "/api/me/ssh-keys", { name: machineName(ctx), publicKey: key.publicKey, source: "cli" });
  return { registered: true, key: res.key };
}

/** `SHA256:…k3Qe`. */
export const shortFingerprint = (fp: string) => `SHA256:…${fp.slice(-4)}`;
