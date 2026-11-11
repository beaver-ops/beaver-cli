import { Cli } from "./cli";
import { COMMANDS } from "./commands";
import { processContext } from "./context";

// `beaver db info x | head`: the reader closing the pipe early is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw err;
  });
}

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
