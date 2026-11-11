# Beaver CLI (`beaver`)

Open the databases you were granted in [Beaver Ops](https://app.beaverops.ai) with one command: sign in
through the browser, then `beaver db connect <db>` opens a tunnel through the Beaver Ops DB gateway.

```
beaver login                 # sign in through the browser (device code)
beaver db list               # databases you can open
beaver db connect shop_db    # tunnel through the DB gateway; prints Host / Port / User
beaver db connect shop_db saas   # several at once (one SSH connection per gateway)
beaver db shell saas         # SQL shell (ClickHouse built in; Postgres opens psql)
beaver db query saas "SELECT count() FROM events" --format csv
beaver db info shop_db       # connection details for DBeaver / TablePlus / your app
beaver db password shop_db   # reset your password on that server (shown once; --remember to keep it here)
beaver doctor                # what's wrong, and what to do
beaver update                # newest release (brew upgrade, or the binary replaces itself)
```

## Install

```
brew install beaver-ops/tap/beaver                       # macOS / Linux (Homebrew)
npm install -g @beaver-ops/cli                           # anywhere with Node >= 20
curl -fsSL https://github.com/beaver-ops/beaver-cli/releases/latest/download/install.sh | sh   # macOS / Linux
```

Or download an archive from [Releases](https://github.com/beaver-ops/beaver-cli/releases) (Windows:
`beaver-windows-x64.zip`) and check it against `checksums.txt`. `beaver update` updates whichever you used.

`<db>` is a database name, or `project/env/db` when the name is on several servers.

## How it works

- `login`: `POST /api/cli/device` → you approve the code on `/app/cli` → `POST /api/cli/token` gives a `bcli_` token
  (90 days after its last use). Kept in the macOS Keychain, the Secret Service (`secret-tool`) on Linux, the Windows
  Credential Manager, else `~/.config/beaver/credentials` (0600). `BEAVER_TOKEN` overrides it (CI).
- This machine's SSH key: `~/.config/beaver/id_ed25519` (0600), registered on your account as a CLI key
  (`source: cli`). `logout` (or revoking the session in Account › CLI sessions) removes it.
- The tunnel uses `ssh2` in-process (no system `ssh`). The gateway's host key is pinned: the keys
  `/api/me/db-access` returns (`gateway.hostKeys`), plus `PINNED_GATEWAY_HOST_KEYS` in `src/tunnel.ts`; with neither,
  the first key seen is remembered in `known_gateways.json` and any other is refused.
- Local ports: 15432 (Postgres), 18123 / 19000 (ClickHouse HTTP / native); a busy one moves to the next free port
  (`--port` / `--native-port` to choose; exact then).
- `db connect` keeps the local ports when the connection drops (sleep, network change, gateway restart): it
  reconnects with backoff (1, 2, 5, 10, then every 30 s), connections made meanwhile wait, and a clock jump
  after sleep drops the stale connection at once. A refused key while reconnecting is checked against
  `/api/me/db-access`: access gone → stop and say so; key deleted on the web → registered again; still listed →
  the gateway probably can't reach Beaver Ops, keep trying (up to 5 minutes).
- `db query` / `db shell`: a tunnel on free ports, then ClickHouse over HTTP (`X-ClickHouse-User/Key`,
  `JSONCompact`; a `FORMAT …` in the SQL prints the server's own output), Postgres with the bundled `pg` driver
  (`db query`) or the installed `psql` (`db shell`). Output: a table in a terminal, TSV when piped, `--format
  csv|tsv|json|table`. ClickHouse shell history: `history_clickhouse` in the config folder (0600).
- Database passwords: Beaver Ops doesn't keep them. `BEAVER_DB_PASSWORD`, else one saved on this machine with
  `--remember` (same stores as the token, per server login), else asked (hidden). A saved one that is refused is
  removed. `db password` calls the same reset as Account › Database access.
- `update`: the latest release of `beaver-ops/beaver-cli` (tags `v<version>`). Homebrew → `brew upgrade`; a
  single binary downloads its platform's archive, checks it against `checksums.txt` and replaces itself; under
  Node it says to run `npm install -g @beaver-ops/cli@latest`.

## Environment

| Variable | |
|---|---|
| `BEAVER_API_URL` | Beaver Ops to talk to (default `https://app.beaverops.ai`; http only for localhost) |
| `BEAVER_CONFIG_DIR` | Instead of `~/.config/beaver` (`$XDG_CONFIG_HOME/beaver`, `%APPDATA%\beaver`) |
| `BEAVER_TOKEN` | A `bcli_` token to use instead of the stored one |
| `BEAVER_NO_KEYCHAIN=1` | Keep secrets in the 0600 file only |
| `BEAVER_DB_PASSWORD` | The database password for `db query` / `db shell` (CI, scripts) |
| `NO_COLOR` | No colors |
| `BEAVER_DEBUG=1` | Stack traces for unexpected errors |

## Develop

```
npm ci
npm test            # unit + end to end (stand-in Beaver Ops API and DB gateway: tests/fakes.ts, tests/gateway.ts)
npm run typecheck
npm run build       # dist/beaver.mjs (node >= 20): what npm ships
npm run build:binary   # build/bin/beaver-<os>-<arch>[.exe] + build/release/*.tar.gz|zip (needs bun 1.4.4+)
BEAVER_BINARY=$PWD/build/bin/beaver-darwin-arm64 npx vitest run tests/e2e.test.ts -t "compiled binary"
BEAVER_API_URL=http://localhost:3000 npx tsx src/main.ts login
```

The end-to-end tests run the CLI against an in-memory Beaver Ops API and a small SSH gateway with the same
protocol as the real one (public keys checked with Beaver Ops, `direct-tcpip` only, access re-checked while
a tunnel is open). The real gateway's own rules are tested where it lives.

## Release

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a unit test checks they match); merge.
2. Tag the merge commit `v<version>` and push the tag (`git tag v1.2.3 && git push origin v1.2.3`).
   `.github/workflows/release.yml` tests, builds the binaries (macOS arm64 / x64, Linux x64 / arm64,
   Windows x64), checks each native one end to end, creates the GitHub Release (archives, `install.sh`,
   `checksums.txt`) and publishes `@beaver-ops/cli` to npm with provenance.
3. [beaver-ops/homebrew-tap](https://github.com/beaver-ops/homebrew-tap) picks the release up within 30
   minutes (or run its "Update formula" workflow by hand).
4. Raise the minimum CLI version on the Beaver Ops server (`CLI_MIN_VERSION`) only once the release is out:
   older CLIs are then told to `beaver update`.

npm publishing uses the `NPM_TOKEN` secret until npm Trusted Publishing is configured for `@beaver-ops/cli`
(repository `beaver-ops/beaver-cli`, workflow `release.yml`); then the secret can be deleted. macOS binaries
are not notarized yet: Homebrew installs are fine, a downloaded binary may need
`xattr -d com.apple.quarantine beaver`.

## License

MIT
