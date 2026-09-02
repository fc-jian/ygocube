#!/usr/bin/env bash
# Synchronise the YGOPro card database, scripts and image resources, and
# optionally publish the resulting runtime resources to Aly.
#
# The command is intentionally conservative: it never writes on `main` or
# `master`, never resolves a Git conflict automatically, never uploads source
# pictures, and requires an explicit confirmation before stopping services.
# See `--help` for the complete workflow.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HELPER="$ROOT_DIR/scripts/card_resources.py"
UPSTREAM_REPO="${YGOPRO_UPSTREAM_REPO:-https://github.com/mycard/ygopro.git}"
UPSTREAM_REF="${YGOPRO_UPSTREAM_REF:-server}"
UPSTREAM_COMMIT="${YGOPRO_UPSTREAM_COMMIT:-5e63f18fb6b9a6ddc651bc2e8847eec9689ccbff}"
SCRIPT_COMMIT="${YGOPRO_SCRIPT_COMMIT:-5864b6f6}"
OCGCORE_COMMIT="${YGOPRO_OCGCORE_COMMIT:-e04144d6}"
IMAGE_LOCALE="${YGOCUBE_IMAGE_LOCALE:-zh-CN}"
IMAGE_URL="${YGOCUBE_IMAGES_URL:-https://cdn02.moecube.com:444/images/ygopro-images-${IMAGE_LOCALE}.zip}"
ALY_HOST="${YGOCUBE_ALY_HOST:-aly}"
ALY_ROOT="${YGOCUBE_ALY_ROOT:-/opt/ygocube}"
ALY_PUBLIC_URL="${YGOCUBE_ALY_URL:-https://39.96.220.91}"
CACHE_ROOT="${YGOCUBE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ygocube/card-resources}"
STATE_DIR="$ROOT_DIR/.card-resource-sync"
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || printf unknown)"

COMMAND=""
DRY_RUN=0
COMMIT_MERGE=0
PUSH=0
CLIENT=0
SKIP_BUILD=0
SKIP_IMAGES=0
SKIP_E2E=0
ALLOW_MISSING_NAMES=0
REFRESH_NAMES=0
CONFIRM_MAINTENANCE=0
BACKUP_ID=""

usage() {
  sed -n '1,55p' "$0"
  cat <<'USAGE'

Usage:
  scripts/update-card-resources.sh [options] <check|sync|prepare|build|test|deploy|rollback>

Commands:
  check       Query upstream refs and print local/remote resource metadata.
  sync        Fetch server and prepare a no-ff merge in the ygopro submodule.
  prepare     Validate/copy cards.cdb and scripts, download images and build AVIF.
  build       Build the Linux host when the merge changes native code; --client is optional.
  test        Run resource tests, API/Web/srvpro builds and optional E2E probes.
  deploy      Back up Aly, enter maintenance mode, atomically publish a delta, and verify it.
  rollback    Restore an explicit --backup-id created by deploy.

Options:
  --dry-run                 Print actions without changing files or remote services.
  --locale <locale>         Image locale (default: zh-CN).
  --images-url <https-url>  Override the image archive URL.
  --aly-host <ssh-alias>    SSH alias (default: aly).
  --aly-root <path>         Aly installation root (default: /opt/ygocube).
  --client                  Build the Windows/Linux GUI client when supported.
  --skip-build              Do not run the native build from prepare/test.
  --skip-images             Validate/copy database and scripts without image work.
  --skip-e2e                Skip E2E probes in test.
  --refresh-names           Merge missing names from the YGOCDB cards.zip archive.
  --allow-missing-names     Allow missing non-token names (a report is retained).
  --commit                  With sync/--continue, create the submodule merge commit.
  --continue                Continue a previously interrupted/manual merge.
  --push                    Push feature branches (never force-push).
  --confirm-maintenance     Required by deploy before stopping Aly services.
  --backup-id <id>          Backup identifier for rollback.
  -h, --help                Show this help.

Environment variables may override defaults (YGOCUBE_CACHE_DIR, YGOCUBE_ALY_URL,
YGOCUBE_ALY_HOST, YGOCUBE_ALY_ROOT, YGOCUBE_IMAGES_URL and commit variables).
No token, password or private key is read or stored by this script.
USAGE
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }
info() { printf '[card-resources] %s\n' "$*"; }

