#!/usr/bin/env python3
"""Publish a rehearsed API/resource patch in an explicitly confirmed maintenance window."""
import argparse, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, time, urllib.request

P = pathlib.Path
parser = argparse.ArgumentParser()
parser.add_argument('stage', type=P)
parser.add_argument('--confirm-maintenance', action='store_true', required=True)
args = parser.parse_args()
stage = args.stage.resolve()
assert stage.parent == P('/opt/ygocube/.staging') and (stage/'verification.json').is_file()
payload = stage/'payload'
manifest = json.loads((payload/'manifest.json').read_text())
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def run(*cmd): return subprocess.check_output(cmd, text=True).strip()
def switch(root, target):
    temporary = root/'catalog-next'
    temporary.symlink_to(target)
    os.replace(temporary, root/'current')
def copy_file(src,dst):
    dst.parent.mkdir(parents=True,exist_ok=True)
    if dst.is_symlink(): dst.unlink()
    shutil.copy2(src,dst)
def health():
    for _ in range(40):
        try:
            for port in [3001,3101]:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=3) as r: assert r.status==200
            with urllib.request.urlopen('http://127.0.0.1:3101/public/duel/search?q=100200292',timeout=3) as r:
                assert any(c['code']==100200292 for c in json.load(r))
            return
        except Exception: time.sleep(1)
    raise RuntimeError('Post-deploy API health failed')

for name,sha in manifest['files'].items(): assert digest(payload/name)==sha, name
host=P('/opt/ygocube/shared/srvpro/ygopro')
for name,sha in manifest['expansionCdbs'].items(): assert digest(host/'expansions'/name)==sha, name
release='20260909-expansion-catalog-r10'
roots={name:P('/opt')/name for name in ['ygocube','ygoduel']}
olds={name:(root/'current').resolve() for name,root in roots.items()}
backups={name:root/'backups'/release for name,root in roots.items()}
news={name:root/'releases'/release for name,root in roots.items()}
protected=['ygocube-srvpro','ygocube-web','ygoduel-web','nginx']
baseline=run('systemctl','show',*protected,'-p','Id','-p','MainPID','-p','ExecMainStartTimestamp')
for name,root in roots.items():
    backups[name].mkdir(parents=True,exist_ok=False)
    assert not news[name].exists()
    shutil.copytree(olds[name],news[name],symlinks=True)
    for module in ['cards/cards.service.js','duel/duel.service.js','duel/replay-catalog.js']:
        target=news[name]/'api/dist'/module
        if target.exists(): copy_file(payload/'api'/module,target)
    (backups[name]/'previous-release.txt').write_text(str(olds[name]))

# The isolated host retains its own executable; data/scripts come from the audited resource generation.
new_duel=news['ygoduel']
for name in ['cards.cdb','strings.conf','lflist.conf']: copy_file(host/name,new_duel/'srvpro/ygopro'/name)
for name in ['script','expansions']:
    target=new_duel/'srvpro/ygopro'/name
    if target.is_symlink(): target.unlink()
    elif target.exists(): shutil.rmtree(target)
    shutil.copytree(host/name,target,ignore=shutil.ignore_patterns('pics','pack','*.ypk','corres_srv.ini'))
shutil.copytree(P('/opt/ygocube/shared/assets/pics_avif'),new_duel/'assets/pics_avif',dirs_exist_ok=True)
for src in (payload/'avif').glob('*.avif'): copy_file(src,new_duel/'assets/pics_avif'/src.name)
copy_file(P('/opt/ygocube/shared/assets/ygocdb_cards.json'),new_duel/'assets/ygocdb_cards.json')
assert 'not found' not in run('ldd',str(new_duel/'srvpro/ygopro/ygopro'))
config_file=roots['ygoduel']/'shared/config.yaml'
old_config=config_file.read_bytes()
config=json.loads(old_config)
config['server'].update(cards_cdb='/opt/ygoduel/current/srvpro/ygopro/cards.cdb',strings_conf='/opt/ygoduel/current/srvpro/ygopro/strings.conf',card_names_json='/opt/ygoduel/current/assets/ygocdb_cards.json')
config['pics']['avif_dir']='/opt/ygoduel/current/assets/pics_avif'
copy_file(config_file,backups['ygoduel']/'config.yaml')
for name in roots:
    metadata_file = news[name]/'release.json'
    if metadata_file.exists():
        metadata = json.loads(metadata_file.read_text())
        metadata.update(id=release, previousRelease=olds[name].name)
        metadata_file.write_text(json.dumps(metadata,indent=2))
resources = new_duel/'resources.json'
if resources.exists():
    values = json.loads(resources.read_text())
    values.update({name:digest(new_duel/'srvpro/ygopro'/name) for name in ['ygopro','cards.cdb','strings.conf','lflist.conf']})
    resources.write_text(json.dumps(values,indent=2))
for name in roots: run('chown','-R',f'{name}:{name}',str(news[name]))
for name in roots:
    (news[name]/'expansion-catalog-release.json').write_text(json.dumps({'id':release,'previousRelease':olds[name].name,'modules':manifest['files'],'expansionCdbs':manifest['expansionCdbs']},indent=2))
# Backup databases after stopping API writers. Cube native hosts and web servers remain running.
services=['ygocube-api','ygoduel-api','ygoduel-srvpro']
installed_images=[]
try:
    run('systemctl','stop',*services)
    for name,root in roots.items():
        database=root/'shared/data'/('cube.sqlite' if name=='ygocube' else 'duel.sqlite')
        source=sqlite3.connect(database)
        assert source.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        target=sqlite3.connect(backups[name]/database.name)
        source.backup(target);target.close();source.close()
    for src in (payload/'avif').glob('*.avif'):
        target=P('/opt/ygocube/shared/assets/pics_avif')/src.name
        existed=target.exists()
        if existed: copy_file(target,backups['ygocube']/'avif'/src.name)
        installed_images.append((target,existed))
        copy_file(src,target)
    config_file.write_text(json.dumps(config,indent=2))
    for name,root in roots.items(): switch(root,news[name])
    run('systemctl','start','ygocube-api','ygoduel-srvpro','ygoduel-api')
    health()
    assert baseline==run('systemctl','show',*protected,'-p','Id','-p','MainPID','-p','ExecMainStartTimestamp')
except Exception:
    run('systemctl','stop',*services)
    config_file.write_bytes(old_config)
    for name,root in roots.items():
        if (root/'current').resolve()!=olds[name]: switch(root,olds[name])
    for target,existed in installed_images:
        if existed: copy_file(backups['ygocube']/'avif'/target.name,target)
        else: target.unlink(missing_ok=True)
    run('systemctl','start','ygocube-api','ygoduel-srvpro','ygoduel-api')
    raise
result={'ok':True,'release':release,'backups':{n:str(p) for n,p in backups.items()},'protectedServicesUnchanged':True}
for backup in backups.values(): (backup/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
