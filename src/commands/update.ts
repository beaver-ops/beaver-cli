// beaver update: the latest release of the CLI (GitHub Releases of beaver-ops/beaver-cli, tags `v1.2.3`).
// Homebrew installs are upgraded with brew; a single binary downloads its platform's archive, checks it
// against the release's checksums.txt and replaces itself; under Node (npm) it says how to update.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Command } from "../cli";
import type { Context } from "../context";
import { CliError } from "../errors";
import { compareVersions, VERSION } from "../version";

export const RELEASE_REPO = "beaver-ops/beaver-cli";
export const BREW_FORMULA = "beaver-ops/tap/beaver";
export const NPM_PACKAGE = "@beaver-ops/cli";

const repo = (ctx: Context) => ctx.env.BEAVER_UPDATE_REPO || RELEASE_REPO;

/**
 * The release archive of this platform: `beaver-darwin-arm64.tar.gz`, `beaver-linux-x64.tar.gz`,
 * `beaver-windows-x64.zip`; each holds one file, `beaver` (`beaver.exe` on Windows).
 */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!["darwin", "linux", "windows"].includes(os) || !["arm64", "x64"].includes(arch)) throw new CliError(`No beaver build for ${platform}-${arch}.`);
  return `beaver-${os}-${arch}${os === "windows" ? ".zip" : ".tar.gz"}`;
}

/** The checksum of `name` in a `sha256sum` listing (`<hex>  <name>`, or `<hex> *<name>`). */
export function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return undefined;
}

/** Unpacks `archive` (tar.gz, or zip on Windows: its tar reads both) into a new folder; returns the binary in it. */
function unpack(archive: string, platform: NodeJS.Platform): string {
  const dir = mkdtempSync(join(tmpdir(), "beaver-update-"));
  const r = spawnSync("tar", ["-xf", archive, "-C", dir], { stdio: "pipe" });
  if (r.error || r.status !== 0) throw new CliError(`Couldn't unpack ${basename(archive)} (tar: ${r.error?.message ?? r.stderr.toString().trim()}).`);
  const bin = join(dir, platform === "win32" ? "beaver.exe" : "beaver");
  if (!existsSync(bin)) throw new CliError(`${basename(archive)} has no ${basename(bin)} in it.`);
  return bin;
}

export type InstallKind = "brew" | "binary" | "node";

/** How this CLI was installed, from the program running it. */
export function installKind(execPath: string, compiled: boolean): InstallKind {
  if (/[/\\](Cellar|homebrew|linuxbrew)[/\\]/i.test(execPath)) return "brew";
  if (compiled && !/^(node|bun)(\.exe)?$/i.test(basename(execPath))) return "binary";
  return "node";
}

/** A `bun build --compile` binary runs with Bun and its own path as the executable. */
const isCompiled = () => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function latestRelease(ctx: Context): Promise<{ version: string; url: string }> {
  let res: Response;
  try {
    res = await ctx.fetch(`https://api.github.com/repos/${repo(ctx)}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "beaver-cli" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new CliError(`Couldn't reach GitHub to check for updates: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new CliError(`GitHub answered ${res.status} for the latest beaver release.`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string };
  const version = body.tag_name?.replace(/^v/, "");
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) throw new CliError(`Unexpected release tag ${JSON.stringify(body.tag_name)}.`);
  return { version, url: body.html_url ?? `https://github.com/${repo(ctx)}/releases/latest` };
}

async function download(ctx: Context, url: string): Promise<Buffer> {
  const res = await ctx.fetch(url, { headers: { "user-agent": "beaver-cli" }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new CliError(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads this platform's archive of `version`, checks it against checksums.txt and puts its binary in place of `exe`. */
export async function replaceBinary(ctx: Context, version: string, exe: string): Promise<void> {
  const base = `https://github.com/${repo(ctx)}/releases/download/v${version}`;
  const name = assetName(ctx.platform, ctx.arch);
  const sums = (await download(ctx, `${base}/checksums.txt`)).toString("utf8");
  const expected = checksumOf(sums, name);
  if (!expected) throw new CliError(`The release has no checksum for ${name}.`);
  const archive = await download(ctx, `${base}/${name}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new CliError(`The download of ${name} doesn't match its checksum: not installed.`);
  const work = mkdtempSync(join(tmpdir(), "beaver-download-"));
  let unpacked: string | null = null;
  try {
    writeFileSync(join(work, name), archive);
    unpacked = unpack(join(work, name), ctx.platform);
    // Next to the target first (same filesystem), then renamed over it.
    const next = `${exe}.new`;
    copyFileSync(unpacked, next);
    if (ctx.platform !== "win32") chmodSync(next, 0o755);
    swap(ctx.platform, exe, next);
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (unpacked) rmSync(dirname(unpacked), { recursive: true, force: true });
  }
}

function swap(platform: NodeJS.Platform, exe: string, next: string): void {
  if (platform === "win32") {
    // A running .exe can be renamed, not overwritten.
    const old = `${exe}.old`;
    if (existsSync(old)) rmSync(old, { force: true });
    renameSync(exe, old);
  }
  renameSync(next, exe);
}

export const update: Command = {
  name: "update",
  group: "Other",
  usage: "update",
  summary: "Update the CLI",
  flags: [{ name: "check", help: "Only say whether a newer version exists" }],
  async run(ctx, ui, { flags }) {
    const latest = await latestRelease(ctx);
    if (compareVersions(latest.version, VERSION) <= 0) {
      ui.ok(`beaver ${VERSION} is the latest version.`);
      return 0;
    }
    ui.out(`beaver ${latest.version} is out (you have ${VERSION}): ${latest.url}`);
    if (flags.check) return 0;
    const exe = ctx.env.BEAVER_UPDATE_EXE || process.execPath;
    const kind = installKind(exe, ctx.env.BEAVER_UPDATE_EXE ? true : isCompiled());
    if (kind === "brew") {
      ui.out(`Running: brew upgrade ${BREW_FORMULA}`);
      return new Promise((resolve) => {
        const child = spawn("brew", ["upgrade", BREW_FORMULA], { stdio: "inherit" });
        child.on("error", () => {
          ui.fail(`Couldn't run brew. Run: brew upgrade ${BREW_FORMULA}`);
          resolve(1);
        });
        child.on("exit", (code) => resolve(code ?? 1));
      });
    }
    if (kind === "node") {
      ui.out(`This beaver runs with Node (npm). Run: npm install -g ${NPM_PACKAGE}@latest`);
      return 0;
    }
    try {
      await replaceBinary(ctx, latest.version, exe);
    } catch (err) {
      if (err instanceof CliError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw new CliError(`No permission to replace ${exe}. Run it with sudo, or reinstall from ${latest.url}`);
      throw err;
    }
    ui.ok(`Updated to beaver ${latest.version}.`);
    return 0;
  },
};
