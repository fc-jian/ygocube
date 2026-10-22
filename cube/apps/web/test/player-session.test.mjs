import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  const storage = new Map(), cookies = new Map(), window = new EventTarget();
  window.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  const document = {};
  Object.defineProperty(document, 'cookie', {
    get: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    set: raw => { const pair = raw.split(';')[0], index = pair.indexOf('='), key = pair.slice(0, index), value = pair.slice(index + 1); if (raw.includes('max-age=0')) cookies.delete(key); else cookies.set(key, value); },
  });
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(code, { exports, window, document, process: { env: {} }, CustomEvent });
  return { api: exports, window, storage, cookies };
}

test('a saved player identity renews expired cookies without requiring another token entry', () => {
  const { api, cookies } = harness(); api.storeToken('1', 'A', 'secret'); cookies.clear();
  const resolved = api.resolvePlayerIdentity('1', 'A');
  assert.equal(resolved.identity.pid, 'A'); assert.equal(api.readIdentity('1').pid, 'A'); assert.equal(cookies.get('yc_token_1'), 'secret');
});

test('logout clears stored identity and local listeners, while preserving another player cookie', () => {
  const { api, cookies, window, storage } = harness(); api.storeToken('1', 'A', 'secret-a'); api.storeToken('1', 'B', 'secret-b');
  let a = 0, b = 0;
  const removeA = api.onPlayerLogout({ tid: '1', pid: 'A', token: 'secret-a' }, () => a++);
  api.onPlayerLogout({ tid: '1', pid: 'B', token: 'secret-b' }, () => b++);
  api.logoutPlayer('1', 'A');
  assert.equal(api.resolvePlayerIdentity('1', 'A').needToken, true); assert.equal(cookies.get('yc_pid_1'), 'B'); assert.equal(cookies.get('yc_token_1'), 'secret-b');
  assert.equal(a, 1); assert.equal(b, 0);
  const event = new Event('storage'); Object.assign(event, { key: api.PLAYER_LOGOUT_STORAGE_KEY, newValue: storage.get(api.PLAYER_LOGOUT_STORAGE_KEY) });
  window.dispatchEvent(event); assert.equal(a, 2); assert.equal(b, 0);
  removeA(); window.dispatchEvent(event); assert.equal(a, 2);
});

test('logout removes the current cookie and clears page memory before navigating', () => {
  const { api, window, cookies } = harness(); api.storeToken('1', 'A', 'secret');
  const cleanups = [], order = []; let pageIdentity = { tid: '1', pid: 'A', token: 'secret' };
  window.location = { replace: path => { assert.equal(pageIdentity, null); order.push(path); } };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../lib/usePlayerLogout.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const react = { useRef: current => ({ current }), useEffect: f => cleanups.push(f()) };
  vm.runInNewContext(code, { exports, window, require: name => name === 'react' ? react : api });
  exports.usePlayerLogout(pageIdentity, () => { pageIdentity = null; order.push('cleared'); }); api.logoutPlayer('1', 'A');
  assert.deepEqual(order, ['cleared', '/t/1']); assert.equal(cookies.size, 0);
  assert.equal(api.getStoredToken('1', 'A'), undefined); assert.equal(api.resolvePlayerIdentity('1', 'A').needToken, true);
  cleanups.forEach(f => f());
});

test('logout still clears cookies and the active page when browser storage is blocked', () => {
  const { api, window, cookies } = harness();
  api.setIdentityCookie('1', 'A', '');
  const calls = [];
  api.onPlayerLogout({ tid: '1', pid: 'A', token: '' }, () => calls.push('A'));
  api.onPlayerLogout({ tid: '1', pid: 'B', token: '' }, () => calls.push('B'));
  Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('SecurityError'); } });
  assert.doesNotThrow(() => api.logoutPlayer('1', 'A'));
  assert.equal(cookies.size, 0);
  assert.deepEqual(calls, ['A']);
});

test('blocked storage falls back to a scoped cookie for storing and restoring identity', () => {
  const { api, window, cookies } = harness();
  Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('SecurityError'); } });
  assert.doesNotThrow(() => api.storeToken('1', 'A', 'secret'));
  assert.equal(cookies.get('yc_token_1'), 'secret');
  assert.equal(api.resolvePlayerIdentity('1', 'A').identity.token, 'secret');
  assert.equal(api.resolvePlayerIdentity('1', 'B').needToken, true);
});

test('font controls render and still apply a size when storage is blocked', () => {
  const window = new EventTarget(), cleanups = [], document = { documentElement: { style: {} } };
  Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('SecurityError'); } });
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../components/FontSizeController.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(code, { exports, window, document, require: name => name === 'react' ? { useEffect: f => cleanups.push(f()) } : { jsx, jsxs: jsx } });
  exports.FontSizeController();
  assert.equal(document.documentElement.style.fontSize, '16px');
  const buttons = exports.FontSizeSetting().props.children[1];
  assert.equal(buttons.length, 3);
  buttons[2].props.onClick();
  assert.equal(document.documentElement.style.fontSize, '18px');
  cleanups.forEach(f => f());
});
