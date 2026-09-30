#!/usr/bin/env python3
"""Focused safety tests for remote independent-Duel resource publishing."""

from __future__ import annotations

import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import signal
import sqlite3
import unittest
from unittest.mock import patch


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
    def test_banlist_api_names_keep_upstream_calendar_dates(self) -> None:
        self.assertEqual(REMOTE.banlist_api_name("2026.10"), "2026.10.01 OCG")
        self.assertEqual(REMOTE.banlist_api_name("2026.9 TCG"), "2026.09.01 TCG")
        self.assertEqual(REMOTE.banlist_api_name("2025.04.01 OCG"), "2025.04.01 OCG")

    @unittest.skipIf(os.name == "nt", "Linux systemd signals")
    def test_maintenance_preserves_a_host_that_appears_during_preparation(self) -> None:
        with patch.object(REMOTE, "active_standalone_host", side_effect=[False, True]), \
             patch.object(REMOTE, "run", side_effect=lambda *args: "123" if "MainPID" in args else "") as run, \
             patch.object(REMOTE.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "maintenance was cancelled"):
                REMOTE.enter_maintenance()
        self.assertEqual([call.args for call in kill.call_args_list], [(123, signal.SIGSTOP), (123, signal.SIGCONT)])
        self.assertNotIn(("systemctl", "stop", "ygoduel-srvpro"), [call.args for call in run.call_args_list])
        self.assertIn(("systemctl", "start", "ygoduel-api"), [call.args for call in run.call_args_list])

    @unittest.skipIf(os.name == "nt", "Linux systemd signals")
    def test_maintenance_pauses_acceptor_before_final_host_check(self) -> None:
        events = []
        def occupied():
            events.append("host-check")
            return False
        with patch.object(REMOTE, "active_standalone_host", side_effect=occupied), \
             patch.object(REMOTE, "run", side_effect=lambda *args: "123" if "MainPID" in args else events.append(args) or ""), \
             patch.object(REMOTE.os, "kill", side_effect=lambda *args: events.append(args)):
            REMOTE.enter_maintenance()
        self.assertLess(events.index((123, signal.SIGSTOP)), len(events) - 1)
        self.assertEqual(events[-2:], ["host-check", ("systemctl", "stop", "ygoduel-srvpro")])

    def test_application_archive_preserves_previous_hardlinked_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, new = root / "old", root / "new"
            old.mkdir()
            (old / "application.js").write_bytes(b"old application")
            (old / "cards.cdb").write_bytes(b"shared resource")
            REMOTE.shutil.copytree(old, new, copy_function=REMOTE.hardlink_file)
            archive_path = root / "application.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                member = tarfile.TarInfo("application.js")
                member.size = len(b"new application")
                archive.addfile(member, io.BytesIO(b"new application"))
            REMOTE.extract_application_archive(archive_path, new)
            self.assertEqual((old / "application.js").read_bytes(), b"old application")
            self.assertEqual((new / "application.js").read_bytes(), b"new application")
            self.assertEqual((old / "cards.cdb").stat().st_ino, (new / "cards.cdb").stat().st_ino)

    def test_srvpro_application_install_preserves_old_release(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage, old, new = root / "stage", root / "old", root / "new"
            (stage / "metadata").mkdir(parents=True)
            (stage / "application/srvpro").mkdir(parents=True)
            (old / "srvpro").mkdir(parents=True)
            (old / "release.json").write_text('{"id":"old"}', encoding="utf-8")
            files = {}
            for name in ["ygopro-server.js", "cube-banlists.js"]:
                content = b"new server"
                (stage / "application/srvpro" / name).write_bytes(content)
                (old / "srvpro" / name).write_bytes(b"old server")
                files[name] = {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            REMOTE.shutil.copytree(old, new, copy_function=REMOTE.hardlink_file)
            (stage / "metadata/srvpro-application.json").write_text(json.dumps({"files": files}), encoding="utf-8")
            with patch.object(REMOTE, "run"):
                REMOTE.install_srvpro_application(stage, new)
            self.assertEqual((old / "srvpro/ygopro-server.js").read_bytes(), b"old server")
            self.assertEqual((new / "srvpro/ygopro-server.js").read_bytes(), b"new server")
            self.assertNotIn("srvproApplication", json.loads((old / "release.json").read_text()))
            self.assertIn("srvproApplication", json.loads((new / "release.json").read_text()))

    def test_rollback_invalidates_derived_catalogue_without_restoring_player_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous, current = root / 'releases/old', root / 'releases/new'
            previous.mkdir(parents=True); current.mkdir()
            backup = root / 'backups/card-sync-fixture'
            backup.mkdir(parents=True)
            (backup / 'previous-release.txt').write_text(str(previous))
            (backup / 'config.yaml').write_text('restored config')
            (root / 'shared/data').mkdir(parents=True)
            (root / 'shared/config.yaml').write_text('current config')
            database = root / 'shared/data/duel.sqlite'
            with sqlite3.connect(database) as connection:
                connection.execute('create table cards(metadata_version integer)')
                connection.execute('insert into cards values(6)')
                connection.execute('create table players(name text)')
                connection.execute("insert into players values('preserve me')")
            try:
                (root / 'current').symlink_to(current, target_is_directory=True)
            except OSError:
                self.skipTest('directory symlinks unavailable in this Windows sandbox')
            with patch.object(REMOTE, 'enter_maintenance'):
                REMOTE.rollback(root, 'fixture', defer_start=True)
            self.assertEqual((root / 'current').resolve(), previous)
            with sqlite3.connect(database) as connection:
                self.assertEqual(connection.execute('select metadata_version from cards').fetchone()[0], 0)
                self.assertEqual(connection.execute('select name from players').fetchone()[0], 'preserve me')

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

    def test_release_ownership_skips_shared_hardlinks_and_uses_supported_chown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = root / "release"
            release.mkdir()
            shared_source = root / "shared.js"
            shared_source.write_text("shared\n", encoding="utf-8")
            shared_release = release / "shared.js"
            os.link(shared_source, shared_release)
            unique_file = release / "release.json"
            unique_file.write_text("{}\n", encoding="utf-8")

            with patch.object(REMOTE.shutil, "chown") as chown:
                REMOTE.set_release_ownership(release)

            paths = [Path(call.args[0]) for call in chown.call_args_list]
            self.assertIn(release, paths)
            self.assertIn(unique_file, paths)
            self.assertNotIn(shared_release, paths)
            self.assertTrue(all("follow_symlinks" not in call.kwargs for call in chown.call_args_list))

    def test_identical_and_changed_resources_are_hardlinked_to_cube(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.cdb"
            destination = root / "release" / "source.cdb"
            source.write_text("return 1\n", encoding="utf-8")
            destination.parent.mkdir()
            destination.write_text("duplicate old copy\n", encoding="utf-8")

            REMOTE.link_resource_file(source, destination)
            self.assertEqual(source.stat().st_ino, destination.stat().st_ino)
            self.assertEqual(source.stat().st_dev, destination.stat().st_dev)

            updated = root / "updated.lua"
            updated.write_text("return 2\n", encoding="utf-8")
            os.replace(updated, source)
            REMOTE.link_resource_file(source, destination)
            self.assertEqual(destination.read_text(encoding="utf-8"), "return 2\n")
            self.assertEqual(source.stat().st_ino, destination.stat().st_ino)

    def test_cross_device_resource_link_fails_without_copying(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.cdb"
            destination = root / "release" / "source.cdb"
            source.write_bytes(b"verified source")
            destination.parent.mkdir()
            destination.write_bytes(b"old destination")

            with patch.object(REMOTE.os, "link", side_effect=OSError(errno.EXDEV, "cross-device link")):
                with self.assertRaisesRegex(RuntimeError, "refusing to copy"):
                    REMOTE.link_resource_file(source, destination)

            self.assertEqual(destination.read_bytes(), b"old destination")
            self.assertEqual(list(destination.parent.iterdir()), [destination])

    def test_hardlink_helper_fails_on_cross_device(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.lua"
            destination = Path(temporary) / "release.lua"
            source.write_text("return 1\n", encoding="utf-8")

            with patch.object(REMOTE.os, "link", side_effect=OSError(errno.EXDEV, "cross-device link")):
                with self.assertRaisesRegex(RuntimeError, "refusing a duplicate copy"):
                    REMOTE.hardlink_file(str(source), str(destination))

            self.assertFalse(destination.exists())

    def test_resource_set_hardlinks_cube_and_duel_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_host = root / "cube" / "srvpro" / "ygopro"
            target_host = root / "duel" / "srvpro" / "ygopro"
            source_assets = root / "cube" / "assets"
            target_assets = root / "duel" / "assets"
            contents = {
                "cards.cdb": b"main database",
                "strings.conf": b"strings",
                "lflist.conf": b"root banlist",
                "expansions/lflist.conf": b"expansion banlist",
                "script/card.lua": b"return 1",
                "expansions/super-pre.cdb": b"expansion database",
            }
            for relative, content in contents.items():
                source = source_host / relative
                target = target_host / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                target.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(content)
                target.write_bytes(content)
            source_assets.mkdir(parents=True)
            target_assets.mkdir(parents=True)
            for asset_name, content in (("ygocdb_cards.json", b"{}"), ("pics_avif/1.avif", b"avif")):
                source = source_assets / asset_name
                target = target_assets / asset_name
                source.parent.mkdir(parents=True, exist_ok=True)
                target.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(content)
                target.write_bytes(content)

            def metadata(path: Path) -> dict[str, int | str]:
                content = path.read_bytes()
                return {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}

            manifest = {
                "scripts": {"files": {"card.lua": metadata(source_host / "script/card.lua")}},
                "expansions": {
                    "files": {
                        "super-pre.cdb": metadata(source_host / "expansions/super-pre.cdb"),
                        "lflist.conf": metadata(source_host / "expansions/lflist.conf"),
                    }
                },
                "avif": {"files": {"1.avif": metadata(source_assets / "pics_avif/1.avif")}},
            }
            self.assertTrue(
                REMOTE.managed_resource_sets_match(
                    source_host, target_host, source_assets, target_assets, manifest
                )
            )
            checked = REMOTE.hardlink_resource_set(
                source_host, target_host, source_assets, target_assets, manifest
            )
            self.assertGreaterEqual(checked, 9)
            for relative in contents:
                self.assertEqual(
                    (source_host / relative).stat().st_ino,
                    (target_host / relative).stat().st_ino,
                )
            self.assertEqual(
                (source_assets / "ygocdb_cards.json").stat().st_ino,
                (target_assets / "ygocdb_cards.json").stat().st_ino,
            )
            self.assertEqual(
                (source_assets / "pics_avif/1.avif").stat().st_ino,
                (target_assets / "pics_avif/1.avif").stat().st_ino,
            )

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
