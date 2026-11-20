import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../lib/gameStorage.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
function openTab(window) {
  const exports = {};
  vm.runInNewContext(outputText, { exports, window });
  return exports;
}
function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}
const blocked = () => { throw new Error('Storage is unavailable'); };

test('a quota fallback survives reload, supersedes a stale seat, and clears on exit', () => {
  const key = 'yc_guess_session_room';
  const localStorage = { ...storage(), getItem: () => 'expired', setItem: blocked, removeItem: blocked };
  const window = { localStorage, sessionStorage: storage() };
  let tab = openTab(window);
  assert.equal(tab.readGameValue(key), 'expired');
  tab.writeGameValue(key, 'replacement');
  tab = openTab(window);
  assert.equal(tab.readGameValue(key), 'replacement');
  tab.writeGameValue(key, null);
  assert.equal(openTab(window).readGameValue(key), null);
  window.localStorage = storage();
  tab.writeGameValue(key, 'next-seat');
  assert.equal(window.sessionStorage.getItem(key), null);
  assert.equal(openTab(window).readGameValue(key), 'next-seat');
});

test('blocked storage getters retain seats by game and room during client navigation', () => {
  const tab = openTab(Object.defineProperties({}, { localStorage: { get: blocked }, sessionStorage: { get: blocked } }));
  tab.writeGameValue('yc_guess_session_room', 'guess');
  tab.writeGameValue('yc_dg_session_room', 'dg');
  assert.equal(tab.readGameValue('yc_guess_session_room'), 'guess');
  tab.writeGameValue('yc_guess_session_room', null);
  assert.equal(tab.readGameValue('yc_guess_session_room'), null);
  assert.equal(tab.readGameValue('yc_dg_session_room'), 'dg');
  assert.equal(tab.readGameValue('yc_dg_session_other'), null);
});
