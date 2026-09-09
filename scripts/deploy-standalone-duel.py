#!/usr/bin/env python3
"""Install an isolated Aly test stack. Never restart or write Cube runtime files."""
import hashlib, json, os, pathlib, secrets, shutil, subprocess, sys, tarfile, time, urllib.request
P=pathlib.Path
ROOT=P('/opt/ygoduel')
RELEASE='20260906-independent-duel-r1'
ARCHIVE=P('/tmp/ygoduel-release.tar.gz')
def run(*args): return subprocess.check_output(args,text=True).strip()
def snapshot():
 return run('systemctl','show','ygocube-api','ygocube-srvpro','ygocube-web','nginx','-p','Id','-p','ActiveState','-p','MainPID','-p','ExecMainStartTimestamp')
def health(url):
 for _ in range(40):
  try:
   with urllib.request.urlopen(url,timeout=3) as r:
    if r.status==200:return
  except Exception:time.sleep(1)
 raise RuntimeError('Health check failed: '+url)
if os.geteuid()!=0:raise SystemExit('root required')
if len(sys.argv)!=2 or hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()!=sys.argv[1]:raise SystemExit('archive hash mismatch')
release=ROOT/'releases'/RELEASE
if release.exists():raise SystemExit('release exists; inspect before retry')
before=snapshot()
if before.count('ActiveState=active')!=4:raise SystemExit('Cube baseline is not healthy')
for port in (3100,3101,17911,17922):
 import socket
 with socket.socket() as sk:
  try:sk.bind(('127.0.0.1',port))
  except OSError:raise SystemExit(f'port {port} occupied')
