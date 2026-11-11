// Everything a command touches outside its own code, so tests can run the CLI in-process: output
// streams, environment, HTTP, the browser, the clock and the place secrets are kept.
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { SecretStore } from "./credentials";

export type Output = Writable & { isTTY?: boolean; columns?: number };
export type Input = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export type Context = {
  env: Record<string, string | undefined>;
  stdout: Output;
  stderr: Output;
  stdin: Input;
  fetch: typeof fetch;
  /** Opens a URL in the browser (best effort). */
  openUrl: (url: string) => Promise<void>;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Resolves on Ctrl+C (or the test saying so). */
  interrupted: () => Promise<void>;
  /** Tests: a store instead of the Keychain / file. */
  secretStore?: SecretStore;
};

export async function defaultOpenUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve());
      child.unref();
      setTimeout(resolve, 50);
    } catch {
      resolve();
    }
  });
}

export function processContext(): Context {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    fetch: globalThis.fetch.bind(globalThis),
    openUrl: (url) => defaultOpenUrl(url),
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    interrupted: () =>
      new Promise<void>((resolve) => {
        const done = () => {
          process.off("SIGINT", done);
          process.off("SIGTERM", done);
          resolve();
        };
        process.on("SIGINT", done);
        process.on("SIGTERM", done);
      }),
  };
}
