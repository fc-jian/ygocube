#!/usr/bin/env bash
# Fetch external tools not available via conda: premake5 (source build, CI-pinned commit)
# and the lua 5.4.8 source tarball (ocgcore requires lua compiled as C++).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p envs/tools

PREMAKE_VER="5.0.0-beta8"
PREMAKE_COMMIT="2ca338a25ed5f6e62d36c9cd70e5f313953c630d"

if [ ! -x envs/tools/premake5 ]; then
  echo "== Building premake $PREMAKE_VER from source (GLIBC-compatible) =="
  TMPD=$(mktemp -d)
  git clone -q https://github.com/premake/premake-core "$TMPD/premake-src"
  git -C "$TMPD/premake-src" checkout -q "$PREMAKE_COMMIT"
  mkdir -p "$TMPD/premake-inc"
  ln -sf "$(pwd)/envs/ygocube/include/uuid" "$TMPD/premake-inc/uuid"
  # Bootstrap.mak uses $(CC) for compile+link; point it at conda uuid only (full conda
  # include dir would shadow vendored curl headers with conda's, breaking the build).
  make -C "$TMPD/premake-src" -f Bootstrap.mak linux \
    CC="gcc -I$TMPD/premake-inc -L$(pwd)/envs/ygocube/lib"
  cp "$TMPD/premake-src/bin/release/premake5" envs/tools/premake5
  rm -rf "$TMPD"
fi
envs/tools/premake5 --version

if [ ! -f /tmp/lua-5.4.8.tar.gz ] && [ ! -d ygopro/lua ]; then
  echo "== Downloading lua 5.4.8 =="
  curl -sL -o /tmp/lua-5.4.8.tar.gz https://www.lua.org/ftp/lua-5.4.8.tar.gz
fi
if [ ! -d ygopro/lua ]; then
  tar xf /tmp/lua-5.4.8.tar.gz -C ygopro
  mv ygopro/lua-5.4.8 ygopro/lua
fi
echo "== Tools ready =="
