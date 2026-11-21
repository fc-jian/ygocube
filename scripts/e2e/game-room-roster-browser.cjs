// Pass the URL of an isolated Web/API instance. Each case creates and starts a room.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const button = (page, name) => page.getByRole('button', { name, exact: true });

async function join(page, playerId) {
  await page.getByLabel('玩家 ID', { exact: true }).fill(playerId);
  const response = page.waitForResponse(r => r.url().endsWith('/join') && r.request().method() === 'POST');
  await button(page, '加入游戏').click();
  const result = await response;
  assert.equal(result.status(), 201);
  await button(page, '退出房间').waitFor();
  return result.json();
}

async function verify(browser, origin, game, mode) {
  const contexts = await Promise.all([390, 1280, 390].map(width => browser.newContext({ viewport: { width, height: 844 } })));
  try {
    const [host, guest, visitor] = await Promise.all(contexts.map(context => context.newPage()));
    const errors = [];
    for (const page of [host, guest, visitor]) {
      page.setDefaultTimeout(12_000);
      page.on('pageerror', error => errors.push(error.message));
    }
    await host.goto(origin + '/games/' + game);
    await host.getByLabel('房间名称').fill('Roster ' + (mode || game));
    await host.getByLabel('玩家 ID').fill('Host');
    await host.getByLabel('发牌卡池').selectOption('0');
    if (mode) await host.getByLabel('玩法').selectOption(mode);
    await button(host, '创建房间').click();
    await button(host, '开始游戏').waitFor();
    await Promise.all([guest.goto(host.url()), visitor.goto(host.url())]);
    const former = await join(guest, 'Guest');
    await visitor.getByLabel('玩家 ID').waitFor();
    const remove = button(host, '移除 Guest');
    await remove.waitFor();
    assert.equal(await button(host, '移除 Host').count(), 0);
    for (const page of [guest, visitor]) assert.equal(await page.getByRole('button', { name: /^移除 / }).count(), 0);

    const dialog = host.getByRole('dialog', { name: '移除 Guest', exact: true });
    await remove.click();
    await button(dialog, '取消').click();
    await remove.click();
    await dialog.waitFor();
    await join(visitor, 'Other');
    await dialog.waitFor({ state: 'hidden' });
    await button(host, '移除 Other').waitFor();
    const stale = host.getByRole('status').filter({ hasText: '名单已更新，本次移除 Guest 的操作未执行。' });
    await stale.waitFor();
    assert.equal(await remove.evaluate(el => document.activeElement === el), true);
    const otherTransfer = button(host, '将房主移交给 Other');
    await otherTransfer.click();
    await stale.waitFor({ state: 'hidden' });
    await button(visitor, '退出房间').click();
    await host.getByRole('status').filter({ hasText: '名单已更新，本次向 Other 移交房主的操作未执行。' }).waitFor();
    assert.equal(await host.locator('ul.guess-roster').evaluate(el => document.activeElement === el), true);
    await visitor.goto(host.url());
    await join(visitor, 'Other');
    await otherTransfer.waitFor();

    await remove.click();
    await button(dialog, '移除').click();
    await remove.waitFor({ state: 'hidden' });
    const notice = guest.getByText('你的玩家席位已失效，现已切换为观战。', { exact: true });
    await notice.waitFor();
    const apiPath = origin + '/api/games/' + game + '/rooms/' + former.room.roomId;
    const expired = await guest.request.get(apiPath, { headers: { Authorization: 'Bearer ' + former.token } });
    assert.equal(expired.status(), 401);
    await button(host, '锁定入座').click();
    await button(host, '重新开放入座').waitFor();
    const locked = guest.getByText('房主已锁定入座，访客可以观战。', { exact: true });
    await locked.waitFor();
    assert.equal(await button(guest, '加入游戏').count(), 0);
    await guest.goto(origin + '/games/' + game);
    const watch = guest.getByRole('region', { name: '最近加入的房间' }).getByRole('link', { name: /观战/ });
    assert.equal(await watch.getAttribute('href'), '/games/' + game + '/' + former.room.roomId);
    await watch.click();
    await locked.waitFor();
    const closed = await guest.request.post(apiPath + '/join', { data: { playerId: 'Guest' } });
    assert.equal(closed.status(), 409);
    await button(host, '重新开放入座').click();
    const rejoined = await join(guest, 'Guest');
    assert.notEqual(rejoined.token, former.token);
    await notice.waitFor({ state: 'hidden' });
    await remove.waitFor();

    assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile roster fits viewport');
    const transfer = button(host, '将房主移交给 Guest');
    await transfer.click();
    await button(host.getByRole('dialog'), '移交房主').click();
    await button(guest, '将房主移交给 Host').click();
    await button(guest.getByRole('dialog'), '移交房主').click();
    await transfer.waitFor();
    await button(host, 'EN').click();
    await button(host, 'Remove Guest').click();
    await button(host.getByRole('dialog', { name: 'Remove Guest', exact: true }), 'Cancel').click();
    await button(host, 'Start game').click();
    await button(host, 'Start game').waitFor({ state: 'hidden' });
    assert.equal(await button(host, 'Remove Guest').count(), 0);
    const roomUrl = host.url();
    await host.goto(origin + '/games/' + game);
    const recent = host.getByRole('region', { name: 'Recently joined rooms' }).getByRole('link', { name: /Return to my room/ });
    assert.equal(await recent.getAttribute('href'), new URL(roomUrl).pathname);
    await recent.click();
    await host.getByRole('heading', { name: 'Roster ' + (mode || game), exact: true }).waitFor();
    assert.equal(host.url(), roomUrl);
    assert.deepEqual(errors, []);
    console.log('PASS host transfer, seating lock, removal and recent room return in ' + (mode || game));
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
}

async function main() {
  const origin = new URL(process.argv[2]).origin;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    await verify(browser, origin, 'guess');
    await verify(browser, origin, 'dg', 'classic');
    await verify(browser, origin, 'dg', 'relay');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
