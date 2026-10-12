#!/usr/bin/env bash
# Extract the root CA of this machine's local HTTPS-intercepting proxy.
#
# Needed only when Node refuses github.com with SELF_SIGNED_CERT_IN_CHAIN while
# curl works — i.e. a local MITM proxy whose root is not in Node's trust store.
# `npm run contributions` reads the file this script writes, and never ships it.
#
# If your machine has no intercepting proxy, skip this entirely: plain
# `node build/scan_contributions.mjs` will work.
#
#   ./build/setup-ca.sh            # defaults to github.com
#   HOST=api.github.com ./build/setup-ca.sh
set -euo pipefail

HOST="${HOST:-github.com}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
mkdir -p "$OUT_DIR"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

echo "reading the TLS chain for $HOST ..."
# The last certificate in the presented chain is the root.
echo | openssl s_client -connect "${HOST}:443" -servername "$HOST" -showcerts 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/{n++} n{print > ("'"$OUT_DIR"'/chain" (n-1) ".pem")}'

roots=("$OUT_DIR"/chain*.pem)
if [ ! -e "${roots[0]}" ]; then
  echo "no certificates captured — is $HOST reachable?" >&2
  exit 1
fi

# verify locally so a truncated capture fails here rather than at fetch time
for f in "$OUT_DIR"/chain*.pem; do
  echo "  $(basename "$f"): $(openssl x509 -in "$f" -noout -subject 2>/dev/null | sed 's/^subject=//')"
done

last="$(ls -1 "$OUT_DIR"/chain*.pem | sort -V | tail -1)"
echo "using root: $last"
echo
echo "run with:  NODE_EXTRA_CA_CERTS=$last node build/scan_contributions.mjs"
