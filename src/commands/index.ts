import type { Command } from "../cli";
import { login, logout, whoami } from "./account";
import { dbConnect, dbInfo, dbList } from "./db";
import { doctor } from "./doctor";
import { dbPasswordCommand } from "./password";
import { dbQuery, dbShell } from "./sql";
import { update } from "./update";

export const helpCommand: Command = {
  name: "help",
  group: "Other",
  usage: "help [command]",
  summary: "Help for a command (also: beaver <command> --help)",
  args: [0, 2],
  // `beaver help …` is answered by Cli.run before commands run.
  run: async () => 0,
};

export const COMMANDS: Command[] = [login, logout, whoami, dbList, dbConnect, dbShell, dbQuery, dbInfo, dbPasswordCommand, doctor, update, helpCommand];
