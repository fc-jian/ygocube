#!/usr/bin/env node
// Real browser -> Next WebSocket proxy -> API -> srvpro -> native host.
const fs = require("fs"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const base = process.argv[2] || "http://127.0.0.1:3000",
  fixture = process.argv[3];
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  try {
    const errors = [],
      pages = [],
      contexts = [];
    for (const [i, width] of [390, 1440].entries()) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: i === 0,
      });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (e) => {errors.push(e.message);console.error("PAGE_ERROR",e.message);});
      page.on("websocket", ws => ws.on("socketerror", e => console.error("WS_ERROR", String(e))));
      await page.goto(base + "/duel");
      await page
        .getByLabel("昵称", { exact: true })
        .fill(i ? "BrowserBob" : "BrowserAlice");
      await page
        .getByLabel("房间密码", { exact: true })
        .fill("browser-" + process.pid);
      await page.locator("input[type=file]").setInputFiles(fixture);
      await page.waitForFunction(
        () => document.querySelector("select[required]")?.value,
      );
      await page.getByLabel(/对局模式/).selectOption("0");
      if(process.env.EFFECT_TEST) await page.getByLabel("不洗牌",{exact:true}).check();
      await page
        .getByRole("button", { name: "创建 / 加入房间", exact: true })
        .click();
      await page.waitForURL(/\/duel\/room\/W[a-f0-9]{18}$/);
      await page.getByText("已连接", { exact: true }).waitFor();
      await page.locator('summary').filter({hasText:'房间信息与链接'}).click();
      await page.locator('.native-connection code').waitFor();
      assert.equal(await page.locator('.native-connection code').textContent(),new URL(page.url()).pathname.split('/').pop());
      await page.getByRole('button',{name:'复制密码',exact:true}).waitFor();
      await page.locator('summary').filter({hasText:'房间信息与链接'}).click();
      await page
        .getByRole("button", { name: /^(准备|取消准备)$/ })
        .waitFor()
        .catch(async (e) => {
          console.error(await page.locator("body").innerText());
          await page.screenshot({
            path: require('node:path').join(require('node:os').tmpdir(), "standalone-failed.png"),
            fullPage: true,
          });
          throw e;
        });
    }
    const [a, b] = pages;
    for (const p of pages) {
      await p.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => /^(准备|取消准备)$/.test(b.textContent) && !b.disabled));
      if(await p.getByRole('button',{name:'准备',exact:true}).isVisible()) {
        await p.getByRole('button',{name:'准备',exact:true}).click();
        await p.getByRole('button',{name:'取消准备',exact:true}).waitFor();
      }
    }
    await a.getByRole("button", { name: "开始对战", exact: true }).click();
    await a.screenshot({path:require('node:path').join(require('node:os').tmpdir(), "duel-rps-390.png"),fullPage:true});
    await a.getByRole("button", { name: "石头", exact: true }).click();
    await b.getByRole("button", { name: "剪刀", exact: true }).click();
    // RPS result chooses one of the two clients.
    await Promise.race(
      pages.map((p) =>
        p.getByRole("button", { name: "先攻", exact: true }).waitFor(),
      ),
    );
    for (const p of pages)
      if (
        await p.getByRole("button", { name: "先攻", exact: true }).isVisible()
      )
        await p.getByRole("button", { name: "先攻", exact: true }).click();
    await a.locator(".duel-hand button").first().waitFor();
    const active = a;
    if (process.env.EFFECT_TEST) {
      await active.locator('.duel-hand:not(.opponent-hand)').getByRole('button',{name:'增援',exact:true}).first().click();
      assert.equal(await active.locator('.duel-dialog').getByRole('button',{name:'发动效果',exact:true}).count(),1);
      await active.locator('.duel-dialog').getByRole('button',{name:'发动效果',exact:true}).click();
      await active.locator('.duel-zone-target').first().click();
      await active.locator('.effect-activate').waitFor();
      await active.locator('.duel-prompt h2').filter({hasText:'卡片'}).waitFor();
      await active.locator('.duel-choice-main').first().click();
      await active.getByRole('button',{name:'确认 (1)',exact:true}).click();
      await active.locator('.effect-resolve').waitFor();
      await active.screenshot({path:require('node:path').join(require('node:os').tmpdir(), 'duel-live-chain.png'),fullPage:true});
      await active.locator('.effect-end').waitFor();
      await active.getByRole('button',{name:'墓地 1',exact:true}).waitFor();
      console.log('PASS real host effect activation, search response during animation, chain resolution');
    } else {
      await active.locator('.duel-hand:not(.opponent-hand) .card-selectable').first().click();
      await active.locator('.duel-dialog').getByRole('button',{name:'通常召唤',exact:true}).click();
      await active.locator(".duel-zone-target").first().click();
      await active.locator(".duel-half:not(.opponent) .duel-zone-row").first().locator(".duel-card").waitFor();
      assert.equal(await active.locator(".duel-zone-target").count(),0);
      console.log("PASS real host normal summon by clicking field zone");
    }
    for (const [i, p] of pages.entries()) {
      assert(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "horizontal overflow",
      );
      await p.screenshot({
        path: require('node:path').join(require('node:os').tmpdir(), `standalone-duel-${i}.png`),
        fullPage: true,
      });
    }
    const builder = await contexts[0].newPage();
    builder.on("pageerror", (e) => errors.push(e.message));
    await builder.goto(base + "/duel/decks");
    await builder
      .getByLabel("已保存卡组", { exact: true })
      .selectOption({ index: 1 });
    assert.equal(
      await builder.locator(".builder-zone").nth(0).locator("article").count(),
      40,
    );
    await builder.locator(".builder-zone").first().locator(".card-preview").first().click();
    await builder
      .getByRole("button", { name: "移到 备选卡组 1", exact: true })
      .click();
    assert.equal(
      await builder.locator(".builder-zone").nth(2).locator("article").count(),
      2,
    );
    await builder.getByRole("button", { name: /保存/ }).click();
    await builder.reload();
    await builder
      .getByLabel("已保存卡组", { exact: true })
      .selectOption({ index: 1 });
    assert.equal(
      await builder.locator(".builder-zone").nth(0).locator("article").count(),
      39,
    );
    assert.equal(
      await builder.locator(".builder-zone").nth(2).locator("article").count(),
      2,
    );
    await builder
      .getByRole("textbox", { name: "搜索卡片", exact: true })
      .fill("青眼");
    await builder.locator(".builder-results article").first().waitFor();
    await builder.locator(".builder-results .card-preview").first().click();
    await builder.locator(".deck-inspector h2").filter({hasText:"青眼"}).waitFor();
    await builder.screenshot({
      path: require('node:path').join(require('node:os').tmpdir(), "standalone-builder-390.png"),
      fullPage: true,
    });
    assert(
      await builder.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "builder overflow",
    );
    assert(
      (await contexts[0].cookies()).some(
        (c) =>
          c.name.startsWith("yc_dueldeck_") &&
          c.path === "/duel" &&
          c.expires === -1,
      ),
    );
    await builder.getByText('卡图设置',{exact:true}).click();
    await builder.getByRole('button',{name:'绑定本地图像目录',exact:true}).waitFor();
    const roomUrl=a.url(),watchContext=await browser.newContext({viewport:{width:390,height:900}}),watch=await watchContext.newPage();
    await watch.goto(roomUrl);await watch.getByRole('button',{name:'观战',exact:true}).click();
    await watch.getByText('已连接',{exact:true}).waitFor();
    await watch.locator('.duel-hand button').first().waitFor();
    assert.equal(await watch.getByRole('button',{name:'投降',exact:true}).count(),0);
    await contexts[0].close();
    if (process.env.RECONNECT_DELAY_MS) { console.log("Waiting beyond the former reconnect window"); await new Promise(resolve=>setTimeout(resolve,Number(process.env.RECONNECT_DELAY_MS))); }
    const reconnectContext=await browser.newContext({viewport:{width:390,height:900}}),resumed=await reconnectContext.newPage();
    await resumed.goto(roomUrl);await resumed.getByLabel('玩家 ID',{exact:true}).fill('BrowserAlice');
    await resumed.getByRole('button',{name:'使用 ID 重连',exact:true}).click();
    await resumed.getByText('已连接',{exact:true}).waitFor();await resumed.locator('.duel-hand:not(.opponent-hand) button').first().waitFor();
    await b.getByRole('button',{name:'投降',exact:true}).click();await b.getByRole('button',{name:'确认',exact:true}).click();
    await resumed.locator('.duel-outcome').filter({hasText:'投降'}).waitFor();
    console.log('PASS authoritative surrender reason shown');
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ok: true,
        realWebSocket: true,
        widths: [390, 1440],
        cookieImport: true,
        mainSideMove: true,
        cookieReload: true,
        searchAndDetails: true,
        roomUrl: true, lateWatch: true, idReconnect: true, localPicsSetting: true,
      }),
    );
  } catch(e) {
    for(const [i,context] of browser.contexts().entries())for(const page of context.pages()){
      console.error('Browser failure',i,await page.locator('body').innerText());
      await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(), `duel-browser-failure-${i}.png`),fullPage:true});
    }
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