run() {
  if ((DRY_RUN)); then
    printf '+ %q' "$1"; shift || true
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

require_command() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

parse_args() {
  while (($#)); do
    case "$1" in
      check|sync|prepare|build|test|deploy|rollback)
        [[ -z "$COMMAND" ]] || die "only one command may be specified"
        COMMAND="$1"; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --locale) [[ $# -ge 2 ]] || die "--locale needs a value"; IMAGE_LOCALE="$2"; shift 2; IMAGE_URL="https://cdn02.moecube.com:444/images/ygopro-images-${IMAGE_LOCALE}.zip" ;;
      --images-url) [[ $# -ge 2 ]] || die "--images-url needs a value"; IMAGE_URL="$2"; shift 2 ;;
      --aly-host) [[ $# -ge 2 ]] || die "--aly-host needs a value"; ALY_HOST="$2"; shift 2 ;;
      --aly-root) [[ $# -ge 2 ]] || die "--aly-root needs a value"; ALY_ROOT="$2"; shift 2 ;;
      --client) CLIENT=1; shift ;;
      --skip-build) SKIP_BUILD=1; shift ;;
      --skip-images) SKIP_IMAGES=1; shift ;;
      --skip-e2e) SKIP_E2E=1; shift ;;
      --refresh-names) REFRESH_NAMES=1; shift ;;
      --allow-missing-names) ALLOW_MISSING_NAMES=1; shift ;;
      --commit) COMMIT_MERGE=1; shift ;;
      --continue) CONTINUE_MERGE=1; shift ;;
      --push) PUSH=1; shift ;;
      --confirm-maintenance) CONFIRM_MAINTENANCE=1; shift ;;
      --backup-id) [[ $# -ge 2 ]] || die "--backup-id needs a value"; BACKUP_ID="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1 (use --help)" ;;
    esac
  done
  [[ -n "$COMMAND" ]] || { usage >&2; exit 2; }
}

CONTINUE_MERGE=0
parse_args "$@"

if [[ "$COMMAND" == "check" || "$COMMAND" == "test" ]]; then
  :
else
  branch="$(git -C "$ROOT_DIR" symbolic-ref --quiet --short HEAD || true)"
  [[ "$branch" == codex/card-resource-sync-* ]] || die "refusing to modify '$branch'; switch to codex/card-resource-sync-* first"
fi

state_init() {
  ((DRY_RUN)) && return 0
  mkdir -p "$STATE_DIR" "$CACHE_ROOT"
}

git_clean_check() {
  local where="$1"
  [[ -z "$(git -C "$where" status --porcelain)" ]] || die "$where has uncommitted changes; commit or stash them before sync"
}

submodule_branch_check() {
  local branch
  branch="$(git -C "$ROOT_DIR/ygopro" symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$branch" ]] || die "ygopro is detached; create a feature branch before sync"
  [[ "$branch" != main && "$branch" != master ]] || die "refusing to modify ygopro/$branch"
}

cmd_check() {
  require_command git
  require_command curl
  info "upstream: $UPSTREAM_REPO ref=$UPSTREAM_REF expected=$UPSTREAM_COMMIT"
  local head
  head="$(git ls-remote "$UPSTREAM_REPO" "refs/heads/$UPSTREAM_REF" | awk 'NR==1 {print $1}')"
  [[ -n "$head" ]] || die "unable to resolve upstream ref"
  printf 'upstream_head=%s\n' "$head"
  [[ "$head" == "$UPSTREAM_COMMIT" ]] || warn "configured commit differs from current upstream head"
  if git -C "$ROOT_DIR/ygopro" show "$UPSTREAM_COMMIT:cards.cdb" >/dev/null 2>&1; then
    printf 'upstream_cards_size=%s\n' "$(git -C "$ROOT_DIR/ygopro" cat-file -s "$UPSTREAM_COMMIT:cards.cdb")"
  else
    printf 'upstream_cards_size=fetch-required\n'
  fi
  printf 'local_cards='; python3 "$HELPER" validate-cdb "$ROOT_DIR/ygopro/cards.cdb" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["size"], "bytes,", d["codeCount"], "codes,", d["sha256"])'
  printf 'local_ygopro=%s\n' "$(git -C "$ROOT_DIR/ygopro" rev-parse HEAD)"
  printf 'local_script=%s\n' "$(git -C "$ROOT_DIR/ygopro/script" rev-parse HEAD)"
  printf 'local_ocgcore=%s\n' "$(git -C "$ROOT_DIR/ygopro/ocgcore" rev-parse HEAD)"
  local headers
  headers="$(curl --fail --silent --show-error --location --head --max-time 30 --proto '=https' --tlsv1.2 "$IMAGE_URL" || true)"
  if [[ -n "$headers" ]]; then
    printf 'image_url=%s\n' "$IMAGE_URL"
    printf '%s\n' "$headers" | awk 'BEGIN{IGNORECASE=1} /^etag:|^last-modified:|^content-length:|^content-type:/ {gsub("\r",""); print}'
  else
    warn "image archive HEAD request failed"
  fi
}

