#!/usr/bin/env node
// Check published decimal limits against a real native host, in a private directory.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { parse, publicLists } = require('../../srvpro/cube-banlists');
const { Framer, packet, encodeDeck } = require('../../cube/packages/duel-protocol/dist');
const Database = require('../../cube/apps/api/node_modules/better-sqlite3');
const source = path.resolve(process.argv[2]);
const runtime = path.join(root, 'srvpro/ygopro');
const binary = process.env.YGOPRO_HOST || path.join(root, process.platform === 'win32' ? 'srvpro/ygopro/ygopro.exe' : 'ygopro/bin/release/ygopro');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ygocube-banlists-'));
const lists = publicLists([...parse(fs.readFileSync(source, 'utf8')), ...parse(fs.readFileSync(source, 'utf8'))]);
const sc = lists.find(list => list.format === 'SC');
const ocg = lists.find(list => list.format === 'OCG');
assert(sc && ocg);
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'config/banlists/2026.10.01-sc.json'), 'utf8'));
assert.deepEqual(sc.limits, Object.fromEntries(snapshot.entries.map(row => [row.code, row.limit])));
const db = new Database(path.join(runtime, 'cards.cdb'), { readonly: true });
const cards = new Map(db.prepare('SELECT id, type, alias FROM datas').all().map(card => [card.id, card]));
db.close();
for (const entry of snapshot.entries) assert(cards.has(entry.code), `Missing SC card ${entry.code}`);
fs.mkdirSync(path.join(tmp, 'expansions'));
fs.copyFileSync(source, path.join(tmp, 'lflist.conf'));
fs.copyFileSync(source, path.join(tmp, 'expansions/lflist.conf'));
fs.copyFileSync(path.join(runtime, 'cards.cdb'), path.join(tmp, 'cards.cdb'));
fs.copyFileSync(path.join(runtime, 'strings.conf'), path.join(tmp, 'strings.conf'));

async function check(list, codes, side = []) {
  const child = spawn(binary, ['0', String(list.id), '5', '0', '5', 'F', 'F', '8000', '5', '1', '0', '0', '--cube-deck-limits', '1', '60', '15', '15'], {
    cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let socket, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Host startup timeout: ' + stderr)), 10000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(Error(`Host exited ${code}: ${stderr}`)));
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/^(\d+)\r?\n/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native deck validation timeout: ' + stderr)), 10000);
      const done = (value, error) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      socket = net.connect(port, '127.0.0.1');
      const framer = new Framer();
      socket.on('error', error => done(null, error));
      socket.on('connect', () => {
        const name = Buffer.alloc(40), join = Buffer.alloc(48);
        name.write('BanlistProbe', 0, 38, 'utf16le');
        join.writeUInt16LE(4962);
        socket.write(packet(0x10, name));
        socket.write(packet(0x12, join));
      });
      socket.on('data', chunk => {
        try {
          for (const value of framer.feed(chunk)) {
            const frame = Buffer.from(value);
            if (frame[2] === 0x13) socket.write(packet(2, encodeDeck([89631139, ...codes], side)));
            if (frame[2] === 2) done({ error: frame.readUInt32LE(7), kind: frame[3] });
            if (frame[2] === 0x21 && (frame[3] & 15) === 9) done({ ready: true });
          }
        } catch (error) { done(null, error); }
      });
    });
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
}

(async () => {
  try {
    const semi = snapshot.entries.find(entry => entry.limit === 2 && !(cards.get(entry.code).type & 0x4802040)).code;
    const regional = snapshot.entries.find(entry => entry.limit === 1 && ocg.limits[entry.code] === 0).code;
    const cases = [
      ['SC forbids 03679218', sc, [3679218], [], false],
      ['OCG forbids 03679218', ocg, [3679218], [], false],
      ['SC accepts one limited card', sc, [83764718], [], true],
      ['SC counts main and side together', sc, [83764718], [83764718], false],
      ['SC combines artwork aliases', sc, [83764718, 83764722], [], false],
      ['SC accepts two semi-limited cards', sc, [semi, semi], [], true],
      ['SC rejects three semi-limited cards', sc, [semi, semi, semi], [], false],
      ['SC permits a regionally limited card', sc, [regional], [], true],
      ['OCG independently forbids the same card', ocg, [regional], [], false],
    ];
    for (const [label, list, codes, side, allowed] of cases) {
      const result = await check(list, codes, side);
      if (allowed) assert.equal(result.ready, true, label + ': ' + JSON.stringify(result));
      else { assert.equal(result.kind, 2, label); assert.equal(result.error >>> 28, 1, label); }
      console.log('PASS ' + label);
    }
    console.log(JSON.stringify({ platform: process.platform, officialEntries: snapshot.entries.length, nativeCases: cases.length }));
  } finally {
    // This directory is created above, never derived from user-controlled paths.
    const resolved = fs.realpathSync(tmp);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('ygocube-banlists-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
