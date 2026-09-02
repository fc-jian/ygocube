#!/usr/bin/env python3
"""CLI-level safety checks for update-card-resources.sh."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "update-card-resources.sh"
REMOTE_APPLY = ROOT / "scripts" / "remote-resource-apply.sh"


class UpdateScriptTests(unittest.TestCase):
    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["YGOCUBE_CACHE_DIR"] = "/tmp/ygocube-card-resource-test-cache"
        return subprocess.run([str(SCRIPT), *args], cwd=ROOT, env=env, text=True, capture_output=True)

    def git_status(self) -> str:
        return subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True)

    def test_dry_run_prepare_is_non_mutating(self) -> None:
        before = self.git_status()
        result = self.run_script("--dry-run", "prepare", "--skip-images")
        self.assertEqual(result.returncode, 0, result.stderr)
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
                [str(REMOTE_APPLY), "--root", root, "--id", release],
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
