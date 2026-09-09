#!/usr/bin/env python3
"""Install a verified update into the isolated test stack only."""
import pathlib,subprocess,shutil,hashlib,tarfile,json,sqlite3,urllib.request,time,os,sys,re
P=pathlib.Path;root=P('/opt/ygoduel')
release=sys.argv[2];assert re.fullmatch(r'[a-z0-9-]+',release)
new=root/'releases'/release;old=(root/'current').resolve();archive=P(sys.argv[3]);manifest=sys.argv[4]
assert P(manifest).name==manifest
web_only=len(sys.argv)>5 and sys.argv[5]=="--web-only"
def run(*args):return subprocess.check_output(args,text=True).strip()
def occupied():return subprocess.run(['pgrep','-u','ygoduel','-x','ygopro'],stdout=subprocess.DEVNULL).returncode==0
def healthy():
 for _ in range(30):
  try:
   for url in ['http://127.0.0.1:3101/health','http://127.0.0.1:3101/public/duel/options','http://127.0.0.1:3100/duel']:
    with urllib.request.urlopen(url,timeout=3) as r:assert r.status==200
   return
  except Exception:time.sleep(1)
 raise RuntimeError('new release health failed')
if not web_only and occupied():raise SystemExit('Active independent host; deployment deferred')
if new.exists():raise SystemExit('release exists')
assert hashlib.sha256(archive.read_bytes()).hexdigest()==sys.argv[1]
baseline=run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','-p','MainPID','-p','ExecMainStartTimestamp')
backup=root/'backups'/release;backup.mkdir(parents=True)
shutil.copytree(old,new,symlinks=True)
with tarfile.open(archive) as t:
 if web_only:assert all(m.name=='web' or m.name.startswith('web/') or m.name==manifest for m in t.getmembers()),'Web-only archive contains backend files'
 t.extractall(new,filter='data')
for path,digest in json.loads((new/manifest).read_text()).items():assert hashlib.sha256((new/path).read_bytes()).hexdigest()==digest,path
if 'srvpro/ygopro/ygopro' in json.loads((new/manifest).read_text()):
 native=new/'srvpro/ygopro/ygopro'
 assert 'not found' not in run('ldd',str(native)), 'native dependency missing'
 resources=new/'resources.json'
 if resources.exists():
  values=json.loads(resources.read_text());values['ygopro']=hashlib.sha256(native.read_bytes()).hexdigest();resources.write_text(json.dumps(values,indent=2))
metadata=json.loads((new/'release.json').read_text())
metadata.update(id=new.name,previousRelease=old.name,webBuildId=(new/'web/apps/web/.next/BUILD_ID').read_text().strip(),artifactSha256=hashlib.sha256(archive.read_bytes()).hexdigest())
(new/'release.json').write_text(json.dumps(metadata,indent=2))
# Preserve old immutable assets so open browser tabs can finish loading.
run('chown','-R','ygoduel:ygoduel',str(new))
if web_only:
 protected=run('systemctl','show','ygoduel-api','ygoduel-srvpro','-p','MainPID','-p','ExecMainStartTimestamp')
 try:
  (root/'next').symlink_to(new);os.replace(root/'next',root/'current')
  run('systemctl','restart','ygoduel-web');healthy()
 except Exception:
  (root/'rollback').symlink_to(old);os.replace(root/'rollback',root/'current');run('systemctl','restart','ygoduel-web');raise
 assert protected==run('systemctl','show','ygoduel-api','ygoduel-srvpro','-p','MainPID','-p','ExecMainStartTimestamp')
 assert baseline==run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','-p','MainPID','-p','ExecMainStartTimestamp')
 (backup/'cube-baseline.txt').write_text(baseline)
 (backup/'duel-backend-baseline.txt').write_text(protected)
 print(json.dumps({'ok':True,'release':str(new),'webOnly':True,'backendsUnchanged':True,'build':metadata['webBuildId']}))
 raise SystemExit(0)
run('systemctl','stop','ygoduel-web','ygoduel-api')
if occupied():
 run('systemctl','start','ygoduel-api','ygoduel-web');raise SystemExit('Host appeared; old release resumed')
run('systemctl','stop','ygoduel-srvpro')
try:
 db=sqlite3.connect(root/'shared/data/duel.sqlite');out=sqlite3.connect(backup/'duel.sqlite');db.backup(out);out.close();db.close()
 (root/'next').symlink_to(new);os.replace(root/'next',root/'current')
 run('systemctl','start','ygoduel-api','ygoduel-srvpro','ygoduel-web');healthy()
except Exception:
 (root/'rollback').symlink_to(old);os.replace(root/'rollback',root/'current');run('systemctl','restart','ygoduel-api','ygoduel-srvpro','ygoduel-web');raise
assert baseline==run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','-p','MainPID','-p','ExecMainStartTimestamp')
(backup/'cube-baseline.txt').write_text(baseline)
print(json.dumps({'ok':True,'release':str(new),'cubeUnchanged':True,'build':(new/'web/apps/web/.next/BUILD_ID').read_text().strip()}))
