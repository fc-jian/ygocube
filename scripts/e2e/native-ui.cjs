const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const assert = require("node:assert/strict"),
  path = require("node:path"),
  os = require("node:os");
const base = process.argv[2] || "http://127.0.0.1:3100";
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    for (const [width, height] of [
      [1440, 900],
      [1366, 768],
      [1024, 600],
      [390, 844],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base + "/duel");
      await page.getByLabel("对局模式").waitFor();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "lobby horizontal overflow",
      );
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: path.join(os.tmpdir(), `native-lobby-before-check-${width}.png`),
        fullPage: true,
      });
      if (width >= 700)
        assert(
          await page.evaluate(
            () => document.documentElement.scrollHeight <= innerHeight + 1,
          ),
          `desktop lobby vertical overflow at ${width}x${height}`,
        );
      await page.screenshot({
        path: path.join(os.tmpdir(), `native-lobby-${width}.png`),
        fullPage: true,
      });
      await page.goto(base + "/duel/decks");
      await page.locator(".deck-import input[type=file]").setInputFiles({
        name: "ui-test.ydk",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "#main\n89631139\n46986414\n89631139\n#extra\n!side\n",
        ),
      });

      await page.getByText("已导入并保存", { exact: true }).waitFor();
      const main = page.locator("[data-deck-zone=main] .builder-zone");
      await main.locator("article").nth(2).waitFor();
      const card = main.locator(".card-preview").first();
      await card.dblclick();
      await page.getByRole("dialog", { name: "卡片大图" }).waitFor();
      assert.equal(
        await main.locator("article").count(),
        3,
        "double click must not move a card",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "关闭" })
        .click();
      if (width >= 700) {
        const before = await main
          .locator(".card-preview")
          .nth(1)
          .getAttribute("aria-label");
        await main
          .locator("article")
          .nth(1)
          .dragTo(main.locator("article").first());
        assert.equal(
          await main
            .locator(".card-preview")
            .first()
            .getAttribute("aria-label"),
          before,
        );
      }
      await page.getByLabel("搜索卡片", { exact: true }).fill("89631139");
      const result = page.locator(".builder-results .card-preview").first();
      await result.waitFor();
      await result.click({ button: "right" });
      assert.equal(
        await main.locator("article").count(),
        4,
        "right click adds",
      );
      await main.locator(".card-preview").first().click({ button: "right" });
      assert.equal(
        await main.locator("article").count(),
        3,
        "right click removes",
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "builder horizontal overflow",
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight + 1,
        ),
        "builder vertical overflow",
      );
      await page.screenshot({
        path: path.join(os.tmpdir(), `native-builder-${width}.png`),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      console.log("PASS native deck interactions and layout", width, height);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
