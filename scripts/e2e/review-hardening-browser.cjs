// Run against an isolated built Web server. All API calls use local fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const base = process.argv[2] || 'http://127.0.0.1:3330';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const context = await browser.newContext();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    let failInfo = true, failMeta = true;
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (pathname === '/api/t/1' && failInfo || pathname === '/api/meta' && failMeta)
        return route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } });
      let json = { authRequired: false };
      if (pathname.endsWith('/state')) json = { status: 'matches', round: 1, config: {}, players: [] };
      if (pathname.endsWith('/matches')) json = [{ id: 1, round: 1, tableNo: 1, playerA: 'P1', opponent: 'P2', roomName: 'test-room', resultA: null, resultB: null }];
      if (pathname === '/api/meta') json = { srvpro: { host: 'duel.example.test', gamePort: 7911 } };
      if (pathname.endsWith('/duel/options')) json = { lists: [] };
      if (pathname.endsWith('/duel/cards') || pathname.includes('/pics/') || pathname.endsWith('/duel/search')) json = [];
      return route.fulfill({ json });
    });
    await page.goto(base + '/t/1/matches/P1');
    await page.getByRole('button', { name: '重新加载 / Reload', exact: true }).waitFor();
    failInfo = false;
    await page.getByRole('button', { name: '重新加载 / Reload', exact: true }).click();
    await page.getByText('无法读取服务器地址 / Server address unavailable').waitFor();
    assert.equal((await page.locator('body').innerText()).includes('localhost:7911'), false);
    failMeta = false;
    await page.getByRole('button', { name: '重试 / Retry', exact: true }).click();
    await page.getByText('duel.example.test:7911', { exact: true }).waitFor();

    const legacyId = 'a'.repeat(32);
    await context.addCookies([{ name: 'yc_dueldeck_' + legacyId, value: encodeURIComponent(JSON.stringify(['Legacy deck', '1.2', '', ''])), domain: new URL(base).hostname, path: '/duel', sameSite: 'Strict' }]);
    await page.goto(base + '/duel/decks');
    const select = page.getByLabel('已保存卡组', { exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="已保存卡组"]').options.length === 2);
    await select.selectOption(legacyId);
    assert.equal(await page.getByLabel('卡组名称', { exact: true }).inputValue(), 'Legacy deck');
    assert(!(await context.cookies()).some(cookie => cookie.name.startsWith('yc_dueldeck_')));
    for (let n = 0; n < 10; n++) {
      await page.getByLabel('卡组名称', { exact: true }).fill('Stored deck ' + n);
      await page.getByRole('button', { name: '另存', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存 / Saved' }).waitFor();
    }
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[aria-label="已保存卡组"]').options.length === 12);
    assert(!(await context.cookies()).some(cookie => cookie.name.startsWith('yc_dueldeck_')));
    await select.selectOption(legacyId);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="已保存卡组"]').options.length === 11);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[aria-label="已保存卡组"]').options.length === 11);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ matchesInitialError: true, metaRetry: true, legacyMigration: true, elevenDecksPersisted: true, deletionPersisted: true, pageErrors: errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
