#!/usr/bin/env python3
"""Unit tests for scripts/card_resources.py (no network or Git required)."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
import zipfile

from card_resources import (
    build_resource_manifest,
    compare_cdb_files,
    generate_avif,
    manifest_delta,
    missing_names,
    extract_expansion_zip,
    sync_managed_scripts,
    sync_managed_expansions,
    validate_cdb,
    validate_expansion_list,
    validate_expansion_release,
    validate_expansion_zip,
    validate_image_zip,
    merge_name_zip,
)


class CardResourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_cdb(self, path: Path, codes: list[tuple[int, int]]) -> None:
        with sqlite3.connect(path) as db:
            db.executescript(
                "CREATE TABLE datas(id INTEGER PRIMARY KEY, ot INTEGER, alias INTEGER, setcode INTEGER, type INTEGER, atk INTEGER, def INTEGER, level INTEGER, race INTEGER, attribute INTEGER);"
                "CREATE TABLE texts(id INTEGER PRIMARY KEY, name TEXT, desc TEXT, str1 TEXT, str2 TEXT, str3 TEXT, str4 TEXT, str5 TEXT, str6 TEXT, str7 TEXT, str8 TEXT, str9 TEXT, str10 TEXT, str11 TEXT, str12 TEXT, str13 TEXT, str14 TEXT, str15 TEXT, str16 TEXT);"
            )
            for code, card_type in codes:
                db.execute("INSERT INTO datas(id,type) VALUES (?,?)", (code, card_type))
                db.execute("INSERT INTO texts(id,name,desc) VALUES (?,?,?)", (code, f"CDB {code}", ""))

    def test_cdb_integrity_and_name_coverage_uses_localized_fallback_and_ignores_tokens(self) -> None:
        cdb = self.root / "cards.cdb"
        self.make_cdb(cdb, [(100, 1), (200, 0x4000), (300, 1), (400, 1), (500, 1), (600, 1)])
        # A blank CDB name is still a genuine missing display name; code 600
        # deliberately exercises the final CDB-name fallback instead.
        with sqlite3.connect(cdb) as db:
            db.execute("UPDATE texts SET name='' WHERE id=300")
        mapping = self.root / "names.json"
        mapping.write_text(json.dumps({
            "old": {"id": 100, "sc_name": "旧"},
            "cn": {"id": 400, "sc_name": "", "md_name": "", "jp_name": "", "cn_name": "中文后备"},
            "en": {"id": 500, "sc_name": "", "md_name": "", "jp_name": "", "cn_name": " ", "en_name": "English fallback"},
        }), encoding="utf-8")
        info = validate_cdb(cdb)
        self.assertEqual(info["codeCount"], 6)
        self.assertEqual(info["tokenCodes"], 1)
        self.assertEqual(missing_names(cdb, mapping, [100, 200, 300, 400, 500, 600]), [300])

    def test_cdb_diff_reports_added_and_changed_rows(self) -> None:
        old = self.root / "old.cdb"
        new = self.root / "new.cdb"
        self.make_cdb(old, [(100, 1), (200, 1)])
        self.make_cdb(new, [(100, 2), (300, 1)])
        self.assertEqual(compare_cdb_files(old, new), {"addedCodes": 1, "removedCodes": 1, "changedData": 1, "changedTexts": 0})

    def test_cdb_paths_with_spaces_are_read_only_safe(self) -> None:
        cdb = self.root / "cards with spaces.cdb"
        self.make_cdb(cdb, [(101, 1)])
        self.assertEqual(validate_cdb(cdb)["codes"], [101])

    def make_zip(self, name: str, entries: list[tuple[str, bytes, int | None]] | None = None) -> Path:
        path = self.root / name
        with zipfile.ZipFile(path, "w") as archive:
            for entry_name, payload, mode in entries or [("pics/123.jpg", b"image", None)]:
                info = zipfile.ZipInfo(entry_name)
                if mode is not None:
                    info.external_attr = mode << 16
                archive.writestr(info, payload)
        return path

    def test_image_zip_rejects_traversal_and_symlink(self) -> None:
        self.assertEqual(validate_image_zip(self.make_zip("ok.zip"))[0]["code"], 123)
        field = validate_image_zip(self.make_zip("field.zip", [("field/123.jpg", b"x", None)]))[0]
        self.assertEqual(field["kind"], "field")
        with self.assertRaises(ValueError):
            validate_image_zip(self.make_zip("bad.zip", [("pics/../123.jpg", b"x", None)]))
        with self.assertRaises(ValueError):
            validate_image_zip(self.make_zip("link.zip", [("pics/124.jpg", b"x", stat.S_IFLNK)]))

    def test_expansion_archive_extracts_server_files_and_ignores_client_metadata(self) -> None:
        cdb = self.root / "test-release.cdb"
        self.make_cdb(cdb, [(100200292, 1)])
        archive_path = self.root / "super-pre.ypk"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("expansions/", b"")
            archive.writestr("corres_srv.ini", "[YGOProExpansionPack]\n")
            archive.writestr("pack/example.ydk", "#main\n100200292\n")
            archive.writestr("test-release.cdb", cdb.read_bytes())
            archive.writestr("test-strings.conf", "!setname 0x2ea 测试\n")
            archive.writestr("script/c100200292.lua", "local s,id=GetID()\n")
            archive.writestr("pics/100200292.jpg", b"image")
            archive.writestr("pics/field/100200292.jpg", b"field")
        entries = validate_expansion_zip(archive_path)
        self.assertEqual(len(entries), 7)
        self.assertEqual(sum(item["kind"] == "metadata" for item in entries), 2)
        destination = self.root / "expanded"
        extracted = extract_expansion_zip(archive_path, destination)
        self.assertEqual(len(extracted), 7)
        self.assertTrue((destination / "test-release.cdb").exists())
        self.assertTrue((destination / "test-strings.conf").exists())
        self.assertTrue((destination / "script/c100200292.lua").exists())
        self.assertTrue((destination / "pics/100200292.jpg").exists())
        self.assertTrue((destination / "pics/field/100200292.jpg").exists())
        self.assertFalse((destination / "corres_srv.ini").exists())
        self.assertFalse((destination / "pack/example.ydk").exists())

    def test_expansion_archive_rejects_unsafe_duplicate_and_unknown_entries(self) -> None:
        with self.assertRaises(ValueError):
            validate_expansion_zip(self.make_zip("expansion-traversal.ypk", [("../script/x.lua", b"x", None)]))
        duplicate = self.root / "expansion-duplicate.ypk"
        with zipfile.ZipFile(duplicate, "w") as archive:
            archive.writestr("script/c100.lua", b"a")
            archive.writestr("expansions/script/c100.lua", b"b")
        with self.assertRaises(ValueError):
            validate_expansion_zip(duplicate)
        unknown = self.root / "expansion-unknown.ypk"
        with zipfile.ZipFile(unknown, "w") as archive:
            archive.writestr("bin/server", b"not a resource")
        with self.assertRaises(ValueError):
            validate_expansion_zip(unknown)

    def test_expansion_card_list_requires_bounded_https_metadata(self) -> None:
        valid = self.root / "test-release.json"
        valid.write_text(json.dumps([{
            "name": "测试卡",
            "desc": "效果",
            "overallString": "[魔法]",
            "picUrl": "https://example.invalid/pics/1.jpg?version=1",
        }]), encoding="utf-8")
        self.assertEqual(len(validate_expansion_list(valid)), 1)
        invalid = self.root / "unsafe-release.json"
        invalid.write_text(json.dumps([{"name": "x", "picUrl": "http://example.invalid/x.jpg"}]), encoding="utf-8")
        with self.assertRaises(ValueError):
            validate_expansion_list(invalid)

    def test_expansion_release_list_must_match_release_cdb(self) -> None:
        cdb = self.root / "test-release.cdb"
        self.make_cdb(cdb, [(100200292, 1)])
        listing = self.root / "matching-release.json"
        listing.write_text(json.dumps([{
            "name": "测试卡",
            "desc": "效果",
            "overallString": "[魔法]",
            "picUrl": "https://example.invalid/pics/100200292.jpg",
        }]), encoding="utf-8")
        self.assertEqual(validate_expansion_release(listing, cdb)["cdbCount"], 1)
        listing.write_text(listing.read_text(encoding="utf-8").replace("100200292", "100200293"), encoding="utf-8")
        with self.assertRaises(ValueError):
            validate_expansion_release(listing, cdb)

    def test_script_delta_preserves_unknown_files(self) -> None:
        source = self.root / "source"
        destination = self.root / "destination"
        (source / "nested").mkdir(parents=True)
        (source / "nested/a.lua").write_text("a", encoding="utf-8")
        (destination / "nested").mkdir(parents=True)
        (destination / "nested/a.lua").write_text("old", encoding="utf-8")
        (destination / "local.lua").write_text("keep", encoding="utf-8")
        previous = self.root / "scripts.json"
        previous.write_text(json.dumps({"files": {"nested/a.lua": {"size": 3}}}), encoding="utf-8")
        manifest = sync_managed_scripts(source, destination, previous)
        self.assertIn("nested/a.lua", manifest)
        self.assertEqual((destination / "nested/a.lua").read_text(encoding="utf-8"), "a")
        self.assertTrue((destination / "local.lua").exists())

    def test_expansion_sync_removes_only_previous_managed_files(self) -> None:
        source = self.root / "expansion-source"
        destination = self.root / "expansion-destination"
        (source / "script").mkdir(parents=True)
        (source / "pics").mkdir(parents=True)
        (source / "script/new.lua").write_text("new", encoding="utf-8")
        (source / "test-release.cdb").write_bytes(b"cdb")
        (destination / "script").mkdir(parents=True)
        (destination / "script/old.lua").write_text("old", encoding="utf-8")
        (destination / "lflist.conf").write_text("# server local\n", encoding="utf-8")
        (destination / "local.conf").write_text("keep", encoding="utf-8")
        previous = self.root / "expansions.json"
        previous.write_text(json.dumps({"files": {"script/old.lua": {"size": 3}}}), encoding="utf-8")
        manifest = sync_managed_expansions(source, destination, previous)
        self.assertIn("script/new.lua", manifest)
        self.assertFalse((destination / "script/old.lua").exists())
        self.assertTrue((destination / "lflist.conf").exists())
        self.assertTrue((destination / "local.conf").exists())

    def test_expansion_sync_does_not_follow_existing_symlink(self) -> None:
        source = self.root / "safe-source"
        destination = self.root / "safe-destination"
        outside = self.root / "outside.txt"
        source.mkdir()
        destination.mkdir()
        outside.write_text("unchanged", encoding="utf-8")
        (destination / "test-release.cdb").symlink_to(outside)
        (source / "test-release.cdb").write_text("replacement", encoding="utf-8")
        sync_managed_expansions(source, destination)
        self.assertEqual(outside.read_text(encoding="utf-8"), "unchanged")
        self.assertEqual((destination / "test-release.cdb").read_text(encoding="utf-8"), "replacement")

    def test_avif_generation_is_idempotent_and_bounded(self) -> None:
        try:
            from PIL import Image
        except ImportError:  # pragma: no cover - build hosts always provide vips
            self.skipTest("Pillow unavailable")
        source = self.root / "images"
        destination = self.root / "avif"
        source.mkdir()
        Image.new("RGB", (500, 300), (20, 40, 60)).save(source / "123.jpg")
        first = generate_avif(source, destination)
        output = destination / "123.avif"
        self.assertTrue(output.exists())
        self.assertEqual(first["123"]["size"], (source / "123.jpg").stat().st_size)
        with Image.open(output) as image:
            self.assertLessEqual(max(image.size), 200)
            self.assertEqual(image.format, "AVIF")
        second = generate_avif(source, destination, self.root / "avif.json")
        # No previous manifest means the second call is allowed to regenerate;
        # a manifest-driven call below is the idempotency assertion.
        manifest = self.root / "avif.json"
        manifest.write_text(json.dumps({"sources": second}), encoding="utf-8")
        before = output.read_bytes()
        generate_avif(source, destination, manifest)
        self.assertEqual(output.read_bytes(), before)
        output_meta = {"size": output.stat().st_size, "sha256": hashlib.sha256(before).hexdigest()}
        resource_manifest = self.root / "resource.json"
        resource_manifest.write_text(json.dumps({"avif": {"files": {"123.avif": output_meta}}}), encoding="utf-8")
        generate_avif(source, destination, resource_manifest)
        self.assertEqual(output.read_bytes(), before)
        (destination / "999.avif").write_bytes(b"stale")
        manifest.write_text(json.dumps({"files": {"999.avif": {"size": 5}}}), encoding="utf-8")
        generate_avif(source, destination, manifest)
        self.assertFalse((destination / "999.avif").exists())

    def test_avif_includes_expansions_and_preserves_them_on_normal_updates(self) -> None:
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow unavailable")
        source, expansion, destination = self.root / "base", self.root / "expansion", self.root / "thumbs"
        source.mkdir()
        expansion.mkdir()
        Image.new("RGB", (300, 400), (255, 0, 0)).save(source / "123.jpg")
        Image.new("RGB", (300, 400), (0, 255, 0)).save(expansion / "123.jpg")
        Image.new("RGB", (300, 400), (0, 0, 255)).save(expansion / "456.png")
        first = generate_avif(source, destination, expansion_pics=expansion)
        self.assertEqual(set(first), {"123", "456"})
        self.assertEqual(first["123"]["sha256"], hashlib.sha256((expansion / "123.jpg").read_bytes()).hexdigest())
        manifest = self.root / "thumbs.json"
        manifest.write_text(json.dumps({"sources": first}), encoding="utf-8")
        self.assertEqual(generate_avif(source, destination, manifest, expansion), first)
        (expansion / "456.png").unlink()
        generate_avif(source, destination, manifest, expansion)
        self.assertFalse((destination / "456.avif").exists())

    def test_manifest_delta_reports_removed_and_changed(self) -> None:
        previous = self.root / "previous.json"
        current = self.root / "current.json"
        previous.write_text(json.dumps({"scripts": {"files": {"a.lua": {"sha256": "old"}, "gone.lua": {}}}}), encoding="utf-8")
        current.write_text(json.dumps({"scripts": {"files": {"a.lua": {"sha256": "new"}, "b.lua": {}}}}), encoding="utf-8")
        self.assertEqual(manifest_delta(previous, current, "scripts"), {"changed": ["a.lua", "b.lua"], "removed": ["gone.lua"]})
        previous.write_text(json.dumps({"expansions": {"files": {"test-release.cdb": {"sha256": "old"}, "old.lua": {}}}}), encoding="utf-8")
        current.write_text(json.dumps({"expansions": {"files": {"test-release.cdb": {"sha256": "new"}, "new.lua": {}}}}), encoding="utf-8")
        self.assertEqual(manifest_delta(previous, current, "expansions"), {"changed": ["new.lua", "test-release.cdb"], "removed": ["old.lua"]})

    def test_name_refresh_keys_records_by_exact_code(self) -> None:
        archive = self.root / "names.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("cards.json", json.dumps([
                {"id": 1001, "cid": 7, "sc_name": "甲"},
                {"id": 1002, "cid": 7, "sc_name": "乙"},
            ]))
        mapping = self.root / "names.json"
        mapping.write_text(json.dumps({"7": {"id": 1001, "cid": 7, "sc_name": "旧"}}), encoding="utf-8")
        self.assertEqual(merge_name_zip(archive, mapping), 1)
        refreshed = json.loads(mapping.read_text(encoding="utf-8"))
        self.assertNotIn("7", refreshed)
        self.assertEqual(refreshed["1001"]["sc_name"], "甲")
        self.assertEqual(refreshed["1002"]["sc_name"], "乙")

    def test_name_refresh_does_not_erase_existing_display_name(self) -> None:
        archive = self.root / "blank-name.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("cards.json", json.dumps([{"id": 1001, "cid": 7, "sc_name": ""}]))
        mapping = self.root / "names.json"
        mapping.write_text(json.dumps({"1001": {"id": 1001, "sc_name": "已有名称"}}), encoding="utf-8")
        self.assertEqual(merge_name_zip(archive, mapping), 0)
        refreshed = json.loads(mapping.read_text(encoding="utf-8"))
        self.assertEqual(refreshed["1001"]["sc_name"], "已有名称")


if __name__ == "__main__":
    unittest.main()