cmd_sync() {
  state_init
  git_clean_check "$ROOT_DIR"
  git_clean_check "$ROOT_DIR/ygopro"
  submodule_branch_check
  require_command git
  info "fetching upstream $UPSTREAM_REF"
  run git -C "$ROOT_DIR/ygopro" fetch --prune origin "$UPSTREAM_REF"
  if ((DRY_RUN)); then
    info "dry-run: would verify $UPSTREAM_COMMIT and merge with --no-ff --no-commit"
    return 0
  fi
  git -C "$ROOT_DIR/ygopro" cat-file -e "$UPSTREAM_COMMIT^{commit}" || die "upstream commit $UPSTREAM_COMMIT was not fetched"
  if git -C "$ROOT_DIR/ygopro" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    ((CONTINUE_MERGE)) || die "ygopro merge is already in progress; resolve conflicts and rerun with --continue"
    [[ -z "$(git -C "$ROOT_DIR/ygopro" diff --name-only --diff-filter=U)" ]] || die "unresolved ygopro conflicts remain: $(git -C "$ROOT_DIR/ygopro" diff --name-only --diff-filter=U | tr '\n' ' ')"
    ((COMMIT_MERGE)) || die "merge is resolved; pass --commit --continue to create the merge commit"
    git -C "$ROOT_DIR/ygopro" commit -m "merge: sync upstream YGOPro card resources"
  else
    set +e
    git -C "$ROOT_DIR/ygopro" merge --no-ff --no-commit "$UPSTREAM_COMMIT"
    local merge_status=$?
    set -e
    if ((merge_status != 0)); then
      printf 'manual conflict resolution required in ygopro:\n' >&2
      git -C "$ROOT_DIR/ygopro" diff --name-only --diff-filter=U >&2 || true
      exit 20
    fi
    if ((COMMIT_MERGE)); then
      git -C "$ROOT_DIR/ygopro" commit -m "merge: sync upstream YGOPro card resources"
    else
      die "merge prepared without commit; review it, then rerun --continue --commit (or abort manually)"
    fi
  fi
  local script_ref ocg_ref
  script_ref="$(git -C "$ROOT_DIR/ygopro" ls-tree HEAD script | awk '{print $3}')"
  ocg_ref="$(git -C "$ROOT_DIR/ygopro" ls-tree HEAD ocgcore | awk '{print $3}')"
  [[ "$script_ref" == "$SCRIPT_COMMIT"* ]] || die "script gitlink is $script_ref, expected $SCRIPT_COMMIT"
  [[ "$ocg_ref" == "$OCGCORE_COMMIT"* ]] || die "ocgcore gitlink is $ocg_ref, expected $OCGCORE_COMMIT"
  info "ygopro merge committed; root gitlink now points at $(git -C "$ROOT_DIR/ygopro" rev-parse --short HEAD)"
  if ((PUSH)); then
    local root_branch sub_branch
    root_branch="$(git -C "$ROOT_DIR" symbolic-ref --short HEAD)"
    sub_branch="$(git -C "$ROOT_DIR/ygopro" symbolic-ref --short HEAD)"
    run git -C "$ROOT_DIR/ygopro" push --set-upstream fc-jian "$sub_branch"
    info "root gitlink is not committed automatically; commit it before pushing $root_branch"
  fi
}

