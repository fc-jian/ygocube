#!/usr/bin/env python3
"""Install the verified Cube card resources into Aly's independent Duel release."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import time
from urllib.parse import quote
from urllib.request import urlopen


TOKEN_TYPE = 0x4000


def run(*args: str) -> str:
    return subprocess.check_output(args, text=True).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(url: str) -> object:
    with urlopen(url, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"API returned HTTP {response.status}: {url}")
        return json.loads(response.read())


def wait_healthy(banlist_path: Path | None = None) -> None:
    for _ in range(40):
        try:
            if read_json("http://127.0.0.1:3101/health") is None:
                time.sleep(1)
                continue
            options = read_json("http://127.0.0.1:3101/public/duel/options")
            names = {str(item.get("name", "")) for item in options.get("lists", [])}
            if banlist_path is not None:
                headers = [line[1:].strip() for line in banlist_path.read_text(encoding="utf-8").splitlines() if line.startswith("!")]
                expected = [value if "TCG" in value else value + " OCG" for value in headers]
                missing = [name for name in expected if name not in names]
                if missing:
                    raise RuntimeError(f"the standalone Duel API did not load upstream ban-lists: {missing[:5]}")
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError("standalone Duel API health check failed")


def checked_copy_file(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise RuntimeError(f"missing regular resource file: {source.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        destination.unlink()
    elif destination.exists():
        if not destination.is_file():
            raise RuntimeError(f"resource destination is not a regular file: {destination}")
        if source.stat().st_size == destination.stat().st_size and sha256(source) == sha256(destination):
            return
        destination.unlink()
    shutil.copy2(source, destination)


def link_or_copy(source: str, destination: str) -> str:
    try:
        os.link(source, destination)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        shutil.copy2(source, destination)
    return destination


def replace_directory(source: Path, destination: Path, *, ignore=None) -> None:
    if destination.is_symlink():
        destination.unlink()
    elif destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, ignore=ignore, symlinks=False, copy_function=link_or_copy)


def atomic_write_text(path: Path, value: str) -> None:
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.chmod(mode)
    os.replace(temporary, path)


def set_release_ownership(release: Path) -> None:
    for directory, _subdirectories, filenames in os.walk(release, followlinks=False):
        directory_path = Path(directory)
        shutil.chown(directory_path, user="ygoduel", group="ygoduel", follow_symlinks=False)
        for name in filenames:
            path = directory_path / name
            if path.is_symlink():
                continue
            # Unchanged files are hard links to the previous immutable release;
            # they already have the correct owner and must not be chowned here.
            if path.stat().st_nlink == 1:
                shutil.chown(path, user="ygoduel", group="ygoduel", follow_symlinks=False)


def safe_remove_list(root: Path, list_path: Path) -> None:
    if not list_path.is_file():
        return
    for raw in list_path.read_text(encoding="utf-8").splitlines():
        if not raw:
            continue
        relative = PurePosixPath(raw)
        if relative.is_absolute() or ".." in relative.parts or "\\" in raw:
            raise RuntimeError(f"unsafe managed-resource delete path: {raw!r}")
        target = root.joinpath(*relative.parts)
        if target.is_symlink():
            raise RuntimeError(f"refusing to delete a symlinked managed resource: {raw!r}")
        if target.is_file():
            target.unlink()


def verify_cube_resources(cube_root: Path, manifest: dict) -> None:
    host = cube_root / "shared" / "srvpro" / "ygopro"
    card = host / "cards.cdb"
    if not card.is_file() or sha256(card) != manifest.get("cards", {}).get("sha256"):
        raise RuntimeError("staged main cards.cdb does not match its manifest")
    names_meta = manifest.get("cardNames", {})
    names = cube_root / "shared" / "assets" / "ygocdb_cards.json"
    if not names.is_file() or sha256(names) != names_meta.get("sha256"):
        raise RuntimeError("staged YGOCDB mapping does not match its manifest")
    for relative, metadata in manifest.get("banlist", {}).get("files", {}).items():
        path = host / relative
        if not path.is_file() or sha256(path) != metadata.get("sha256"):
            raise RuntimeError(f"staged upstream ban-list does not match its manifest: {relative}")
    for relative, metadata in manifest.get("expansions", {}).get("files", {}).items():
        path = host / "expansions" / relative
        if not path.is_file() or sha256(path) != metadata.get("sha256"):
            raise RuntimeError(f"staged Super Pre file does not match its manifest: {relative}")


def probe_catalogue(release: Path, manifest: dict) -> dict:
    host = release / "srvpro" / "ygopro"
    mapping_raw = json.loads((release / "assets" / "ygocdb_cards.json").read_text(encoding="utf-8"))
    mapping_values = mapping_raw if isinstance(mapping_raw, list) else mapping_raw.values() if isinstance(mapping_raw, dict) else []
    mapping = {}
    for record in mapping_values:
        if isinstance(record, dict):
            try:
                mapping[int(record.get("id"))] = record
            except (TypeError, ValueError):
                pass
    expected: dict[int, str] = {}
    for relative, metadata in manifest.get("expansions", {}).get("files", {}).items():
        if not relative.lower().endswith(".cdb"):
            continue
        database = host / "expansions" / relative
        if not database.is_file() or sha256(database) != metadata.get("sha256"):
            raise RuntimeError(f"installed expansion database hash mismatch: {relative}")
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            rows = db.execute(
                "SELECT datas.id, datas.type, texts.name FROM datas JOIN texts USING(id)"
            ).fetchall()
        for code, card_type, name in rows:
            if not (int(card_type or 0) & TOKEN_TYPE):
                expected[int(code)] = str(name or "").strip()
    found = 0
    for code, cdb_name in sorted(expected.items()):
        probes = [str(code)]
        if cdb_name:
            probes.append(cdb_name)
        mapped = mapping.get(code, {})
        for field in ("sc_name", "md_name", "jp_name", "cn_name", "en_name"):
            value = mapped.get(field)
            if isinstance(value, str) and value.strip():
                probes.append(value.strip())
                break
        for query in dict.fromkeys(probes):
            rows = read_json("http://127.0.0.1:3101/public/duel/search?q=" + quote(query, safe=""))
            if not isinstance(rows, list) or not any(int(row.get("code", 0)) == code for row in rows):
                raise RuntimeError(f"standalone Duel search missed extension card {code}")
        found += 1
    return {"expansionCardsSearchedByCodeAndName": found}


def parse_config(api_modules: Path, config_file: Path) -> dict:
    raw = run(
        "/usr/bin/node",
        "-e",
        "process.stdout.write(JSON.stringify(require(process.argv[1]).parse(require('fs').readFileSync(process.argv[2],'utf8'))))",
        str(api_modules / "yaml"),
        str(config_file),
    )
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise RuntimeError("independent Duel config is not a mapping")
    return value


def atomic_current(duel_root: Path, target: Path, suffix: str) -> None:
    current = duel_root / "current"
    next_link = duel_root / f"current-{suffix}"
    if next_link.exists() or next_link.is_symlink():
        raise RuntimeError(f"refusing to overwrite existing switch path: {next_link.name}")
    next_link.symlink_to(target, target_is_directory=True)
    os.replace(next_link, current)


def active_standalone_host() -> bool:
    result = subprocess.run(
        ["pgrep", "-u", "ygoduel", "-x", "ygopro"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def rollback(duel_root: Path, release_id: str) -> dict:
    backup = duel_root / "backups" / f"card-sync-{release_id}"
    previous_text = backup / "previous-release.txt"
    config_backup = backup / "config.yaml"
    if not previous_text.is_file() or not config_backup.is_file():
        return {"skipped": True, "reason": "no independent Duel release backup for this ID"}
    if active_standalone_host():
        raise RuntimeError("an independent Duel host is active; rollback was not started")
    previous = Path(previous_text.read_text(encoding="utf-8").strip()).resolve(strict=True)
    current = (duel_root / "current").resolve(strict=True)
    run("systemctl", "stop", "ygoduel-api", "ygoduel-srvpro")
    try:
        atomic_current(duel_root, previous, f"rollback-{release_id}")
        config_file = duel_root / "shared" / "config.yaml"
        shutil.copy2(config_backup, config_file)
        run("systemctl", "start", "ygoduel-api", "ygoduel-srvpro")
        wait_healthy(previous / "srvpro" / "ygopro" / "lflist.conf")
    except Exception:
        if (duel_root / "current").resolve() != current:
            atomic_current(duel_root, current, f"recover-{release_id}")
        run("systemctl", "restart", "ygoduel-api", "ygoduel-srvpro")
        raise
    return {"rolledBack": True, "previousRelease": previous.name}


def deploy(cube_root: Path, duel_root: Path, release_id: str) -> dict:
    stage = cube_root / ".staging" / f"card-sync-{release_id}"
    stage_root = stage / "root"
    manifest_path = stage_root / "metadata" / "resource-manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("verified Cube resource staging directory is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    # The Cube apply step atomically moves the payload's complete host and AVIF
    # tree into shared/. Read the now-live, hash-verified resources from there;
    # only the manifest and delete lists remain in the staging directory.
    verify_cube_resources(cube_root, manifest)
    if active_standalone_host():
        raise RuntimeError("an independent Duel host is active; resource deployment was not started")

    current_link = duel_root / "current"
    old = current_link.resolve(strict=True)
    releases = duel_root / "releases"
    if not old.is_relative_to(releases.resolve(strict=True)):
        raise RuntimeError("independent Duel current link resolves outside its releases directory")
    release_name = f"card-sync-{release_id}"
    new = releases / release_name
    if new.exists():
        raise RuntimeError(f"release already exists: {release_name}")
    backup = duel_root / "backups" / release_name
    backup.mkdir(parents=True, exist_ok=False)
    (backup / "previous-release.txt").write_text(str(old) + "\n", encoding="utf-8")

    new.mkdir(parents=True)
    try:
        # Releases share unchanged immutable files to avoid duplicating the
        # independent application's large node_modules tree and exhausting
        # Aly's inode quota. Updated files are unlinked before they are copied.
        shutil.copytree(old, new, dirs_exist_ok=True, symlinks=True, copy_function=link_or_copy)
        release_metadata = new / "release.json"
        if release_metadata.is_file():
            metadata = json.loads(release_metadata.read_text(encoding="utf-8"))
            metadata.update(id=release_name, previousRelease=old.name, resourceManifestSha256=sha256(manifest_path))
            atomic_write_text(release_metadata, json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        source_host = cube_root / "shared" / "srvpro" / "ygopro"
        target_host = new / "srvpro" / "ygopro"
        for name in ("cards.cdb", "strings.conf", "lflist.conf"):
            checked_copy_file(source_host / name, target_host / name)
        for directory in (target_host / "script", target_host / "expansions"):
            if directory.is_symlink():
                directory.unlink()
            directory.mkdir(parents=True, exist_ok=True)

        # Delete only resources the last successful Cube resource manifest owned.
        delete_root = stage_root / "deletes"
        safe_remove_list(target_host / "script", delete_root / "scripts.txt")
        safe_remove_list(target_host / "expansions", delete_root / "expansions.txt")
        # A ban-list used to be recorded as an expansion file. The upstream list
        # is reinstalled below, even when migrating that old manifest format.
        safe_remove_list(target_host, delete_root / "banlist.txt")

        for lua in (source_host / "script").rglob("*.lua"):
            relative = lua.relative_to(source_host / "script")
            checked_copy_file(lua, target_host / "script" / relative)
        source_expansions = source_host / "expansions"
        for source in source_expansions.rglob("*"):
            if source.is_symlink():
                raise RuntimeError(f"refusing symlinked expansion resource: {source.name}")
            if not source.is_file():
                continue
            relative = source.relative_to(source_expansions)
            if any(part in {"pics", "pack"} for part in relative.parts):
                continue
            if source.name == "corres_srv.ini" or source.suffix.lower() == ".ypk":
                continue
            checked_copy_file(source, target_host / "expansions" / relative)
        # Keep the upstream lflist at both srvpro lookup paths. It is tracked as
        # a separate resource so --skip-expansion cannot freeze ban-list dates.
        checked_copy_file(source_host / "lflist.conf", target_host / "expansions" / "lflist.conf")

        image_source = cube_root / "shared" / "assets" / "pics_avif"
        if not image_source.is_dir():
            raise RuntimeError("staged AVIF directory is missing")
        replace_directory(image_source, new / "assets" / "pics_avif")
        checked_copy_file(cube_root / "shared" / "assets" / "ygocdb_cards.json", new / "assets" / "ygocdb_cards.json")

        resources_path = new / "resources.json"
        resources = json.loads(resources_path.read_text(encoding="utf-8")) if resources_path.is_file() else {}
        for name in ("ygopro", "cards.cdb", "strings.conf", "lflist.conf"):
            resource = target_host / name
            if resource.is_file():
                resources[name] = sha256(resource)
        resources["cardNames"] = sha256(new / "assets" / "ygocdb_cards.json")
        resources["resourceManifest"] = sha256(manifest_path)
        atomic_write_text(resources_path, json.dumps(resources, ensure_ascii=False, indent=2) + "\n")
        atomic_write_text(
            new / "resource-sync.json",
            json.dumps(
                {
                    "id": release_id,
                    "upstream": manifest.get("upstream"),
                    "banlistSource": manifest.get("banlistSource"),
                    "cardsSha256": manifest.get("cards", {}).get("sha256"),
                    "cardNamesSha256": resources["cardNames"],
                    "resourceManifestSha256": resources["resourceManifest"],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )
        set_release_ownership(new)

        config_file = duel_root / "shared" / "config.yaml"
        config = parse_config(old / "api" / "node_modules", config_file)
        config.setdefault("server", {}).update(
            cards_cdb="/opt/ygoduel/current/srvpro/ygopro/cards.cdb",
            strings_conf="/opt/ygoduel/current/srvpro/ygopro/strings.conf",
            card_names_json="/opt/ygoduel/current/assets/ygocdb_cards.json",
        )
        config.setdefault("pics", {})["avif_dir"] = "/opt/ygoduel/current/assets/pics_avif"
        config_temp = backup / ".config.yaml.new"
        config_temp.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        config_temp.chmod(0o600)

        run("systemctl", "stop", "ygoduel-api", "ygoduel-srvpro")
        shutil.copy2(config_file, backup / "config.yaml")
        database = duel_root / "shared" / "data" / "duel.sqlite"
        with sqlite3.connect(database) as source, sqlite3.connect(backup / "duel.sqlite") as target:
            if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("independent Duel database integrity check failed")
            source.backup(target)
        (backup / "db-integrity.txt").write_text("ok\n", encoding="utf-8")
        shutil.copy2(config_temp, config_file)
        atomic_current(duel_root, new, release_id)
        with sqlite3.connect(database) as db:
            db.execute("UPDATE cards SET metadata_version=0")
            db.commit()
        run("systemctl", "start", "ygoduel-api", "ygoduel-srvpro")
        wait_healthy(target_host / "lflist.conf")
        search_result = probe_catalogue(new, manifest)
        if new.joinpath("srvpro/ygopro/ygopro").is_file() and "not found" in run("ldd", str(new / "srvpro/ygopro/ygopro")):
            raise RuntimeError("standalone Duel host has unresolved shared libraries")
        (backup / "deployment.json").write_text(
            json.dumps(
                {
                    "ok": True,
                    "release": release_name,
                    "previousRelease": old.name,
                    "search": search_result,
                    "resourceManifestSha256": resources["resourceManifest"],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return {"ok": True, "release": release_name, "backup": str(backup), **search_result}
    except Exception:
        # The release remains on disk for inspection. Restore the old pointer
        # and configuration before starting the former services again.
        config_file = duel_root / "shared" / "config.yaml"
        if (backup / "config.yaml").is_file():
            shutil.copy2(backup / "config.yaml", config_file)
        if (current_link.resolve() != old):
            atomic_current(duel_root, old, f"recover-{release_id}")
        for service in ("ygoduel-api", "ygoduel-srvpro"):
            subprocess.run(["systemctl", "start", service], check=False)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cube-root", type=Path, default=Path("/opt/ygocube"))
    parser.add_argument("--duel-root", type=Path, default=Path("/opt/ygoduel"))
    parser.add_argument("--id", required=True)
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.id):
        raise SystemExit("invalid resource release ID")
    for path in (args.cube_root, args.duel_root):
        if not path.is_absolute() or path == Path("/"):
            raise SystemExit("invalid installation root")
    try:
        if args.rollback:
            result = rollback(args.duel_root.resolve(), args.id)
        else:
            result = deploy(args.cube_root.resolve(), args.duel_root.resolve(), args.id)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
