// Run against a local production Web build. API responses and seats are isolated per case.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const base = process.argv[2] || 'http://127.0.0.1:3330';
const player = playerId => ({ playerId, displayName: playerId, seat: 0 });
const card = code => ({ code, name: 'Card ' + code, desc: '', type: 1, level: 4, setCodes: [], setNames: [] });
const tournament = id => ({
  id, name: 'Tournament ' + id, status: 'registration', round: 0, config: { maxPlayers: 4 },
  players: [], packs: [], picks: [], decks: {}, matches: [], pickSummary: [], frozen: false, authRequired: true,
});
const state = pid => ({
  ...tournament(1), players: [player(pid)], pickedCards: [], droppedCards: [], pack: null,
  deck: { main: [], extra: [], side: [], lockedAt: null }, queueLengths: [], poolInfo: { name: 'pool', count: 0 },
});
const json = (route, data, status = 200) => route.fulfill({ status, json: data });
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  async function scenario(name, runCase) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(10000);
      // Register the fallback first so a case can override its own endpoints.
      await page.route('**/api/**', route => {
        const p = new URL(route.request().url()).pathname;
        if (p.endsWith('/stream') || p.includes('/pics/')) return route.fulfill({ status: 404, body: '' });
        if (p === '/api/meta') return json(route, { srvpro: { host: 'localhost', gamePort: 7911 } });
        return json(route, []);
      });
      await runCase(page);
      assert.deepEqual(errors, []);
      console.log('PASS ' + name);
    } catch (error) {
      throw new Error(name + ': ' + error.message, { cause: error });
    } finally { await context.close(); }
  }
  try {
    await scenario('player identity survives registration and navigation', async page => {
      const pid = 'A B%20+';
      const encoded = encodeURIComponent(pid);
      let joined = false;
      await page.route('**/api/t/1', route => json(route, {
        ...tournament(1), players: joined ? [player(pid)] : [], playerCount: Number(joined),
      }));
      await page.route('**/api/t/1/join', route => {
        assert.equal(route.request().postDataJSON().player_id, pid);
        joined = true;
        return json(route, { token: 'player-fixture' });
      });
      await page.route('**/api/t/1/state', route => {
        assert.equal(route.request().headers()['x-player-id'], encoded);
        assert.equal(route.request().headers()['x-token'], 'player-fixture');
        return json(route, state(pid));
      });
      await page.goto(base + '/t/1');
      await page.getByPlaceholder('玩家 ID', { exact: true }).fill(pid);
      await page.getByRole('button', { name: '报名参加' }).click();
      await page.getByRole('link', { name: '进入我的页面' }).click();
      await page.getByText('Tournament 1', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/t/1/draft/' + encoded);
      await page.goto(base + '/t/1/matches/' + encoded);
      const ranking = page.getByRole('link', { name: '查看积分榜单' });
      assert.equal(await ranking.getAttribute('href'), '/t/1/ranking/' + encoded);
      await ranking.click();
      await page.getByRole('heading', { name: new RegExp('积分榜单') }).waitFor();
      assert.equal(await page.getByRole('link', { name: '返回对战页' }).getAttribute('href'), '/t/1/matches/' + encoded);
    });

    await scenario('late admin response cannot act on previous tournament', async page => {
      const old = gate(), next = gate();
      let hold = false;
      const actions = [];
      await page.route('**/api/admin/t/11/state', async route => {
        if (hold) await old.promise;
        await json(route, tournament(11));
      });
      await page.route('**/api/admin/t/12/state', async route => { await next.promise; await json(route, tournament(12)); });
      await page.route('**/api/admin/t/*/start_draft', route => { actions.push(new URL(route.request().url()).pathname); return json(route, {}); });
      await page.goto(base + '/admin');
      const tid = page.getByPlaceholder('比赛 ID');
      await tid.fill('11');
      await page.getByText('Tournament 11', { exact: true }).waitFor();
      const poolName = page.getByPlaceholder('卡池名称', { exact: true });
      await poolName.fill('Unsubmitted pool');
      hold = true;
      const requested = page.waitForRequest(request => request.url().endsWith('/api/admin/t/11/state'));
      await page.getByRole('button', { name: '加载', exact: true }).click();
      await requested;
      await tid.fill('12');
      old.release();
      const start = page.getByRole('button', { name: '开始选牌', exact: true });
      assert.equal(await start.count(), 0);
      next.release();
      await page.getByText('Tournament 12', { exact: true }).waitFor();
      assert.equal(await poolName.inputValue(), 'Unsubmitted pool');
      await start.click();
      await page.getByText('已发起开始选牌确认，等待所有玩家确认').waitFor();
      assert.deepEqual(actions, ['/api/admin/t/12/start_draft']);
    });

    await scenario('pool read and metadata failures preserve editable membership', async page => {
      let poolReads = 0, metaReads = 0, saved;
      await page.addInitScript(() => sessionStorage.setItem('yc_super_token', 'fixture'));
      await page.route('**/api/admin/pools/71', route => {
        if (route.request().method() === 'PUT') {
          saved = route.request().postDataJSON().codes;
          return json(route, {});
        }
        if (++poolReads === 1) return json(route, { code: 'INTERNAL_ERROR' }, 503);
        return json(route, { id: 71, name: 'Original pool', codes: [101, 102], candidateCount: 0 });
      });
      await page.route('**/api/admin/cards?**', route => {
        const q = new URL(route.request().url()).searchParams;
        if (q.has('q')) return json(route, [card(777)]);
        if (++metaReads === 1) return json(route, { code: 'INTERNAL_ERROR' }, 503);
        return json(route, q.get('codes').split(',').map(Number).map(card));
      });
      await page.goto(base + '/admin/pool/71');
      await page.getByRole('main').getByRole('alert').waitFor();
      assert.equal(await page.getByRole('button', { name: '保存' }).count(), 0);
      await page.getByRole('button', { name: '重试' }).click();
      await page.getByText('2 张待解析', { exact: false }).waitFor();
      await page.getByRole('button', { name: '重试' }).click();
      await page.getByText('2 张待解析', { exact: false }).waitFor({ state: 'hidden' });
      const search = page.getByPlaceholder('按名称、编号、效果或字段搜索', { exact: false });
      await search.fill('777');
      await search.press('Enter');
      await page.getByRole('button', { name: '加入', exact: true }).click();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(saved, [101, 102, 777]);
    });

    await scenario('start confirmation follows server time with a fast client clock', async page => {
      let confirmed = false;
      await page.addInitScript(() => { const now = Date.now; Date.now = () => now() + 120000; });
      await page.route('**/api/t/1', route => json(route, { authRequired: false, players: [player('P')] }));
      await page.route('**/api/t/1/state', route => {
        const serverNow = Date.now();
        return json(route, { ...state('P'), draftStartConfirmation: {
          pending: true, confirmed, total: 2, confirmedCount: Number(confirmed), serverNow,
          deadlineAt: new Date(serverNow + 59000).toISOString(),
        } });
      });
      await page.route('**/api/t/1/player/draft-confirm', route => { confirmed = true; return json(route, {}); });
      await page.goto(base + '/t/1/draft/P');
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /截止 5[0-9] 秒/);
      const buttons = page.getByRole('button', { name: '确认开始选牌', exact: true });
      assert.deepEqual(await buttons.evaluateAll(list => list.map(button => button.disabled)), [false, false]);
      await dialog.getByRole('button').click();
      await page.getByText('已确认开始选牌，等待其他玩家确认', { exact: false }).waitFor();
    });

    await scenario('pick dialog traps focus and restores the invoking card', async page => {
      await page.route('**/api/t/1', route => json(route, { authRequired: false, players: [player('P')] }));
      await page.route('**/api/t/1/state', route => json(route, {
        ...state('P'), status: 'drafting', pack: { isMyTurn: true, index: 0, cardsLeft: 2, cards: [201, 202], queueLength: 1 },
      }));
      await page.route('**/api/t/1/cards?**', route => json(route, [card(201), card(202)]));
      await page.goto(base + '/t/1/draft/P');
      const opener = page.getByRole('button', { name: 'Card 201', exact: true });
      await opener.focus();
      await opener.press('Enter');
      const dialog = page.getByRole('dialog', { name: '选择这张卡？' });
      await dialog.waitFor();
      for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)));
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.ok(await opener.evaluate(el => el === document.activeElement));
    });

    await scenario('public pool loads only changed data while visible', async page => {
      let codes = Array.from({ length: 801 }, (_, i) => i + 10000), revision = 'one', summaries = 0;
      const batches = [];
      await page.clock.install();
      await page.route('**/api/pools/demo', route => {
        summaries++;
        return json(route, { id: 1, name: 'demo', codes, count: codes.length, cardRevision: revision });
      });
      await page.route('**/api/pools/demo/cards?**', route => {
        const batch = new URL(route.request().url()).searchParams.get('codes').split(',').map(Number);
        batches.push(batch);
        return json(route, batch.map(code => ({ ...card(code), name: revision + ' ' + code })));
      });
      await page.goto(base + '/pool/demo');
      const csv = page.getByRole('button', { name: '下载卡池 CSV' });
      await csv.waitFor();
      assert.deepEqual(batches.map(list => list.length), [400, 400, 1]);
      async function nextPoll() {
        const summary = page.waitForResponse(response => response.url().endsWith('/api/pools/demo'));
        await page.clock.fastForward(30010);
        await summary;
      }
      await nextPoll();
      assert.equal(batches.length, 3);
      const before = summaries;
      await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }));
      await page.clock.fastForward(61000);
      assert.equal(summaries, before);
      codes = [10000, 10000, 20000];
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await page.getByText('主卡与额外卡预览（共 3 张）').waitFor();
      assert.deepEqual(batches.slice(3), [[20000]]);
      revision = 'two';
      await nextPoll();
      await page.locator('[data-card-search]').filter({ hasText: 'two 20000' }).first().waitFor({ state: 'attached' });
      assert.deepEqual(batches.slice(4), [[10000, 20000]]);
    });

    for (const failure of ['matches', 'duel-session']) {
      await scenario('expired duel identity at ' + failure, async page => {
        await page.addInitScript(() => {
          localStorage.setItem('yc_token_1_A B', 'expired');
          localStorage.setItem('yc_token_1_other', 'other-token');
          window.WebSocket = class {
            static OPEN = 1;
            readyState = 1;
            constructor() { setTimeout(() => this.onopen?.(), 0); }
            send(raw) { window.lastDuelAuth = JSON.parse(raw); }
            close() { this.readyState = 3; }
          };
        });
        await page.route('**/api/t/1', route => json(route, { authRequired: true }));
        await page.route('**/api/t/1/matches**', route => {
          const endpoint = new URL(route.request().url()).pathname.split('/').pop();
          if (endpoint === failure && route.request().headers()['x-token'] !== 'correct')
            return json(route, { code: 'AUTH_REQUIRED' }, 401);
          return json(route, endpoint === 'matches' ? [{ id: 2, resultA: null, resultB: null }]
            : { ticket: 'accepted', wsPath: '/api/duel/ws' });
        });
        await page.goto(base + '/t/1/duel/A%20B');
        await page.getByRole('heading', { name: '请输入令牌' }).waitFor();
        assert.deepEqual(await page.evaluate(() => [localStorage.getItem('yc_token_1_A B'), localStorage.getItem('yc_token_1_other')]), [null, 'other-token']);
        await page.getByPlaceholder('令牌', { exact: true }).fill('correct');
        await page.getByRole('button', { name: '进入', exact: true }).click();
        await page.waitForFunction(() => window.lastDuelAuth?.ticket === 'accepted');
      });
    }

    await scenario('replay decodes no frames between cursor changes', async page => {
      await page.clock.install();
      await page.addInitScript(() => {
        const decode = window.atob.bind(window);
        window.decodeCalls = 0;
        window.atob = value => { window.decodeCalls++; return decode(value); };
      });
      const frame = Buffer.from([2, 0, 1, 4]).toString('base64');
      await page.route('**/api/public/t/1/matches/1/replay', route => json(route, {
        frames: Array.from({ length: 1000 }, (_, i) => ({ t: 60000 + i, frame: i ? 'AgAAAA==' : frame })),
        snapshots: [], cards: [], descriptions: {}, complete: true,
      }));
      await page.goto(base + '/t/1/replay/1');
      await page.getByRole('button', { name: 'Game 1', exact: true }).waitFor();
      const before = await page.evaluate(() => window.decodeCalls);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await page.clock.runFor(1000);
      assert.equal(await page.evaluate(() => window.decodeCalls), before);
      assert.equal(await page.locator('input[type=range]').inputValue(), '0');
    });

    for (const game of ['guess', 'dg']) {
      for (const action of ['create', 'join']) {
        await scenario(game + ' ' + action + ' with storage full', async page => {
          const roomId = 'ABCDEF12', path = '/games/' + game;
          const host = action === 'create' ? 'P' : 'Host';
          const room = viewerId => ({
            roomId, name: 'Fixture room', phase: 'lobby', viewerId, hostId: host, poolId: 1, poolName: 'Fixture pool', poolCount: 4,
            playerCount: 1, maxPlayers: 4, settings: { roundSeconds: 90 }, version: 1, serverNow: Date.now(), deadlineAt: null,
            standings: [player(host), player('Guest')], players: [player(host), player('Guest')],
          });
          const privateReads = [];
          await page.addInitScript(() => {
            const set = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
              if (key.includes('_session_')) throw new DOMException('Full', 'QuotaExceededError');
              return set.call(this, key, value);
            };
          });
          await page.route('**/api/games/guess/pools', route => json(route, [{ poolId: 1, isDefault: true, name: 'Fixture pool' }]));
          await page.route('**/api' + path + '/rooms', route => json(route, route.request().method() === 'POST'
            ? { room: room(host), token: 'created' } : []));
          await page.route('**/api' + path + '/rooms/' + roomId + '**', route => {
            const p = new URL(route.request().url()).pathname;
            if (p.endsWith('/join')) return json(route, { token: 'joined', room: room('Guest') });
            const auth = route.request().headers().authorization;
            if (auth) privateReads.push(auth);
            return json(route, room(auth ? (action === 'create' ? host : 'Guest') : null));
          });
          await page.goto(base + path + (action === 'join' ? '/' + roomId : ''));
          const form = page.locator('form').first();
          const inputs = form.locator('input:not([type=checkbox])');
          if (action === 'create') {
            await inputs.nth(0).fill('Fixture room');
            await inputs.nth(1).fill(host);
          } else {
            await inputs.nth(0).fill('Guest');
          }
          await form.locator('button[type=submit]').click();
          await page.getByRole('button', { name: '退出房间', exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, path + '/' + roomId);
          assert.ok(privateReads.includes('Bearer ' + (action === 'create' ? 'created' : 'joined')));
        });
      }
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
