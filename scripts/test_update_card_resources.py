#!/usr/bin/env python3
"""CLI-level safety checks for update-card-resources.sh."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "update-card-resources.sh"
REMOTE_APPLY = ROOT / "scripts" / "remote-resource-apply.sh"
BASH = os.environ.get("YGOCUBE_TEST_BASH") or shutil.which("bash")


class UpdateScriptTests(unittest.TestCase):
    def image_download_fixture(self, mode: str, *, resume: bool = False) -> tuple[subprocess.CompletedProcess[str], str, int, bool]:
        source = SCRIPT.read_text(encoding='utf-8')
        helpers = source[source.index('header_last() {'):source.index('\nparse_args() {')]
        body = source[source.index('download_images() {'):source.index('\ndownload_expansion() {')]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Large successful responses are sparse zeros; failures are tiny.
            # This exercises the real 64-MiB bounds and concatenation logic.
            size = 2 * 67108864 + 17 if mode == 'progress' else 17
            fixture = r'''
set -euo pipefail
CACHE_ROOT="$1"; MODE="$2"; REMOTE_SIZE="$3"; IMAGE_LOCALE=fixture; IMAGE_URL=https://fixture.invalid/archive.zip; HELPER=fixture
info() { :; }; warn() { printf '%s\n' "$*" >&2; }; die() { printf '%s\n' "$*" >&2; exit 1; }; sleep() { :; }
python3() {
  [[ "$2" == validate-zip && "$4" == --full-crc && "$(stat -c %s "$3")" == "$REMOTE_SIZE" ]] || return 98
  [[ "$MODE" != crc ]] || return 1
}
curl() {
  local headers='' output='' range='' head=0
  while (($#)); do
    case "$1" in --head) head=1;; -D) headers="$2"; shift;; -o) output="$2"; shift;; --range) range="$2"; shift;; esac
    shift
  done
  if ((head)); then printf 'HTTP/1.1 200 OK\r\nETag: "fixture-v1"\r\nContent-Length: %s\r\nContent-Type: application/zip\r\n\r\n' "$REMOTE_SIZE"; return 0; fi
  printf '%s\n' "$range" >> "$CACHE_ROOT/requests"
  local calls start end length actual_length code=0 encoding='' status=206 etag='"fixture-v1"'
  calls=$(wc -l < "$CACHE_ROOT/requests"); start=${range%-*}; end=${range#*-}; length=$((end-start+1))
  [[ -n "$end" && "$length" -le 67108864 ]] || return 99
  if [[ "$MODE" == progress && $((calls % 6)) -ne 0 ]]; then printf 'x' > "$output"; return 28; fi
  [[ "$MODE" != ignored ]] || status=200
  [[ "$MODE" != etag ]] || etag='"changed-v2"'
  [[ "$MODE" != range ]] || start=$((start+1))
  actual_length="$length"
  if [[ "$MODE" == prefix ]]; then
    if ((calls == 1)); then actual_length=4; code=18;
    elif ((calls == 2)); then actual_length=3; code=28; fi
  elif [[ "$MODE" == prefix-* ]]; then
    actual_length=4; code=18
    case "$MODE" in prefix-etag) etag='"changed-v2"';; prefix-range) start=$((start+1));; prefix-encoding) encoding='Content-Encoding: gzip';; prefix-error) code=56;; esac
  fi
  # An intermediary advertises a misleading valid range; only final headers count.
  printf 'HTTP/1.1 302 Found\r\nETag: "fixture-v1"\r\nContent-Range: bytes 0-16/17\r\n\r\nHTTP/1.1 %s Test\r\nETag: %s\r\nContent-Range: bytes %s-%s/%s\r\nContent-Length: %s\r\n%s\r\n' "$status" "$etag" "$start" "$end" "$REMOTE_SIZE" "$length" "$encoding" > "$headers"
  truncate -s "$actual_length" "$output"
  # curl also rejects an ignored Range when the full response exceeds its cap.
  [[ "$MODE" != ignored ]] || return 63
  return "$code"
}
'''
            if resume:
                (root / 'ygopro-images-fixture.zip.part').write_bytes(b'prefix!')
                (root / 'ygopro-images-fixture.zip.headers').write_text('HTTP/1.1 200 OK\nETag: "fixture-v1"\n\n')
            fixture_path = root / 'download-fixture.sh'
            fixture_path.write_text(fixture + helpers + body + '\ndownload_images\n', encoding='utf-8', newline='\n')
            result = subprocess.run([BASH or 'bash', fixture_path.as_posix(), root.as_posix(), mode, str(size)], capture_output=True, text=True)
            requests = (root / 'requests').read_text() if (root / 'requests').exists() else ''
            partial = root / 'ygopro-images-fixture.zip.part'
            target = root / 'ygopro-images-fixture.zip'
            retained = partial.stat().st_size if partial.exists() else target.stat().st_size if target.exists() else 0
            return result, requests, retained, target.exists()

    def test_image_download_bounds_all_chunks_and_resets_consecutive_failure_budget(self) -> None:
        result, requests, size, completed = self.image_download_fixture('progress')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests.splitlines(), ['0-67108863'] * 6 + ['67108864-134217727'] * 6 + ['134217728-134217744'] * 6)
        self.assertEqual(size, 134217745)
        self.assertTrue(completed)

    def test_image_download_refuses_a_full_response_to_range(self) -> None:
        result, requests, size, completed = self.image_download_fixture('ignored', resume=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ignored Range', result.stderr)
        self.assertEqual(requests.splitlines(), ['7-16'])
        self.assertEqual(size, 7)
        self.assertFalse(completed)

    def test_image_download_rejects_changed_etag_or_range_without_losing_partial(self) -> None:
        for mode in ('etag', 'range'):
            with self.subTest(mode=mode):
                result, requests, size, completed = self.image_download_fixture(mode, resume=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(requests.splitlines(), ['7-16'] * 6)
                self.assertEqual(size, 7)
                self.assertFalse(completed)

    def test_image_download_advances_only_by_verified_interrupted_prefixes(self) -> None:
        result, requests, size, completed = self.image_download_fixture('prefix', resume=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(requests.splitlines(), ['7-16', '11-16', '14-16'])
        self.assertEqual(size, 17)
        self.assertTrue(completed)

    def test_image_download_never_appends_unsafe_interrupted_prefixes(self) -> None:
        for mode in ('prefix-etag', 'prefix-range', 'prefix-encoding', 'prefix-error'):
            with self.subTest(mode=mode):
                result, requests, size, completed = self.image_download_fixture(mode, resume=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(requests.splitlines(), ['7-16'] * 6)
                self.assertEqual(size, 7)
                self.assertFalse(completed)

    def test_image_download_does_not_publish_a_complete_but_invalid_zip(self) -> None:
        result, _, size, completed = self.image_download_fixture('crc', resume=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('full ZIP validation', result.stderr)
        self.assertEqual(size, 17)
        self.assertFalse(completed)

    def test_explicit_build_invokes_compiler_even_without_last_commit_native_changes(self) -> None:
        source = SCRIPT.read_text(encoding='utf-8')
        body = source[source.index('cmd_build() {'):source.index('\ncmd_test() {')]
        for client in (0, 1):
            fixture = f'''ROOT_DIR=/fixture; STATE_DIR=/fixture/state; SKIP_BUILD=0; CLIENT={client}; DRY_RUN=1
state_init() {{ :; }}
info() {{ :; }}
git() {{ return 0; }}
run() {{ printf 'COMPILER %s\\n' "$*"; }}
'''
            result = subprocess.run([BASH or 'bash', '-c', 'set -e\n' + fixture + body + '\ncmd_build'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('COMPILER bash /fixture/scripts/build-ygopro.sh', result.stdout)
            self.assertEqual('--client' in result.stdout, bool(client))

    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["YGOCUBE_CACHE_DIR"] = "/tmp/ygocube-card-resource-test-cache"
        command = [str(SCRIPT), *args] if os.name != "nt" else [BASH or "bash", str(SCRIPT), *args]
        return subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True)

    def git_status(self) -> str:
        return subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True)

    def test_server_payload_excludes_raw_expansion_images(self) -> None:
        import json
        import tempfile
        # Exercise the actual payload copier against a tiny managed expansion.
        script = SCRIPT.read_text()
        start = script.index('import json, os, shutil, sys\nsd, ad, ed, bd =')
        body = script[start:script.index('\nPY\n', start)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base, payload = root / 'source', root / 'payload'
            files = ['test-release.cdb', 'script/c123.lua', 'pics/123.jpg']
            banlist_files = ['lflist.conf', 'expansions/lflist.conf']
            for name in files:
                source = base / 'srvpro/ygopro/expansions' / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(b'fixture')
            (base / 'srvpro/ygopro/lflist.conf').parent.mkdir(parents=True, exist_ok=True)
            (base / 'srvpro/ygopro/lflist.conf').write_bytes(b'# upstream\n')
            (base / 'srvpro/ygopro/expansions/lflist.conf').write_bytes(b'# upstream\n')
            (payload / 'deletes').mkdir(parents=True)
            deltas = []
            for index in range(4):
                delta = root / f'delta{index}.json'
                changed = files if index == 2 else banlist_files if index == 3 else []
                delta.write_text(json.dumps({'changed': changed, 'removed': []}))
                deltas.append(str(delta))
            result = subprocess.run([sys.executable, '-c', body, *deltas, str(payload), str(base)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((payload / 'srvpro/ygopro/expansions/test-release.cdb').is_file())
            self.assertTrue((payload / 'srvpro/ygopro/expansions/script/c123.lua').is_file())
            self.assertFalse((payload / 'srvpro/ygopro/expansions/pics/123.jpg').exists())
            self.assertTrue((payload / 'srvpro/ygopro/lflist.conf').is_file())
            self.assertTrue((payload / 'srvpro/ygopro/expansions/lflist.conf').is_file())

    def test_dry_run_prepare_is_non_mutating(self) -> None:
        import tempfile
        # A clean CI checkout has no runtime cards or initialized submodules.
        # Exercise the real command against a private fixture, never the user's
        # resource tree. Dry-run must not open or validate the dummy CDB.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'ygopro/script').mkdir(parents=True)
            script = root / 'scripts/update-card-resources.sh'
            shutil.copy2(SCRIPT, script)
            def run(*extra):
                return subprocess.run([BASH or 'bash', str(script), '--dry-run', 'prepare', '--skip-images', *extra], cwd=root, text=True, capture_output=True)
            self.assertNotEqual(run().returncode, 0)
            (root / 'ygopro/cards.cdb').write_bytes(b'dry-run fixture: do not open')
            snapshot = lambda: {str(p.relative_to(root)): p.read_bytes() if p.is_file() else None for p in root.rglob('*')}
            before = snapshot()
            for extra in [(), ('--expansion',)]:
                result = run(*extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('expansion', result.stdout)
                self.assertEqual(snapshot(), before)

    def test_dry_run_deploy_requires_confirmation_but_does_not_connect(self) -> None:
        missing = self.run_script("--dry-run", "deploy")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--confirm-maintenance", missing.stderr)
        result = self.run_script("--dry-run", "deploy", "--confirm-maintenance")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("ssh", result.stdout.lower())

    def test_dry_run_sync_does_not_fetch_or_modify(self) -> None:
        before = self.git_status()
        result = self.run_script("--dry-run", "sync")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would verify", result.stdout)
        self.assertEqual(self.git_status(), before)

    def test_remote_apply_rejects_broad_or_unsafe_targets(self) -> None:
        for root, release in (("/", "safe"), ("/opt/ygocube", "../unsafe")):
            result = subprocess.run(
                ([str(REMOTE_APPLY), "--root", root, "--id", release]
                 if os.name != "nt" else [BASH or "bash", str(REMOTE_APPLY), "--root", root, "--id", release]),
                cwd=ROOT,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid root or release id", result.stderr)

    def test_rollback_rejects_unsafe_backup_identifier(self) -> None:
        result = self.run_script("--dry-run", "rollback", "--backup-id", "../latest")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("safe identifier", result.stderr)

    def test_rollback_propagates_first_ssh_failure_in_conditional_context(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        body = source[source.index('remote_rollback() {'):source.index('\nremote_health() {')]
        fixture = '''
ROOT_DIR=/fixture; ALY_ROOT=/opt/ygocube; ALY_DUEL_ROOT=/opt/ygoduel; RELEASE_ID=fixture
info() { :; }
calls=0
ssh_exec() { calls=$((calls + 1)); if [ "$calls" = 1 ]; then return 7; fi; return 0; }
ssh_upload() { return 0; }
refresh_server_baseline() { return 0; }
'''
        result = subprocess.run([BASH or "bash", "-c", 'set -e\n' + fixture + body + '\nremote_rollback fixture || exit $?'], text=True, capture_output=True)
        self.assertEqual(result.returncode, 7, result.stderr)

    def test_rollback_propagates_upload_failure(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        body = source[source.index('remote_rollback() {'):source.index('\nremote_health() {')]
        fixture = '''
ROOT_DIR=/fixture; ALY_ROOT=/opt/ygocube; ALY_DUEL_ROOT=/opt/ygoduel; RELEASE_ID=fixture
info() { :; }
ssh_exec() { return 0; }
ssh_upload() { return 13; }
refresh_server_baseline() { return 0; }
'''
        result = subprocess.run([BASH or "bash", "-c", 'set -e\n' + fixture + body + '\nremote_rollback fixture || exit $?'], text=True, capture_output=True)
        self.assertEqual(result.returncode, 13, result.stderr)

    def test_server_baseline_replaces_stale_local_deploy_record(self) -> None:
        import json
        import tempfile
        source = SCRIPT.read_text(encoding="utf-8")
        start = source.index('import json, os, pathlib, re, sys\noutput = ')
        body = source[start:source.index('\nPYBASE\n', start)]
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            record = state / 'deployed-resource-manifest.json'
            record.write_text(json.dumps({'cards': {'sha256': 'stale'}}))
            actual = {'cards': {'sha256': 'restored'}, 'expansions': {'files': {'restored.lua': {'sha256': 'a'}}}}
            response = state / 'server.txt'
            stdout = 'YGOCUBE_MANIFEST_SHA=' + 'a' * 64 + '\nYGOCUBE_MANIFEST_JSON=' + json.dumps(actual) + '\n'
            for output in [stdout, json.dumps({'success': True, 'exit_code': 0, 'stdout': stdout})]:
                response.write_text(output)
                result = subprocess.run([sys.executable, '-c', body, str(response), str(state)], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(record.read_text()), actual)
                self.assertEqual((state / 'expected-server-manifest.sha256').read_text().strip(), 'a' * 64)

    @unittest.skipIf(os.name == "nt", "Linux deployment lock and tool fixture")
    def test_pair_rollback_stops_on_duel_failure_before_cube_restore(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cube, duel, commands = root / 'cube', root / 'duel', root / 'commands'
            backup = cube / 'backups/card-sync-fixture'
            for directory in [backup / 'srvpro-ygopro', backup / 'pics_avif', duel, commands, cube / 'shared/srvpro/ygopro']:
                directory.mkdir(parents=True, exist_ok=True)
            (backup / 'resource-manifest.json').write_text('{}')
            live = cube / 'shared/srvpro/ygopro/live.cdb'
            live.write_text('current resource')
            transaction = root / 'transaction.sh'
            shutil.copyfile(SCRIPT.with_name('remote-resource-transaction.sh'), transaction)
            (root / 'apply-duel.py').write_text('# fixture')
            python = commands / 'python3'
            python.write_text('#!/usr/bin/env bash\nfor arg in "$@"; do if [ "$arg" = --rollback ]; then exit 17; fi; done\nexit 0\n')
            systemctl = commands / 'systemctl'
            systemctl.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SERVICE_LOG"\n')
            python.chmod(0o755); systemctl.chmod(0o755)
            env = {**os.environ, 'PATH': str(commands) + os.pathsep + os.environ['PATH'], 'SERVICE_LOG': str(root / 'services.log')}
            result = subprocess.run([BASH or 'bash', str(transaction), 'rollback', '--cube-root', str(cube), '--duel-root', str(duel), '--id', 'fixture'], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 17, result.stderr)
            self.assertEqual(live.read_text(), 'current resource')
            self.assertNotIn('start ', (root / 'services.log').read_text())
            self.assertIn('stop ygocube', (root / 'services.log').read_text())

    @unittest.skipIf(os.name == "nt", "Linux deployment lock and tool fixture")
    def test_failed_pair_apply_never_reopens_ingress_before_recovery(self) -> None:
        import hashlib
        import tempfile
        for fail_rollback in (False, True):
            with self.subTest(fail_rollback=fail_rollback), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                cube, duel, commands = root / 'cube', root / 'duel', root / 'commands'
                stage = cube / '.staging/card-sync-fixture'
                backup = cube / 'backups/card-sync-fixture'
                for directory in (stage, commands, duel, cube / 'shared/assets/pics_avif', cube / 'shared/srvpro/ygopro', backup / 'srvpro-ygopro', backup / 'pics_avif'):
                    directory.mkdir(parents=True, exist_ok=True)
                for filename in ('resource-manifest.json', 'ygocdb_cards.json'):
                    (cube / 'shared/assets' / filename).write_text('{}')
                    (backup / filename).write_text('{}')
                (backup / 'RESOURCES_BACKED_UP').touch()
                (stage / 'expected-server-manifest.sha256').write_text(hashlib.sha256(b'{}').hexdigest())
                (stage / 'apply.sh').write_text('#!/bin/bash\nexit 0\n')
                shutil.copyfile(SCRIPT.with_name('remote-resource-transaction.sh'), root / 'transaction.sh')
                (root / 'apply-duel.py').write_text('# fixture')
                fake_python = '#!/bin/bash\nprintf "helper %s\\n" "$*" >> "$SERVICE_LOG"\n'
                fake_python += 'case "$*" in *--rollback*) exit ' + ('19' if fail_rollback else '0') + ';; *--enter-maintenance*|*--relink-current-to-cube*|*--verify-current*|*--verify-live*|*--record-components*|*--close-ingress*|*--open-ingress*) exit 0;; *) exit 17;; esac\n'
                for name, text in {'python3': fake_python, 'systemctl': '#!/bin/bash\nprintf "service %s\\n" "$*" >> "$SERVICE_LOG"\n', 'sqlite3': '#!/bin/bash\nexit 0\n', 'chown': '#!/bin/bash\nexit 0\n'}.items():
                    (commands / name).write_text(text)
                    (commands / name).chmod(0o755)
                log = root / 'services.log'
                env = {**os.environ, 'PATH': str(commands) + os.pathsep + os.environ['PATH'], 'SERVICE_LOG': str(log)}
                result = subprocess.run([BASH or 'bash', str(root / 'transaction.sh'), 'apply', '--cube-root', str(cube), '--duel-root', str(duel), '--id', 'fixture'], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 17, result.stderr)
                calls = log.read_text()
                if fail_rollback:
                    self.assertNotIn('service start ', calls)
                    self.assertNotIn('--open-ingress', calls)
                    self.assertFalse((backup / 'ROLLED_BACK').exists())
                else:
                    self.assertLess(calls.index('--verify-current'), calls.index('service start '))
                    self.assertLess(calls.index('--verify-live'), calls.index('--open-ingress'))
                    self.assertTrue((backup / 'ROLLED_BACK').exists())
                self.assertFalse((backup / 'COMPLETED').exists())


if __name__ == "__main__":
    unittest.main()