release.mkdir(parents=True)
backup=ROOT/'backups'/RELEASE;backup.mkdir(parents=True)
(backup/'cube-services-before.txt').write_text(before)
# Python's data filter rejects archive traversal and escaping symlinks.
with tarfile.open(ARCHIVE) as tar:tar.extractall(release,filter='data')
for name,digest in json.loads((release/'checksums.json').read_text()).items():
 if hashlib.sha256((release/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('payload checksum mismatch '+name)
try:run('id','ygoduel')
except subprocess.CalledProcessError:run('useradd','--system','--home-dir',str(ROOT),'--shell','/usr/sbin/nologin','ygoduel')
# Copy dependencies and native resources; nothing in the existing release is modified.
current=P('/opt/ygocube/current').resolve()
api_modules=release/'api/node_modules'
for f in (current/'api/node_modules').iterdir():
 if f.name=='@ygocube' or (api_modules/f.name).exists():continue
 if f.is_dir():shutil.copytree(f,api_modules/f.name,symlinks=False)
 else:shutil.copy2(f,api_modules/f.name)
shutil.copytree(current/'srvpro/node_modules',release/'srvpro/node_modules',symlinks=False)
shutil.copytree('/opt/ygocube/shared/srvpro/ygopro',release/'srvpro/ygopro',symlinks=False)
shared=ROOT/'shared';shared.mkdir(exist_ok=True)
for name in ('data','archives','assets','srvpro-config','replay','deck','logs','decks','replays','deck_log'):(shared/name).mkdir(exist_ok=True)
shutil.copy2('/opt/ygocube/shared/assets/ygocdb_cards.json',shared/'assets/ygocdb_cards.json')
shutil.copytree('/opt/ygocube/shared/assets/pics_avif',shared/'assets/pics_avif',dirs_exist_ok=True)
for name,target in [(n,shared/n) for n in ('logs','decks','replays','deck_log')] + [('config',shared/'srvpro-config'),('ygopro/replay',shared/'replay'),('ygopro/deck',shared/'deck')]:
 link=release/'srvpro'/name
 if link.exists():raise RuntimeError('unexpected writable runtime directory '+name)
 link.symlink_to(target,target_is_directory=True)
key=secrets.token_hex(32)
config={
 'admin':{'super_token':secrets.token_hex(32)},
 'srvpro':{'url':'http://127.0.0.1:17922','api_key':key,'host':'127.0.0.1','game_port':17911},
 'server':{'host':'127.0.0.1','port':3101,'db_path':str(shared/'data/duel.sqlite'),'cards_cdb':str(release/'srvpro/ygopro/cards.cdb'),'strings_conf':str(release/'srvpro/ygopro/strings.conf'),'card_names_json':str(shared/'assets/ygocdb_cards.json'),'allowed_origins':['https://39.96.220.91']},
 'web_duel':{'enabled':True,'archive_dir':str(shared/'archives'),'upstream_host':'127.0.0.1','protocol_version':4962,'max_connections':32},
 'pics':{'avif_dir':str(shared/'assets/pics_avif')}
}
# JSON is valid YAML; secrets are generated remotely and never printed.
(shared/'config.yaml').write_text(json.dumps(config,indent=2));os.chmod(shared/'config.yaml',0o600)
srv={'port':17911,'bind_address':'127.0.0.1','version':4962,'modules':{'http':{'port':17922,'ssl':{'enabled':False}},'cube':{'enabled':True,'api_key':key,'webhook_url':'','web_max_rooms':8},'random_duel':{'enabled':False},'mysql':{'enabled':False},'cloud_replay':{'enabled':False},'dialogues':{'enabled':False},'tips':{'enabled':False},'neos':{'enabled':False},'reconnect':{'enabled':True,'allow_kick_reconnect':True,'wait_time':1800000},'max_mem_percentage':100}}
(shared/'srvpro-config/config.json').write_text(json.dumps(srv));os.chmod(shared/'srvpro-config/config.json',0o600)
(release/'srvpro/plugins').mkdir(exist_ok=True)
run('chown','-R','ygoduel:ygoduel',str(ROOT))
resources={name:hashlib.sha256((release/'srvpro/ygopro'/name).read_bytes()).hexdigest() for name in ('ygopro','cards.cdb','strings.conf','lflist.conf')}
(release/'resources.json').write_text(json.dumps(resources,indent=2))
ldd=run('ldd',str(release/'srvpro/ygopro/ygopro'))
if 'not found' in ldd:raise RuntimeError(ldd)
run('node','-e',"for(const n of ['ws','better-sqlite3','@ygocube/duel-protocol'])require(require.resolve(n,{paths:[process.argv[1]]}))",str(release/'api'))
(ROOT/'current').symlink_to(release,target_is_directory=True)
P('/etc/systemd/system/ygoduel.slice').write_text('[Unit]\nDescription=Independent web duel test resource budget\n[Slice]\nCPUQuota=100%\nMemoryHigh=500M\nMemoryMax=600M\nTasksMax=128\n')
for name,cwd,entry,env in [
 ('api',ROOT/'current/api',ROOT/'current/api/dist/main.js',f'Environment=CONFIG_FILE={shared}/config.yaml\n'),
 ('srvpro',ROOT/'current/srvpro',ROOT/'current/srvpro/ygopro-server.js',''),
 ('web',ROOT/'current/web',ROOT/'current/web/apps/web/server.js','Environment=HOSTNAME=127.0.0.1\nEnvironment=PORT=3100\n')]:
 P(f'/etc/systemd/system/ygoduel-{name}.service').write_text(f'''[Unit]
Description=Independent web duel {name} test service
After=network-online.target
[Service]
Type=simple
User=ygoduel
Group=ygoduel
Slice=ygoduel.slice
WorkingDirectory={cwd}
Environment=NODE_ENV=production
{env}ExecStart=/usr/bin/node {entry}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={shared}
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
''')
run('systemctl','daemon-reload')
run('systemctl','set-property','ygoduel-srvpro.service','IPAddressDeny=any','IPAddressAllow=localhost')
run('systemctl','enable','--now','ygoduel-api','ygoduel-srvpro','ygoduel-web')
health('http://127.0.0.1:3101/health');health('http://127.0.0.1:3101/public/duel/options');health('http://127.0.0.1:3100/duel')
nginx=P('/etc/nginx/conf.d/ygocube.conf');original=nginx.read_text()
shutil.copy2(nginx,backup/'ygocube-nginx.conf')
snippet=P('/etc/nginx/ygoduel-locations.conf')
if snippet.exists():raise RuntimeError('existing duel nginx snippet requires inspection')
common='''proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Real-IP $remote_addr;
'''
blocks=[]
for location,target in [('= /duel','http://127.0.0.1:3100'),('^~ /duel/','http://127.0.0.1:3100'),('^~ /duel-assets/','http://127.0.0.1:3100/'),('^~ /duel-api/public/duel/','http://127.0.0.1:3101/public/duel/'),('^~ /duel-api/pics/','http://127.0.0.1:3101/pics/')]:
 blocks.append(f'location {location} {{\n proxy_pass {target};\n{common}proxy_set_header Connection "";\n}}')
blocks.append('''location = /duel-api/duel/ws {
 proxy_pass http://127.0.0.1:3101/duel/ws;
'''+common+'''proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection "upgrade";
 proxy_set_header Origin $http_origin;
 proxy_buffering off;
 proxy_read_timeout 60s;
}
location /duel-api/ { return 404; }
''')
snippet.write_text('\n'.join(blocks))
anchor='    # The web app uses /api/* and SSE; keep the stream unbuffered.'
if original.count(anchor)!=1:raise RuntimeError('nginx insertion anchor mismatch')
nginx.write_text(original.replace(anchor,'    include /etc/nginx/ygoduel-locations.conf;\n\n'+anchor))
try:
 run('nginx','-t');run('systemctl','reload','nginx')
except Exception:
 nginx.write_text(original);raise
health('https://39.96.220.91/duel');health('https://39.96.220.91/api/health')
after=snapshot();(backup/'cube-services-after.txt').write_text(after)
if before!=after:raise RuntimeError('existing Cube service identity changed; inspect immediately')
print(json.dumps({'ok':True,'release':str(release),'build':json.loads((release/'release.json').read_text())['webBuildId'],'cubeProcessesUnchanged':True,'backup':str(backup)}))
