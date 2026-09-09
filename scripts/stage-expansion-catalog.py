#!/usr/bin/env python3
"""Rehearse the catalogue patch on Aly without changing running services."""
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile

P = pathlib.Path
archive = P(sys.argv[1])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == sys.argv[2]
stage = P('/opt/ygocube/.staging') / ('expansion-catalog-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
stage.mkdir(mode=0o700, parents=True, exist_ok=False)
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        assert member.isfile() and not member.name.startswith('/') and '..' not in P(member.name).parts
    tar.extractall(stage / 'payload', filter='data')
payload = stage / 'payload'
manifest = json.loads((payload / 'manifest.json').read_text())
for name, digest in manifest['files'].items():
    assert hashlib.sha256((payload / name).read_bytes()).hexdigest() == digest, name
host = P('/opt/ygocube/shared/srvpro/ygopro')
for name, digest in manifest['expansionCdbs'].items():
    assert hashlib.sha256((host / 'expansions' / name).read_bytes()).hexdigest() == digest, name

results = {}
for service in ['ygocube', 'ygoduel']:
    root = P('/opt') / service
    current = (root / 'current').resolve()
    trial = stage / service
    trial.mkdir()
    shutil.copytree(current / 'api/dist', trial / 'dist')
    (trial / 'node_modules').symlink_to(current / 'api/node_modules')
    for name in ['cards/cards.service.js', 'duel/duel.service.js', 'duel/replay-catalog.js']:
        target = trial / 'dist' / name
        if target.exists():
            shutil.copy2(payload / 'api' / name, target)
    source_config = current / 'config.yaml' if service == 'ygocube' else root / 'shared/config.yaml'
    # Configuration remains private and is never included in logs or artifacts.
    raw = subprocess.check_output(['node', '-e',
        "process.stdout.write(JSON.stringify(require(process.argv[1]).parse(require('fs').readFileSync(process.argv[2],'utf8'))))",
        str(current / 'api/node_modules/yaml'), str(source_config)], text=True)
    config = json.loads(raw)
    config['server']['db_path'] = str(trial / 'probe.sqlite')
    config['server']['cards_cdb'] = str(host / 'cards.cdb')
    config['server']['strings_conf'] = str(host / 'strings.conf')
    config['server']['card_names_json'] = '/opt/ygocube/shared/assets/ygocdb_cards.json'
    config['web_duel'] = {'enabled': False}
    config_file = trial / 'config.json'
    config_file.write_text(json.dumps(config))
    config_file.chmod(0o600)
    probe = trial / 'probe.cjs'
    probe.write_text(r"""
process.env.CONFIG_FILE = process.argv[2];
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const Database = require('better-sqlite3');
const {CardsService,cardDatabasePaths} = require('./dist/cards/cards.service');
const {PoolsService} = require('./dist/pools/pools.service');
const {config} = require('./dist/config');
const cards = new CardsService(), expected = new Map(), expansion = new Set();
const sources = cardDatabasePaths(config.server.cardsCdb);
for (const file of sources) {
  const db = new Database(file,{readonly:true});
  for(const row of db.prepare('SELECT datas.*,texts.* FROM datas JOIN texts USING(id)').all()) {
    expected.set(row.id,row);
    if(file!==sources[0]) expansion.add(row.id);
  }
  db.close();
}
assert.equal(cards.allCodes().length,expected.size);
let searched=0, descriptions=0;
const eligible=[];
const duel=fs.existsSync('./dist/duel/duel.service.js') ? new (require('./dist/duel/duel.service').DuelService)(cards) : null;
for(const code of expansion) {
  const expectedCard=expected.get(code), actual=cards.get(code);
  assert.equal(actual.type,expectedCard.type);
  assert.equal(actual.desc,expectedCard.desc);
  if(!(actual.type&0x4000)) {
    assert(cards.search(String(code)).some(c=>c.code===code));
    assert(cards.search(actual.name).some(c=>c.code===code));
    eligible.push(code); searched++;
  }
  if(duel) for(let i=1;i<=16;i++) if(expectedCard['str'+i]) {
    const id=code*16+i-1;
    assert.equal(duel.descriptions([id])[id],expectedCard['str'+i]); descriptions++;
  }
}
const pool=new PoolsService(cards).create('expansion-verification',eligible).pool;
assert.equal(pool.codes.length,eligible.length);
process.stdout.write(JSON.stringify({catalogue:expected.size,expansion:expansion.size,searched,poolCards:pool.codes.length,descriptions}));
""")
    output = subprocess.check_output(['node', str(probe), str(config_file)], cwd=trial, text=True)
    results[service] = json.loads(output)
    results[service]['previousRelease'] = current.name

(stage / 'verification.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'staged': str(stage), 'liveServicesUnchanged': True, 'results': results}))
