import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

function harness() {
  const cookies = new Map();
  let blockDeletion = false;
  const document = {};
  Object.defineProperty(document, 'cookie', {
    get: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    set: raw => {
      const [key, value] = raw.split(';')[0].split('=');
      if (raw.includes('Max-Age=0')) { if (!blockDeletion) cookies.delete(key); }
      else cookies.set(key, value);
    },
  });
  const indexedDB = new IDBFactory();
  const cache = {};
  const load = name => {
    if (cache[name]) return cache[name];
    const code = ts.transpileModule(fs.readFileSync(new URL(`../components/duel/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, indexedDB, document, crypto, location: { protocol: 'https:' }, require: value => load(value.slice(2)) });
    return cache[name] = exports;
  };
  return { api: load('deck-storage'), legacy: load('deck-cookie'), cookies, blockDeletion: () => { blockDeletion = true; } };
}
test('migrates legacy decks before deleting cookies and retains all zones', async () => {
  const {api, legacy, cookies} = harness();
  const deck = legacy.parseYdk('#main\n89631139\n89631139\n#extra\n23995346\n!side\n32864', '青眼');
  const id = legacy.saveDeck(deck);
  const saved = await api.readDecks();
  assert.equal(saved[0].id, id); assert.equal(api.ydk(saved[0]), api.ydk(deck));
  assert.equal(cookies.size, 0);
  assert.equal((await api.readDecks()).length, 1);
});
test('stores more than eight decks without sending deck cookies', async () => {
  const {api, cookies} = harness();
  for (let i = 0; i < 20; i++) await api.saveDeck({name:`deck-${i}`,main:[123],extra:[],side:[]});
  assert.equal((await api.readDecks()).length, 20); assert.equal(cookies.size, 0);
});
test('blocked cookie deletion cannot resurrect deleted decks or replace edited decks', async () => {
  const {api, legacy, blockDeletion} = harness();
  const id = legacy.saveDeck({name:'old',main:[123],extra:[],side:[]}); blockDeletion();
  await api.readDecks();
  await api.saveDeck({name:'new',main:[456],extra:[],side:[]}, id);
  assert.equal((await api.readDecks())[0].name, 'new');
  await api.deleteDeck(id);
  assert.equal((await api.readDecks()).length, 0);
});
test('migration failure preserves original cookies for retry', async () => {
  const {api, legacy, cookies} = harness();
  legacy.saveDeck({name:'keep',main:[123],extra:[],side:[]});
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
  try { await assert.rejects(api.readDecks(), /存储|保存/); } finally { IDBObjectStore.prototype.put = put; }
  assert.equal(cookies.size, 1);
  assert.equal((await api.readDecks())[0].name, 'keep');
});
test('failed saves preserve the old deck and snapshot input before awaiting', async () => {
  const {api} = harness();
  const deck = {name:'original',main:[123],extra:[],side:[]};
  const pending = api.saveDeck(deck); deck.main.push(456);
  const id = await pending;
  assert.equal((await api.readDecks())[0].main.length, 1);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
  try { await assert.rejects(api.saveDeck({...deck,name:'replacement'},id)); } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await api.readDecks())[0].name, 'original');
});
