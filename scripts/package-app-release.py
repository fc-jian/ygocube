#!/usr/bin/env python3
"""Package built Linux Web outputs and the API's locked production dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root):
    files, links = {}, {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target) or not path.resolve().is_relative_to(root):
                raise ValueError(f'Nonportable link: {name}')
            links[name] = target
        elif path.is_file():
            files[name] = sha(path)
    return files, links


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('archive', type=Path)
    parser.add_argument('commit')
    parser.add_argument('branch')
    parser.add_argument('srvpro')
    parser.add_argument('--api-runtime', type=Path, help='Directory from pnpm --filter @ygocube/api deploy --legacy --prod')
    args = parser.parse_args()
    root = args.root.resolve()
    with tempfile.TemporaryDirectory(dir=root) as directory:
        stage = Path(directory) / 'payload'
        for instance, subpath in [('ygocube', 'standalone/apps/web'), ('ygoduel', 'apps/web')]:
            web = root / 'payload' / instance / 'web'
            next_dir = web / subpath / '.next'
            if not (next_dir / 'BUILD_ID').is_file() or not any((next_dir / 'static').rglob('*.js')):
                raise ValueError(f'Incomplete Web build: {instance}')
            shutil.copytree(web, stage / instance / 'web', symlinks=True)
        runtime = args.api_runtime
        if runtime is None:
            runtime = Path(directory) / 'runtime'
            subprocess.run(['pnpm', '--filter', '@ygocube/api', 'deploy', '--legacy', '--prod', str(runtime)], cwd=root / 'cube', check=True)
        api = stage / 'api'
        shutil.copytree(root / 'cube/apps/api/dist', api / 'dist')
        shutil.copytree(runtime / 'node_modules', api / 'node_modules', symlinks=True)
        for name in ('shared', 'duel-protocol'):
            built = api / 'node_modules/@ygocube' / name / 'dist/index.js'
            if not built.is_file() or sha(built) != sha(root / 'cube/packages' / name / 'dist/index.js'):
                raise ValueError(f'Workspace package is missing or stale: {name}')
        (stage / 'srvpro').mkdir()
        files, links = inventory(stage)
        manifest = dict(format=2, sourceCommit=args.commit, sourceBranch=args.branch, srvproCommit=args.srvpro, files=files, links=links)
        (stage / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        with tarfile.open(args.archive, 'w:gz', compresslevel=3) as tar:
            for path in sorted(stage.iterdir()):
                tar.add(path, arcname=path.name)
    print(json.dumps(dict(archive=str(args.archive), sha256=sha(args.archive), files=len(files), links=len(links))))


if __name__ == '__main__':
    main()
