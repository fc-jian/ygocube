import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const load = (name, dependencies = {}) => {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(code, { exports, AbortController, require: name => dependencies[name] });
  return exports;
};
const refreshModule = load('coalescedRefresh');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a pack event during an old state request drains another refresh and never publishes the old pack', async () => {
  const first = deferred(), second = deferred(), rendered = [];
  let calls = 0;
  const refresh = refreshModule.createCoalescedRefresh(async ({ isCurrent }) => {
    const state = await (++calls === 1 ? first.promise : second.promise);
    if (isCurrent()) rendered.push(state);
  });
  const initial = refresh.request(); await tick();
  const pick = refresh.request(), phase = refresh.request();
  first.resolve({ status: 'drafting', pack: null }); await tick();
  assert.equal(calls, 2); assert.deepEqual(rendered, []);
  second.resolve({ status: 'deckbuilding', pack: null });
  await Promise.all([initial, pick, phase]);
  assert.deepEqual(rendered, [{ status: 'deckbuilding', pack: null }]);
});

test('invalidation during card metadata fetch is retained until the latest state is loaded', async () => {
  const metadata = deferred(), rendered = []; let calls = 0;
  const refresh = refreshModule.createCoalescedRefresh(async ({ isCurrent }) => {
    if (++calls === 1) await metadata.promise;
    if (isCurrent()) rendered.push(calls);
  });
  const initial = refresh.request(); await tick(); refresh.request(); metadata.resolve(); await initial;
  assert.equal(calls, 2); assert.deepEqual(rendered, [2]);
});

test('logout or identity replacement aborts in-flight work and prevents pending refresh or stale errors', async () => {
  const result = deferred(), rendered = []; let context, calls = 0;
  const refresh = refreshModule.createCoalescedRefresh(async current => {
    context = current; calls++; await result.promise;
    if (current.isCurrent()) rendered.push('old player');
  });
  const pending = refresh.request(); await tick(); refresh.request(); refresh.cancel(); result.resolve(); await pending;
  assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false);
  assert.deepEqual(rendered, []); assert.equal(calls, 1);
  await refresh.request(); assert.equal(calls, 1);
});

test('refresh hook restarts after Strict Mode cleanup and invalidates the old identity at commit', async () => {
  let ref, setup;
  const react = { useRef: value => ref ??= { current: value }, useEffect: f => { setup = f; }, useCallback: f => f };
  const { useCoalescedRefresh } = load('useCoalescedRefresh', { react, './coalescedRefresh': refreshModule });
  const old = deferred(), rendered = [];
  let firstContext;
  const taskA = async context => { firstContext = context; await old.promise; if (context.isCurrent()) rendered.push('A'); };
  const a = useCoalescedRefresh(taskA);
  let cleanup = setup(); cleanup(); cleanup = setup();
  const pending = a.request(); await tick();
  assert.equal(firstContext.signal.aborted, false);
  const b = useCoalescedRefresh(async context => { if (context.isCurrent()) rendered.push('B'); });
  cleanup(); cleanup = setup();
  assert.equal(firstContext.signal.aborted, true);
  old.resolve(); await pending; await b.request();
  assert.deepEqual(rendered, ['B']); cleanup();
});
