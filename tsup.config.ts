import { defineConfig } from "tsup";

// One ESM file for npm / `node dist/beaver.mjs`; ssh2 stays a dependency (its optional native parts load
// when present). Single binaries are built with `bun build --compile` (scripts/build-binaries.sh).
export default defineConfig({
  entry: { beaver: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
  external: ["ssh2"],
  clean: true,
  sourcemap: false,
});
