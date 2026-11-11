// An in-process CLI for tests: captured output, a scripted Ctrl+C, secrets in memory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Cli } from "../src/cli";
import { COMMANDS } from "../src/commands";
import type { Context } from "../src/context";
import type { SecretStore } from "../src/credentials";

export class MemoryStore implements SecretStore {
  readonly label = "test store";
  readonly secrets = new Map<string, string>();
  async get(a: string) {
    return this.secrets.get(a) ?? null;
  }
  async set(a: string, s: string) {
    this.secrets.set(a, s);
  }
  async delete(a: string) {
    this.secrets.delete(a);
  }
}

export type TestCli = {
  ctx: Context;
  store: MemoryStore;
  dir: string;
  opened: string[];
  stdout: () => string;
  stderr: () => string;
  /** Runs `beaver …` and waits for it. */
  run: (...argv: string[]) => Promise<number>;
  /** Starts `beaver …` without waiting (db connect), with a Ctrl+C to send. */
  start: (...argv: string[]) => { done: Promise<number>; interrupt: () => void };
  /** Waits until stdout matches. */
  waitFor: (re: RegExp, ms?: number) => Promise<RegExpMatchArray>;
  reset: () => void;
};

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

export function testCli(env: Record<string, string>): TestCli {
  const dir = mkdtempSync(join(tmpdir(), "beaver-cli-"));
  let out = "";
  let err = "";
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (d: Buffer) => (out += d.toString()));
  stderr.on("data", (d: Buffer) => (err += d.toString()));
  const store = new MemoryStore();
  const opened: string[] = [];
  let interrupt: () => void = () => {};
  const ctx: Context = {
    env: { HOME: dir, BEAVER_CONFIG_DIR: join(dir, "config"), ...env },
    stdout,
    stderr,
    stdin: new PassThrough(),
    fetch: globalThis.fetch.bind(globalThis),
    openUrl: async (url) => void opened.push(url),
    hostname: "Sons-MacBook-Pro.local",
    platform: process.platform,
    arch: process.arch,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    interrupted: () => new Promise<void>((r) => (interrupt = r)),
    secretStore: store,
  };
  const cli = new Cli(COMMANDS);
  const t: TestCli = {
    ctx,
    store,
    dir,
    opened,
    stdout: () => strip(out),
    stderr: () => strip(err),
    run: (...argv) => cli.run(ctx, argv),
    start: (...argv) => ({ done: cli.run(ctx, argv), interrupt: () => interrupt() }),
    waitFor: async (re, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) {
        const m = strip(out).match(re);
        if (m) return m;
        if (Date.now() > end) throw new Error(`timed out waiting for ${re}; stdout:\n${strip(out)}\nstderr:\n${strip(err)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    reset: () => {
      out = "";
      err = "";
    },
  };
  return t;
}
