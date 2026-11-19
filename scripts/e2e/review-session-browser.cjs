// Use a built local Web server. A loopback proxy supplies every API response,
// including real streaming responses, so no development or production DB is used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const webBase = process.argv[2] || 'http://127.0.0.1:3330';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > end) throw Error('Fixture condition timed out'); await delay(25); }
}

(async () => {
  const streams = new Set(), streamRequests = [], stateRequests = [], errors = [];
  let withPack = false, holdNext = false, releaseOld;
  const players = ['A', 'B', 'C'].map((playerId, seat) => ({ playerId, displayName: playerId, seat }));
  const state = pid => ({
    id: 1, name: 'Session regression', status: 'drafting', round: 0, frozen: false,
    config: { draftMode: 'passing', mainMin: 1, mainMax: 60, extraMax: 15, sideMax: 15, maxCopies: 1 },
    players, pickedCards: [], droppedCards: [], cardsRemainingToDraft: 1, cardsRemainingExact: true,
    deck: { main: [], extra: [], side: [], lockedAt: null }, pause: null, poolInfo: { name: 'fixture', count: 1 },
    queueLengths: players.map(p => ({ playerId: p.playerId, length: withPack && pid === 'A' ? 1 : 0 })),
    pack: withPack && pid === 'A' ? {
      index: 0, cardsLeft: 1, packsRemaining: 1, currentPicker: pid, isMyTurn: true,
      cards: [123], queueLength: 1, reserveMs: 400000, deadlineAt: new Date(Date.now() + 450000).toISOString(),
    } : null,
  });
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    if (!url.pathname.startsWith('/api/')) {
      const target = new URL(req.url, webBase);
      const forward = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
      });
      forward.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(forward); return;
    }
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const pid = decodeURIComponent(req.headers['x-player-id'] || '');
    if (url.pathname.endsWith('/stream')) {
      const record = { pid, token: req.headers['x-token'], url: req.url, res };
      streamRequests.push(record); streams.add(record);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders(); res.write(': connected\n\n');
      res.on('close', () => streams.delete(record)); return;
    }
    if (url.pathname.endsWith('/state')) {
      stateRequests.push(pid); const snapshot = state(pid);
      if (pid === 'A' && holdNext) { holdNext = false; releaseOld = () => json(snapshot); return; }
      return json(snapshot);
    }
    if (/\/api\/t\/\d+$/.test(url.pathname)) return json({ authRequired: !url.pathname.endsWith('/2'), players, status: 'drafting', config: { maxPlayers: 3 } });
    if (url.pathname.endsWith('/cards')) return json([{ code: 123, name: 'Fixture card', desc: 'Fixture only', type: 1, atk: 1000, def: 1000, level: 4, race: 1, attribute: 1, setCodes: [], setNames: [] }]);
    if (url.pathname.includes('/pics/')) { res.writeHead(404); res.end(); return; }
    json({});
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const context = await browser.newContext();
    const page = async () => { const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); return p; };
    const a = await page(); await a.goto(base);
    await a.evaluate(() => { localStorage.setItem('yc_token_1_A', 'fixture-a'); localStorage.setItem('yc_token_1_B', 'fixture-b'); });
    await a.goto(base + '/t/1/draft/A');
    await a.getByText('暂无可选择的牌堆（等待传堆）', { exact: true }).waitFor();
    await until(() => [...streams].some(s => s.pid === 'A'));
    assert((await context.cookies()).some(c => c.name === 'yc_pid_1' && c.value === 'A'));
    const b = await page(); await b.goto(base + '/t/1/draft/B');
    await until(() => [...streams].some(s => s.pid === 'B'));
    const originalA = [...streams].find(s => s.pid === 'A'); originalA.res.end();
    await until(() => streamRequests.filter(s => s.pid === 'A').length === 2);
    assert(streamRequests.filter(s => s.pid === 'A').every(s => s.token === 'fixture-a'));
    assert(streamRequests.filter(s => s.pid === 'B').every(s => s.token === 'fixture-b'));
    assert(streamRequests.every(s => !s.url.includes('?') && !s.url.includes('fixture-')));

    // Hold a previously captured no-pack snapshot, deliver a new pack event, then
    // release the old snapshot. A connected stream must not lose this invalidation.
    await delay(150); holdNext = true;
    const currentA = [...streams].find(s => s.pid === 'A');
    currentA.res.write('event: notice\ndata: {}\n\n'); await until(() => !!releaseOld);
    const before = stateRequests.filter(p => p === 'A').length;
    withPack = true; currentA.res.write('event: pick\ndata: {}\n\n'); await delay(100); releaseOld();
    await a.getByText('轮到你选牌', { exact: false }).waitFor();
    assert(stateRequests.filter(p => p === 'A').length > before);

    const c = await page(); await c.goto(base + '/t/2/draft/C');
    await until(() => [...streams].some(s => s.pid === 'C'));
    assert.equal(streamRequests.find(s => s.pid === 'C').token, '');
    const a2 = await page(); await a2.goto(base + '/t/1/draft/A');
    await until(() => [...streams].filter(s => s.pid === 'A').length === 2);
    await a.getByRole('button', { name: '退出登录', exact: true }).click();
    await a.waitForURL(base + '/t/1'); await a2.waitForURL(base + '/t/1');
    await until(() => ![...streams].some(s => s.pid === 'A'));
    assert([...streams].some(s => s.pid === 'B')); assert([...streams].some(s => s.pid === 'C'));
    assert.equal(await a.evaluate(() => localStorage.getItem('yc_token_1_A')), null);
    assert.equal(await a.getByRole('button', { name: '退出登录', exact: true }).count(), 0);
    const afterLogout = stateRequests.filter(p => p === 'A').length;
    await a.goto(base + '/t/1/draft/A'); await a.getByRole('heading', { name: '请输入令牌', exact: true }).waitFor();
    await a.reload(); await a.getByRole('heading', { name: '请输入令牌', exact: true }).waitFor();
    assert.equal(stateRequests.filter(p => p === 'A').length, afterLogout);
    // A browser can revoke storage access during an already authenticated page.
    // The no-token player must still leave and abort its stream without affecting B.
    await c.evaluate(() => { Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('Storage is blocked', 'SecurityError'); } }); });
    await c.getByRole('button', { name: '退出登录', exact: true }).click();
    await c.waitForURL(base + '/t/2');
    await until(() => ![...streams].some(s => s.pid === 'C'));
    assert([...streams].some(s => s.pid === 'B'));
    assert(!(await context.cookies()).some(cookie => cookie.name === 'yc_pid_2'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ perTabStreamIdentity: true, noTokenInUrl: true, cookieRenewal: true, noTokenStream: true, slowStateEventRecovered: true, logoutClosesMatchingTabsOnly: true, logoutSurvivesReload: true, blockedStorageLogout: true, pageErrors: errors }));
  } finally {
    await browser.close(); for (const stream of streams) stream.res.end();
    fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
