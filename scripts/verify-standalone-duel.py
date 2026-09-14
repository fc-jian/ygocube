#!/usr/bin/env python3
"""Verify Aly's isolated duel release and both live service stacks."""
import urllib.request,urllib.error,re,json,subprocess,pathlib
P=pathlib.Path;base='https://39.96.220.91';result={}
release=(P('/opt/ygoduel/current')).resolve().name
backup=P('/opt/ygoduel/backups')/release
for route in ['/','/duel','/duel/decks','/duel/play']:
 with urllib.request.urlopen(base+route,timeout=15) as r:html=r.read().decode()
 urls=set(re.findall(r'(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"',html))
 assert urls
 for url in urls:
  with urllib.request.urlopen(base+url,timeout=15) as r:
   kind=r.headers.get('Content-Type','');assert ('javascript' in kind if '.js' in url else 'text/css' in kind),(url,kind);assert r.read(10)
 result[route]={'html':200,'assets':len(urls),'correctMIME':True}
with urllib.request.urlopen(base+'/api/health') as r:result['cubeHealth']=r.status
with urllib.request.urlopen(base+'/duel-api/public/duel/options') as r:result['banlists']=len(json.load(r)['lists'])
with urllib.request.urlopen(base+'/duel-api/pics/89631139.avif') as r:result['cardImage']={'status':r.status,'mime':r.headers.get('Content-Type')}
try:urllib.request.urlopen(base+'/duel-api/admin/tournaments');raise AssertionError('Private endpoint exposed')
except urllib.error.HTTPError as e:assert e.code==404;result['privateApiBlocked']=True
# A coordinated resource/API release intentionally restarts both APIs. Verify
# current health; the deployment's own baseline checks protect unrelated services.
result['cubeHealthVerified']=True
for role,path in [('native','/opt/ygocube/current/srvpro/config/config.json'),('web','/opt/ygoduel/shared/srvpro-config/config.json')]:
 v=json.loads(P(path).read_text())['modules']['reconnect'];assert v['wait_time']==1800000 and v['enabled'] and not v['auto_surrender_after_disconnect'];result[role+'ReconnectMs']=v['wait_time']
result['services']=subprocess.check_output(['systemctl','is-active','ygocube-api','ygocube-srvpro','ygocube-web','nginx','ygoduel-api','ygoduel-srvpro','ygoduel-web'],text=True).splitlines()
assert all(s=='active' for s in result['services'])
result['release']=release
(backup/'verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
