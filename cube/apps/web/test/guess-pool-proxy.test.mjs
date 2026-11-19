import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness(fetch) {
  const exports = {};
  const source = fs.readFileSync(new URL('../lib/server/guess-pool-proxy.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText,
    { exports, fetch, Buffer, AbortSignal, process: { env: { CUBE_API_URL: 'http://127.0.0.1:3201' } } });
  const response = { statusCode: 0, headers: {}, data: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; }, send(data) { this.data = data; }, end() {},
  };
  return { ...exports, response };
}

test('pool proxy derives the IP from the connection and ignores arbitrary client forwarded headers', () => {
  const { poolProxyIp } = harness();
  const request = { socket: { remoteAddress: '198.51.100.10' }, headers: { 'x-real-ip': 'fake', 'x-forwarded-for': 'fake' } };
  assert.equal(poolProxyIp(request), '198.51.100.10');
  request.socket.remoteAddress = '::ffff:127.0.0.1';
  request.headers['x-real-ip'] = '192.0.2.10';
  assert.equal(poolProxyIp(request), '192.0.2.10');
});

test('pool proxy forwards validated routes, a server IP and origin while preserving quota errors and private caching', async () => {
  const { proxyGuessPool, response } = harness(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3201/games/guess/pools/5/proposals');
    assert.equal(options.headers['X-Real-IP'], '198.51.100.10');
    assert.equal(options.headers.Origin, 'https://cube.example');
    assert.equal(options.headers['X-Forwarded-For'], undefined);
    assert.equal(options.body, '{"code":10000}');
    return new Response('{"code":"GUESS_PROPOSAL_DAILY_LIMIT"}', { status: 409, headers: { 'Content-Type': 'application/json' } });
  });
  await proxyGuessPool({ method: 'POST', url: '/api/games/guess/pools/5/proposals', query: { segments: ['5', 'proposals'] },
    socket: { remoteAddress: '198.51.100.10' }, headers: { origin: 'https://cube.example', 'x-real-ip': 'spoof' }, body: { code: 10000 } }, response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.data.toString(), /GUESS_PROPOSAL_DAILY_LIMIT/);
});

test('pool proxy preserves CSV bytes, attachment headers and search queries', async () => {
  const csv = '\uFEFF"卡片编号","效果文本"\r\n"00010000","描述"\r\n';
  const { proxyGuessPool, response } = harness(async (url) => {
    assert.equal(url, 'http://127.0.0.1:3201/games/guess/pools/5/export.csv?q=%E9%BE%99');
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="guess-pool-5.csv"' } });
  });
  await proxyGuessPool({ method: 'GET', url: '/api/games/guess/pools/5/export.csv?q=%E9%BE%99', query: { segments: ['5', 'export.csv'], q: '龙' },
    socket: { remoteAddress: '127.0.0.1' }, headers: {} }, response);
  assert.equal(response.data.toString('utf8'), csv);
  assert.equal(response.headers['Content-Disposition'], 'attachment; filename="guess-pool-5.csv"');
});

test('pool proxy forwards full proposal rankings with multilingual search and pagination', async () => {
  const { proxyGuessPool, response } = harness(async (url) => {
    assert.equal(url, 'http://127.0.0.1:3201/games/guess/pools/5/proposals/ranking?q=%E9%BE%99&page=1');
    return new Response('{"proposals":[],"totalCount":25,"totalPages":2}', { headers: { 'Content-Type': 'application/json' } });
  });
  await proxyGuessPool({ method: 'GET', url: '/api/games/guess/pools/5/proposals/ranking?q=%E9%BE%99&page=1',
    query: { segments: ['5','proposals','ranking'] }, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.data).totalCount, 25);
});

test('pool proxy rejects route traversal, unsupported methods and failed upstream connections', async () => {
  for (const segments of [['..', 'admin'], ['5', 'cards', '..', 'proposals'], ['http:', 'evil'], ['5', 'arbitrary']]) {
    const { proxyGuessPool, response } = harness(() => { throw new Error('must not fetch'); });
    await proxyGuessPool({ method: 'GET', query: { segments } }, response);
    assert.equal(response.statusCode, 404);
  }
  const badMethod = harness();
  await badMethod.proxyGuessPool({ method: 'DELETE', query: { segments: ['5', 'proposals'] } }, badMethod.response);
  assert.equal(badMethod.response.statusCode, 405);
  const offline = harness(async () => { throw new Error('offline'); });
  await offline.proxyGuessPool({ method: 'GET', query: { segments: ['5', 'proposals'] }, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, offline.response);
  assert.equal(offline.response.statusCode, 502);
});
