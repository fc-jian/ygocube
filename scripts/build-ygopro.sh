#!/usr/bin/env bash
# Build the ygopro server binary (cube-server branch) against the conda env at ./envs/ygocube.
# Usage: scripts/build-ygopro.sh [--skip-copy]
set -euo pipefail
cd "$(dirname "$0")/.."

CONDA_PREFIX="${CONDA_PREFIX:-$(pwd)/envs/ygocube}"
PREMAKE="$(pwd)/envs/tools/premake5"
[ -x "$PREMAKE" ] || { echo "premake5 missing: run scripts/fetch-tools.sh first"; exit 1; }
[ -d "$CONDA_PREFIX/lib" ] || { echo "conda env missing: run scripts/setup-env.sh first"; exit 1; }

cd ygopro
[ -d lua ] || { echo "lua source missing in ygopro/lua (fetch-tools.sh)"; exit 1; }

if [ "${1:-}" != "--skip-copy" ]; then
  cp -r premake/* .
fi

"$PREMAKE" gmake \
  --sqlite-include-dir="$CONDA_PREFIX/include" --sqlite-lib-dir="$CONDA_PREFIX/lib" --sqlite-lib-name=sqlite3 \
  --event-include-dir="$CONDA_PREFIX/include" --event-lib-dir="$CONDA_PREFIX/lib" --event-lib-name=event \
  --lzma-include-dir="$CONDA_PREFIX/include" --lzma-lib-dir="$CONDA_PREFIX/lib" --lzma-lib-name=lzma \
  --zlib-include-dir="$CONDA_PREFIX/include" --zlib-lib-dir="$CONDA_PREFIX/lib" --zlib-lib-name=z

cd build
make -j"$(nproc)" config=release
cd ..
ls -la bin/release/