download_images() {
  local target="$CACHE_ROOT/ygopro-images-${IMAGE_LOCALE}.zip"
  local partial="$target.part"
  local headers="$target.headers"
  if [[ -s "$target" ]]; then
    local remote_etag local_etag
    remote_etag="$(curl --fail --silent --show-error --location --head --max-time 30 --proto '=https' --tlsv1.2 "$IMAGE_URL" | awk 'BEGIN{IGNORECASE=1} /^etag:/ {sub("^[^:]*:[[:space:]]*",""); gsub("\r",""); print; exit}')" || true
    local_etag="$(cat "$target.etag" 2>/dev/null || true)"
    if [[ -n "$remote_etag" && "$remote_etag" == "$local_etag" ]]; then
    info "image archive cache is current (ETag matched)" >&2
      printf '%s\n' "$target"
      return 0
    fi
  fi
  info "downloading image archive to cache (this can be large)" >&2
  curl --fail --show-error --location --proto '=https' --tlsv1.2 --max-time 3600 --retry 4 --retry-delay 3 --continue-at - -D "$headers" -o "$partial" "$IMAGE_URL"
  local content_type size
  content_type="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {sub("^[^:]*:[[:space:]]*",""); gsub("\r",""); print; exit}' "$headers")"
  size="$(stat -c %s "$partial")"
  [[ "$content_type" == *zip* || "$content_type" == *octet-stream* || "$content_type" == *binary* ]] || die "image response has unexpected content type: $content_type"
  ((size <= 4000000000)) || die "image archive exceeds configured size limit"
  mv -f "$partial" "$target"
  awk 'BEGIN{IGNORECASE=1} /^etag:/ {sub("^[^:]*:[[:space:]]*",""); gsub("\r",""); print; exit}' "$headers" > "$target.etag" || true
  sha256sum "$target" | awk '{print $1}' > "$target.sha256"
  printf '%s\n' "$target"
}

