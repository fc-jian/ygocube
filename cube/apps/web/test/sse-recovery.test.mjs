import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(name, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name], TextDecoder, ...globals });
  return exports;
}
const eventStream = load('eventStream');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('SSE framing survives every chunk boundary, UTF-8, CRLF/CR/LF and multiline data', async () => {
  const text = '\uFEFF: heartbeat\r\nevent: pick\r\ndata: {"卡":\r\ndata: 7}\r\n\r\nevent: pause\rdata: null\r\revent: notice\ndata:\n\nevent: ignored\ndata: incomplete';
  const bytes = new TextEncoder().encode(text);
  for (let split = 0; split <= bytes.length; split++) {
    const events = [];
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();
    } });
    await eventStream.readEventStream(new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }), e => events.push(JSON.parse(JSON.stringify(e))));
    assert.deepEqual(events, [{ event: 'pick', data: '{"卡":\n7}' }, { event: 'pause', data: 'null' }, { event: 'notice', data: '' }]);
  }
});

function harness({ identity = { tid: '1', pid: 'A', token: 'a-token' }, status = 200 } = {}) {
  const cleanups = [], requests = [], events = [], timers = [], connected = [], cookies = [];
  let logout;
  const react = {
    useState: () => [false, value => connected.push(value)], useRef: value => ({ current: value }),
    useCallback: f => f, useEffect: f => { const cleanup = f(); if (cleanup) cleanups.push(cleanup); },
  };
  const api = {
    API_BASE: '/custom-api', encodePathSegment: encodeURIComponent,
    identityHeaders: id => ({ 'X-Tournament-Id': id.tid, 'X-Player-Id': encodeURIComponent(id.pid), 'X-Token': id.token }),
    setIdentityCookie: (...args) => cookies.push(args),
    onPlayerLogout: (id, callback) => { logout = callback; return () => { logout = null; }; },
  };
  const fetch = async (url, options) => {
    const request = { url, options }; requests.push(request);
    const body = new ReadableStream({ start(controller) {
      request.controller = controller;
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } });
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  };
  const hooks = load('sse', { react, './api': api, './eventStream': eventStream }, {
    fetch, AbortController, console,
    setTimeout: (f, delay) => { const timer = { f, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cancelled = true; },
  });
  hooks.useTournamentStream('1', identity, (event, data) => events.push([event, data]));
  return { requests, events, timers, connected, cookies, logout: () => logout(), cleanup: () => cleanups.forEach(f => f()) };
}

test('a dropped stream reconnects with current-page headers and immediately recovers state', async () => {
  const h = harness(); await turn();
  assert.equal(h.requests[0].url, '/custom-api/t/1/stream');
  assert.equal(h.requests[0].options.headers['X-Player-Id'], 'A');
  assert.equal(h.requests[0].options.headers['X-Token'], 'a-token');
  assert.deepEqual(h.events, [['reconnect', null]]);
  h.requests[0].controller.enqueue(new TextEncoder().encode('event: phase\ndata: {"status":"deckbuilding"}\n\nevent: ignored\ndata: {}\n\n'));
  await turn();
  assert.equal(h.events[1][0], 'phase'); assert.equal(h.events[1][1].status, 'deckbuilding'); assert.equal(h.events.length, 2);
  h.requests[0].controller.close(); await turn();
  assert.equal(h.timers[0].delay, 1000);
  h.timers[0].f(); await turn();
  assert.deepEqual(h.events.map(e => e[0]), ['reconnect', 'phase', 'reconnect']);
  h.cleanup(); await turn();
  assert.equal(h.requests[1].options.signal.aborted, true); assert.equal(h.timers.length, 1);
});

test('HTTP 401 triggers identity recovery and bounded backoff; cleanup stops future attempts', async () => {
  const h = harness({ status: 401 }); await turn();
  assert.deepEqual(h.events, [['auth-required', null]]); assert.equal(h.connected.includes(true), false);
  for (let i = 0; i < 4; i++) { h.timers[i].f(); await turn(); }
  assert.deepEqual(h.timers.map(t => t.delay), [1000, 2000, 4000, 5000, 5000]);
  h.cleanup(); assert.equal(h.timers.at(-1).cancelled, true);
});

test('no-token sessions and different players use their own headers, and logout aborts the stream', async () => {
  const a = harness({ identity: { tid: '1', pid: 'A', token: '' } });
  const b = harness({ identity: { tid: '1', pid: 'B B', token: 'b-token' } }); await turn();
  assert.equal(a.requests[0].options.headers['X-Player-Id'], 'A'); assert.equal(a.requests[0].options.headers['X-Token'], '');
  assert.equal(b.requests[0].options.headers['X-Player-Id'], 'B%20B'); assert.equal(b.requests[0].options.headers['X-Token'], 'b-token');
  assert.deepEqual(a.cookies[0], ['1', 'A', '']);
  a.logout(); await turn();
  assert.equal(a.requests[0].options.signal.aborted, true); assert.equal(b.requests[0].options.signal.aborted, false); assert.equal(a.timers.length, 0);
  a.cleanup(); b.cleanup();
});
