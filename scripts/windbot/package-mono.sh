#!/usr/bin/env bash
set -euo pipefail
src=$1
out=$2
mkdir -p "$out/runtime/bin" "$out/runtime/lib/mono" "$out/runtime/etc"
cp /usr/bin/mono-sgen "$out/runtime/bin/mono"
cp -a /usr/lib/mono/4.5 /usr/lib/mono/gac "$out/runtime/lib/mono/"
cp -a /etc/mono "$out/runtime/etc/"
cp -L /usr/lib/libMonoPosixHelper.so /usr/lib/libmono-native.so "$out/runtime/lib/"
cp -a "$src/bin/Release/." "$out/"
cp "$src/LICENSE" "$out/LICENSE.windbot"
cp /usr/share/doc/mono-runtime/copyright "$out/LICENSE.mono"
cat > "$out/run-windbot" <<'EOF'
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export MONO_CFG_DIR="$root/runtime/etc"
export MONO_PATH="$root/runtime/lib/mono/4.5"
export LD_LIBRARY_PATH="$root/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$root/runtime/bin/mono" --config "$root/runtime/etc/mono/config" "$root/WindBot.exe" "$@"
EOF
chmod +x "$out/run-windbot"
