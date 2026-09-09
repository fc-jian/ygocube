#!/usr/bin/env python3
"""Set both Aly srvpro reconnect windows without restarting Cube web/API."""
import pathlib,json,subprocess,shutil,time
P=pathlib.Path
backup=P('/opt/ygoduel/backups/20260907-retention');backup.mkdir(parents=True,exist_ok=True)
def run(*a):return subprocess.check_output(a,text=True).strip()
def assert_idle():
 assert subprocess.run(['pgrep','-x','ygopro'],stdout=subprocess.DEVNULL).returncode==1,'Active host: retry after matches finish'
 assert not run('ss','-Htn','state','established','( sport = :7911 or sport = :17911 )'),'Connected native clients: defer restart'
assert_idle()
baseline=run('systemctl','show','ygocube-api','ygocube-web','-p','MainPID','-p','ExecMainStartTimestamp')
paths=[P('/opt/ygocube/current/srvpro/config/config.json'),P('/opt/ygoduel/shared/srvpro-config/config.json')]
old=[]
for i,path in enumerate(paths):
 old.append(path.read_bytes());saved=backup/f'config-{i}.json';assert not saved.exists(),'Retention already applied; inspect before retry'
 shutil.copy2(path,saved)
 value=json.loads(old[-1]);value.setdefault('modules',{}).setdefault('reconnect',{}).update(enabled=True,wait_time=1800000,auto_surrender_after_disconnect=False)
 path.write_text(json.dumps(value,indent=2))
try:
 assert_idle()
 run('systemctl','restart','ygocube-srvpro')
 assert run('systemctl','is-active','ygocube-srvpro')=='active'
 assert baseline==run('systemctl','show','ygocube-api','ygocube-web','-p','MainPID','-p','ExecMainStartTimestamp')
except Exception:
 for path,data in zip(paths,old):path.write_bytes(data)
 raise
(backup/'cube-web-api-baseline.txt').write_text(baseline)
print(json.dumps({'waitMs':1800000,'cubeWebApiUnchanged':True,'nativeSrvpro':'active','independent':'configured; activated by next release'}))
