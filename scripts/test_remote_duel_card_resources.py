#!/usr/bin/env python3
"""Focused safety tests for remote independent-Duel resource publishing."""

from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("remote-duel-resource-apply.py")
SPEC = importlib.util.spec_from_file_location("remote_duel_resource_apply", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)

PACKAGE_SPEC = importlib.util.spec_from_file_location(
    "package_card_resource_payload", Path(__file__).with_name("package-card-resource-payload.py")
)
assert PACKAGE_SPEC is not None and PACKAGE_SPEC.loader is not None
PACKAGE = importlib.util.module_from_spec(PACKAGE_SPEC)
PACKAGE_SPEC.loader.exec_module(PACKAGE)


class RemoteDuelResourceApplyTests(unittest.TestCase):
    def test_resource_payload_archive_contains_files_without_directory_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "payload"
            (payload / "srvpro" / "ygopro").mkdir(parents=True)
            (payload / "assets" / "pics_avif").mkdir(parents=True)
            (payload / "srvpro" / "ygopro" / "cards.cdb").write_bytes(b"cdb fixture")
            (payload / "assets" / "pics_avif" / "1.avif").write_bytes(b"avif fixture")
            archive_path = root / "payload.tar.gz"

            PACKAGE.package_payload(payload, archive_path)

            with tarfile.open(archive_path, "r:gz") as archive:
                members = archive.getmembers()
            self.assertEqual({member.name for member in members}, {
                "assets/pics_avif/1.avif",
                "srvpro/ygopro/cards.cdb",
            })
            self.assertTrue(all(member.isfile() for member in members))

    def test_atomic_write_does_not_mutate_hardlinked_previous_release(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = root / "previous.json"
            release = root / "release.json"
            previous.write_text('{"version":1}\n', encoding="utf-8")
            os.link(previous, release)

            REMOTE.atomic_write_text(release, '{"version":2}\n')

            self.assertEqual(previous.read_text(encoding="utf-8"), '{"version":1}\n')
            self.assertEqual(release.read_text(encoding="utf-8"), '{"version":2}\n')
            self.assertNotEqual(previous.stat().st_ino, release.stat().st_ino)

    def test_identical_copy_keeps_hardlink_and_changed_copy_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.lua"
            destination = root / "release" / "source.lua"
            source.write_text("return 1\n", encoding="utf-8")
            destination.parent.mkdir()
            os.link(source, destination)

            REMOTE.checked_copy_file(source, destination)
            self.assertEqual(source.stat().st_ino, destination.stat().st_ino)

            updated = root / "updated.lua"
            updated.write_text("return 2\n", encoding="utf-8")
            os.replace(updated, source)
            REMOTE.checked_copy_file(source, destination)
            self.assertEqual(destination.read_text(encoding="utf-8"), "return 2\n")
            self.assertNotEqual(source.stat().st_ino, destination.stat().st_ino)

    def test_avif_directory_fingerprint_matches_manifest_and_detects_extras(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "100000001.avif"
            image.write_bytes(b"avif fixture")
            checksum = hashlib.sha256(image.read_bytes()).hexdigest()
            manifest = {image.name: {"sha256": checksum, "size": image.stat().st_size}}

            expected = REMOTE.manifest_tree_fingerprint(manifest)
            self.assertEqual(REMOTE.directory_fingerprint(root), expected)
            (root / "unexpected.avif").write_bytes(b"extra")
            self.assertNotEqual(REMOTE.directory_fingerprint(root), expected)

    def test_compressed_card_art_rejects_raw_images_and_oversized_avif(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host = root / "ygopro"
            avif = root / "pics_avif"
            host.mkdir()
            avif.mkdir()
            (avif / "1.avif").write_bytes(b"small avif")
            REMOTE.verify_compressed_card_art(host, avif)

            raw = host / "expansions" / "pics" / "1.jpg"
            raw.parent.mkdir(parents=True)
            raw.write_bytes(b"raw image")
            with self.assertRaisesRegex(RuntimeError, "uncompressed card-image directory"):
                REMOTE.verify_compressed_card_art(host, avif)
            REMOTE.remove_raw_card_images(host)

            (avif / "large.avif").write_bytes(b"0" * (64 * 1024 + 1))
            with self.assertRaisesRegex(RuntimeError, "exceeds the compressed-size limit"):
                REMOTE.verify_compressed_card_art(host, avif)


if __name__ == "__main__":
    unittest.main()
