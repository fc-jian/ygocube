#!/usr/bin/env python3
"""Enable only the isolated stack's native TCP ingress while it has no active host."""
import json, pathlib, subprocess, shutil, time, urllib.request, urllib.parse, os
P=pathlib.Path; root=P('/opt/ygoduel'); shared=root/'shared'
def run(*args): return subprocess.check_output(args,text=True).strip()
def occupied(): return subprocess.run(['pgrep','-u','ygoduel','-x','ygopro'],stdout=subprocess.DEVNULL).returncode==0
assert not occupied(), 'Active independent host; configuration deferred'
backup=root/'backups'/(root/'current').resolve().name/'native-bridge'
assert not backup.exists(), 'Bridge configuration already attempted; inspect backup first'
backup.mkdir()
files=[shared/'config.yaml',shared/'srvpro-config/config.json',P('/etc/systemd/system/ygoduel-native.socket'),P('/etc/systemd/system/ygoduel-native.service')]
original={str(p):p.read_bytes() if p.exists() else None for p in files}
for i,p in enumerate(files):
 if p.exists(): shutil.copy2(p,backup/str(i))
baseline=run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
config=json.loads(files[0].read_text()); native=json.loads(files[1].read_text())
web=config['web_duel']; web.setdefault('public_url',config['server']['allowed_origins'][0].rstrip('/')+'/duel')
web.setdefault('native_host',urllib.parse.urlparse(web['public_url']).hostname);web.setdefault('native_port',17911)
route=json.loads(run('ip','-4','-j','route','get','1.1.1.1'))[0]
web.setdefault('native_bind_address',route['prefsrc'])
port=web['native_port'];assert port==17911 and native['port']==17911 and native['bind_address']=='127.0.0.1'
assert urllib.parse.urlparse(web['public_url']).scheme=='https'
module=native['modules']['cube'];module.update(web_public_url=web['public_url'],web_native_host=web['native_host'],web_native_port=port)
zone=run('firewall-cmd','--get-zone-of-interface='+route['dev'])
if zone=='no zone':zone=run('firewall-cmd','--get-default-zone')
fw=['firewall-cmd','--zone='+zone]; opened=[]
run('systemctl','stop','ygoduel-web','ygoduel-api')
if occupied():
 run('systemctl','start','ygoduel-api','ygoduel-web');raise SystemExit('Host appeared; old configuration resumed')
run('systemctl','stop','ygoduel-srvpro')
try:
 files[0].write_text(json.dumps(config,indent=2));files[1].write_text(json.dumps(native,indent=2))
 for p in files[:2]:os.chmod(p,0o600);shutil.chown(p,user='ygoduel',group='ygoduel')
 files[2].write_text(f'''[Unit]
Description=Independent YGOPro public game socket
[Socket]
ListenStream={web['native_bind_address']}:{port}
NoDelay=true
[Install]
WantedBy=sockets.target
''')
 files[3].write_text('''[Unit]
Description=Independent YGOPro TCP ingress to loopback srvpro
Requires=ygoduel-native.socket
After=ygoduel-srvpro.service
[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:17911
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Slice=ygoduel.slice
''')
 run('systemctl','daemon-reload');run('systemctl','start','ygoduel-srvpro','ygoduel-api','ygoduel-web')
 run('systemctl','enable','--now','ygoduel-native.socket')
 for permanent in [False,True]:
  args=fw+(['--permanent'] if permanent else [])
  if subprocess.run(args+['--query-port=17911/tcp'],stdout=subprocess.DEVNULL).returncode:
   run(*args,'--add-port=17911/tcp');opened.append(permanent)
 for i in range(30):
  try:
   with urllib.request.urlopen('http://127.0.0.1:3101/public/duel/options',timeout=2) as r:assert r.status==200
   break
  except Exception:
   if i==29:raise
   time.sleep(1)
 assert baseline==run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','MainPID','-p','ExecMainStartTimestamp')
 (backup/'cube-baseline.txt').write_text(baseline)
 print(json.dumps({'ok':True,'host':web['native_host'],'port':port,'privateListenersUnchanged':True,'cubeUnchanged':True}))
except Exception:
 run('systemctl','stop','ygoduel-native.socket','ygoduel-native.service')
 for p in files:
  data=original[str(p)]
  if data is None:p.unlink(missing_ok=True)
  else:p.write_bytes(data)
 for permanent in opened:run(*fw,*(['--permanent'] if permanent else []),'--remove-port=17911/tcp')
 run('systemctl','daemon-reload');run('systemctl','restart','ygoduel-srvpro','ygoduel-api','ygoduel-web');raise
