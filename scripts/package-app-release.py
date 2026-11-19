#!/usr/bin/env python3
"""Package already built Linux Cube and Duel outputs for the Aly installer."""
import pathlib, shutil, json, hashlib, tarfile, sys
r, archive = map(pathlib.Path, sys.argv[1:3]); commit, branch, srvpro = sys.argv[3:6]
p = r/'payload'
shutil.copytree(r/'cube/apps/api/dist', p/'api/dist', dirs_exist_ok=True)
for name in ['shared','duel-protocol']:
    source = r/'cube/packages'/name
    target = p/'api/node_modules/@ygocube'/name
    shutil.copytree(source/'dist', target/'dist', dirs_exist_ok=True)
    (target/'package.json').write_text((source/'package.json').read_text())
# No srvpro change in this release; the installer retains the verified existing server.
(p/'srvpro').mkdir(exist_ok=True)
manifest = {'sourceCommit':commit,'sourceBranch':branch,'srvproCommit':srvpro,'files':{}}
for f in sorted(p.rglob('*')):
    if f.is_file() and f.name != 'manifest.json': manifest['files'][str(f.relative_to(p))] = hashlib.sha256(f.read_bytes()).hexdigest()
(p/'manifest.json').write_text(json.dumps(manifest))
with tarfile.open(archive,'w:gz') as tar:
    for f in p.iterdir(): tar.add(f, arcname=f.name)
print(json.dumps({'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':len(manifest['files'])}))
