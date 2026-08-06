#!/usr/bin/env bash
# srvpro cube integration E2E test (dev_docs/08 M2 DoD).
# Prereqs: srvpro running with modules.cube enabled (config/config.json), webhook catcher
# optional. Generates a card pool from the deployed cards.cdb, then drives the cube API
# and the game protocol end-to-end. Exit 0 = all checks passed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

SRVPRO_HOST="${SRVPRO_HOST:-127.0.0.1}"
SRVPRO_PORT="${SRVPRO_PORT:-7911}"
HTTP_PORT="${HTTP_PORT:-7922}"
API_KEY="${API_KEY:-cube-test-key}"
CDB="${CDB:-srvpro/ygopro/cards.cdb}"

python3 - "$CDB" > /tmp/cube-cardcodes.json <<'EOF'
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
cur = conn.cursor()
mask = 0x4802040  # TYPES_EXTRA_DECK in this codebase (FUSION|SYNCHRO|XYZ|LINK)
main = [r[0] for r in cur.execute("SELECT id FROM datas WHERE (type & %d)=0 AND (type & 0x4000)=0 LIMIT 60" % mask)]
extra = [r[0] for r in cur.execute("SELECT id FROM datas WHERE (type & %d)!=0 LIMIT 12" % mask)]
json.dump({"main": main, "extra": extra}, open('/tmp/cube-cardcodes.json', 'w'))
EOF

CARDCODES=/tmp/cube-cardcodes.json node "$SCRIPT_DIR/cube-e2e.js" "$SRVPRO_HOST" "$SRVPRO_PORT" "$HTTP_PORT" "$API_KEY"
