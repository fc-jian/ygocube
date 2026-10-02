#!/usr/bin/env python3
"""CLI-level safety checks for update-card-resources.sh."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "update-card-resources.sh"
REMOTE_APPLY = ROOT / "scripts" / "remote-resource-apply.sh"
BASH = os.environ.get("YGOCUBE_TEST_BASH") or shutil.which("bash")


class UpdateScriptTests(unittest.TestCase):
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
        before = self.git_status()
        result = self.run_script("--dry-run", "prepare", "--skip-images")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git_status(), before)
        expansion = self.run_script("--dry-run", "prepare", "--skip-images", "--expansion")
        self.assertEqual(expansion.returncode, 0, expansion.stderr)
        self.assertIn("expansion", expansion.stdout)
        self.assertEqual(self.git_status(), before)

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
