#!/usr/bin/env bash
# Permanent workaround for @discordjs/opus + Bun ABI mismatch.
#
# Bun's embedded Node reports a fixed ABI ("node-v137" as of Bun 1.3.x on
# darwin-arm64), but @discordjs/opus ships prebuilts for the active Node
# release line ("node-v141" etc.). N-API v3 is ABI-stable across Node major
# versions, so the same .node binary works — we just need to point Bun at it.
#
# Strategy: find any node-vNNN-napi-v3-<platform> prebuild and symlink the
# Bun-expected ABI name to it. Safe to re-run (idempotent).
#
# Triggered automatically by `bun install` via the postinstall hook in
# package.json. Run manually if needed: `bash scripts/fix-opus-abi.sh`
set -euo pipefail

# This workaround only applies to macOS. On Linux (e.g. Docker / Railway) it is
# a no-op: the Docker image skips native @discordjs/opus and uses opusscript.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "[fix-opus-abi] not macOS — skip"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREBUILD_DIR="$SCRIPT_DIR/../node_modules/@discordjs/opus/prebuild"

# Bun's current ABI on darwin-arm64. Bump if a future Bun version changes.
BUN_ABI="${BUN_OPUS_ABI:-node-v137-napi-v3-darwin-arm64-unknown-unknown}"

if [ ! -d "$PREBUILD_DIR" ]; then
  echo "[fix-opus-abi] prebuild dir missing ($PREBUILD_DIR) — skip"
  exit 0
fi

cd "$PREBUILD_DIR"

# If a real (non-symlink) dir with the target name exists, leave it alone.
if [ -e "$BUN_ABI" ] && [ ! -L "$BUN_ABI" ]; then
  echo "[fix-opus-abi] $BUN_ABI exists (not symlink) — assume good, skip"
  exit 0
fi

# Match the platform suffix; replace if cross-compiling for another arch.
PLATFORM_SUFFIX="darwin-arm64-unknown-unknown"

# Pick the most-recent vNNN prebuild that exists.
for d in $(ls -d node-v[0-9]*-napi-v3-${PLATFORM_SUFFIX} 2>/dev/null | sort -r); do
  if [ "$d" = "$BUN_ABI" ]; then
    continue
  fi
  ln -sfn "$d" "$BUN_ABI"
  echo "[fix-opus-abi] symlinked $BUN_ABI → $d"
  exit 0
done

echo "[fix-opus-abi] no compatible prebuild found in $PREBUILD_DIR" >&2
exit 1
