#!/usr/bin/env python3
"""Build a resource tarball without directory entries."""

from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import tarfile


def package_payload(root: Path, archive_path: Path) -> None:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"payload root is not a directory: {root}")
    archive_path = archive_path.resolve()
    if archive_path.is_relative_to(root):
        raise ValueError("archive must be outside the payload root")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive_path.with_name(f".{archive_path.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with tarfile.open(temporary, mode="w:gz") as archive:
            for path in sorted(root.rglob("*")):
                if path.is_symlink():
                    raise ValueError(f"refusing symlink in payload: {path.relative_to(root)}")
                if path.is_dir():
                    continue
                if not path.is_file():
                    raise ValueError(f"refusing special file in payload: {path.relative_to(root)}")
                relative = PurePosixPath(path.relative_to(root).as_posix())
                if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative):
                    raise ValueError(f"unsafe payload path: {relative}")
                archive.add(path, arcname=str(relative), recursive=False)
        os.replace(temporary, archive_path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload_root", type=Path)
    parser.add_argument("archive_path", type=Path)
    args = parser.parse_args()
    package_payload(args.payload_root, args.archive_path)


if __name__ == "__main__":
    main()
