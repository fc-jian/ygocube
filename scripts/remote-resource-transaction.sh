#!/usr/bin/env bash
# Hold one lock and keep Duel ingress closed across both resource switches.
set -euo pipefail
MODE="${1:-}"; shift || true
CUBE_ROOT=""; DUEL_ROOT=""; RELEASE_ID=""
while (($#)); do
  case "$1" in
    --cube-root) CUBE_ROOT="$2"; shift 2 ;;
    --duel-root) DUEL_ROOT="$2"; shift 2 ;;
    --id) RELEASE_ID="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$MODE" == apply || "$MODE" == rollback ]]
for root in "$CUBE_ROOT" "$DUEL_ROOT"; do
  [[ "$root" =~ ^/[A-Za-z0-9._/+:-]+$ && "$root" != / ]] || { echo 'invalid root' >&2; exit 2; }
done
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'invalid release id' >&2; exit 2; }
HELPER="$(dirname "$(readlink -f "$0")")/apply-duel.py"
[[ -f "$HELPER" ]]
exec 8>"$CUBE_ROOT/.card-resource-deploy.lock"
flock -n 8
MAINTENANCE=0
recover_services() {
  local status=$?
  if [[ "$MAINTENANCE" == 1 ]]; then
    systemctl start ygocube-api ygocube-srvpro ygocube-web ygoduel-api ygoduel-srvpro ygoduel-web nginx >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap recover_services EXIT
if [[ "$MODE" == apply ]]; then
  STAGE="$CUBE_ROOT/.staging/card-sync-$RELEASE_ID"
  expected="$(cat "$STAGE/expected-server-manifest.sha256")"
  actual="$(sha256sum "$CUBE_ROOT/shared/assets/resource-manifest.json" | cut -d' ' -f1)"
  [[ "$expected" == "$actual" ]] || { echo 'server resources changed after packaging; refresh baseline and retry' >&2; exit 1; }
  python3 "$HELPER" --cube-root "$CUBE_ROOT" --duel-root "$DUEL_ROOT" --id "$RELEASE_ID" --enter-maintenance
  MAINTENANCE=1
  bash "$STAGE/apply.sh" --root "$CUBE_ROOT" --id "$RELEASE_ID"
  python3 "$HELPER" --cube-root "$CUBE_ROOT" --duel-root "$DUEL_ROOT" --id "$RELEASE_ID"
else
  BACKUP="$CUBE_ROOT/backups/card-sync-$RELEASE_ID"
  [[ -d "$BACKUP/srvpro-ygopro" && -d "$BACKUP/pics_avif" && -f "$BACKUP/resource-manifest.json" ]]
  previous=""
  if [[ -f "$BACKUP/previous-release.txt" ]]; then
    previous="$(readlink -f "$(cat "$BACKUP/previous-release.txt")")"
    [[ "$previous" == "$CUBE_ROOT/releases/"* && -d "$previous" ]]
  fi
  python3 "$HELPER" --cube-root "$CUBE_ROOT" --duel-root "$DUEL_ROOT" --id "$RELEASE_ID" --enter-maintenance
  MAINTENANCE=1
  python3 "$HELPER" --cube-root "$CUBE_ROOT" --duel-root "$DUEL_ROOT" --id "$RELEASE_ID" --rollback --defer-start
  systemctl stop ygocube-srvpro ygocube-web ygocube-api nginx
  rm -rf "$CUBE_ROOT/shared/srvpro/ygopro" "$CUBE_ROOT/shared/assets/pics_avif"
  cp -al "$BACKUP/srvpro-ygopro" "$CUBE_ROOT/shared/srvpro/ygopro"
  cp -al "$BACKUP/pics_avif" "$CUBE_ROOT/shared/assets/pics_avif"
  for name in ygocdb_cards.json resource-manifest.json; do
    [[ -f "$BACKUP/$name" ]]
    cp -f "$BACKUP/$name" "$CUBE_ROOT/shared/assets/.$name.rollback-new"
    mv -f "$CUBE_ROOT/shared/assets/.$name.rollback-new" "$CUBE_ROOT/shared/assets/$name"
  done
  if [[ -n "$previous" ]]; then
    ln -s "$previous" "$CUBE_ROOT/current-rollback-$RELEASE_ID"
    mv -Tf "$CUBE_ROOT/current-rollback-$RELEASE_ID" "$CUBE_ROOT/current"
  fi
  sqlite3 "$CUBE_ROOT/shared/data/cube.sqlite" 'UPDATE cards SET metadata_version=0;'
  chown -R ygocube:ygocube "$CUBE_ROOT/shared/srvpro/ygopro" "$CUBE_ROOT/shared/assets/pics_avif"
  chown ygocube:ygocube "$CUBE_ROOT/shared/assets/ygocdb_cards.json" "$CUBE_ROOT/shared/assets/resource-manifest.json"
  python3 "$HELPER" --cube-root "$CUBE_ROOT" --duel-root "$DUEL_ROOT" --id "$RELEASE_ID" --relink-current-to-cube --defer-start
  python3 "$HELPER" --cube-root "$CUBE_ROOT" --duel-root "$DUEL_ROOT" --id "$RELEASE_ID" --verify-current
  systemctl start ygocube-api ygocube-srvpro ygocube-web ygoduel-api ygoduel-srvpro nginx
fi
# Bind Web to current before older releases can be considered for cleanup.
systemctl restart ygoduel-web
systemctl is-active ygocube-api ygocube-srvpro ygocube-web ygoduel-api ygoduel-srvpro ygoduel-web nginx
MAINTENANCE=0
trap - EXIT
