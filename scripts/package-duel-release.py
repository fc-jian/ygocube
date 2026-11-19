#!/usr/bin/env python3
"""Package a built Linux standalone Duel app without changing Cube or card resources."""
import pathlib, tempfile, shutil, json, hashlib, tarfile, sys
build, archive = map(pathlib.Path, sys.argv[1:3])
commit = sys.argv[3]
with tempfile.TemporaryDirectory(prefix='duel-release-') as directory:
    out = pathlib.Path(directory)
    shutil.copytree(build/'cube/apps/web/.next/standalone', out/'web', symlinks=True)
    assert (out/'web/apps/web/.next/static').is_dir()
    (out/'web/source.json').write_text(json.dumps({'sourceCommit':commit,'workingTreeChanges':False}))
    shutil.copytree(build/'cube/apps/api/dist', out/'api/dist')
    for name in ['shared','duel-protocol']:
        source = build/'cube/packages'/name
        target = out/'api/node_modules/@ygocube'/name
        shutil.copytree(source/'dist', target/'dist')
        shutil.copy2(source/'package.json', target/'package.json')
    manifest = {str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.rglob('*')) if p.is_file()}
    (out/'app-manifest.json').write_text(json.dumps(manifest))
    with tarfile.open(archive,'w:gz') as tar:
        for item in out.iterdir(): tar.add(item,arcname=item.name)
print(json.dumps({'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':len(manifest)}))
