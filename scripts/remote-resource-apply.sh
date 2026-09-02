#!/usr/bin/env bash
# This file is uploaded to Aly for one release only.  It intentionally accepts
# no credentials and performs all mutations beneath the supplied installation
# root while the service lock is held.
set -euo pipefail

ROOT=""
RELEASE_ID=""
while (($#)); do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --id) RELEASE_ID="$2"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$ROOT" == /* && "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'invalid root or release id' >&2; exit 2; }

STAGE="$ROOT/.staging/card-sync-$RELEASE_ID"
BACKUP="$ROOT/backups/card-sync-$RELEASE_ID"
OLD_HOST="$ROOT/shared/srvpro/ygopro"
OLD_AVIF="$ROOT/shared/assets/pics_avif"
DB="$ROOT/shared/data/cube.sqlite"
mkdir -p "$BACKUP"
exec 9>"$ROOT/.card-resource.lock"
flock -n 9
[[ -d "$OLD_HOST" && -d "$OLD_AVIF" && -f "$DB" && -f "$STAGE/payload.tar.gz" ]]

# Checkpoint before copying so the backup is a consistent SQLite image.  Keep
# the sidecar files too: they are useful for forensic recovery if a process
# writes between the checkpoint and service stop.
sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;' > "$BACKUP/db-integrity.txt"
grep -Fxq ok "$BACKUP/db-integrity.txt"
cp -f "$DB" "$BACKUP/cube.sqlite"
for sidecar in "$DB-wal" "$DB-shm"; do
  [[ -e "$sidecar" ]] && cp -f "$sidecar" "$BACKUP/$(basename "$sidecar")" || true
done
rm -rf "$BACKUP/srvpro-ygopro" "$BACKUP/pics_avif"
cp -a "$OLD_HOST" "$BACKUP/srvpro-ygopro"
cp -a "$OLD_AVIF" "$BACKUP/pics_avif"
cp -a "$ROOT/current/config.yaml" "$BACKUP/config.yaml"
[[ -f "$ROOT/shared/assets/resource-manifest.json" ]] && cp -f "$ROOT/shared/assets/resource-manifest.json" "$BACKUP/resource-manifest.json" || true

systemctl stop ygocube-srvpro ygocube-web ygocube-api nginx
rm -rf "$STAGE/root"
mkdir -p "$STAGE/root/srvpro/ygopro" "$STAGE/root/assets/pics_avif"
cp -a "$OLD_HOST"/. "$STAGE/root/srvpro/ygopro"/
cp -a "$OLD_AVIF"/. "$STAGE/root/assets/pics_avif"/
tar -xzf "$STAGE/payload.tar.gz" -C "$STAGE/root" --no-same-owner

safe_delete() {
  local base="$1" list="$2" rel
  [[ -f "$list" ]] || return 0
  while IFS= read -r rel || [[ -n "$rel" ]]; do
    [[ -z "$rel" ]] && continue
    case "$rel" in
      /*|*'..'*|*'\\'*) echo "unsafe delete path: $rel" >&2; return 1 ;;
    esac
    rm -f "$base/$rel"
  done < "$list"
}
safe_delete "$STAGE/root/srvpro/ygopro/script" "$STAGE/root/deletes/scripts.txt"
safe_delete "$STAGE/root/assets/pics_avif" "$STAGE/root/deletes/avif.txt"

(cd "$STAGE/root" && sha256sum -c metadata/SHA256SUMS)
[[ -s "$STAGE/root/srvpro/ygopro/cards.cdb" ]]
[[ -f "$STAGE/root/metadata/resource-manifest.json" ]]

# The old directories remain available as .pre-$RELEASE_ID until a later
# cleanup.  Moving complete directories on one filesystem makes the switch
# atomic from running processes' point of view.
mv "$OLD_HOST" "$ROOT/shared/srvpro/ygopro.pre-$RELEASE_ID"
mv "$OLD_AVIF" "$ROOT/shared/assets/pics_avif.pre-$RELEASE_ID"
mv "$STAGE/root/srvpro/ygopro" "$OLD_HOST"
mv "$STAGE/root/assets/pics_avif" "$OLD_AVIF"
cp -f "$STAGE/root/metadata/resource-manifest.json" "$ROOT/shared/assets/resource-manifest.json"
chown -R ygocube:ygocube "$OLD_HOST" "$OLD_AVIF" "$ROOT/shared/assets/resource-manifest.json"

systemctl start ygocube-api
systemctl start ygocube-srvpro
systemctl start ygocube-web
systemctl start nginx
systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx
printf '%s\n' "$RELEASE_ID" > "$BACKUP/COMPLETED"