cmd_prepare() {
  state_init
  require_command python3
  require_command sha256sum
  local cdb="$ROOT_DIR/ygopro/cards.cdb" runtime="$ROOT_DIR/srvpro/ygopro" scripts="$ROOT_DIR/ygopro/script"
  [[ -f "$cdb" ]] || die "missing $cdb (run sync first)"
  [[ -d "$scripts" ]] || die "missing $scripts (submodule was not checked out)"
  if ((DRY_RUN)); then
    info "dry-run: would validate/copy cards.cdb, strings.conf, managed Lua deltas and generate AVIF"
    return 0
  fi
  mkdir -p "$runtime/script" "$ROOT_DIR/assets/pics_avif"
  if [[ ! -f "$STATE_DIR/base-cdb.json" && -f "$runtime/cards.cdb" ]]; then
    python3 "$HELPER" validate-cdb "$runtime/cards.cdb" > "$STATE_DIR/base-cdb.json"
  fi
  python3 "$HELPER" validate-cdb "$cdb" > "$STATE_DIR/current-cdb.json"
  if ((REFRESH_NAMES)); then
    local names_zip="$CACHE_ROOT/ygocdb-cards.zip"
    if [[ ! -s "$names_zip" ]]; then
      info "downloading YGOCDB names archive"
      curl --fail --show-error --location --proto '=https' --tlsv1.2 --max-time 600 -o "$names_zip.part" https://ygocdb.com/api/v0/cards.zip
      mv -f "$names_zip.part" "$names_zip"
    fi
    python3 "$HELPER" merge-names "$names_zip" "$ROOT_DIR/assets/ygocdb_cards.json"
  fi
  local only_codes="$STATE_DIR/new-codes.json"
  if [[ -f "$STATE_DIR/base-cdb.json" ]]; then
    python3 - "$STATE_DIR/base-cdb.json" "$STATE_DIR/current-cdb.json" > "$only_codes" <<'PY'
import json, sys
old=json.load(open(sys.argv[1], encoding='utf-8'))
new=json.load(open(sys.argv[2], encoding='utf-8'))
old_codes=set(old.get('codes', [])); print(json.dumps(sorted(set(new.get('codes', []))-old_codes)))
PY
  else
    printf '[]\n' > "$only_codes"
  fi
  local missing
  missing="$(python3 "$HELPER" missing-names "$cdb" "$ROOT_DIR/assets/ygocdb_cards.json" --only "$only_codes")"
  printf '%s\n' "$missing" > "$STATE_DIR/missing-names.json"
  if [[ "$missing" != '[]' ]]; then
    warn "new non-token cards missing display names: $missing"
    ((ALLOW_MISSING_NAMES)) || die "name coverage is incomplete; use --refresh-names or --allow-missing-names"
  fi
  [[ -f "$STATE_DIR/resource-manifest.json" ]] && cp -f "$STATE_DIR/resource-manifest.json" "$STATE_DIR/previous-resource-manifest.json" || true
  cp -f "$cdb" "$runtime/cards.cdb"
  [[ -f "$ROOT_DIR/ygopro/strings.conf" ]] && cp -f "$ROOT_DIR/ygopro/strings.conf" "$runtime/strings.conf"
  [[ -f "$STATE_DIR/script-manifest.json" ]] && cp -f "$STATE_DIR/script-manifest.json" "$STATE_DIR/previous-script-manifest.json" || true
  python3 "$HELPER" sync-scripts "$scripts" "$runtime/script" --previous "${STATE_DIR}/previous-script-manifest.json" --manifest-out "$STATE_DIR/script-manifest.json"
  if ((SKIP_IMAGES)); then
    warn "image generation skipped by request"
  else
    local archive image_source
    archive="$(download_images)"
    python3 "$HELPER" validate-zip "$archive" > "$STATE_DIR/image-zip-entries.json"
    image_source="$CACHE_ROOT/extracted-${IMAGE_LOCALE}"
    mkdir -p "$image_source"
    # Extraction itself is streaming and path-checked by the helper.
    python3 "$HELPER" extract-zip "$archive" "$image_source" >/dev/null
    [[ -f "$STATE_DIR/avif-manifest.json" ]] && cp -f "$STATE_DIR/avif-manifest.json" "$STATE_DIR/previous-avif-manifest.json" || true
    python3 "$HELPER" avif "$image_source" "$ROOT_DIR/assets/pics_avif" --previous "${STATE_DIR}/previous-avif-manifest.json" --manifest-out "$STATE_DIR/avif-manifest.json"
  fi
  local extra
  extra="$(python3 -c 'import json,sys; print(json.dumps({"upstream": {"repo": sys.argv[1], "ref": sys.argv[2], "commit": sys.argv[3]}, "scriptCommit": sys.argv[4], "ocgcoreCommit": sys.argv[5], "imageLocale": sys.argv[6]}, separators=(",", ":")))' "$UPSTREAM_REPO" "$UPSTREAM_REF" "$UPSTREAM_COMMIT" "$SCRIPT_COMMIT" "$OCGCORE_COMMIT" "$IMAGE_LOCALE")"
  python3 "$HELPER" manifest --cdb "$runtime/cards.cdb" --scripts "$runtime/script" --avif "$ROOT_DIR/assets/pics_avif" --out "$STATE_DIR/resource-manifest.json" --extra "$extra" >/dev/null
  info "prepared resources: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["cards"]["codeCount"], "cards,", len(d["scripts"]["files"]), "Lua,", len(d["avif"]["files"]), "AVIF")' "$STATE_DIR/resource-manifest.json")"
}

native_changes() {
  git -C "$ROOT_DIR/ygopro" diff --name-only HEAD^ HEAD -- 2>/dev/null | grep -Eq '(^gframe/|^ocgcore/|^premake/|\.cpp$|\.h$|\.c$|\.lua$)' 
}

cmd_build() {
  state_init
  if ((SKIP_BUILD)); then info "native build skipped"; return 0; fi
  local needs=1
  if git -C "$ROOT_DIR/ygopro" rev-parse HEAD^ >/dev/null 2>&1 && ! native_changes; then needs=0; fi
  if ((needs == 0)); then info "no native changes detected; build skipped"; return 0; fi
  local args=("$ROOT_DIR/scripts/build-ygopro.sh")
  ((CLIENT)) && args+=(--client)
  info "building YGOPro native target"
  run bash "${args[@]}"
  if ((DRY_RUN)); then return 0; fi
  local binary="$ROOT_DIR/ygopro/bin/release/ygopro"
  [[ -x "$binary" ]] || die "native build did not produce $binary"
  local ldd_output
  ldd_output="$(LD_LIBRARY_PATH="$ROOT_DIR/envs/ygocube/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$binary" 2>&1)"
  ! grep -q 'not found' <<<"$ldd_output" || { printf '%s\n' "$ldd_output" >&2; die "native binary has unresolved libraries"; }
  cp -f "$binary" "$ROOT_DIR/srvpro/ygopro/ygopro"
  info "native host verified and copied to srvpro/ygopro/ygopro"
}

