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
EXPANSION_URL="${YGOCUBE_EXPANSION_URL:-https://cdn02.moecube.com:444/ygopro-super-pre/archive/ygopro-super-pre.ypk}"
EXPANSION_LIST_URL="${YGOCUBE_EXPANSION_LIST_URL:-https://cdn02.moecube.com:444/ygopro-super-pre/data/test-release.json}"
ALY_HOST="${YGOCUBE_ALY_HOST:-aly}"
ALY_ROOT="${YGOCUBE_ALY_ROOT:-/opt/ygocube}"
ALY_PUBLIC_URL="${YGOCUBE_ALY_URL:-https://39.96.220.91}"
# Keep the default cache in /tmp: the project may run in a read-only home
# (notably WSL/CI), while callers can still select a durable cache explicitly.
CACHE_ROOT="${YGOCUBE_CACHE_DIR:-/tmp/ygocube-card-resources}"
STATE_DIR="$ROOT_DIR/.card-resource-sync"
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || printf unknown)"

COMMAND=""
DRY_RUN=0
COMMIT_MERGE=0
CONTINUE_MERGE=0
PUSH=0
CLIENT=0
SKIP_BUILD=0
SKIP_IMAGES=0
SKIP_E2E=0
ALLOW_MISSING_NAMES=0
REFRESH_NAMES=0
CONFIRM_MAINTENANCE=0
BACKUP_ID=""
IMAGE_URL_OVERRIDE=0
EXPANSION_ENABLED=0

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
  --expansion               Fetch and publish the official Super Pre expansion.
  --expansion-url <url>     Override the Super Pre .ypk URL (enables expansion).
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
YGOCUBE_ALY_HOST, YGOCUBE_ALY_ROOT, YGOCUBE_IMAGES_URL, YGOCUBE_EXPANSION_URL,
YGOCUBE_EXPANSION_LIST_URL and commit variables).
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

# `curl -I -L` can return one header block per redirect. Always use the final
# non-empty value, and prefer a non-zero Content-Length so a redirect's
# `Content-Length: 0` does not mask the archive size from the final response.
header_last() {
  local name="$1"
  awk -v wanted="$name" '
    BEGIN { wanted = tolower(wanted) ":" }
    {
      line = tolower($0)
      if (index(line, wanted) == 1) {
        value = $0
        sub("^[^:]*:[[:space:]]*", "", value)
        gsub("\\r", "", value)
        if (value != "") last = value
      }
    }
    END { print last }
  '
}

header_length() {
  awk '
    BEGIN { fallback = "" }
    {
      line = tolower($0)
      if (index(line, "content-length:") == 1) {
        value = $0
        sub("^[^:]*:[[:space:]]*", "", value)
        gsub("\\r", "", value)
        if (value ~ /^[0-9]+$/ && value != "0") { last = value; found = 1 }
        else if (fallback == "") fallback = value
      }
    }
    END { print (found ? last : fallback) }
  '
}

