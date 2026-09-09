#!/usr/bin/env python3
"""Install and verify the two Web bundles without restarting duel backends."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tarfile,time,urllib.request,re
P=pathlib.Path
archive=P(sys.argv[1]);assert hashlib.sha256(archive.read_bytes()).hexdigest()==sys.argv[2]
release='20260909-local-expansion-pics-r11'
stage=P('/opt/ygocube/.staging')/release;stage.mkdir(parents=True,exist_ok=False)
with tarfile.open(archive) as t:
 for m in t.getmembers():assert P(m.name).parts[0] in ['ygocube','ygoduel','manifest.json'] and '..' not in P(m.name).parts
 t.extractall(stage,filter='data')
for name,sha in json.loads((stage/'manifest.json').read_text()).items():assert hashlib.sha256((stage/name).read_bytes()).hexdigest()==sha,name
def run(*cmd):return subprocess.check_output(cmd,text=True).strip()
def switch(root,target):
 (root/'pics-next').symlink_to(target);os.replace(root/'pics-next',root/'current')
protected=['ygocube-api','ygocube-srvpro','ygoduel-api','ygoduel-srvpro','nginx']
baseline=run('systemctl','show',*protected,'-p','MainPID','-p','ExecMainStartTimestamp')
olds={};news={};results={}
for service in ['ygocube','ygoduel']:
 root=P('/opt')/service;old=(root/'current').resolve();new=root/'releases'/release
 backup=root/'backups'/release;backup.mkdir(parents=True,exist_ok=False)
 shutil.copytree(old,new,symlinks=True)
 # Overlay hashed assets; retain previous immutable chunks for existing tabs.
 shutil.rmtree(new/'web')
 shutil.copytree(stage/service/'web',new/'web',symlinks=True)
 app=new/'web'/('standalone/apps/web' if service=='ygocube' else 'apps/web')
 assert (app/'.next/static').is_dir() and (app/'.next/BUILD_ID').is_file()
 old_static=old/'web'/('standalone/apps/web/.next/static' if service=='ygocube' else 'apps/web/.next/static')
 for previous in old_static.rglob('*'):
  target=app/'.next/static'/previous.relative_to(old_static)
  if previous.is_file() and not target.exists():
   target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(previous,target)
 metadata=new/'release.json'
 if metadata.exists():
  v=json.loads(metadata.read_text());v.update(id=release,previousRelease=old.name,webBuildId=(app/'.next/BUILD_ID').read_text().strip());metadata.write_text(json.dumps(v,indent=2))
 run('chown','-R',service+':'+service,str(new))
 (backup/'previous-release.txt').write_text(str(old))
 olds[service]=old;news[service]=new
try:
 for service in news:switch(P('/opt')/service,news[service])
 run('systemctl','restart','ygocube-web','ygoduel-web')
 for route in ['/','/duel','/duel/decks']:
  for attempt in range(30):
   try:
    with urllib.request.urlopen('https://39.96.220.91'+route,timeout=5) as r:html=r.read().decode()
    break
   except Exception:
    if attempt==29:raise
    time.sleep(1)
  assets=set(re.findall(r'(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"',html));assert assets
  for asset in assets:
   with urllib.request.urlopen('https://39.96.220.91'+asset,timeout=10) as r:
    assert ('javascript' in r.headers.get('Content-Type','') if '.js' in asset else 'text/css' in r.headers.get('Content-Type',''))
  results[route]={'status':200,'assets':len(assets)}
 assert baseline==run('systemctl','show',*protected,'-p','MainPID','-p','ExecMainStartTimestamp')
except Exception:
 for service in olds:switch(P('/opt')/service,olds[service])
 run('systemctl','restart','ygocube-web','ygoduel-web');raise
result={'ok':True,'release':release,'backendsUnchanged':True,'pages':results}
for service in news:(P('/opt')/service/'backups'/release/'verification.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
