#!/usr/bin/env python3
"""Install a verified update into the isolated test stack only."""
import pathlib,subprocess,shutil,hashlib,tarfile,json,sqlite3,urllib.request,time,os,sys,re
import importlib.util
import fcntl
resource_lock=open('/opt/ygocube/.card-resource-deploy.lock','a')
fcntl.flock(resource_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
helper_path=pathlib.Path('/opt/ygocube/shared/card-resource-tools/apply-duel.py')
if not helper_path.is_file():raise SystemExit('Install current resource workflow before application deployment')
spec=importlib.util.spec_from_file_location('resource_apply',helper_path)
resource_apply=importlib.util.module_from_spec(spec);spec.loader.exec_module(resource_apply)
P=pathlib.Path;root=P('/opt/ygoduel')
release=sys.argv[2];assert re.fullmatch(r'[a-z0-9-]+',release)
new=root/'releases'/release;old=(root/'current').resolve();archive=P(sys.argv[3]);manifest=sys.argv[4]
assert P(manifest).name==manifest
web_only=len(sys.argv)>5 and sys.argv[5]=="--web-only"
api_only=len(sys.argv)>5 and sys.argv[5]=="--api-only"
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
baseline=run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
backup=root/'backups'/release;backup.mkdir(parents=True,exist_ok=False)
(backup/'previous-release.txt').write_text(str(old))
shutil.copy2(root/'shared/config.yaml',backup/'config.yaml')
shutil.copytree(old,new,symlinks=True,copy_function=resource_apply.hardlink_file)
with tarfile.open(archive) as t:
 if web_only:assert all(m.name=='web' or m.name.startswith('web/') or m.name==manifest for m in t.getmembers()),'Web-only archive contains backend files'
resource_apply.extract_application_archive(archive,new)
for path,digest in json.loads((new/manifest).read_text()).items():assert hashlib.sha256((new/path).read_bytes()).hexdigest()==digest,path
if 'srvpro/ygopro/ygopro' in json.loads((new/manifest).read_text()):
 native=new/'srvpro/ygopro/ygopro'
 assert 'not found' not in run('ldd',str(native)), 'native dependency missing'
 resources=new/'resources.json'
 if resources.exists():
  values=json.loads(resources.read_text());values['ygopro']=hashlib.sha256(native.read_bytes()).hexdigest();resource_apply.atomic_write_text(resources,json.dumps(values,indent=2))
metadata=json.loads((new/'release.json').read_text())
metadata.update(id=new.name,previousRelease=old.name,webBuildId=(new/'web/apps/web/.next/BUILD_ID').read_text().strip(),artifactSha256=hashlib.sha256(archive.read_bytes()).hexdigest())
if (new/'web/source.json').exists():
 provenance=json.loads((new/'web/source.json').read_text())
 metadata.update({k:provenance[k] for k in ['sourceCommit','workingTreeChanges','webSourceSha256','applicationSourceSha256'] if k in provenance})
resource_apply.atomic_write_text(new/'release.json',json.dumps(metadata,indent=2))
# Preserve old immutable assets so open browser tabs can finish loading.
resource_apply.link_existing_release_resources(P('/opt/ygocube'),new)
resource_apply.set_release_ownership(new)
if api_only:
 # A follow-up API fix must preserve the already verified frontend and srvpro.
 for path,digest in json.loads((new/manifest).read_text()).items():
  if path.startswith('web/') and path!='web/source.json':assert (old/path).is_file() and hashlib.sha256((old/path).read_bytes()).hexdigest()==digest,path
 protected=run('systemctl','show','ygoduel-web','ygoduel-srvpro','-p','MainPID','-p','ExecMainStartTimestamp')
 run('systemctl','stop','ygoduel-api')
 try:
  db=sqlite3.connect(root/'shared/data/duel.sqlite');out=sqlite3.connect(backup/'duel.sqlite');db.backup(out);assert out.execute('PRAGMA integrity_check').fetchone()[0]=='ok';out.close();db.close()
  (root/'next').symlink_to(new);os.replace(root/'next',root/'current')
  run('systemctl','start','ygoduel-api');healthy()
 except Exception:
  (root/'rollback').symlink_to(old);os.replace(root/'rollback',root/'current');run('systemctl','restart','ygoduel-api');raise
 assert protected==run('systemctl','show','ygoduel-web','ygoduel-srvpro','-p','MainPID','-p','ExecMainStartTimestamp')
 assert baseline==run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
 (backup/'cube-baseline.txt').write_text(baseline)
 (backup/'duel-protected-baseline.txt').write_text(protected)
 print(json.dumps({'ok':True,'release':str(new),'apiOnly':True,'otherServicesUnchanged':True,'build':metadata['webBuildId']}))
 raise SystemExit(0)
if web_only:
 protected=run('systemctl','show','ygoduel-api','ygoduel-srvpro','-p','MainPID','-p','ExecMainStartTimestamp')
 try:
  (root/'next').symlink_to(new);os.replace(root/'next',root/'current')
  run('systemctl','restart','ygoduel-web');healthy()
 except Exception:
  (root/'rollback').symlink_to(old);os.replace(root/'rollback',root/'current');run('systemctl','restart','ygoduel-web');raise
 assert protected==run('systemctl','show','ygoduel-api','ygoduel-srvpro','-p','MainPID','-p','ExecMainStartTimestamp')
 assert baseline==run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
 (backup/'previous-release.txt').write_text(str(old))
 (backup/'cube-baseline.txt').write_text(baseline)
 (backup/'duel-backend-baseline.txt').write_text(protected)
 print(json.dumps({'ok':True,'release':str(new),'webOnly':True,'backendsUnchanged':True,'build':metadata['webBuildId']}))
 raise SystemExit(0)
resource_apply.enter_maintenance()
run('systemctl','stop','ygoduel-web')
try:
 db=sqlite3.connect(root/'shared/data/duel.sqlite');out=sqlite3.connect(backup/'duel.sqlite');db.backup(out);assert out.execute('PRAGMA integrity_check').fetchone()[0]=='ok';out.close();db.close()
 shutil.copytree(root/'shared/srvpro-config',backup/'srvpro-config')
 (root/'next').symlink_to(new);os.replace(root/'next',root/'current')
 run('systemctl','start','ygoduel-api','ygoduel-srvpro','ygoduel-web');healthy()
except Exception:
 (root/'rollback').symlink_to(old);os.replace(root/'rollback',root/'current');run('systemctl','restart','ygoduel-api','ygoduel-srvpro','ygoduel-web');raise
assert baseline==run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
(backup/'cube-baseline.txt').write_text(baseline)
print(json.dumps({'ok':True,'release':str(new),'cubeUnchanged':True,'build':(new/'web/apps/web/.next/BUILD_ID').read_text().strip()}))