cmd_test() {
  require_command python3
  info "resource helper tests"
  PYTHONPATH="$ROOT_DIR/scripts" python3 -m unittest discover -s "$ROOT_DIR/scripts" -p 'test_card_resources.py'
  info "API tests/build"
  (cd "$ROOT_DIR" && TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm --prefix cube/apps/api test -- --runInBand)
  (cd "$ROOT_DIR" && npm --prefix cube/apps/api run build)
  info "Web build"
  (cd "$ROOT_DIR" && npm --prefix cube/apps/web run build)
  info "srvpro tests/build"
  (cd "$ROOT_DIR/srvpro" && npm test)
  (cd "$ROOT_DIR/srvpro" && npm run build)
  if ((SKIP_E2E)); then
    warn "E2E probes skipped by request"
  else
    [[ -x "$ROOT_DIR/scripts/e2e/run-e2e.sh" ]] || die "missing E2E runner"
    (cd "$ROOT_DIR" && bash scripts/e2e/run-e2e.sh)
    (cd "$ROOT_DIR" && bash scripts/e2e/run-full-sim.sh)
  fi
  git -C "$ROOT_DIR" diff --check
}

make_payload() {
  local payload="$1" previous="$STATE_DIR/previous-resource-manifest.json" current="$STATE_DIR/resource-manifest.json"
  [[ -f "$current" ]] || die "run prepare before deploy"
  rm -rf "$payload"
  mkdir -p "$payload/srvpro/ygopro" "$payload/srvpro/ygopro/script" "$payload/assets/pics_avif" "$payload/metadata" "$payload/deletes"
  cp -f "$ROOT_DIR/srvpro/ygopro/cards.cdb" "$payload/srvpro/ygopro/cards.cdb"
  [[ -f "$ROOT_DIR/srvpro/ygopro/strings.conf" ]] && cp -f "$ROOT_DIR/srvpro/ygopro/strings.conf" "$payload/srvpro/ygopro/strings.conf"
  [[ -x "$ROOT_DIR/srvpro/ygopro/ygopro" ]] && cp -f "$ROOT_DIR/srvpro/ygopro/ygopro" "$payload/srvpro/ygopro/ygopro"
  local script_delta avif_delta
  script_delta="$(python3 "$HELPER" delta "$current" ${previous:+--previous "$previous"} --section scripts)"
  avif_delta="$(python3 "$HELPER" delta "$current" ${previous:+--previous "$previous"} --section avif)"
  python3 - "$script_delta" "$avif_delta" "$payload" "$ROOT_DIR" <<'PY'
import json, os, shutil, sys
sd, ad, root, base = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3], sys.argv[4]
base=os.path.abspath(base)
for section, delta, source, target in (("scripts", sd, os.path.join(base, "srvpro", "ygopro", "script"), os.path.join(root, "srvpro", "ygopro", "script")), ("avif", ad, os.path.join(base, "assets", "pics_avif"), os.path.join(root, "assets", "pics_avif"))):
    for rel in delta["changed"]:
        src=os.path.join(source, rel); dst=os.path.join(target, rel)
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
    with open(os.path.join(root, "deletes", section + ".txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(delta["removed"]) + ("\n" if delta["removed"] else ""))
PY
  cp -f "$current" "$payload/metadata/resource-manifest.json"
  (cd "$payload" && sha256sum srvpro/ygopro/cards.cdb > metadata/SHA256SUMS)
  tar -C "$payload" -czf "$STATE_DIR/card-resources-${RELEASE_ID}.tar.gz" .
  printf '%s\n' "$STATE_DIR/card-resources-${RELEASE_ID}.tar.gz"
}

ssh_exec() {
  python3 /home/jianfc/myskills/ssh-skill/scripts/ssh_execute.py "$ALY_HOST" "$1" --timeout "${2:-120}" --no-shell-init
}

ssh_upload() {
  python3 /home/jianfc/myskills/ssh-skill/scripts/ssh_upload.py "$ALY_HOST" "$1" "$2" --no-progress
}

remote_rollback() {
  local id="$1"
  info "rolling back Aly resource backup $id"
  ssh_exec "set -eu; root='$ALY_ROOT'; backup=\"\$root/backups/card-sync-$id\"; test -d \"\$backup\"; systemctl stop ygocube-srvpro ygocube-web ygocube-api nginx; rm -rf \"\$root/shared/srvpro/ygopro\" \"\$root/shared/assets/pics_avif\"; cp -a \"\$backup/srvpro-ygopro\" \"\$root/shared/srvpro/ygopro\"; cp -a \"\$backup/pics_avif\" \"\$root/shared/assets/pics_avif\"; systemctl start ygocube-api; systemctl start ygocube-srvpro; systemctl start ygocube-web; systemctl start nginx; systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx" 300
}

remote_health() {
  ssh_exec "set -eu; systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx; test -x '$ALY_ROOT/shared/srvpro/ygopro/ygopro'; ! ldd '$ALY_ROOT/shared/srvpro/ygopro/ygopro' 2>&1 | grep -q 'not found'; sha256sum '$ALY_ROOT/shared/srvpro/ygopro/cards.cdb'" 120
  curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 30 "$ALY_PUBLIC_URL/api/health" >/dev/null
  local html assets asset
  html="$(curl --fail --silent --show-error --retry 3 --max-time 30 "$ALY_PUBLIC_URL/")"
  assets="$(printf '%s' "$html" | grep -Eo "/_next/static/[^\"' ]+\.(js|css)" | sort -u || true)"
  [[ -n "$assets" ]] || die "homepage did not reference Next static assets"
  while IFS= read -r asset; do
    [[ -z "$asset" ]] && continue
    curl --fail --silent --show-error --max-time 30 -o /dev/null -H 'Accept: */*' "$ALY_PUBLIC_URL$asset"
  done <<<"$assets"
  info "Aly health and static-asset checks passed"
}

cmd_deploy() {
  ((CONFIRM_MAINTENANCE)) || die "deploy stops Aly services; pass --confirm-maintenance explicitly"
  require_command tar; require_command curl
  state_init
  ((DRY_RUN)) && { info "dry-run: would package, back up, stop services, atomically publish, restart and verify Aly"; return 0; }
  local archive staging="$STATE_DIR/deploy-$RELEASE_ID"
  archive="$(make_payload "$staging/payload")"
  info "uploading delta archive to Aly"
  ssh_exec "set -eu; root='$ALY_ROOT'; mkdir -p \"\$root/.staging/card-sync-$RELEASE_ID\"" 60
  ssh_upload "$archive" "$ALY_ROOT/.staging/card-sync-$RELEASE_ID/payload.tar.gz"
  ssh_upload "$ROOT_DIR/scripts/remote-resource-apply.sh" "$ALY_ROOT/.staging/card-sync-$RELEASE_ID/apply.sh"
  if ! ssh_exec "set -eu; chmod 700 '$ALY_ROOT/.staging/card-sync-$RELEASE_ID/apply.sh'; '$ALY_ROOT/.staging/card-sync-$RELEASE_ID/apply.sh' --root '$ALY_ROOT' --id '$RELEASE_ID'" 900; then
    warn "Aly publish failed; attempting automatic resource rollback"
    remote_rollback "$RELEASE_ID" || die "automatic rollback also failed; keep services stopped and restore $ALY_ROOT/backups/card-sync-$RELEASE_ID manually"
    die "Aly publish failed and was rolled back"
  fi
  remote_health
  info "Aly deployment completed: $RELEASE_ID"
}

cmd_rollback() {
  [[ "$BACKUP_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "rollback requires --backup-id with a safe identifier"
  ((DRY_RUN)) && { info "dry-run: would restore Aly backup $BACKUP_ID"; return 0; }
  remote_rollback "$BACKUP_ID"
  remote_health
}

case "$COMMAND" in
  check) cmd_check ;;
  sync) cmd_sync ;;
  prepare) cmd_prepare ;;
  build) cmd_build ;;
  test) cmd_test ;;
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
esac
