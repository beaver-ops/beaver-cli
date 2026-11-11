// Terminal output: colors only on a TTY (and never with NO_COLOR), tables, a spinner, prompts.
import type { Context, Output } from "./context";

const codes = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] } as const;
type Style = keyof typeof codes;

export function colorsOn(ctx: Pick<Context, "env">, out: Output): boolean {
  return !!out.isTTY && !ctx.env.NO_COLOR && ctx.env.TERM !== "dumb";
}

export type Paint = Record<Style, (s: string) => string>;

export function painter(on: boolean): Paint {
  const make = (style: Style) => (s: string) => (on ? `\u001b[${codes[style][0]}m${s}\u001b[${codes[style][1]}m` : s);
  return { bold: make("bold"), dim: make("dim"), red: make("red"), green: make("green"), yellow: make("yellow"), cyan: make("cyan") };
}

export type Ui = Paint & {
  out: (line?: string) => void;
  err: (line?: string) => void;
  ok: (line: string) => void;
  warn: (line: string) => void;
  fail: (line: string) => void;
};

export function makeUi(ctx: Context): Ui {
  const p = painter(colorsOn(ctx, ctx.stdout));
  const pe = painter(colorsOn(ctx, ctx.stderr));
  return {
    ...p,
    out: (line = "") => void ctx.stdout.write(`${line}\n`),
    err: (line = "") => void ctx.stderr.write(`${line}\n`),
    ok: (line) => void ctx.stdout.write(`${p.green("✓")} ${line}\n`),
    warn: (line) => void ctx.stderr.write(`${pe.yellow("!")} ${line}\n`),
    fail: (line) => void ctx.stderr.write(`${pe.red("✗")} ${line}\n`),
  };
}

/** Visible width (ANSI codes don't count). */
const width = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;

/** Columns padded to the widest cell; the last column is not padded. */
export function table(headers: string[], rows: string[][], gap = 2): string[] {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ""))));
  return all.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(widths[i] - width(cell) + gap)))
      .join("")
      .trimEnd(),
  );
}

/** A spinner on a TTY (`⠋ Waiting…`), plain lines otherwise. Returns a stop function. */
export function spinner(ctx: Context, text: () => string): () => void {
  if (!ctx.stderr.isTTY) {
    ctx.stderr.write(`${text()}\n`);
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const draw = () => ctx.stderr.write(`\r\u001b[2K${frames[i++ % frames.length]} ${text()}`);
  draw();
  const timer = setInterval(draw, 100);
  return () => {
    clearInterval(timer);
    ctx.stderr.write("\r\u001b[2K");
  };
}

/** Resolves on the next line of input (Enter); never when stdin is not a terminal. */
export function waitForEnter(ctx: Context): { promise: Promise<void>; cancel: () => void } {
  if (!ctx.stdin.isTTY) return { promise: new Promise(() => {}), cancel: () => {} };
  let onData: (b: Buffer) => void = () => {};
  const promise = new Promise<void>((resolve) => {
    onData = (b: Buffer) => {
      if (b.includes(10) || b.includes(13)) {
        cancel();
        resolve();
      }
    };
    ctx.stdin.on("data", onData);
    ctx.stdin.resume();
  });
  const cancel = () => {
    ctx.stdin.off("data", onData);
    ctx.stdin.pause();
  };
  return { promise, cancel };
}

/** Asks for a secret without echoing it (TTY only); null when stdin is not a terminal. */
export async function promptHidden(ctx: Context, question: string): Promise<string | null> {
  if (!ctx.stdin.isTTY || !ctx.stdin.setRawMode) return null;
  ctx.stderr.write(question);
  ctx.stdin.setRawMode(true);
  ctx.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (b: Buffer) => {
      for (const ch of b.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0003") return finish(null);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const finish = (v: string | null) => {
      ctx.stdin.off("data", onData);
      ctx.stdin.setRawMode?.(false);
      ctx.stdin.pause();
      ctx.stderr.write("\n");
      resolve(v);
    };
    ctx.stdin.on("data", onData);
  });
}

/** Asks a yes/no question on a TTY (default no); false when stdin is not a terminal. */
export async function confirm(ctx: Context, question: string): Promise<boolean> {
  if (!ctx.stdin.isTTY) return false;
  ctx.stderr.write(`${question} [y/N] `);
  ctx.stdin.resume();
  return new Promise((resolve) => {
    ctx.stdin.once("data", (b: Buffer) => {
      ctx.stdin.pause();
      resolve(/^y(es)?$/i.test(b.toString().trim()));
    });
  });
}
