const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const assert = require("node:assert/strict"),
  fs = require("fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const base = process.argv[2] || "http://127.0.0.1:3100",
      fixture = process.argv[3],
      bot = process.argv[4] || "Blue-Eyes";
    const catalogResponse = page.waitForResponse((r) =>
      r.url().endsWith("/public/duel/bots"),
    );
    await page.goto(base + "/duel/bot/");
    const catalog = await (await catalogResponse).json();
    await page
      .getByLabel("昵称", { exact: true })
      .fill("BotTest" + Date.now().toString().slice(-5));
    const selectedBot = catalog.bots.find((b) => b.id === bot);
    assert(selectedBot);
    await page
      .getByLabel("机器人", { exact: true })
      .selectOption(selectedBot.robot);
    await page.getByLabel("机器人卡组", { exact: true }).selectOption(bot);
    await page
      .getByRole("button", { name: "建立房间并进入", exact: true })
      .click();
    await page.waitForURL(/\/duel\/room\/W[a-f0-9]{18}$/);
    console.log("ROOM", page.url());
    await page.getByText("已连接", { exact: true }).waitFor();
    await page
      .locator(".duel-room-deck input[type=file]")
      .setInputFiles(fixture);
    await page.getByRole("button", { name: "准备", exact: true }).click();
    await page
      .getByRole("button", { name: "开始对战", exact: true })
      .click({ timeout: 30000 });
    const end = Date.now() + 60000;
    let began = false,
      opponentCards = false;
    while (Date.now() < end) {
      for (const name of ["石头", "后攻", "不响应"]) {
        const b = page.getByRole("button", { name: new RegExp("^" + name) });
        if ((await b.isVisible().catch(() => false)) && (await b.isEnabled()))
          await b.click();
      }
      if (await page.locator(".duel-hand:not(.opponent-hand) button").count())
        began = true;
      const opponent = await page
        .locator(".opponent-hand")
        .getAttribute("data-hand-player")
        .catch(() => null);
      if (
        opponent !== null &&
        (await page
          .locator(
            '[data-duel-ref^="' +
              opponent +
              ':4:"], [data-duel-ref^="' +
              opponent +
              ':8:"]',
          )
          .count())
      ) {
        opponentCards = true;
        break;
      }
      const endTurn = page
        .locator(".duel-phase-track")
        .getByRole("button", { name: "结束阶段", exact: true });
      if (
        (await endTurn.count()) &&
        (await endTurn.isEnabled().catch(() => false))
      )
        await endTurn.click();
      await page.waitForTimeout(400);
    }
    fs.mkdirSync("data/bot-verification", { recursive: true });
    await page.screenshot({
      path: `data/bot-verification/${bot}.png`,
      fullPage: true,
    });
    console.log((await page.locator("body").innerText()).slice(-2800));
    assert(began, "duel began");
    assert(opponentCards, "bot played a card");
    if (!(await page.locator(".duel-outcome").count())) {
      await page.getByRole("button", { name: "投降", exact: true }).click();
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await page.locator(".duel-outcome").filter({ hasText: "投降" }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ ok: true, bot, played: true, finished: true }),
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
