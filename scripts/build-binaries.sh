#!/usr/bin/env bash
# Single binaries of the CLI with `bun build --compile` (Bun's runtime + the bundled CLI in one file,
# nothing to install), and the release archives of them.
# Usage: scripts/build-binaries.sh [target…]
# Targets: darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 (default: all of them).
# Output:
#   build/bin/beaver-<target>[.exe]             the binary
#   build/release/beaver-<target>.tar.gz         holding `beaver` (macOS, Linux)
#   build/release/beaver-windows-x64.zip         holding `beaver.exe`
# These archive names are what `beaver update`, install.sh and the Homebrew formula download.
set -euo pipefail
cd "$(dirname "$0")/.."
targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
mkdir -p build/bin build/release
for t in "${targets[@]}"; do
  case "$t" in
    darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | windows-x64) ;;
    *) echo "unknown target: $t" >&2; exit 1 ;;
  esac
  exe=""
  [[ $t == windows-* ]] && exe=.exe
  out="build/bin/beaver-$t$exe"
  bun build src/main.ts --compile --minify --target="bun-$t" --outfile "$out"
  stage=$(mktemp -d)
  cp "$out" "$stage/beaver$exe"
  chmod 755 "$stage/beaver$exe"
  if [ -n "$exe" ]; then
    rm -f "build/release/beaver-$t.zip"
    (cd "$stage" && zip -q -X "$OLDPWD/build/release/beaver-$t.zip" "beaver$exe")
  else
    tar -czf "build/release/beaver-$t.tar.gz" -C "$stage" beaver
  fi
  rm -rf "$stage"
done
ls -l build/release
