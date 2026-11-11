// Command line: `beaver <command> [args] [--flags]`, help for everything (`beaver help db connect`,
// `beaver db connect --help`), and "Did you mean …" for typos.
import type { Context } from "./context";
import { CliError } from "./errors";
import { suggest } from "./suggest";
import { makeUi, type Ui } from "./ui";
import { VERSION } from "./version";

export type FlagSpec = { name: string; short?: string; value?: string; help: string };

export type Parsed = { args: string[]; flags: Record<string, string | boolean> };

export type Command = {
  /** `login`, `db connect`. */
  name: string;
  aliases?: string[];
  group: "Account" | "Databases" | "Other";
  /** `db connect <db>`. */
  usage: string;
  summary: string;
  /** Longer help, shown by `beaver help <command>`. */
  help?: string;
  flags?: FlagSpec[];
  /** Positional arguments: exact count, or [min, max]. */
  args?: number | [number, number];
  run: (ctx: Context, ui: Ui, input: Parsed) => Promise<number>;
};

const GLOBAL_FLAGS: FlagSpec[] = [{ name: "help", short: "h", help: "Show help for the command" }];

export function parseFlags(tokens: string[], specs: FlagSpec[]): Parsed {
  const all = [...specs, ...GLOBAL_FLAGS];
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      args.push(...tokens.slice(i + 1));
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      args.push(t);
      continue;
    }
    const [rawName, inline] = t.startsWith("--") ? [t.slice(2).split("=")[0], t.includes("=") ? t.slice(t.indexOf("=") + 1) : undefined] : [t.slice(1), undefined];
    const spec = t.startsWith("--") ? all.find((f) => f.name === rawName) : all.find((f) => f.short === rawName);
    if (!spec) {
      const close = suggest(rawName, all.map((f) => f.name));
      throw new CliError(`Unknown option ${JSON.stringify(t)}.${close ? ` Did you mean "--${close}"?` : ""}`, 2);
    }
    if (spec.value) {
      const value = inline ?? tokens[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new CliError(`--${spec.name} needs a value (${spec.value})`, 2);
      flags[spec.name] = value;
    } else flags[spec.name] = true;
  }
  return { args, flags };
}

export class Cli {
  constructor(private readonly commands: Command[]) {}

  private names(): string[] {
    return this.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  }

  /** The command the tokens start with (two words first: `db connect`), and the rest. */
  find(tokens: string[]): { command: Command; rest: string[] } | null {
    for (const words of [2, 1]) {
      const name = tokens.slice(0, words).join(" ");
      const command = this.commands.find((c) => c.name === name || c.aliases?.includes(name));
      if (command && tokens.length >= words) return { command, rest: tokens.slice(words) };
    }
    return null;
  }

  usage(): string {
    const lines = [`Beaver Ops CLI ${VERSION}`, "", "Usage: beaver <command> [options]"];
    for (const group of ["Account", "Databases", "Other"] as const) {
      const cmds = this.commands.filter((c) => c.group === group);
      if (!cmds.length) continue;
      lines.push("", group);
      for (const c of cmds) {
        const alias = c.aliases?.length ? ` (alias: ${c.aliases.join(", ")})` : "";
        lines.push(`  ${c.usage.padEnd(25)}${c.summary}${alias}`);
      }
    }
    if (this.commands.some((c) => c.name.startsWith("db "))) {
      lines.push(
        "",
        "<db> is a database name (orders_db), or project/env/db when the name is ambiguous",
        "(orders/production/orders_db). Run `beaver db list` to see them.",
      );
    }
    lines.push("", "Help for one command: beaver help <command>, or add --help (-h): beaver db connect -h");
    return lines.join("\n");
  }

  commandHelp(c: Command): string {
    const lines = [`Usage: beaver ${c.usage}${c.flags?.length ? " [options]" : ""}`, "", c.summary];
    if (c.help) lines.push("", c.help);
    if (c.aliases?.length) lines.push("", `Alias: beaver ${c.aliases.join(", beaver ")}`);
    const flags = [...(c.flags ?? []), ...GLOBAL_FLAGS];
    lines.push("", "Options");
    for (const f of flags) {
      const left = `${f.short ? `-${f.short}, ` : "    "}--${f.name}${f.value ? ` <${f.value}>` : ""}`;
      lines.push(`  ${left.padEnd(26)}${f.help}`);
    }
    return lines.join("\n");
  }

  /** `beaver db conect` → `Unknown command "db conect". Did you mean "db connect"?`. */
  unknown(tokens: string[]): CliError {
    const two = tokens.slice(0, 2).join(" ");
    const candidates = this.names();
    const asTwo = tokens.length > 1 ? suggest(two, candidates.filter((n) => n.includes(" "))) : null;
    const asOne = suggest(tokens[0], candidates.filter((n) => !n.includes(" ")).concat(["db"]));
    const shown = tokens.length > 1 && (asTwo || tokens[0] === "db" || asOne === "db") ? two : tokens[0];
    const close = asTwo ?? (asOne && asOne !== "db" ? asOne : null);
    return new CliError(`Unknown command ${JSON.stringify(shown)}.${close ? ` Did you mean ${JSON.stringify(close)}?` : ""} Run: beaver help`, 2);
  }

  async run(ctx: Context, argv: string[]): Promise<number> {
    const ui = makeUi(ctx);
    try {
      if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
        ui.out(this.usage());
        return 0;
      }
      if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
        ui.out(VERSION);
        return 0;
      }
      if (argv[0] === "help") {
        const topic = argv.slice(1).filter((a) => !a.startsWith("-"));
        if (!topic.length) {
          ui.out(this.usage());
          return 0;
        }
        const hit = this.find(topic);
        if (hit && !hit.rest.length) {
          ui.out(this.commandHelp(hit.command));
          return 0;
        }
        if (topic.length === 1 && topic[0] === "db") {
          ui.out(this.groupHelp("db"));
          return 0;
        }
        throw this.unknown(topic);
      }
      const hit = this.find(argv);
      if (!hit) {
        if (argv[0] === "db" && (argv.length === 1 || argv[1].startsWith("-"))) {
          ui.out(this.groupHelp("db"));
          return argv.length === 1 ? 2 : 0;
        }
        throw this.unknown(argv);
      }
      const parsed = parseFlags(hit.rest, hit.command.flags ?? []);
      if (parsed.flags.help) {
        ui.out(this.commandHelp(hit.command));
        return 0;
      }
      const [min, max] = typeof hit.command.args === "number" ? [hit.command.args, hit.command.args] : (hit.command.args ?? [0, 0]);
      if (parsed.args.length < min || parsed.args.length > max) {
        throw new CliError(`Usage: beaver ${hit.command.usage}${parsed.args.length < min ? "" : ` (unexpected ${JSON.stringify(parsed.args[max])})`}. More: beaver ${hit.command.name} --help`, 2);
      }
      return await hit.command.run(ctx, ui, parsed);
    } catch (err) {
      if (err instanceof CliError) {
        ui.fail(err.message);
        return err.exitCode;
      }
      ui.fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      if (ctx.env.BEAVER_DEBUG && err instanceof Error && err.stack) ui.err(err.stack);
      return 1;
    }
  }

  private groupHelp(prefix: string): string {
    const cmds = this.commands.filter((c) => c.name.startsWith(`${prefix} `));
    return ["Usage: beaver db <command>", "", ...cmds.map((c) => `  ${c.usage.padEnd(25)}${c.summary}`), "", "Details: beaver help db <command>, or beaver db <command> -h"].join("\n");
  }
}
