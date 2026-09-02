#!/usr/bin/env python3
"""Safe, deterministic helpers for the YGOPro card-resource pipeline.

The update shell script deliberately keeps orchestration and remote operations
in bash.  This module owns the parts that are easier to test safely in Python:
SQLite validation, ZIP entry validation/extraction, manifests and the managed
Lua delta.  It has no network or Git side effects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import subprocess
from typing import Any, Iterable
from urllib.parse import quote
import zipfile


MAX_IMAGE_ENTRIES = 500_000
MAX_IMAGE_UNCOMPRESSED = 4_000_000_000
MAX_IMAGE_ENTRY = 20_000_000
IMAGE_SUFFIXES = {"jpg", "jpeg", "png", "webp"}
TOKEN_TYPE = 0x4000000


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk_size)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _json_dump(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temp, path)


def validate_cdb(path: Path) -> dict[str, Any]:
    """Validate a cards.cdb and return stable, useful metadata."""
    path = path.resolve()
    if not path.is_file():
        raise ValueError(f"cards.cdb not found: {path}")
    uri = f"file:{quote(path.as_posix())}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
        try:
            quick = connection.execute("PRAGMA quick_check").fetchone()
            if not quick or quick[0] != "ok":
                raise ValueError(f"cards.cdb integrity check failed: {quick[0] if quick else 'unknown'}")
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            missing = {"datas", "texts"} - tables
            if missing:
                raise ValueError(f"cards.cdb missing tables: {', '.join(sorted(missing))}")
            data_count = int(connection.execute("SELECT COUNT(*) FROM datas").fetchone()[0])
            text_count = int(connection.execute("SELECT COUNT(*) FROM texts").fetchone()[0])
            rows = connection.execute("SELECT id, type FROM datas ORDER BY id").fetchall()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise ValueError(f"cards.cdb is not readable SQLite: {exc}") from exc
    codes = [int(row[0]) for row in rows]
    return {
        "path": str(path),
        "size": path.stat().st_size,
        "sha256": sha256_file(path),
        "dataRows": data_count,
        "textRows": text_count,
        "codes": codes,
        "codeCount": len(codes),
        "tokenCodes": sum(1 for _, card_type in rows if int(card_type or 0) & TOKEN_TYPE),
    }


def compare_cdb(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, int]:
    old_codes = {int(value) for value in previous.get("codes", [])}
    new_codes = {int(value) for value in current.get("codes", [])}
    return {
        "added": len(new_codes - old_codes),
        "removed": len(old_codes - new_codes),
        "totalChanged": 0,
    }


def compare_cdb_files(previous_path: Path, current_path: Path) -> dict[str, int]:
    """Compare card IDs and all data/text columns between two CDB files."""
    validate_cdb(previous_path)
    validate_cdb(current_path)
    def rows(path: Path, table: str) -> dict[int, tuple[Any, ...]]:
        uri = f"file:{quote(path.resolve().as_posix())}?mode=ro"
        with sqlite3.connect(uri, uri=True) as connection:
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            values = connection.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
        return {int(row[0]): tuple(row[1:]) for row in values}
    old_data, new_data = rows(previous_path, "datas"), rows(current_path, "datas")
    old_text, new_text = rows(previous_path, "texts"), rows(current_path, "texts")
    old_codes, new_codes = set(old_data), set(new_data)
    return {
        "addedCodes": len(new_codes - old_codes),
        "removedCodes": len(old_codes - new_codes),
        "changedData": sum(1 for code in old_codes & new_codes if old_data[code] != new_data[code]),
        "changedTexts": sum(1 for code in set(old_text) & set(new_text) if old_text[code] != new_text[code]),
    }


def _image_code(name: str) -> tuple[int, str, str] | None:
    # The source archive normally has pics/123.jpg.  Accept one fixed pics
    # directory (and no other nesting) so an archive cannot escape extraction.
    if "\\" in name or "\x00" in name:
        raise ValueError(f"unsafe image path: {name!r}")
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        raise ValueError(f"unsafe image path: {name!r}")
    if len(pure.parts) > 2 or (len(pure.parts) == 2 and pure.parts[0] not in {"pics", "images", "field"}):
        raise ValueError(f"unexpected image path: {name!r}")
    stem = pure.stem
    suffix = pure.suffix.lower().lstrip(".")
    if not stem.isdecimal() or not (1 <= len(stem) <= 12) or suffix not in IMAGE_SUFFIXES:
        raise ValueError(f"invalid card image entry: {name!r}")
    code = int(stem)
    if code <= 0 or code > 2_147_483_647:
        raise ValueError(f"invalid card image code: {name!r}")
    # `field/` is part of the official archive and contains the alternate
    # field-spell artwork.  It is extracted safely but intentionally not
    # converted to the public card AVIF endpoint.
    kind = "field" if len(pure.parts) == 2 and pure.parts[0] == "field" else "card"
    return code, suffix, kind


def validate_image_zip(path: Path) -> list[dict[str, Any]]:
    """Validate every image ZIP entry before any extraction takes place."""
    if not path.is_file():
        raise ValueError(f"image archive not found: {path}")
    entries: list[dict[str, Any]] = []
    codes: set[tuple[str, int]] = set()
    total = 0
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_IMAGE_ENTRIES:
                raise ValueError(f"image archive has too many entries: {len(infos)}")
            for info in infos:
                if info.is_dir():
                    # Directory entries are harmless but still have to be safe.
                    directory = info.filename
                    if "\\" in directory or "\x00" in directory:
                        raise ValueError(f"unsafe image path: {directory!r}")
                    pure_directory = PurePosixPath(directory.rstrip("/"))
                    if pure_directory.is_absolute() or ".." in pure_directory.parts:
                        raise ValueError(f"unsafe image path: {directory!r}")
                    if len(pure_directory.parts) > 1 or (pure_directory.parts and pure_directory.parts[0] not in {"pics", "images", "field"}):
                        raise ValueError(f"unexpected image path: {directory!r}")
                    continue
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK or (info.create_system == 3 and (info.external_attr & 0x10)):
                    raise ValueError(f"symbolic links are not allowed: {info.filename!r}")
                code, suffix, kind = _image_code(info.filename)
                code_key = (kind, code)
                if code_key in codes:
                    raise ValueError(f"duplicate image code: {kind}/{code}")
                if info.file_size > MAX_IMAGE_ENTRY:
                    raise ValueError(f"image entry is too large: {info.filename!r}")
                total += int(info.file_size)
                if total > MAX_IMAGE_UNCOMPRESSED:
                    raise ValueError("image archive exceeds uncompressed size limit")
                codes.add(code_key)
                entries.append(
                    {
                        "name": info.filename,
                        "code": code,
                        "kind": kind,
                        "suffix": suffix,
                        "size": int(info.file_size),
                        "crc": int(info.CRC),
                    }
                )
    except zipfile.BadZipFile as exc:
        raise ValueError(f"invalid image ZIP: {exc}") from exc
    return sorted(entries, key=lambda item: item["code"])


def extract_image_zip(path: Path, destination: Path) -> list[dict[str, Any]]:
    entries = validate_image_zip(path)
    destination.mkdir(parents=True, exist_ok=True)
    by_name = {entry["name"]: entry for entry in entries}
    with zipfile.ZipFile(path) as archive:
        for name, entry in by_name.items():
            target_dir = destination / entry["kind"] if entry["kind"] == "field" else destination
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / f"{entry['code']}.{entry['suffix']}"
            temp = target.with_name(f".{target.name}.tmp")
            with archive.open(name, "r") as source, temp.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            os.replace(temp, target)
    return entries


def file_manifest(directory: Path, suffix: str | None = None) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not directory.exists():
        return out
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        if suffix and path.suffix.lower() != suffix.lower():
            continue
        rel = path.relative_to(directory).as_posix()
        out[rel] = {"size": path.stat().st_size, "sha256": sha256_file(path)}
    return out


def sync_managed_scripts(source: Path, destination: Path, previous: Path | None = None) -> dict[str, dict[str, Any]]:
    """Copy Lua files and remove only files managed by our previous manifest."""
    current = file_manifest(source, ".lua")
    old: dict[str, Any] = {}
    if previous and previous.exists():
        try:
            old = json.loads(previous.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = {}
    old_files = set(old.get("files", old).keys()) if isinstance(old, dict) else set()
    for rel in sorted(old_files - set(current)):
        pure = PurePosixPath(rel)
        if pure.is_absolute() or ".." in pure.parts:
            raise ValueError(f"unsafe managed script path: {rel!r}")
        candidate = destination / rel
        if candidate.is_file() and not candidate.is_symlink():
            candidate.unlink()
    for rel, metadata in current.items():
        pure = PurePosixPath(rel)
        if pure.is_absolute() or ".." in pure.parts:
            raise ValueError(f"unsafe managed script path: {rel!r}")
        source_path = source / rel
        target = destination / rel
        if not target.exists() or target.is_symlink() or target.stat().st_size != metadata["size"] or sha256_file(target) != metadata["sha256"]:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, target)
    return current


def generate_avif(source: Path, destination: Path, previous: Path | None = None) -> dict[str, dict[str, Any]]:
    """Generate max-200px Q30 AVIFs; unchanged source CRC/size is skipped."""
    if shutil.which("vips") is None:
        raise ValueError("vips is required to generate AVIF resources")
    old: dict[str, Any] = {}
    if previous and previous.exists():
        try:
            old = json.loads(previous.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = {}
    old_section = old.get("avif", {}) if isinstance(old, dict) and isinstance(old.get("avif"), dict) else old
    old_sources = old_section.get("sources", {}) if isinstance(old_section, dict) else {}
    # A bootstrapped resource manifest may only contain output-file metadata,
    # not the JPEG source metadata produced by this helper.  Still use those
    # exact output names for stale-file cleanup; never delete an unrelated
    # extension or a non-numeric local file.
    old_output_codes = {
        Path(name).stem
        for name in (old_section.get("files", {}) if isinstance(old_section, dict) else {})
        if Path(name).suffix.lower() == ".avif" and Path(name).stem.isdecimal()
    }
    destination.mkdir(parents=True, exist_ok=True)
    current: dict[str, dict[str, Any]] = {}
    for image in sorted(source.iterdir() if source.exists() else []):
        if not image.is_file() or image.suffix.lower().lstrip(".") not in IMAGE_SUFFIXES:
            continue
        if not image.stem.isdecimal():
            continue
        code = int(image.stem)
        source_meta = {"size": image.stat().st_size, "sha256": sha256_file(image)}
        output = destination / f"{code}.avif"
        current[str(code)] = source_meta
        if output.exists() and old_sources.get(str(code)) == source_meta:
            continue
        old_output = old_section.get("files", {}).get(f"{code}.avif") if isinstance(old_section, dict) else None
        if output.exists() and isinstance(old_output, dict):
            output_meta = {"size": output.stat().st_size, "sha256": sha256_file(output)}
            if output_meta == old_output:
                continue
        # Keep the .avif suffix on the temporary output: libvips chooses the
        # writer from the final extension, and a .tmp suffix would be rejected.
        temp = output.with_name(f".{output.stem}.tmp.avif")
        subprocess.run(
            ["vips", "thumbnail", str(image), f"{temp}[Q=30,effort=9,subsample-mode=on,strip]", "200", "--size", "down"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        os.replace(temp, output)
    for old_code in (set(old_sources) | old_output_codes) - set(current):
        stale = destination / f"{old_code}.avif"
        if stale.is_file():
            stale.unlink()
    return current


def missing_names(cdb_path: Path, mapping_path: Path, only_codes: Iterable[int] | None = None) -> list[int]:
    metadata = validate_cdb(cdb_path)
    selected = set(int(code) for code in only_codes) if only_codes is not None else set(metadata["codes"])
    records: dict[int, Any] = {}
    if mapping_path.is_file():
        try:
            parsed = json.loads(mapping_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            parsed = {}
        values = parsed if isinstance(parsed, list) else (parsed.values() if isinstance(parsed, dict) else [])
        for value in values:
            if not isinstance(value, dict):
                continue
            try:
                code = int(value.get("id"))
            except (TypeError, ValueError):
                continue
            records[code] = value
    # Read type for token filtering.  Tokens may intentionally be absent from
    # the external name mapping; all other cards must have a display name.
    uri = f"file:{quote(cdb_path.resolve().as_posix())}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        types = dict(connection.execute("SELECT id, type FROM datas"))
    missing: list[int] = []
    for code in sorted(selected):
        record = records.get(code, {})
        display = next((record.get(key) for key in ("sc_name", "md_name", "jp_name") if isinstance(record.get(key), str) and record.get(key).strip()), "")
        if not display and not (int(types.get(code, 0)) & TOKEN_TYPE):
            missing.append(code)
    return missing


def merge_name_zip(zip_path: Path, mapping_path: Path) -> int:
    """Merge records from YGOCDB cards.zip into the exact-code map."""
    with zipfile.ZipFile(zip_path) as archive:
        candidates = [name for name in archive.namelist() if name.endswith("cards.json")]
        if not candidates:
            raise ValueError("YGOCDB archive does not contain cards.json")
        with archive.open(candidates[0]) as handle:
            parsed = json.load(handle)
    incoming = parsed if isinstance(parsed, list) else (list(parsed.values()) if isinstance(parsed, dict) else [])
    existing: dict[str, Any] = {}
    if mapping_path.exists():
        old = json.loads(mapping_path.read_text(encoding="utf-8"))
        if isinstance(old, dict):
            existing = old
    added = 0
    for record in incoming:
        if not isinstance(record, dict):
            continue
        raw_id = record.get("id")
        try:
            code = int(raw_id)
        except (TypeError, ValueError):
            continue
        # The API consumes records by exact printed card id.  `cid` is an
        # upstream catalog identifier and can be shared by reprints, so it
        # must never be the JSON key for a code-to-name refresh.
        key = str(code)
        if key not in existing:
            added += 1
        existing[key] = record
    _json_dump(existing, mapping_path)
    return added


def build_resource_manifest(cdb: Path, scripts: Path, avif: Path, output: Path, names: Path | None = None, **extra: Any) -> dict[str, Any]:
    cards = validate_cdb(cdb)
    # Absolute build paths are useful in a local diagnostic but must not be
    # published to Aly or embedded in an artifact manifest.
    cards.pop("path", None)
    manifest = {
        "schemaVersion": 1,
        "cards": cards,
        "scripts": {"files": file_manifest(scripts, ".lua")},
        "avif": {"files": file_manifest(avif, ".avif")},
    }
    if names and names.is_file():
        manifest["cardNames"] = {"size": names.stat().st_size, "sha256": sha256_file(names)}
    manifest.update(extra)
    _json_dump(manifest, output)
    return manifest


def manifest_delta(previous: Path | None, current: Path, section: str) -> dict[str, list[str]]:
    """Return changed and removed paths for a manifest section."""
    old: dict[str, Any] = {}
    if previous and previous.exists():
        try:
            old = json.loads(previous.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = {}
    new = json.loads(current.read_text(encoding="utf-8"))
    old_files = old.get(section, {}).get("files", {}) if isinstance(old, dict) else {}
    new_files = new.get(section, {}).get("files", {}) if isinstance(new, dict) else {}
    changed = sorted(name for name, metadata in new_files.items() if old_files.get(name) != metadata)
    removed = sorted(name for name in old_files if name not in new_files)
    return {"changed": changed, "removed": removed}


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    cdb = sub.add_parser("validate-cdb")
    cdb.add_argument("path", type=Path)
    compare = sub.add_parser("compare-cdb")
    compare.add_argument("previous", type=Path)
    compare.add_argument("current", type=Path)
    z = sub.add_parser("validate-zip")
    z.add_argument("path", type=Path)
    x = sub.add_parser("extract-zip")
    x.add_argument("path", type=Path)
    x.add_argument("destination", type=Path)
    s = sub.add_parser("sync-scripts")
    s.add_argument("source", type=Path)
    s.add_argument("destination", type=Path)
    s.add_argument("--previous", type=Path)
    s.add_argument("--manifest-out", type=Path, required=True)
    a = sub.add_parser("avif")
    a.add_argument("source", type=Path)
    a.add_argument("destination", type=Path)
    a.add_argument("--previous", type=Path)
    a.add_argument("--manifest-out", type=Path, required=True)
    n = sub.add_parser("missing-names")
    n.add_argument("cdb", type=Path)
    n.add_argument("mapping", type=Path)
    n.add_argument("--only", type=Path, help="JSON file containing a code array")
    m = sub.add_parser("merge-names")
    m.add_argument("zip", type=Path)
    m.add_argument("mapping", type=Path)
    man = sub.add_parser("manifest")
    man.add_argument("--cdb", type=Path, required=True)
    man.add_argument("--scripts", type=Path, required=True)
    man.add_argument("--avif", type=Path, required=True)
    man.add_argument("--names", type=Path)
    man.add_argument("--out", type=Path, required=True)
    man.add_argument("--extra", default="{}")
    man.add_argument("--extra-file", type=Path)
    d = sub.add_parser("delta")
    d.add_argument("current", type=Path)
    d.add_argument("--previous", type=Path)
    d.add_argument("--section", choices=("scripts", "avif"), required=True)
    args = parser.parse_args()
    try:
        if args.command == "validate-cdb":
            print(json.dumps(validate_cdb(args.path), ensure_ascii=False, sort_keys=True))
        elif args.command == "compare-cdb":
            print(json.dumps(compare_cdb_files(args.previous, args.current), ensure_ascii=False, sort_keys=True))
        elif args.command == "validate-zip":
            print(json.dumps(validate_image_zip(args.path), ensure_ascii=False, sort_keys=True))
        elif args.command == "extract-zip":
            print(json.dumps(extract_image_zip(args.path, args.destination), ensure_ascii=False, sort_keys=True))
        elif args.command == "sync-scripts":
            result = sync_managed_scripts(args.source, args.destination, args.previous)
            _json_dump({"schemaVersion": 1, "files": result}, args.manifest_out)
            print(json.dumps({"files": len(result)}, ensure_ascii=False))
        elif args.command == "avif":
            result = generate_avif(args.source, args.destination, args.previous)
            _json_dump({"schemaVersion": 1, "sources": result, "files": file_manifest(args.destination, ".avif")}, args.manifest_out)
            print(json.dumps({"files": len(result)}, ensure_ascii=False))
        elif args.command == "missing-names":
            only = None
            if args.only:
                only = json.loads(args.only.read_text(encoding="utf-8"))
            print(json.dumps(missing_names(args.cdb, args.mapping, only), ensure_ascii=False))
        elif args.command == "merge-names":
            print(json.dumps({"added": merge_name_zip(args.zip, args.mapping)}, ensure_ascii=False))
        elif args.command == "manifest":
            extra = json.loads(args.extra)
            if args.extra_file:
                extra = json.loads(args.extra_file.read_text(encoding="utf-8"))
            print(json.dumps(build_resource_manifest(args.cdb, args.scripts, args.avif, args.out, names=args.names, **extra), ensure_ascii=False, sort_keys=True))
        elif args.command == "delta":
            print(json.dumps(manifest_delta(args.previous, args.current, args.section), ensure_ascii=False, sort_keys=True))
    except (OSError, ValueError, sqlite3.Error, zipfile.BadZipFile, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
