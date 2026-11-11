import { Cli } from "./cli";
import { COMMANDS } from "./commands";
import { processContext } from "./context";

const cli = new Cli(COMMANDS);
cli
  .run(processContext(), process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .finally(() => {
    // The tunnel and stdin are closed by the commands; anything left (keep-alive sockets) must not hold the CLI open.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