parse_args() {
  while (($#)); do
    case "$1" in
      check|sync|prepare|build|test|deploy|rollback)
        [[ -z "$COMMAND" ]] || die "only one command may be specified"
        COMMAND="$1"; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --locale) [[ $# -ge 2 ]] || die "--locale needs a value"; IMAGE_LOCALE="$2"; shift 2; ((IMAGE_URL_OVERRIDE)) || IMAGE_URL="https://cdn02.moecube.com:444/images/ygopro-images-${IMAGE_LOCALE}.zip" ;;
      --images-url) [[ $# -ge 2 ]] || die "--images-url needs a value"; IMAGE_URL="$2"; IMAGE_URL_OVERRIDE=1; shift 2 ;;
      --expansion|--with-expansion) EXPANSION_ENABLED=1; shift ;;
      --expansion-url) [[ $# -ge 2 ]] || die "--expansion-url needs a value"; EXPANSION_URL="$2"; EXPANSION_ENABLED=1; shift 2 ;;
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

parse_args "$@"

# Keep values that are later interpolated into remote shell commands and
# archive paths deliberately narrow.  The image endpoint is required to use
# TLS; callers can still point it at a different HTTPS mirror with
# --images-url.
[[ "$IMAGE_LOCALE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]] || die "invalid image locale"
[[ "$IMAGE_URL" == https://* ]] || die "image URL must use HTTPS"
[[ "$EXPANSION_URL" == https://* ]] || die "expansion URL must use HTTPS"
[[ "$EXPANSION_LIST_URL" == https://* ]] || die "expansion list URL must use HTTPS"
[[ "$ALY_ROOT" =~ ^/[A-Za-z0-9._/+:-]+$ ]] || die "invalid Aly root path"

if ((DRY_RUN)) || [[ "$COMMAND" == "check" || "$COMMAND" == "test" ]]; then
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
  if [[ -z "$branch" ]]; then
    local root_branch
    root_branch="$(git -C "$ROOT_DIR" symbolic-ref --short HEAD)"
    [[ "$root_branch" == codex/card-resource-sync-* ]] || die "ygopro is detached; switch the root to a resource-sync feature branch first"
    if ((DRY_RUN)); then
      info "dry-run: would create matching ygopro branch $root_branch"
      return 0
    fi
    info "ygopro is detached; creating matching feature branch $root_branch"
    git -C "$ROOT_DIR/ygopro" switch -c "$root_branch"
    branch="$root_branch"
  fi
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
  if ((EXPANSION_ENABLED)); then
    headers="$(curl --fail --silent --show-error --location --head --max-time 30 --proto '=https' --tlsv1.2 "$EXPANSION_URL" || true)"
    if [[ -n "$headers" ]]; then
      printf 'expansion_url=%s\n' "$EXPANSION_URL"
      printf '%s\n' "$headers" | awk 'BEGIN{IGNORECASE=1} /^etag:|^last-modified:|^content-length:|^content-type:/ {gsub("\r",""); print}'
    else
      warn "expansion archive HEAD request failed"
    fi
    printf 'expansion_list_url=%s\n' "$EXPANSION_LIST_URL"
  fi
}

cmd_sync() {
  state_init
  if ((DRY_RUN)); then
    info "dry-run: would verify $UPSTREAM_COMMIT and merge with --no-ff --no-commit"
    return 0
  fi
  git_clean_check "$ROOT_DIR"
  git_clean_check "$ROOT_DIR/ygopro"
  submodule_branch_check
  require_command git
  info "fetching upstream $UPSTREAM_REF"
  run git -C "$ROOT_DIR/ygopro" fetch --prune origin "$UPSTREAM_REF"
  git -C "$ROOT_DIR/ygopro" cat-file -e "$UPSTREAM_COMMIT^{commit}" || die "upstream commit $UPSTREAM_COMMIT was not fetched"
  # A repeated sync is a safe no-op once the requested upstream commit is
  # already an ancestor.  This keeps scheduled runs idempotent and avoids a
  # second no-op merge followed by a failing `git commit`.
  if git -C "$ROOT_DIR/ygopro" merge-base --is-ancestor "$UPSTREAM_COMMIT" HEAD; then
    info "ygopro already contains upstream $UPSTREAM_COMMIT"
    local script_ref ocg_ref
    script_ref="$(git -C "$ROOT_DIR/ygopro" ls-tree HEAD script | awk '{print $3}')"
    ocg_ref="$(git -C "$ROOT_DIR/ygopro" ls-tree HEAD ocgcore | awk '{print $3}')"
    [[ "$script_ref" == "$SCRIPT_COMMIT"* ]] || die "script gitlink is $script_ref, expected $SCRIPT_COMMIT"
    [[ "$ocg_ref" == "$OCGCORE_COMMIT"* ]] || die "ocgcore gitlink is $ocg_ref, expected $OCGCORE_COMMIT"
    if ((PUSH)); then
      local root_branch sub_branch
      root_branch="$(git -C "$ROOT_DIR" symbolic-ref --short HEAD)"
      sub_branch="$(git -C "$ROOT_DIR/ygopro" symbolic-ref --short HEAD)"
      run git -C "$ROOT_DIR/ygopro" push --set-upstream fc-jian "$sub_branch"
      ((DRY_RUN)) || [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] || die "root gitlink is not committed; commit it before --push"
      run git -C "$ROOT_DIR" push --set-upstream origin "$root_branch"
    fi
    return 0
  fi
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
    ((DRY_RUN)) || [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] || die "root gitlink is not committed; commit it before --push"
    run git -C "$ROOT_DIR" push --set-upstream origin "$root_branch"
  fi
}

download_images() {
  local target="$CACHE_ROOT/ygopro-images-${IMAGE_LOCALE}.zip"
  local partial="$target.part"
  local headers="$target.headers"
  local remote_headers remote_etag remote_size local_etag local_size
  remote_headers="$(curl --fail --silent --show-error --location --head --max-time 30 --proto '=https' --tlsv1.2 "$IMAGE_URL")" || die "image archive HEAD request failed"
  remote_etag="$(printf '%s\n' "$remote_headers" | header_last etag)"
  remote_size="$(printf '%s\n' "$remote_headers" | header_length)"
  [[ -z "$remote_size" || "$remote_size" =~ ^[0-9]+$ ]] || die "image response has invalid Content-Length: $remote_size"
  [[ -z "$remote_size" || "$remote_size" -le 4000000000 ]] || die "image archive exceeds configured size limit"
  if [[ -s "$target" ]]; then
    local_size="$(stat -c %s "$target")"
    local_etag="$(cat "$target.etag" 2>/dev/null || true)"
    if [[ -n "$remote_etag" && "$remote_etag" == "$local_etag" && ( -z "$remote_size" || "$remote_size" == "$local_size" ) ]]; then
      # Metadata alone is not sufficient after an interrupted/proxy download;
      # validate the central directory before trusting a cached archive.
      if python3 "$HELPER" validate-zip "$target" >/dev/null 2>&1; then
        info "image archive cache is current (ETag matched)" >&2
        printf '%s\n' "$target"
        return 0
      fi
      warn "cached image archive failed ZIP validation; downloading a clean copy"
    else
      warn "cached image archive metadata differs (ETag or size); downloading a clean copy"
    fi
    rm -f "$target" "$target.etag" "$target.sha256" "$target.headers"
  fi
  info "downloading image archive to cache (this can be large)" >&2
  # curl's --continue-at can append a full 200 response when a proxy ignores a
  # Range header.  Resume explicitly, verify Content-Range, and only append a
  # chunk whose start and length match the existing partial file.
  local attempt offset expected_size resume_headers resume_chunk range_value range_start range_end range_total size content_type
  expected_size="$remote_size"
  for attempt in 1 2 3 4 5 6; do
    offset=0
    [[ -f "$partial" ]] && offset="$(stat -c %s "$partial")"
    if [[ -n "$expected_size" && "$offset" -ge "$expected_size" ]]; then
      if [[ "$offset" -eq "$expected_size" ]]; then
        break
      fi
      warn "partial image archive is larger than Content-Length; restarting clean"
      rm -f "$partial"
      continue
    fi
    if [[ "$offset" -gt 0 ]]; then
      resume_headers="$partial.headers"
      resume_chunk="$partial.resume"
      rm -f "$resume_chunk" "$resume_headers"
      if curl --http1.1 --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 --max-filesize 4000000000 --range "$offset-" -D "$resume_headers" -o "$resume_chunk" "$IMAGE_URL"; then
        range_value="$(awk 'BEGIN{IGNORECASE=1} /^content-range:/ {sub("^[^:]*:[[:space:]]*",""); gsub("\r",""); print; exit}' "$resume_headers")"
        if [[ "$range_value" =~ ^bytes[[:space:]]+([0-9]+)-([0-9]+)/([0-9]+)$ ]]; then
          range_start="${BASH_REMATCH[1]}"; range_end="${BASH_REMATCH[2]}"; range_total="${BASH_REMATCH[3]}"
          size="$(stat -c %s "$resume_chunk" 2>/dev/null || echo 0)"
          if [[ "$range_start" == "$offset" && "$range_end" -ge "$range_start" && "$size" -eq $((range_end - range_start + 1)) && ( -z "$expected_size" || "$range_total" == "$expected_size" ) ]]; then
            cat "$resume_chunk" >> "$partial"
          fi
        fi
      fi
      rm -f "$resume_chunk" "$resume_headers"
    else
      rm -f "$partial"
      curl --http1.1 --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 --max-filesize 4000000000 -D "$headers" -o "$partial" "$IMAGE_URL" || true
    fi
    size="$(stat -c %s "$partial" 2>/dev/null || echo 0)"
    if [[ -n "$expected_size" && "$size" == "$expected_size" ]]; then
      break
    fi
    sleep 2
  done
  [[ -f "$partial" ]] || die "image archive download failed"
  size="$(stat -c %s "$partial")"
  [[ -z "$expected_size" || "$size" == "$expected_size" ]] || die "image archive size mismatch: $size (expected $expected_size)"
  content_type="$(printf '%s\n' "$remote_headers" | header_last content-type)"
  [[ "$content_type" == *zip* || "$content_type" == *octet-stream* || "$content_type" == *binary* ]] || die "image response has unexpected content type: $content_type"
  mv -f "$partial" "$target"
  printf '%s\n' "$remote_etag" > "$target.etag"
  sha256sum "$target" | awk '{print $1}' > "$target.sha256"
  printf '%s\n' "$target"
}

download_expansion() {
  local target="$CACHE_ROOT/ygopro-super-pre.ypk"
  local partial="$target.part"
  local headers="$target.headers"
  local remote_headers remote_etag remote_size local_etag local_size local_url content_type size attempt
  remote_headers="$(curl --fail --silent --show-error --location --head --max-time 30 --proto '=https' --tlsv1.2 "$EXPANSION_URL")" || die "expansion archive HEAD request failed"
  remote_etag="$(printf '%s\n' "$remote_headers" | header_last etag)"
  remote_size="$(printf '%s\n' "$remote_headers" | header_length)"
  [[ -z "$remote_size" || "$remote_size" =~ ^[0-9]+$ ]] || die "expansion response has invalid Content-Length: $remote_size"
  [[ -z "$remote_size" || "$remote_size" -le 1000000000 ]] || die "expansion archive exceeds configured size limit"
  if [[ -s "$target" ]]; then
    local_size="$(stat -c %s "$target")"
    local_etag="$(cat "$target.etag" 2>/dev/null || true)"
    local_url="$(cat "$target.url" 2>/dev/null || true)"
    if [[ "$local_url" == "$EXPANSION_URL" && -n "$remote_etag" && "$remote_etag" == "$local_etag" && ( -z "$remote_size" || "$remote_size" == "$local_size" ) ]] && python3 "$HELPER" validate-expansion-zip "$target" >/dev/null 2>&1; then
      info "expansion archive cache is current (ETag matched)" >&2
      printf '%s\n' "$target"
      return 0
    fi
    warn "cached expansion archive metadata or validation differs; downloading a clean copy"
    rm -f "$target" "$target.etag" "$target.sha256" "$target.headers" "$target.url"
  fi
  for attempt in 1 2 3 4 5; do
    rm -f "$partial" "$headers"
    curl --http1.1 --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 --max-filesize 1000000000 -D "$headers" -o "$partial" "$EXPANSION_URL" || true
    size="$(stat -c %s "$partial" 2>/dev/null || echo 0)"
    if [[ -n "$remote_size" && "$size" == "$remote_size" ]] || [[ -z "$remote_size" && "$size" -gt 0 ]]; then
      if python3 "$HELPER" validate-expansion-zip "$partial" >/dev/null 2>&1; then
        break
      fi
      warn "downloaded expansion archive failed ZIP validation; retrying"
      rm -f "$partial"
    fi
    sleep 2
  done
  [[ -f "$partial" ]] || die "expansion archive download failed"
  size="$(stat -c %s "$partial")"
  [[ -z "$remote_size" || "$size" == "$remote_size" ]] || die "expansion archive size mismatch: $size (expected $remote_size)"
  content_type="$(printf '%s\n' "$remote_headers" | header_last content-type)"
  [[ "$content_type" == *zip* || "$content_type" == *octet-stream* || "$content_type" == *binary* ]] || die "expansion response has unexpected content type: $content_type"
  mv -f "$partial" "$target"
  printf '%s\n' "$remote_etag" > "$target.etag"
  printf '%s\n' "$EXPANSION_URL" > "$target.url"
  sha256sum "$target" | awk '{print $1}' > "$target.sha256"
  python3 "$HELPER" validate-expansion-zip "$target" >/dev/null
  printf '%s\n' "$target"
}

download_expansion_list() {
  local target="$CACHE_ROOT/test-release.json"
  local partial="$target.part"
  local headers="$target.headers"
  local remote_headers remote_etag remote_size local_etag local_size local_url content_type size
  remote_headers="$(curl --fail --silent --show-error --location --head --max-time 30 --proto '=https' --tlsv1.2 "$EXPANSION_LIST_URL")" || die "expansion card-list HEAD request failed"
  remote_etag="$(printf '%s\n' "$remote_headers" | header_last etag)"
  remote_size="$(printf '%s\n' "$remote_headers" | header_length)"
  [[ -z "$remote_size" || "$remote_size" =~ ^[0-9]+$ ]] || die "expansion list has invalid Content-Length: $remote_size"
  [[ -z "$remote_size" || "$remote_size" -le 10000000 ]] || die "expansion list exceeds configured size limit"
  if [[ -s "$target" ]]; then
    local_size="$(stat -c %s "$target")"
    local_etag="$(cat "$target.etag" 2>/dev/null || true)"
    local_url="$(cat "$target.url" 2>/dev/null || true)"
    if [[ "$local_url" == "$EXPANSION_LIST_URL" && -n "$remote_etag" && "$remote_etag" == "$local_etag" && ( -z "$remote_size" || "$remote_size" == "$local_size" ) ]] && python3 "$HELPER" validate-expansion-list "$target" >/dev/null 2>&1; then
      printf '%s\n' "$target"
      return 0
    fi
    rm -f "$target" "$target.etag" "$target.sha256" "$target.headers" "$target.url"
  fi
  rm -f "$partial" "$headers"
  curl --http1.1 --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 120 --max-filesize 10000000 -D "$headers" -o "$partial" "$EXPANSION_LIST_URL" || die "expansion card-list download failed"
  size="$(stat -c %s "$partial")"
  [[ -z "$remote_size" || "$size" == "$remote_size" ]] || die "expansion list size mismatch: $size (expected $remote_size)"
  content_type="$(printf '%s\n' "$remote_headers" | header_last content-type)"
  [[ "$content_type" == *json* || "$content_type" == *text* ]] || die "expansion list has unexpected content type: $content_type"
  python3 "$HELPER" validate-expansion-list "$partial" >/dev/null || die "expansion card-list failed validation"
  mv -f "$partial" "$target"
  printf '%s\n' "$remote_etag" > "$target.etag"
  printf '%s\n' "$EXPANSION_LIST_URL" > "$target.url"
  sha256sum "$target" | awk '{print $1}' > "$target.sha256"
  printf '%s\n' "$target"
}

cmd_prepare() {
  state_init
  require_command python3
  require_command sha256sum
  local cdb="$ROOT_DIR/ygopro/cards.cdb" runtime="$ROOT_DIR/srvpro/ygopro" scripts="$ROOT_DIR/ygopro/script" expansions="$ROOT_DIR/srvpro/ygopro/expansions"
  [[ -f "$cdb" ]] || die "missing $cdb (run sync first)"
  [[ -d "$scripts" ]] || die "missing $scripts (submodule was not checked out)"
  if ((DRY_RUN)); then
    if ((EXPANSION_ENABLED)); then
      info "dry-run: would validate/copy cards.cdb, strings.conf, managed Lua/expansion deltas and generate AVIF"
    else
      info "dry-run: would validate/copy cards.cdb, strings.conf, managed Lua deltas and generate AVIF"
    fi
    return 0
  fi
  mkdir -p "$runtime/script" "$runtime/expansions" "$ROOT_DIR/assets/pics_avif"
  # Keep a binary baseline so repeated prepare runs continue to report the
  # original upstream diff instead of comparing the already-copied CDB to
  # itself.  It lives in the ignored state directory.
  if [[ ! -f "$STATE_DIR/base-cdb.sqlite" && -f "$runtime/cards.cdb" ]]; then
    cp -f "$runtime/cards.cdb" "$STATE_DIR/base-cdb.sqlite"
  fi
  if [[ ! -f "$STATE_DIR/base-cdb.json" && -f "$runtime/cards.cdb" ]]; then
    python3 "$HELPER" validate-cdb "$runtime/cards.cdb" > "$STATE_DIR/base-cdb.json"
  fi
  python3 "$HELPER" validate-cdb "$cdb" > "$STATE_DIR/current-cdb.json"
  if [[ -f "$STATE_DIR/base-cdb.sqlite" ]]; then
    python3 "$HELPER" compare-cdb "$STATE_DIR/base-cdb.sqlite" "$cdb" > "$STATE_DIR/cdb-diff.json"
  else
    printf '{"addedCodes":0,"removedCodes":0,"changedData":0,"changedTexts":0}\n' > "$STATE_DIR/cdb-diff.json"
  fi
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
  local missing name_check_codes="$only_codes"
  # A name refresh is also a repair pass for older exact-code rows.  Earlier
  # releases only checked newly added IDs, so expanding the fallback order can
  # otherwise leave historical alternate-art records permanently unexamined.
  if ((REFRESH_NAMES)); then
    name_check_codes="$STATE_DIR/name-refresh-codes.json"
    python3 "$HELPER" missing-names "$cdb" "$ROOT_DIR/assets/ygocdb_cards.json" > "$name_check_codes"
  fi
  missing="$(python3 "$HELPER" missing-names "$cdb" "$ROOT_DIR/assets/ygocdb_cards.json" --only "$name_check_codes")"
  if ((REFRESH_NAMES)) && [[ "$missing" != '[]' ]]; then
    # YGOCDB's bulk archive intentionally omits many alternate-art records.
    # Resolve those exact ids through the read-only card endpoint and copy the
    # literal text/name fields to a new exact-code record; failures remain in
    # the audited missing-name report and still require --allow-missing-names.
    local api_records="$STATE_DIR/ygocdb-api-records.jsonl" code response
    : > "$api_records"
    while IFS= read -r code; do
      [[ "$code" =~ ^[0-9]+$ ]] || continue
      response="$(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 20 "https://ygocdb.com/api/v0/card/$code" 2>/dev/null || true)"
      [[ -n "$response" ]] && printf '%s\n' "$(python3 -c 'import json,sys; print(json.dumps({"requested": int(sys.argv[1]), "payload": json.loads(sys.argv[2])}, ensure_ascii=False, separators=(",", ":")))' "$code" "$response")" >> "$api_records"
    done < <(python3 -c 'import json,sys; print("\n".join(str(x) for x in json.load(sys.stdin)))' <<<"$missing")
    python3 - "$ROOT_DIR/assets/ygocdb_cards.json" "$api_records" <<'PY'
import json, sys
mapping_path, records_path = sys.argv[1:]
try:
    mapping = json.load(open(mapping_path, encoding='utf-8'))
except (OSError, json.JSONDecodeError):
    mapping = {}
if not isinstance(mapping, dict):
    mapping = {str(item.get('id')): item for item in mapping if isinstance(item, dict) and item.get('id') is not None}
else:
    normalized = {}
    for value in mapping.values():
        if not isinstance(value, dict):
            continue
        try:
            code = int(value.get('id'))
        except (TypeError, ValueError):
            continue
        if code > 0:
            key = str(code)
            old = normalized.get(key)
            if old is None or not any(str(old.get(field) or '').strip() for field in ('sc_name', 'md_name', 'jp_name', 'cn_name', 'en_name')):
                normalized[key] = value
    mapping = normalized
with open(records_path, encoding='utf-8') as source:
    for line in source:
        try:
            item = json.loads(line); requested = int(item['requested']); payload = item['payload']
            text = payload.get('text', {}); data = payload.get('data', {})
            record = {'id': requested, 'cid': payload.get('cid'), 'cn_name': text.get('name', ''), 'sc_name': text.get('sc_name', ''), 'md_name': text.get('md_name', ''), 'jp_name': text.get('jp_name', ''), 'en_name': text.get('en_name', ''), 'text': {'types': text.get('types', ''), 'pdesc': text.get('pdesc', ''), 'desc': text.get('desc', '')}, 'data': data}
            mapping[str(requested)] = record
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            continue
with open(mapping_path, 'w', encoding='utf-8') as target:
    json.dump(mapping, target, ensure_ascii=False, indent=2, sort_keys=True); target.write('\n')
PY
    missing="$(python3 "$HELPER" missing-names "$cdb" "$ROOT_DIR/assets/ygocdb_cards.json" --only "$name_check_codes")"
  fi
  printf '%s\n' "$missing" > "$STATE_DIR/missing-names.json"
  if [[ "$missing" != '[]' ]]; then
    warn "non-token cards missing display names: $missing"
    ((ALLOW_MISSING_NAMES)) || die "name coverage is incomplete; use --refresh-names or --allow-missing-names"
  fi
  # On the first run there is no prior state manifest yet.  Bootstrap one
  # from the currently installed runtime so the first payload still contains
  # only changed Lua/AVIF files (rather than re-uploading the whole cache).
  if [[ -f "$STATE_DIR/resource-manifest.json" ]]; then
    cp -f "$STATE_DIR/resource-manifest.json" "$STATE_DIR/previous-resource-manifest.json"
  elif [[ -f "$runtime/cards.cdb" ]]; then
    python3 "$HELPER" manifest --cdb "$runtime/cards.cdb" --scripts "$runtime/script" --avif "$ROOT_DIR/assets/pics_avif" --expansions "$expansions" --out "$STATE_DIR/previous-resource-manifest.json" --names "$ROOT_DIR/assets/ygocdb_cards.json" >/dev/null
  fi
  cp -f "$cdb" "$runtime/cards.cdb"
  [[ -f "$ROOT_DIR/ygopro/strings.conf" ]] && cp -f "$ROOT_DIR/ygopro/strings.conf" "$runtime/strings.conf"
  if [[ -f "$STATE_DIR/script-manifest.json" ]]; then
    cp -f "$STATE_DIR/script-manifest.json" "$STATE_DIR/previous-script-manifest.json"
  elif [[ -d "$runtime/script" ]]; then
    python3 - "$runtime/script" "$STATE_DIR/previous-script-manifest.json" <<'PY'
import json, hashlib, os, sys
root, out = sys.argv[1:]
files = {}
for base, _, names in os.walk(root):
    for name in sorted(names):
        if not name.lower().endswith('.lua'):
            continue
        path = os.path.join(base, name)
        rel = os.path.relpath(path, root).replace(os.sep, '/')
        digest = hashlib.sha256()
        with open(path, 'rb') as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(block)
        files[rel] = {'size': os.path.getsize(path), 'sha256': digest.hexdigest()}
with open(out, 'w', encoding='utf-8') as handle:
    json.dump({'schemaVersion': 1, 'files': files}, handle, ensure_ascii=False, sort_keys=True)
    handle.write('\n')
PY
  fi
  python3 "$HELPER" sync-scripts "$scripts" "$runtime/script" --previous "${STATE_DIR}/previous-script-manifest.json" --manifest-out "$STATE_DIR/script-manifest.json"
  local expansion_archive_meta_file="$STATE_DIR/expansion-archive-meta.json"
  printf '%s\n' '{"enabled":false,"mode":"preserved","url":null,"listUrl":null,"etag":null,"size":null,"sha256":null,"entryCount":0,"serverEntryCount":0,"listSha256":null,"listSize":null,"listCount":null}' > "$expansion_archive_meta_file"
  if ((EXPANSION_ENABLED)); then
    local expansion_archive expansion_list expansion_source expansion_entries expansion_previous
    expansion_archive="$(download_expansion)"
    expansion_list="$(download_expansion_list)"
    expansion_entries="$STATE_DIR/expansion-zip-entries.json"
    python3 "$HELPER" validate-expansion-zip "$expansion_archive" > "$expansion_entries"
    expansion_source="$CACHE_ROOT/extracted-expansion"
    rm -rf "$expansion_source"
    mkdir -p "$expansion_source"
    rm -f "$STATE_DIR/expansion-release-match.json"
    python3 "$HELPER" extract-expansion-zip "$expansion_archive" "$expansion_source" >/dev/null
    local -a expansion_cdbs=()
    mapfile -t expansion_cdbs < <(find "$expansion_source" -maxdepth 1 -type f -name '*.cdb' -print | sort)
    ((${#expansion_cdbs[@]} > 0)) || die "expansion archive contains no server CDB"
    for expansion_cdb in "${expansion_cdbs[@]}"; do
      python3 "$HELPER" validate-cdb "$expansion_cdb" > /dev/null
    done
    if [[ -f "$expansion_source/test-release.cdb" ]]; then
      python3 "$HELPER" validate-expansion-release "$expansion_list" "$expansion_source/test-release.cdb" > "$STATE_DIR/expansion-release-match.json"
    fi
    expansion_previous="$STATE_DIR/previous-expansion-manifest.json"
    if [[ -f "$STATE_DIR/deployed-expansion-manifest.json" ]]; then
      cp -f "$STATE_DIR/deployed-expansion-manifest.json" "$expansion_previous"
    elif [[ -f "$STATE_DIR/expansion-manifest.json" ]]; then
      cp -f "$STATE_DIR/expansion-manifest.json" "$expansion_previous"
    else
      # Do not infer ownership from an old full resource manifest: it may
      # contain server-local lflist.conf or administrator-added files.
      printf '%s\n' '{"schemaVersion":1,"files":{}}' > "$expansion_previous"
    fi
    python3 "$HELPER" sync-expansions "$expansion_source" "$expansions" --previous "$expansion_previous" --manifest-out "$STATE_DIR/expansion-manifest.json"
    python3 - "$expansion_archive" "$expansion_entries" "$expansion_list" "$EXPANSION_URL" "$EXPANSION_LIST_URL" "$STATE_DIR/expansion-release-match.json" > "$expansion_archive_meta_file" <<'PY'
import hashlib, json, os, sys
archive, entries_path, listing, url, list_url, match_path = sys.argv[1:]
entries = json.load(open(entries_path, encoding='utf-8'))
with open(listing, 'rb') as handle:
    list_bytes = handle.read()
archive_digest = hashlib.sha256(open(archive, 'rb').read()).hexdigest()
list_digest = hashlib.sha256(list_bytes).hexdigest()
etag_path = archive + '.etag'
etag = open(etag_path, encoding='utf-8').read().strip() if os.path.exists(etag_path) else None
try:
    release_match = json.load(open(match_path, encoding='utf-8'))
except (OSError, json.JSONDecodeError):
    release_match = None
print(json.dumps({
    'enabled': True,
    'mode': 'official-super-pre',
    'url': url,
    'listUrl': list_url,
    'etag': etag,
    'size': os.path.getsize(archive),
    'sha256': archive_digest,
    'entryCount': len(entries),
    'serverEntryCount': sum(item.get('kind') != 'metadata' for item in entries),
    'listSha256': list_digest,
    'listSize': len(list_bytes),
    'listCount': len(json.loads(list_bytes.decode('utf-8'))),
    'releaseMatch': release_match,
}, ensure_ascii=False, separators=(',', ':')))
PY
  fi
  local image_archive_meta_file="$STATE_DIR/image-archive-meta.json"
  printf '%s\n' '{"locale":null,"url":null,"etag":null,"size":null,"sha256":null,"entryCount":0,"entries":[]}' > "$image_archive_meta_file"
  if ((SKIP_IMAGES)); then
    warn "image generation skipped by request"
  else
    local archive image_source avif_previous
    archive="$(download_images)"
    python3 "$HELPER" validate-zip "$archive" > "$STATE_DIR/image-zip-entries.json"
    # Keep the large entry list in a file. Passing it as a command-line
    # argument exceeds Linux ARG_MAX for the 15k-entry official archive.
    python3 - "$archive" "$STATE_DIR/image-zip-entries.json" "$IMAGE_URL" "$IMAGE_LOCALE" > "$image_archive_meta_file" <<'PY'
import hashlib, json, os, sys
archive, entries_path, url, locale = sys.argv[1:]
with open(entries_path, encoding='utf-8') as handle:
    entries = json.load(handle)
digest = hashlib.sha256()
with open(archive, 'rb') as handle:
    for block in iter(lambda: handle.read(1024 * 1024), b''):
        digest.update(block)
etag_path = archive + '.etag'
etag = open(etag_path, encoding='utf-8').read().strip() if os.path.exists(etag_path) else None
print(json.dumps({'locale': locale, 'url': url, 'etag': etag, 'size': os.path.getsize(archive), 'sha256': digest.hexdigest(), 'entryCount': len(entries), 'entries': entries}, ensure_ascii=False, separators=(',', ':')))
PY
    image_source="$CACHE_ROOT/extracted-${IMAGE_LOCALE}"
    # Never mix entries from an older archive into the new manifest.  The
    # cache path is derived from CACHE_ROOT and locale (validated above), so
    # replacing this one extraction directory is safe and deterministic.
    rm -rf "$image_source"
    mkdir -p "$image_source"
    # Extraction itself is streaming and path-checked by the helper.
    python3 "$HELPER" extract-zip "$archive" "$image_source" >/dev/null
    [[ -f "$STATE_DIR/avif-manifest.json" ]] && cp -f "$STATE_DIR/avif-manifest.json" "$STATE_DIR/previous-avif-manifest.json" || true
    avif_previous="${STATE_DIR}/previous-avif-manifest.json"
    # On the first run, reuse the bootstrapped resource manifest's AVIF file
    # hashes.  This avoids re-encoding thousands of unchanged thumbnails;
    # only new or modified source images invoke vips.
    if [[ ! -f "$avif_previous" && -f "$STATE_DIR/previous-resource-manifest.json" ]]; then
      avif_previous="${STATE_DIR}/previous-resource-manifest.json"
    fi
    python3 "$HELPER" avif "$image_source" "$ROOT_DIR/assets/pics_avif" --expansion-pics "$expansions/pics" --previous "$avif_previous" --manifest-out "$STATE_DIR/avif-manifest.json"
  fi
  python3 - "$STATE_DIR/manifest-extra.json" "$image_archive_meta_file" "$expansion_archive_meta_file" "$STATE_DIR/missing-names.json" "$STATE_DIR/cdb-diff.json" "$UPSTREAM_REPO" "$UPSTREAM_REF" "$UPSTREAM_COMMIT" "$SCRIPT_COMMIT" "$OCGCORE_COMMIT" <<'PY'
import json, sys
out, image_path, expansion_path, missing, cdb_diff, repo, ref, commit, script, ocgcore = sys.argv[1:]
payload = {
    'upstream': {'repo': repo, 'ref': ref, 'commit': commit},
    'scriptCommit': script,
    'ocgcoreCommit': ocgcore,
    'imageArchive': json.load(open(image_path, encoding='utf-8')),
    'expansionArchive': json.load(open(expansion_path, encoding='utf-8')),
    'missingNameCodes': json.load(open(missing, encoding='utf-8')),
    'cdbDiff': json.load(open(cdb_diff, encoding='utf-8')),
}
with open(out, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'))
PY
  python3 "$HELPER" manifest --cdb "$runtime/cards.cdb" --scripts "$runtime/script" --avif "$ROOT_DIR/assets/pics_avif" --expansions "$expansions" --names "$ROOT_DIR/assets/ygocdb_cards.json" --out "$STATE_DIR/resource-manifest.json" --extra-file "$STATE_DIR/manifest-extra.json" >/dev/null
  if ((EXPANSION_ENABLED)); then
    python3 - "$STATE_DIR/resource-manifest.json" "$STATE_DIR/expansion-manifest.json" <<'PY'
import json, os, sys
manifest_path, managed_path = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding='utf-8'))
managed = json.load(open(managed_path, encoding='utf-8'))
manifest['expansions'] = {
    'schemaVersion': managed.get('schemaVersion', 1),
    'files': managed.get('files', {}),
}
temporary = manifest_path + '.managed'
with open(temporary, 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
    handle.write('\n')
os.replace(temporary, manifest_path)
PY
  fi
  # Expansion publication is opt-in. A normal card/image update must not
  # remove or overwrite a Super Pre installation that may only exist on Aly.
  # Preserve the last successful expansion section when one is available;
  # otherwise omit it until --expansion explicitly establishes a baseline.
  if ((EXPANSION_ENABLED == 0)); then
    python3 - "$STATE_DIR/resource-manifest.json" "$STATE_DIR/previous-resource-manifest.json" <<'PY'
import json, os, sys
manifest_path, previous_path = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding='utf-8'))
try:
    previous = json.load(open(previous_path, encoding='utf-8'))
except (OSError, json.JSONDecodeError):
    previous = {}
if isinstance(previous, dict) and 'expansions' in previous:
    manifest['expansions'] = previous['expansions']
else:
    manifest.pop('expansions', None)
if isinstance(previous, dict) and 'expansionArchive' in previous:
    manifest['expansionArchive'] = previous['expansionArchive']
temporary = manifest_path + '.preserved'
with open(temporary, 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
    handle.write('\n')
os.replace(temporary, manifest_path)
PY
  fi
  info "prepared resources: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["cards"]["codeCount"], "cards,", len(d["scripts"]["files"]), "Lua,", len(d["avif"]["files"]), "AVIF,", len(d.get("expansions", {}).get("files", {})), "expansion files")' "$STATE_DIR/resource-manifest.json")"
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
  grep -Fq 'PRODUCT_VERSION_SUFFIX = L"-cube"' "$ROOT_DIR/ygopro/gframe/config.h" || die "ygopro version suffix -cube is missing"
  if command -v readelf >/dev/null 2>&1; then
    readelf -h "$binary" | grep -Eq 'Class:.*ELF(32|64)' || die "native artifact is not a valid ELF binary"
    readelf -l "$binary" | grep -q 'Requesting program interpreter' || warn "native binary has no dynamic interpreter (static build)"
  fi
  local ldd_output
  ldd_output="$(LD_LIBRARY_PATH="$ROOT_DIR/envs/ygocube/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$binary" 2>&1)"
  ! grep -q 'not found' <<<"$ldd_output" || { printf '%s\n' "$ldd_output" >&2; die "native binary has unresolved libraries"; }
  cp -f "$binary" "$ROOT_DIR/srvpro/ygopro/ygopro"
  info "native host verified and copied to srvpro/ygopro/ygopro"
}

cmd_test() {
  require_command python3
  info "resource helper tests"
  PYTHONPATH="$ROOT_DIR/scripts" python3 -m unittest discover -s "$ROOT_DIR/scripts" -p 'test_*card_resources.py'
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
  local payload="$1" previous="$STATE_DIR/deployed-resource-manifest.json" current="$STATE_DIR/resource-manifest.json"
  [[ -f "$current" ]] || die "run prepare before deploy"
  # A first publish must not install a manifest that advertises expansion
  # files while sending an empty expansion delta. Once a successful deploy has
  # recorded a deployed manifest, ordinary updates intentionally preserve the
  # existing expansion directory unless --expansion is explicitly used.
  local current_expansion_count
  current_expansion_count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1], encoding="utf-8")).get("expansions", {}).get("files", {})))' "$current")"
  if ((EXPANSION_ENABLED == 0 && current_expansion_count > 0)) && [[ ! -f "$previous" ]]; then
    die "resource manifest contains expansion files but no successful deployed manifest exists; pass --expansion to deploy"
  fi
  rm -rf "$payload"
  mkdir -p "$payload/srvpro/ygopro" "$payload/srvpro/ygopro/script" "$payload/srvpro/ygopro/expansions" "$payload/assets/pics_avif" "$payload/metadata" "$payload/deletes"
  [[ -f "$ROOT_DIR/assets/ygocdb_cards.json" ]] && cp -f "$ROOT_DIR/assets/ygocdb_cards.json" "$payload/assets/ygocdb_cards.json"
  cp -f "$ROOT_DIR/srvpro/ygopro/cards.cdb" "$payload/srvpro/ygopro/cards.cdb"
  [[ -f "$ROOT_DIR/srvpro/ygopro/strings.conf" ]] && cp -f "$ROOT_DIR/srvpro/ygopro/strings.conf" "$payload/srvpro/ygopro/strings.conf"
  [[ -x "$ROOT_DIR/srvpro/ygopro/ygopro" ]] && cp -f "$ROOT_DIR/srvpro/ygopro/ygopro" "$payload/srvpro/ygopro/ygopro"
  local script_delta_file="$payload/metadata/scripts-delta.json" avif_delta_file="$payload/metadata/avif-delta.json" expansion_delta_file="$payload/metadata/expansions-delta.json" delta_args=()
  # Only compare against a manifest recorded after a successful Aly publish.
  # Local prepare attempts can be interrupted and must never make a first
  # deployment omit resources that are still absent on the server.
  [[ -f "$previous" ]] && delta_args=(--previous "$previous")
  python3 "$HELPER" delta "$current" "${delta_args[@]}" --section scripts > "$script_delta_file"
  python3 "$HELPER" delta "$current" "${delta_args[@]}" --section avif > "$avif_delta_file"
  if ((EXPANSION_ENABLED)); then
    python3 "$HELPER" delta "$current" "${delta_args[@]}" --section expansions > "$expansion_delta_file"
    # lflist.conf is a server-local ban-list and is intentionally never
    # removed by an official expansion update, including during migration
    # from an older full-directory manifest.
    python3 - "$expansion_delta_file" <<'PY'
import json, os, sys
path = sys.argv[1]
data = json.load(open(path, encoding='utf-8'))
data['removed'] = [name for name in data.get('removed', []) if name != 'lflist.conf']
temporary = path + '.filtered'
with open(temporary, 'w', encoding='utf-8') as handle:
    json.dump(data, handle, ensure_ascii=False, sort_keys=True)
    handle.write('\n')
os.replace(temporary, path)
PY
  else
    printf '%s\n' '{"changed":[],"removed":[]}' > "$expansion_delta_file"
  fi
  # Read the potentially large delta JSON from files; passing all changed
  # paths as argv can exceed Linux ARG_MAX on a first resource publish.
  python3 - "$script_delta_file" "$avif_delta_file" "$expansion_delta_file" "$payload" "$ROOT_DIR" <<'PY'
import json, os, shutil, sys
sd, ad, ed = (json.load(open(sys.argv[1], encoding='utf-8')),
              json.load(open(sys.argv[2], encoding='utf-8')),
              json.load(open(sys.argv[3], encoding='utf-8')))
root, base = sys.argv[4], sys.argv[5]
base=os.path.abspath(base)
for section, delta, source, target in (
    ("scripts", sd, os.path.join(base, "srvpro", "ygopro", "script"), os.path.join(root, "srvpro", "ygopro", "script")),
    ("avif", ad, os.path.join(base, "assets", "pics_avif"), os.path.join(root, "assets", "pics_avif")),
    ("expansions", ed, os.path.join(base, "srvpro", "ygopro", "expansions"), os.path.join(root, "srvpro", "ygopro", "expansions")),
):
    for rel in delta["changed"]:
        # Source pictures are local AVIF inputs, never server payloads.
        if section == "expansions" and rel.startswith("pics/"):
            continue
        src=os.path.join(source, rel); dst=os.path.join(target, rel)
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
    with open(os.path.join(root, "deletes", section + ".txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(delta["removed"]) + ("\n" if delta["removed"] else ""))
PY
  python3 - "$current" "$payload/metadata/resource-manifest.json" <<'PYMANIFEST'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    manifest = json.load(handle)
if isinstance(manifest.get('expansions'), dict):
    files = manifest['expansions'].get('files', {})
    manifest['expansions']['files'] = {name: meta for name, meta in files.items() if not name.startswith('pics/')}
with open(sys.argv[2], 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, ensure_ascii=False, sort_keys=True)
PYMANIFEST
  (cd "$payload" && find srvpro assets -type f -print0 | sort -z | xargs -0 sha256sum > metadata/SHA256SUMS)
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
  ssh_exec "set -eu; root='$ALY_ROOT'; backup=\"\$root/backups/card-sync-$id\"; test -d \"\$backup\"; systemctl stop ygocube-srvpro ygocube-web ygocube-api nginx; rm -rf \"\$root/shared/srvpro/ygopro\" \"\$root/shared/assets/pics_avif\"; cp -a \"\$backup/srvpro-ygopro\" \"\$root/shared/srvpro/ygopro\"; cp -a \"\$backup/pics_avif\" \"\$root/shared/assets/pics_avif\"; if [ -f \"\$backup/ygocdb_cards.json\" ]; then cp -f \"\$backup/ygocdb_cards.json\" \"\$root/shared/assets/.ygocdb_cards.json.rollback-new\"; mv -f \"\$root/shared/assets/.ygocdb_cards.json.rollback-new\" \"\$root/shared/assets/ygocdb_cards.json\"; else rm -f \"\$root/shared/assets/ygocdb_cards.json\"; fi; if [ -f \"\$backup/resource-manifest.json\" ]; then cp -f \"\$backup/resource-manifest.json\" \"\$root/shared/assets/.resource-manifest.json.rollback-new\"; mv -f \"\$root/shared/assets/.resource-manifest.json.rollback-new\" \"\$root/shared/assets/resource-manifest.json\"; else rm -f \"\$root/shared/assets/resource-manifest.json\"; fi; if [ -f \"\$root/shared/data/cube.sqlite\" ]; then sqlite3 \"\$root/shared/data/cube.sqlite\" 'UPDATE cards SET metadata_version=0;'; fi; chown -R ygocube:ygocube \"\$root/shared/srvpro/ygopro\" \"\$root/shared/assets/pics_avif\"; chown ygocube:ygocube \"\$root/shared/assets/ygocdb_cards.json\" \"\$root/shared/assets/resource-manifest.json\" 2>/dev/null || true; systemctl start ygocube-api; systemctl start ygocube-srvpro; systemctl start ygocube-web; systemctl start nginx; systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx" 300
}

remote_health() {
  local expected_cdb_sha="${1:-}" expected_manifest_sha="${2:-}" remote_check
  remote_check="set -eu; systemctl is-active ygocube-api ygocube-srvpro ygocube-web nginx; test -x '$ALY_ROOT/shared/srvpro/ygopro/ygopro'; ! ldd '$ALY_ROOT/shared/srvpro/ygopro/ygopro' 2>&1 | grep -q 'not found'; actual=\$(sha256sum '$ALY_ROOT/shared/srvpro/ygopro/cards.cdb' | awk '{print \$1}'); printf 'remote_cards_sha256=%s\\n' \"\$actual\""
  [[ -z "$expected_cdb_sha" ]] || remote_check+="; test \"\$actual\" = '$expected_cdb_sha'"
  if [[ -n "$expected_manifest_sha" ]]; then
    remote_check+="; test -f '$ALY_ROOT/shared/assets/resource-manifest.json'; manifest=\$(sha256sum '$ALY_ROOT/shared/assets/resource-manifest.json' | awk '{print \$1}'); printf 'remote_manifest_sha256=%s\\n' \"\$manifest\"; test \"\$manifest\" = '$expected_manifest_sha'"
    local expansion_count
    expansion_count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1], encoding="utf-8")).get("expansions", {}).get("files", {})))' "$STATE_DIR/resource-manifest.json")"
    if [[ "$expansion_count" -gt 0 ]]; then
      remote_check+="; test -d '$ALY_ROOT/shared/srvpro/ygopro/expansions'; find '$ALY_ROOT/shared/srvpro/ygopro/expansions' -maxdepth 1 -type f -name '*.cdb' -print | grep -q ."
    fi
  fi
  ssh_exec "$remote_check" 120
  curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 30 "$ALY_PUBLIC_URL/api/health" >/dev/null
  local html assets asset
  html="$(curl --fail --silent --show-error --retry 3 --max-time 30 "$ALY_PUBLIC_URL/")"
  assets="$(printf '%s' "$html" | grep -Eo "/_next/static/[^\"' ]+\.(js|css)" | sort -u || true)"
  [[ -n "$assets" ]] || die "homepage did not reference Next static assets"
  while IFS= read -r asset; do
    [[ -z "$asset" ]] && continue
    local asset_headers content_type
    asset_headers="$(curl --fail --silent --show-error --head --max-time 30 -H 'Accept: */*' "$ALY_PUBLIC_URL$asset")"
    content_type="$(printf '%s\n' "$asset_headers" | awk 'BEGIN{IGNORECASE=1} /^content-type:/ {sub("^[^:]*:[[:space:]]*",""); gsub("\r",""); print; exit}')"
    case "$asset" in
      *.js) [[ "$content_type" == *javascript* || "$content_type" == *ecmascript* ]] || die "JS asset has wrong MIME: $asset ($content_type)" ;;
      *.css) [[ "$content_type" == *text/css* ]] || die "CSS asset has wrong MIME: $asset ($content_type)" ;;
    esac
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
    if ssh_exec "test -d '$ALY_ROOT/backups/card-sync-$RELEASE_ID/srvpro-ygopro' && test -d '$ALY_ROOT/backups/card-sync-$RELEASE_ID/pics_avif'" 30 >/dev/null 2>&1; then
      warn "Aly publish failed; attempting automatic resource rollback"
      remote_rollback "$RELEASE_ID" || die "automatic rollback also failed; keep services stopped and restore $ALY_ROOT/backups/card-sync-$RELEASE_ID manually"
      die "Aly publish failed and was rolled back"
    fi
    die "Aly publish failed before a complete backup was created; services were recovered by the remote safety trap"
  fi
  local expected_cdb_sha expected_manifest_sha
  expected_cdb_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["cards"]["sha256"])' "$STATE_DIR/resource-manifest.json")"
  expected_manifest_sha="$(sha256sum "$STATE_DIR/resource-manifest.json" | awk '{print $1}')"
  remote_health "$expected_cdb_sha" "$expected_manifest_sha"
  cp -f "$STATE_DIR/resource-manifest.json" "$STATE_DIR/deployed-resource-manifest.json"
  if ((EXPANSION_ENABLED)) && [[ -f "$STATE_DIR/expansion-manifest.json" ]]; then
    cp -f "$STATE_DIR/expansion-manifest.json" "$STATE_DIR/deployed-expansion-manifest.json"
  fi
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
