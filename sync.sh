#!/usr/bin/env bash
# Install the built plugin into the DSH profile(s) that load it.
#
# A DSH that runs on Windows cannot reliably `require` a package living inside
# WSL, so the built artifact is COPIED to a Windows-visible directory. This
# workspace stays the single source of truth.
#
# Configure for your machine (either edit the defaults or export them):
#
#   DSH_CANON_DIR   stable copy of the package
#   DSH_PROFILES    colon-separated DSH profile directories to install into
#
# Windows users (paths as seen from WSL) example:
#   DSH_CANON_DIR=/mnt/c/Users/me/dsh-plugins/dsh-tianyicui-monitor \
#   DSH_PROFILES=/mnt/c/Users/me/.dsh/profiles/desktop \
#     ./sync.sh
#
# Run `npm run build` first whenever lib/client.js changed.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults: a single profile under $HOME, no Windows hop.
DSH_CANON_DIR="${DSH_CANON_DIR:-$HOME/dsh-plugins/dsh-tianyicui-monitor}"
DSH_PROFILES="${DSH_PROFILES:-$HOME/.dsh/profiles/web}"

sync_into() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest/lib"
  cp -a "$SRC/lib/index.js" "$SRC/lib/client.js" "$dest/lib/"
  cp -a "$SRC/package.json" "$SRC/README.md" "$dest/"
  echo "  -> $dest"
}

echo "syncing $SRC"
sync_into "$DSH_CANON_DIR"
IFS=':' read -r -a profiles <<< "$DSH_PROFILES"
for p in "${profiles[@]}"; do
  [ -n "$p" ] || continue
  if [ -d "$p" ]; then
    sync_into "$p/node_modules/dsh-tianyicui-monitor"
  else
    echo "  (skipped, profile not found: $p)"
  fi
done
echo "done. restart DSH if the plugin was not already loaded."
