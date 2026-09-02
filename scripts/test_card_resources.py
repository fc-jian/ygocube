#!/usr/bin/env python3
"""Unit tests for scripts/card_resources.py (no network or Git required)."""

from __future__ import annotations

import json
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
    sync_managed_scripts,
    validate_cdb,
    validate_image_zip,
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

    def test_cdb_integrity_and_name_coverage_only_new_codes(self) -> None:
        cdb = self.root / "cards.cdb"
        self.make_cdb(cdb, [(100, 1), (200, 0x4000000), (300, 1)])
        mapping = self.root / "names.json"
        mapping.write_text(json.dumps({"old": {"id": 100, "sc_name": "旧"}}), encoding="utf-8")
        info = validate_cdb(cdb)
        self.assertEqual(info["codeCount"], 3)
        self.assertEqual(info["tokenCodes"], 1)
        self.assertEqual(missing_names(cdb, mapping, [100, 200, 300]), [300])

    def test_cdb_diff_reports_added_and_changed_rows(self) -> None:
        old = self.root / "old.cdb"
        new = self.root / "new.cdb"
        self.make_cdb(old, [(100, 1), (200, 1)])
        self.make_cdb(new, [(100, 2), (300, 1)])
        self.assertEqual(compare_cdb_files(old, new), {"addedCodes": 1, "removedCodes": 1, "changedData": 1, "changedTexts": 0})

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

    def test_manifest_delta_reports_removed_and_changed(self) -> None:
        previous = self.root / "previous.json"
        current = self.root / "current.json"
        previous.write_text(json.dumps({"scripts": {"files": {"a.lua": {"sha256": "old"}, "gone.lua": {}}}}), encoding="utf-8")
        current.write_text(json.dumps({"scripts": {"files": {"a.lua": {"sha256": "new"}, "b.lua": {}}}}), encoding="utf-8")
        self.assertEqual(manifest_delta(previous, current, "scripts"), {"changed": ["a.lua", "b.lua"], "removed": ["gone.lua"]})


if __name__ == "__main__":
    unittest.main()
