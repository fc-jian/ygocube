const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH),
  assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/public/duel/bots"),
      );
      await page.goto(
        (process.argv[2] || "http://127.0.0.1:3100") + "/duel/bot/",
      );
      const { bots } = await (await response).json();
      assert.equal(bots.length, 70);
      const robot = page.getByLabel("机器人", { exact: true }),
        deck = page.getByLabel("机器人卡组", { exact: true });
      await robot.locator("option").first().waitFor({ state: "attached" });
      assert.equal(await robot.locator("option").count(), 24);
      for (const name of [...new Set(bots.map((b) => b.robot))]) {
        await robot.selectOption(name);
        const expected = bots.filter((b) => b.robot === name).map((b) => b.id);
        assert.deepEqual(
          await deck
            .locator("option")
            .evaluateAll((os) => os.map((o) => o.value)),
          expected,
        );
        assert.equal(await deck.inputValue(), expected[0]);
        await deck.selectOption(expected[expected.length - 1]);
      }
      await robot.selectOption("尼亚");
      await deck.selectOption("Labrynth");
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `data/bot-verification/catalog-${width}.png`,
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      "PASS 24 groups / 70 decks; dependent selection, desktop and mobile",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
