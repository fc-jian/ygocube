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
OLD_NAMES="$ROOT/shared/assets/ygocdb_cards.json"
DB="$ROOT/shared/data/cube.sqlite"
mkdir -p "$BACKUP"
exec 9>"$ROOT/.card-resource.lock"
flock -n 9
[[ -d "$OLD_HOST" && -d "$OLD_AVIF" && -f "$DB" && -f "$STAGE/payload.tar.gz" ]]
systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx > "$BACKUP/services-before.txt" 2>&1 || true

# Enter maintenance before touching the database. This prevents a write from
# racing the backup and makes the checkpoint/integrity result reproducible.
SERVICES_STOPPED=1
HOST_REPLACED=0
AVIF_REPLACED=0
HOST_PRE_MOVED=0
AVIF_PRE_MOVED=0
NAMES_REPLACED=0
MANIFEST_REPLACED=0
rollback_resource_moves() {
  # The backup is complete before any live directory is moved.  If an
  # unexpected filesystem error occurs during the two-directory switch,
  # restore the old paths before bringing services back up.  Keep the failed
  # stage and backup for forensic inspection; never touch the database here.
  if [[ "${HOST_REPLACED:-0}" == 1 ]]; then
    rm -rf "$OLD_HOST"
    if [[ -d "$OLD_HOST.pre-$RELEASE_ID" ]]; then
      mv "$OLD_HOST.pre-$RELEASE_ID" "$OLD_HOST" || true
    elif [[ -d "$BACKUP/srvpro-ygopro" ]]; then
      cp -a "$BACKUP/srvpro-ygopro" "$OLD_HOST" || true
    fi
  elif [[ "${HOST_PRE_MOVED:-0}" == 1 && ! -e "$OLD_HOST" && -d "$OLD_HOST.pre-$RELEASE_ID" ]]; then
    mv "$OLD_HOST.pre-$RELEASE_ID" "$OLD_HOST" || true
  fi
  if [[ "${AVIF_REPLACED:-0}" == 1 ]]; then
    rm -rf "$OLD_AVIF"
    if [[ -d "$OLD_AVIF.pre-$RELEASE_ID" ]]; then
      mv "$OLD_AVIF.pre-$RELEASE_ID" "$OLD_AVIF" || true
    elif [[ -d "$BACKUP/pics_avif" ]]; then
      cp -a "$BACKUP/pics_avif" "$OLD_AVIF" || true
    fi
  elif [[ "${AVIF_PRE_MOVED:-0}" == 1 && ! -e "$OLD_AVIF" && -d "$OLD_AVIF.pre-$RELEASE_ID" ]]; then
    mv "$OLD_AVIF.pre-$RELEASE_ID" "$OLD_AVIF" || true
  fi
  if [[ "${NAMES_REPLACED:-0}" == 1 ]]; then
    if [[ -f "$BACKUP/ygocdb_cards.json" ]]; then
      cp -f "$BACKUP/ygocdb_cards.json" "$OLD_NAMES"
    else
      rm -f "$OLD_NAMES"
    fi
  fi
  if [[ "${MANIFEST_REPLACED:-0}" == 1 ]]; then
    if [[ -f "$BACKUP/resource-manifest.json" ]]; then
      cp -f "$BACKUP/resource-manifest.json" "$ROOT/shared/assets/resource-manifest.json"
    else
      rm -f "$ROOT/shared/assets/resource-manifest.json"
    fi
  fi
}
recover_services() {
  local status=$?
  if [[ "$status" != 0 ]]; then
    rollback_resource_moves || true
  fi
  if [[ "${SERVICES_STOPPED:-0}" == 1 ]]; then
    systemctl start ygocube-api ygocube-srvpro ygocube-web nginx >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap recover_services EXIT
systemctl stop ygocube-srvpro ygocube-web ygocube-api nginx

# Checkpoint before copying so the backup is a consistent SQLite image. Keep
# the sidecar files too: they are useful for forensic recovery diagnostics.
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
[[ -f "$OLD_NAMES" ]] && cp -f "$OLD_NAMES" "$BACKUP/ygocdb_cards.json" || true
[[ -f "$ROOT/shared/assets/resource-manifest.json" ]] && cp -f "$ROOT/shared/assets/resource-manifest.json" "$BACKUP/resource-manifest.json" || true

rm -rf "$STAGE/root"
mkdir -p "$STAGE/root/srvpro/ygopro" "$STAGE/root/assets/pics_avif"
cp -a "$OLD_HOST"/. "$STAGE/root/srvpro/ygopro"/
cp -a "$OLD_AVIF"/. "$STAGE/root/assets/pics_avif"/
[[ -f "$OLD_NAMES" ]] && cp -f "$OLD_NAMES" "$STAGE/root/assets/ygocdb_cards.json" || true
# Validate the uploaded tar before extraction.  The staging directory is
# root-owned, but treating the archive as untrusted protects against a
# replaced upload and prevents traversal, symlink and device-file writes.
python3 - "$STAGE/payload.tar.gz" <<'PY'
import posixpath
import sys
import tarfile

archive_path = sys.argv[1]
total = 0
with tarfile.open(archive_path, "r:gz") as archive:
    for member in archive.getmembers():
        name = member.name
        if not name or name.startswith("/") or "\\" in name:
            raise SystemExit(f"unsafe payload path: {name!r}")
        normalized = posixpath.normpath(name)
        if normalized == ".." or normalized.startswith("../") or "/../" in name:
            raise SystemExit(f"unsafe payload path: {name!r}")
        if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
            raise SystemExit(f"unsupported payload entry: {name!r}")
        total += max(0, int(member.size))
        if total > 4_000_000_000:
            raise SystemExit("payload is too large")
PY
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
HOST_PRE_MOVED=1
mv "$OLD_AVIF" "$ROOT/shared/assets/pics_avif.pre-$RELEASE_ID"
AVIF_PRE_MOVED=1
mv "$STAGE/root/srvpro/ygopro" "$OLD_HOST"
HOST_REPLACED=1
mv "$STAGE/root/assets/pics_avif" "$OLD_AVIF"
AVIF_REPLACED=1
if [[ -f "$STAGE/root/assets/ygocdb_cards.json" ]]; then
  cp -f "$STAGE/root/assets/ygocdb_cards.json" "$ROOT/shared/assets/.ygocdb_cards.json.new"
  mv -f "$ROOT/shared/assets/.ygocdb_cards.json.new" "$OLD_NAMES"
  NAMES_REPLACED=1
fi
cp -f "$STAGE/root/metadata/resource-manifest.json" "$ROOT/shared/assets/resource-manifest.json"
MANIFEST_REPLACED=1
# cards are an in-process SQLite index of cards.cdb plus the localized name
# map.  Resource publication must invalidate it before API restart; otherwise
# an older API process can see metadata_version=5 and incorrectly keep the
# pre-update rows.  The database itself is backed up above, so this small
# cache-only mutation is recoverable without restoring tournament state.
sqlite3 "$DB" 'UPDATE cards SET metadata_version=0;' > "$BACKUP/card-cache-invalidated.txt"
chown -R ygocube:ygocube "$OLD_HOST" "$OLD_AVIF" "$ROOT/shared/assets/resource-manifest.json"

systemctl start ygocube-api
systemctl start ygocube-srvpro
systemctl start ygocube-web
systemctl start nginx
systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx
SERVICES_STOPPED=0
trap - EXIT
printf '%s\n' "$RELEASE_ID" > "$BACKUP/COMPLETED"
