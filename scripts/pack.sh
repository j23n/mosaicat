#!/usr/bin/env bash
# Compile atmo into a single binary via `bun build --compile`.
#
# Templates must be embedded with `--asset` under the path `render.ts` expects
# (`dirname(import.meta.url)/templates`). Compiling with cwd=`src/` and
# `--asset ./templates` puts them at `/$bunfs/root/templates`.
#
# Requires Bun with `--asset` support (canary ≥ 1.4 until that lands in stable;
# see ADR 004).
#
# Stages sources under $TMPDIR before compiling: Bun writes a sibling
# `.bun-build` next to the entry and renames it onto --outfile; that rename
# fails across virtiofs / cross-device mounts (Dev Containers).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

outfile="dist-bin/atmo"
target=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --outfile)
      outfile="$2"
      shift 2
      ;;
    --target)
      target="$2"
      shift 2
      ;;
    -h | --help)
      cat <<'EOF'
Usage: scripts/pack.sh [--target bun-<os>-<arch>] [--outfile path]

Compile src/cli.ts into a standalone atmo binary with bundled templates.
EOF
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v bun >/dev/null 2>&1; then
  echo "pack: bun is required (install from https://bun.sh)" >&2
  exit 1
fi

if ! bun build --help 2>&1 | grep -q -- '--asset='; then
  echo "pack: this bun lacks --asset (need canary ≥ 1.4 / a release that embeds directories)" >&2
  bun --version >&2
  exit 1
fi

# decrypt.js is generated; templates/ must be complete before --asset walks it.
npm run bundle

mkdir -p "$(dirname "$outfile")"
outfile_abs="$(cd "$(dirname "$outfile")" && pwd)/$(basename "$outfile")"

stage="$(mktemp -d "${TMPDIR:-/tmp}/atmo-pack.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

mkdir -p "$stage/src"
# Prefer cp -a; fall back if needed.
cp -a "$root/src/." "$stage/src/"
cp "$root/package.json" "$stage/package.json"
ln -s "$root/node_modules" "$stage/node_modules"

stage_out="$stage/$(basename "$outfile_abs")"
compile_args=(build ./cli.ts --compile --asset ./templates --outfile "$stage_out")
if [[ -n "$target" ]]; then
  compile_args+=(--target "$target")
fi

(
  cd "$stage/src"
  bun "${compile_args[@]}"
)

cp "$stage_out" "$outfile_abs"
chmod +x "$outfile_abs" 2>/dev/null || true

ls -lh "$outfile_abs"
echo "packed $outfile_abs"
