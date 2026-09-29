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


if __name__ == "__main__":
    unittest.main()
