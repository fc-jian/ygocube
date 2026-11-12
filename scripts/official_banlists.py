#!/usr/bin/env python3
"""Import audited SC official lists and compose native lflist resources offline."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import unicodedata

SC_INDEX = "https://webadmin.windoent.com/front/yxw-public/forbidden/forbbidengroup/webList?type=2"
SC_DETAIL = "https://webadmin.windoent.com/front/yxw-public/forbidden/forbbidengroup/webinfo/"
CATALOG = Path(__file__).resolve().parents[1] / "config" / "banlists"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def normalized_name(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value).replace("·", "・"))


def import_sc(index_path, detail_path, names_path, cdb_path, source_id):
    index, detail, names = map(read_json, (index_path, detail_path, names_path))
    if index.get("code") != 0 or detail.get("code") != 0:
        raise ValueError("Official source returned an error")
    row = next((item for item in index["list"] if item["id"] == source_id), None)
    if row is None or row["name"] != detail["name"]:
        raise ValueError("Official index and detail do not identify the same list")
    match = re.search(r"(\d{4})/(\d{2})适用", row["name"])
    if not match:
        raise ValueError("Unrecognized official effective date")
    effective = date(int(match[1]), int(match[2]), 1).isoformat()
    with closing(sqlite3.connect(Path(cdb_path).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        aliases = {code: alias or code for code, alias, kind in db.execute("SELECT id,alias,type FROM datas") if not kind & 0x4000}
    candidates = {}
    for key, card in names.items():
        code = int(key)
        if code not in aliases:
            continue
        # Use the official simplified name only; no fuzzy or translation fallback.
        name = card.get("sc_name")
        if name:
            candidates.setdefault(normalized_name(name), set()).add(aliases[code])
    entries, released, counts = [], [], {}
    for group in detail["list"]:
        group_match = re.fullmatch(r"(禁止卡|限制卡|准限制卡|限制解除卡) (\d+)张", group["name"])
        if not group_match or len(group["list"]) != int(group_match[2]):
            raise ValueError("Official group count or category mismatch")
        limit = {"禁止卡": 0, "限制卡": 1, "准限制卡": 2, "限制解除卡": 3}[group_match[1]]
        if str(limit) in counts:
            raise ValueError("Duplicate official category")
        counts[str(limit)] = len(group["list"])
        for card in group["list"]:
            codes = candidates.get(normalized_name(card["name"]), set())
            if len(codes) != 1:
                raise ValueError(f"Official card must resolve to one native identity: {card['name']}: {sorted(codes)}")
            entry = {"code": next(iter(codes)), "name": card["name"], "limit": limit}
            (released if limit == 3 else entries).append(entry)
    result = {
        "format": "SC", "effectiveDate": effective, "title": detail["name"],
        "sourceUrl": f"https://www.yugioh-card-cn.com/limiter/detail?type=2&id={source_id}",
        "sourceApiUrl": SC_DETAIL + str(source_id),
        "sourceSha256": digest(detail_path), "indexSha256": digest(index_path),
        "namesSha256": digest(names_path), "cardsSha256": digest(cdb_path),
        "counts": counts, "entries": entries, "released": released,
    }
    validate_snapshot(result)
    return result


def validate_snapshot(value):
    if value.get("format") != "SC":
        raise ValueError("Only independently published SC lists are supported")
    date.fromisoformat(value["effectiveDate"])
    if not value["sourceApiUrl"].startswith(SC_DETAIL) or not re.fullmatch(r"[0-9a-f]{64}", value["sourceSha256"]):
        raise ValueError("Official source provenance is required")
    counts = Counter()
    seen = set()
    for entry in value["entries"] + value.get("released", []):
        code, limit = entry["code"], entry["limit"]
        if type(code) is not int or not 0 < code <= 0xffffffff or code in seen:
            raise ValueError("Duplicate or invalid canonical card code")
        if type(limit) is not int or limit not in (0, 1, 2, 3):
            raise ValueError("Invalid card limit")
        if not isinstance(entry["name"], str) or not entry["name"].strip() or any(c in entry["name"] for c in "\r\n"):
            raise ValueError("Invalid official card name")
        if (limit == 3) != (entry in value.get("released", [])):
            raise ValueError("Released cards must be separate from active limits")
        seen.add(code)
        counts[str(limit)] += 1
    if dict(counts) != value["counts"] or any(str(limit) not in counts for limit in (0, 1, 2)):
        raise ValueError("Snapshot count mismatch")


def compose(upstream, catalog=CATALOG):
    source = Path(upstream).read_text(encoding="utf-8")
    if not any(line.startswith("!") for line in source.splitlines()):
        raise ValueError("Upstream has no native list headers")
    blocks, provenance, seen = [source.rstrip()], [], set()
    for path in sorted(Path(catalog).glob("*.json")):
        value = read_json(path)
        validate_snapshot(value)
        header = value["effectiveDate"].replace("-", ".") + " SC"
        if header in seen or any(line.strip() == "!" + header for line in source.splitlines()):
            raise ValueError("Duplicate SC list header")
        seen.add(header)
        lines = ["# Official Simplified Chinese list: " + value["sourceUrl"], "!" + header]
        lines.extend(f"{entry['code']} {entry['limit']} --{entry['name']}" for entry in value["entries"])
        blocks.append("\n".join(lines))
        provenance.append({key: value[key] for key in ("format", "effectiveDate", "sourceUrl", "sourceApiUrl", "sourceSha256", "counts")}
                          | {"snapshotSha256": digest(path)})
    if not provenance:
        raise ValueError("No audited SC list snapshots found")
    return "\n\n".join(blocks) + "\n", provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    importer = sub.add_parser("import-sc")
    for key in ("index", "detail", "names", "cdb", "out"):
        importer.add_argument("--" + key, required=True, type=Path)
    importer.add_argument("--source-id", required=True, type=int)
    composer = sub.add_parser("compose")
    composer.add_argument("--upstream", required=True, type=Path)
    composer.add_argument("--catalog", default=CATALOG, type=Path)
    composer.add_argument("--out", required=True, type=Path)
    composer.add_argument("--metadata-out", type=Path)
    args = parser.parse_args()
    if args.command == "import-sc":
        value = import_sc(args.index, args.detail, args.names, args.cdb, args.source_id)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps({"effectiveDate": value["effectiveDate"], "counts": value["counts"]}))
    else:
        text, provenance = compose(args.upstream, args.catalog)
        args.out.write_text(text, encoding="utf-8", newline="\n")
        if args.metadata_out:
            args.metadata_out.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps({"sha256": digest(args.out), "officialLists": len(provenance)}))


if __name__ == "__main__":
    main()
