#!/bin/sh
# Installs the Beaver CLI from its latest GitHub release (macOS / Linux):
#   curl -fsSL https://github.com/beaver-ops/beaver-cli/releases/latest/download/install.sh | sh
# The archive's checksum is checked against the release's checksums.txt.
#   BEAVER_INSTALL_DIR  where to put `beaver` (default /usr/local/bin when writable, else ~/.local/bin)
#   BEAVER_VERSION      a version (1.2.3) instead of the latest
# Windows: download beaver-windows-x64.zip from the releases page, or `npm install -g @beaver-ops/cli`.
set -eu
repo=beaver-ops/beaver-cli
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "beaver: no build for $(uname -s); see https://github.com/$repo/releases" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "beaver: no build for $(uname -m); see https://github.com/$repo/releases" >&2; exit 1 ;;
esac
asset="beaver-$os-$arch.tar.gz"
if [ -n "${BEAVER_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/v${BEAVER_VERSION#v}"
else
  base="https://github.com/$repo/releases/latest/download"
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset…"
curl -fsSL -o "$tmp/$asset" "$base/$asset"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}'); fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "beaver: the download doesn't match its checksum; not installed." >&2
  exit 1
fi
tar -xzf "$tmp/$asset" -C "$tmp" beaver
dir=${BEAVER_INSTALL_DIR:-}
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
chmod 755 "$tmp/beaver"
mv "$tmp/beaver" "$dir/beaver"
echo "Installed $("$dir/beaver" --version | head -n1) to $dir/beaver"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH to run beaver." ;; esac
echo "Next: beaver login"
