#!/usr/bin/env python3
"""Stage or activate a checksummed Cube/Duel application release."""
import argparse, hashlib, json, os, pathlib, re, shutil, sqlite3, subprocess, tarfile, time, urllib.request
P = pathlib.Path
ap = argparse.ArgumentParser()
ap.add_argument('archive', type=P)
ap.add_argument('sha256')
ap.add_argument('release')
ap.add_argument('--activate', action='store_true')
a = ap.parse_args()
assert re.fullmatch(r'[a-z0-9-]+', a.release)
roots = {n: P('/opt')/n for n in ['ygocube', 'ygoduel']}
stage = roots['ygocube']/'.staging'/a.release

def run(*args): return subprocess.check_output(args, text=True).strip()
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def switch(root, target):
    link = root/(a.release+'-next')
    link.symlink_to(target)
    os.replace(link, root/'current')
def occupied(): return subprocess.run(['pgrep', '-x', 'ygopro'], stdout=subprocess.DEVNULL).returncode == 0

def health():
    for _ in range(40):
        try:
            for port in [3001, 3101]:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=3) as r: assert r.status == 200
            with urllib.request.urlopen('http://127.0.0.1:3101/public/duel/options', timeout=5) as r: lists = json.load(r)['lists']
            assert any(l.get('limits') for l in lists), 'Missing banlist contents'
            return
        except Exception: time.sleep(1)
    raise RuntimeError('API health failed')

assert sha(a.archive) == a.sha256
if not stage.exists():
    stage.mkdir(parents=True)
    with tarfile.open(a.archive) as t:
        for m in t.getmembers():
            assert not P(m.name).is_absolute() and '..' not in P(m.name).parts
        t.extractall(stage, filter='data')
manifest = json.loads((stage/'manifest.json').read_text())
for f, h in manifest['files'].items(): assert sha(stage/f) == h, f
olds = {n:(root/'current').resolve() for n,root in roots.items()}
news = {n:root/'releases'/a.release for n,root in roots.items()}
for n,new in news.items():
    if new.exists():
        assert (new/'COMMIT').read_text().strip() == manifest['sourceCommit']
        continue
    shutil.copytree(olds[n], new, symlinks=True)
    shutil.rmtree(new/'web')
    shutil.copytree(stage/n/'web', new/'web', symlinks=True)
    shutil.rmtree(new/'api/dist')
    shutil.copytree(stage/'api/dist', new/'api/dist')
    shutil.copytree(stage/'api/node_modules', new/'api/node_modules', dirs_exist_ok=True)
    shutil.copytree(stage/'srvpro', new/'srvpro', dirs_exist_ok=True)
    app = new/'web'/('standalone/apps/web' if n == 'ygocube' else 'apps/web')
    assert (app/'.next/static').is_dir() and (app/'.next/BUILD_ID').is_file()
    old_static = olds[n]/'web'/('standalone/apps/web/.next/static' if n == 'ygocube' else 'apps/web/.next/static')
    for src in old_static.rglob('*'):
        target = app/'.next/static'/src.relative_to(old_static)
        if src.is_file() and not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, target)
    metadata = dict(id=a.release, sourceCommit=manifest['sourceCommit'], sourceBranch='main', workingTreeChanges=False,
                    previousRelease=olds[n].name, webBuildId=(app/'.next/BUILD_ID').read_text().strip(),
                    artifactSha256=a.sha256, srvproCommit=manifest['srvproCommit'])
    (new/'release.json').write_text(json.dumps(metadata, indent=2))
    (new/'COMMIT').write_text(manifest['sourceCommit']+'\n')
    (new/'RELEASE_ID').write_text(a.release+'\n')
    run('chown','-R',n+':'+n,str(new))
    run('/usr/bin/node','-e',"require(process.argv[1]+'/node_modules/ws'); require(process.argv[1]+'/node_modules/@ygocube/duel-protocol')",str(new/'api'))
if not a.activate:
    print(json.dumps({'prepared':True,'release':a.release,'sourceCommit':manifest['sourceCommit']}))
    raise SystemExit()
assert not occupied(), 'Active duel host; deployment deferred'
services = [n+'-'+s for n in roots for s in ['api','srvpro','web']]
nginx = run('systemctl','show','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
for n,root in roots.items():
    backup=root/'backups'/a.release
    backup.mkdir(parents=True,exist_ok=False)
    (backup/'previous-release.txt').write_text(str(olds[n]))
    shutil.copy2(root/'shared/config.yaml',backup/'config.yaml')
try:
    run('systemctl','stop','ygocube-api','ygoduel-api')
    assert not occupied(), 'Host appeared during maintenance preflight'
    run('systemctl','stop','ygocube-srvpro','ygoduel-srvpro','ygocube-web','ygoduel-web')
    for n,root in roots.items():
        dbfile=root/'shared/data'/('cube.sqlite' if n=='ygocube' else 'duel.sqlite')
        with sqlite3.connect(dbfile) as db, sqlite3.connect(root/'backups'/a.release/dbfile.name) as out:
            db.backup(out)
            assert out.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        switch(root,news[n])
    run('systemctl','start',*services)
    health()
    results={}
    for route in ['/','/duel','/duel/decks']:
        for attempt in range(30):
            try:
                with urllib.request.urlopen('https://39.96.220.91'+route,timeout=10) as r: html=r.read().decode()
                break
            except Exception:
                if attempt==29: raise
                time.sleep(1)
        assets=set(re.findall(r'(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"',html)); assert assets
        for asset in assets:
            with urllib.request.urlopen('https://39.96.220.91'+asset,timeout=10) as r:
                assert r.status==200
                assert ('javascript' in r.headers.get('Content-Type','') if '.js' in asset else 'text/css' in r.headers.get('Content-Type',''))
        results[route]={'status':200,'assets':len(assets)}
    assert all(s=='active' for s in run('systemctl','is-active',*services,'nginx').splitlines())
    assert nginx==run('systemctl','show','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
except Exception:
    for n,root in roots.items():
        if (root/'current').resolve()!=olds[n]: switch(root,olds[n])
    run('systemctl','restart',*services)
    raise
result={'ok':True,'release':a.release,'commit':manifest['sourceCommit'],'pages':results,'services':services+['nginx']}
for n,root in roots.items(): (root/'backups'/a.release/'verification.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
