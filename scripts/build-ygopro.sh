#!/usr/bin/env bash
# Build the ygopro server binary (cube-server branch) against the conda env at ./envs/ygocube.
# Usage: scripts/build-ygopro.sh [--skip-copy] [--client] [--no-audio] [--build-<dep>]
#                                [--max-deck=N] [--min-deck=N] [--max-extra=N] [--max-side=N]
# Default (no --client) builds the headless server host used by srvpro.
# --client builds the GUI client (target YGOPro); it requires the GUI dependency sources
# (irrlicht/freetype/png/jpeg, see .github/workflows/build.yml) and conda packages
# nasm/xorg-libx11/libgl-devel in envs/ygocube.
set -euo pipefail
cd "$(dirname "$0")/.."

CONDA_PREFIX="${CONDA_PREFIX:-$(pwd)/envs/ygocube}"
PREMAKE="$(pwd)/envs/tools/premake5"
[ -x "$PREMAKE" ] || { echo "premake5 missing: run scripts/fetch-tools.sh first"; exit 1; }
[ -d "$CONDA_PREFIX/lib" ] || { echo "conda env missing: run scripts/setup-env.sh first"; exit 1; }

SKIP_COPY=0
CLIENT=0
EXTRA_OPTS=()
for arg in "$@"; do
  case "$arg" in
    --skip-copy) SKIP_COPY=1 ;;
    --client) CLIENT=1 ;;
    --no-audio|--build-*) EXTRA_OPTS+=("$arg") ;;
    --max-deck=*|--min-deck=*|--max-extra=*|--max-side=*) EXTRA_OPTS+=("$arg") ;;
    *) echo "unknown option: $arg"; exit 1 ;;
  esac
done

cd ygopro
[ -d lua ] || { echo "lua source missing in ygopro/lua (fetch-tools.sh)"; exit 1; }

if [ "$SKIP_COPY" != 1 ]; then
  cp -r premake/* .
fi

PREMAKE_ARGS=(
  gmake2
  --sqlite-include-dir="$CONDA_PREFIX/include" --sqlite-lib-dir="$CONDA_PREFIX/lib" --sqlite-lib-name=sqlite3
  --event-include-dir="$CONDA_PREFIX/include" --event-lib-dir="$CONDA_PREFIX/lib" --event-lib-name=event
  --lzma-include-dir="$CONDA_PREFIX/include" --lzma-lib-dir="$CONDA_PREFIX/lib" --lzma-lib-name=lzma
  --zlib-include-dir="$CONDA_PREFIX/include" --zlib-lib-dir="$CONDA_PREFIX/lib" --zlib-lib-name=z
)
if [ "$CLIENT" = 1 ]; then
  PREMAKE_ARGS+=(--client)
fi
PREMAKE_ARGS+=("${EXTRA_OPTS[@]}")

"$PREMAKE" "${PREMAKE_ARGS[@]}"

cd build
if [ "$CLIENT" = 1 ]; then
  # GL/X11 are linked by plain name and nasm is used for libjpeg-turbo SIMD;
  # all come from the conda env.
  export PATH="$CONDA_PREFIX/bin:$PATH"
  export C_INCLUDE_PATH="$CONDA_PREFIX/include"
  export CPLUS_INCLUDE_PATH="$CONDA_PREFIX/include"
  export LIBRARY_PATH="$CONDA_PREFIX/lib"
fi
make -j"$(nproc)" config=release
cd ..
ls -la bin/release/
