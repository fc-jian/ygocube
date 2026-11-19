#!/usr/bin/env python3
"""Create and verify a consistent SQLite backup without stopping writers."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


def verify(path: Path) -> str:
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('backup integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('backup foreign key check failed')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def backup(source: Path, destination: Path, mirror: Path | None = None) -> dict:
    if not source.is_file() or destination.exists():
        raise ValueError('source must exist and destination must be a new file')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.sqlite-backup-', dir=destination.parent)
    os.close(fd)
    staged = Path(temporary)
    try:
        with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(staged)) as dst:
            src.backup(dst)
        digest = verify(staged)
        # A test restore uses a separate file and reopens it with SQLite.
        with tempfile.TemporaryDirectory(prefix='sqlite-restore-check-') as directory:
            restored = Path(directory) / 'restored.sqlite'
            shutil.copyfile(staged, restored)
            if verify(restored) != digest:
                raise RuntimeError('restore verification failed')
        # Exclusive publication cannot overwrite another scheduled run.
        with destination.open('xb') as out, staged.open('rb') as inp:
            os.chmod(destination, 0o600)
            shutil.copyfileobj(inp, out)
            out.flush(); os.fsync(out.fileno())
        if verify(destination) != digest:
            raise RuntimeError('published backup differs')
        if mirror:
            mirror.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = mirror / destination.name
            with target.open('xb') as out, destination.open('rb') as inp:
                os.chmod(target, 0o600)
                shutil.copyfileobj(inp, out)
                out.flush(); os.fsync(out.fileno())
            if verify(target) != digest:
                raise RuntimeError('mirror verification failed')
        result = {'ok': True, 'file': destination.name, 'sha256': digest, 'restoreVerified': True, 'mirrored': mirror is not None}
        manifest = destination.with_suffix(destination.suffix + '.json')
        with manifest.open('x', encoding='utf-8') as file:
            os.chmod(manifest, 0o600)
            json.dump(result, file, indent=2)
        return result
    finally:
        staged.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--mirror-dir', type=Path)
    args = parser.parse_args()
    print(json.dumps(backup(args.db, args.destination, args.mirror_dir)))
