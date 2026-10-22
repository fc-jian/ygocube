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
from unittest.mock import MagicMock, patch


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
    def make_resources(self, release: Path) -> None:
        for name in ('srvpro/ygopro/cards.cdb', 'srvpro/ygopro/strings.conf', 'srvpro/ygopro/lflist.conf',
                     'srvpro/ygopro/expansions/lflist.conf', 'srvpro/ygopro/script/c123.lua',
                     'assets/ygocdb_cards.json', 'assets/pics_avif/123.avif'):
            path = release / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'original resource')

    def test_ingress_gate_covers_ipv4_ipv6_and_keeps_loopback_probes(self) -> None:
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            cube, duel = Path(directory) / 'cube', Path(directory) / 'duel'
            (cube / 'shared').mkdir(parents=True)
            rules = set()
            def execute(*args):
                operation = args[3]
                key = (args[0], tuple(args[6:] if operation == '-I' else args[5:]))
                if operation == '-I': rules.add(key)
                elif operation == '-D': rules.remove(key)
                return ''
            def probe(args, **kwargs):
                return subprocess.CompletedProcess(args, 0 if (args[0], tuple(args[5:])) in rules else 1)
            with patch.object(REMOTE, 'parse_config', return_value={'srvpro': {'game_port': 8911}, 'server': {'port': 3101}}), patch.object(REMOTE.shutil, 'which', side_effect=lambda name: '/sbin/' + name), patch.object(REMOTE, 'run', side_effect=execute), patch.object(REMOTE.subprocess, 'run', side_effect=probe):
                REMOTE.maintenance_ingress(cube, duel, close=True)
                REMOTE.maintenance_ingress(cube, duel, close=True)
                self.assertEqual(len(rules), 2)
                self.assertTrue(any('127.0.0.1/32' in rule for _, rule in rules))
                self.assertTrue(any('::1/128' in rule for _, rule in rules))
                self.assertTrue(all('3000,3100,3101,8911' in rule for _, rule in rules))
                REMOTE.maintenance_ingress(cube, duel, close=False)
                self.assertFalse(rules)
                self.assertFalse((cube / 'shared/card-maintenance-ingress.json').exists())

    def test_component_inventory_detects_changes_and_preserves_component_sources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            (old / 'api/dist').mkdir(parents=True)
            (old / 'web/apps/web/.next/static').mkdir(parents=True)
            (old / 'api/dist/main.js').write_text('old-api')
            (old / 'web/apps/web/.next/static/test.js').write_text('old-web')
            (old / 'release.json').write_text(json.dumps({'sourceCommit': 'old-source'}))
            self.make_resources(old)
            import shutil
            shutil.copytree(old, new, copy_function=REMOTE.hardlink_file)
            REMOTE.atomic_write_text(new / 'api/dist/main.js', 'new-api')
            REMOTE.record_components(new, {'api': 'new-source'}, previous=old)
            declared = json.loads((new / 'release.json').read_text())['components']
            self.assertEqual(declared['api']['sourceCommit'], 'new-source')
            self.assertEqual(declared['web']['sourceCommit'], 'old-source')
            self.assertNotIn('components', json.loads((old / 'release.json').read_text()))
            self.assertEqual(declared, REMOTE.describe_components(new))
            REMOTE.atomic_write_text(new / 'api/dist/main.js', 'tampered')
            self.assertNotEqual(declared['api']['sha256'], REMOTE.describe_components(new)['api']['sha256'])
            REMOTE.record_components(new, {'web': None})
            self.assertIsNone(REMOTE.describe_components(new)['web']['sourceCommit'])
            self.assertEqual(REMOTE.describe_components(new)['web']['sourceEvidence'], 'unknown')

    def test_resource_inventory_hashes_content_and_rejects_missing_required_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            (release / 'release.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'missing required file'):
                REMOTE.record_components(release)
            self.make_resources(release)
            (release / 'assets/resource-manifest.json').write_text('{"unchanged":"manifest"}')
            REMOTE.record_components(release)
            declared = json.loads((release / 'release.json').read_text())['components']['resources']
            self.assertGreater(declared['fileCount'], 0)
            for name in ('srvpro/ygopro/cards.cdb', 'srvpro/ygopro/script/c123.lua', 'assets/pics_avif/123.avif', 'assets/ygocdb_cards.json'):
                path = release / name
                path.write_bytes(b'changed without editing manifest')
                self.assertNotEqual(REMOTE.describe_components(release)['resources']['sha256'], declared['sha256'])
                path.write_bytes(b'original resource')
            (release / 'assets/pics_avif/123.avif').unlink()
            with self.assertRaisesRegex(RuntimeError, 'missing required files: pics_avif'):
                REMOTE.describe_components(release)

    def test_resource_inventory_reads_shared_config_and_maps_current_to_staged_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shared, release = root / 'shared', root / 'releases/new'
            self.make_resources(shared)
            self.make_resources(release)
            (shared / 'config.yaml').write_text('fixture configuration')
            config = {'server': {'cards_cdb': str(shared / 'srvpro/ygopro/cards.cdb'),
                                 'card_names_json': str(root / 'current/assets/ygocdb_cards.json')},
                      'pics': {'avif_dir': str(shared / 'assets/pics_avif')}}
            (release / 'assets/ygocdb_cards.json').write_bytes(b'candidate names')
            with patch.object(REMOTE, 'parse_config', return_value=config):
                actual = REMOTE.resource_component_files(release)
            self.assertEqual(actual['ygocdb_cards.json'], hashlib.sha256(b'candidate names').hexdigest())
            self.assertEqual(actual['cards.cdb'], REMOTE.sha256(shared / 'srvpro/ygopro/cards.cdb'))

    def test_application_stop_pauses_both_creators_but_only_stops_selected_services(self) -> None:
        events = []
        guard = REMOTE.ApplicationMaintenance(Path('/fixture/cube'), Path('/fixture/duel'), ['ygoduel-api'])
        def run(*args):
            events.append(args)
            return '123' if 'ygoduel-api' in args and 'show' in args else '456' if 'show' in args else ''
        def occupied():
            events.append(('host-check',))
            return False
        with patch.object(REMOTE, 'run', side_effect=run), patch.object(guard, 'occupied', side_effect=occupied), \
             patch.object(REMOTE.os, 'kill', side_effect=lambda *args: events.append(args)), \
             patch.object(REMOTE.signal, 'SIGSTOP', 19, create=True), patch.object(REMOTE.signal, 'SIGCONT', 18, create=True):
            guard.stop_services()
        self.assertLess(events.index((123, 19)), events.index(('host-check',)))
        self.assertLess(events.index((456, 19)), events.index(('host-check',)))
        self.assertIn(('systemctl', 'stop', 'ygoduel-api'), events)
        self.assertNotIn(('systemctl', 'stop', 'ygoduel-srvpro'), events)
        self.assertIn((456, 18), events)

    def test_application_activation_failure_preserves_raced_game_or_verifies_rollback(self) -> None:
        from types import SimpleNamespace
        # Execute the real activation/recovery block, with only services,
        # databases and pointer switching replaced by isolated test doubles.
        source = SCRIPT.with_name('deploy-card-details.py').read_text(encoding='utf-8')
        body = source[source.index('maintenance = None if a.web_only'):source.index("result={'ok':True")]
        for raced in (False, True):
            with self.subTest(raced=raced), tempfile.TemporaryDirectory() as directory:
                roots = {name: Path(directory) / name for name in ('ygocube', 'ygoduel')}
                olds = {name: root / 'old' for name, root in roots.items()}
                news = {name: root / 'new' for name, root in roots.items()}
                services = [name + '-' + component for name in roots for component in ('api', 'srvpro', 'web')]
                calls = []
                def run(*args):
                    calls.append(('run', args))
                    return '123' if 'show' in args else ''
                health_calls = []
                def health():
                    health_calls.append(True)
                    if len(health_calls) == 1:
                        raise ValueError('public verification failed')
                database = MagicMock()
                database.connect.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = ('ok',)
                switches = []
                env = {'a': SimpleNamespace(web_only=False, windbot_root=None, release='fixture'),
                       'resource_apply': REMOTE, 'roots': roots, 'olds': olds, 'news': news,
                       'services': services, 'run': run, 'sqlite3': database, 'health': health,
                       'switch': lambda root, target: switches.append((root, target))}
                with patch.object(REMOTE.ApplicationMaintenance, 'occupied', side_effect=[False, False, raced]), \
                     patch.object(REMOTE, 'maintenance_ingress') as gate, patch.object(REMOTE, 'run', side_effect=run), \
                     patch.object(REMOTE.os, 'kill'), patch.object(REMOTE.signal, 'SIGSTOP', 19, create=True), \
                     patch.object(REMOTE.signal, 'SIGCONT', 18, create=True):
                    expected = RuntimeError if raced else ValueError
                    with self.assertRaises(expected):
                        exec(compile(body, 'application-activation-fixture', 'exec'), env)
                restarts = [args for _, args in calls if args[:2] == ('systemctl', 'restart')]
                if raced:
                    self.assertEqual(switches, [(roots[name], news[name]) for name in roots])
                    self.assertFalse(restarts)
                    self.assertEqual(len(health_calls), 1)
                else:
                    self.assertEqual(switches[-2:], [(roots[name], olds[name]) for name in roots])
                    self.assertEqual(len(restarts), 1)
                    self.assertEqual(len(health_calls), 2)
                self.assertFalse(gate.call_args.kwargs['close'])

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
            self.make_resources(old)
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
            connection.close()
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
            connection.close()

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
