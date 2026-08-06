#!/usr/bin/env bash
# Full tournament simulation (8 players, kuro750 pool, BO3, random everything).
# Prereqs: cube api on :3001 and srvpro on :7911/:7922 running with modules.cube
# enabled and webhook_url pointing at the api (see config.yaml / srvpro/config/config.json).
# Artifacts land in ./test_tournaments/<tid>/ (deck ydks, events.log, matches.json, result.md).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

curl -sf http://127.0.0.1:3001/health > /dev/null || { echo "cube api not reachable on :3001"; exit 1; }
curl -s -o /dev/null http://127.0.0.1:7922/ || { echo "srvpro http not reachable on :7922"; exit 1; }

exec node "$SCRIPT_DIR/cube-full-sim.js" "$@"
