// Deterministic browser regression using the real DuelClient and controlled server messages.
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const { initialState } = require("../../cube/packages/duel-protocol/dist");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const base = process.argv[2] || "http://127.0.0.1:3100";
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        actions = [],
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const infos = [
        { code: 61344030, name: "辉光子", desc: "超量怪兽效果" },
        { code: 92125819, name: "圣骑士", desc: "素材卡片详情" },
        { code: 32807846, name: "增援", desc: "检索战士族" },
        { code: 89631139, name: "青眼白龙", desc: "公开怪兽" },
      ].map((c) => ({ ...c, type: 1, atk: 2000, def: 1000, level: 4 }));
      await page.route("**/api/public/duel/session", (r) =>
        r.fulfill({ json: { ticket: "ui", wsPath: "/api/duel-ui-test" } }),
      );
      await page.route("**/api/public/duel/cards", (r) =>
        r.fulfill({ json: infos }),
      );
      await page.route("**/api/public/duel/descriptions", (r) =>
        r.fulfill({ json: {} }),
      );
      await page.addInitScript(() =>
        sessionStorage.setItem(
          "yc_standalone",
          JSON.stringify({ credential: "ui", options: {} }),
        ),
      );
      let ws;
      const state = initialState();
      Object.assign(state, {
        seat: 0,
        stage: "dueling",
        names: ["测试玩家", "对手"],
        turn: 1,
        phase: 4,
        turnPlayer: 0,
      });
      state.cards = [
        {
          player: 1,
          location: 4,
          sequence: 2,
          code: 61344030,
          position: 4,
          materials: [92125819, 92125819],
          counters: {},
        },
        {
          player: 0,
          location: 2,
          sequence: 0,
          code: 32807846,
          position: 1,
          materials: [],
          counters: {},
        },
        {
          player: 0,
          location: 4,
          sequence: 0,
          code: 89631139,
          position: 1,
          materials: [],
          counters: {},
        },
      ];
      state.prompt = {
        kind: "chain",
        message: 16,
        cancel: true,
        choices: [
          {
            index: 0,
            code: 32807846,
            ref: { player: 0, location: 2, sequence: 0 },
          },
          {
            index: 1,
            code: 32807846,
            ref: { player: 0, location: 2, sequence: 0 },
          },
        ],
      };
      await page.routeWebSocket("**/api/duel-ui-test", (socket) => {
        ws = socket;
        socket.onMessage((raw) => {
          const m = JSON.parse(raw);
          if (m.type === "auth") {
            socket.send(JSON.stringify({ type: "session" }));
            socket.send(JSON.stringify({ type: "snapshot", state }));
            socket.send(JSON.stringify({ type: "prompt", id: 1 }));
          } else if (m.type === "action") actions.push(m);
        });
      });
      await page.goto(base + "/duel/play");
      const confirm = page.locator(".duel-chain-confirmation");
      await confirm.waitFor();
      assert.equal(
        await page.locator(".duel-response-cards button").count(),
        1,
        "same card effects grouped",
      );
      assert.equal(
        await confirm.evaluate((e) => getComputedStyle(e).backdropFilter),
        "none",
      );
      assert.equal(
        await confirm.evaluate((e) => getComputedStyle(e).pointerEvents),
        "none",
      );
      await page.locator('[data-slot="0:4:0"] .duel-card').hover();
      await page
        .locator(".duel-inspector")
        .getByRole("heading", { name: "青眼白龙" })
        .waitFor();
      await confirm
        .getByRole("button", { name: "查看场面", exact: true })
        .click();
      await page.screenshot({
        path: path.join(os.tmpdir(), `duel-material-field-${width}.png`),
      });
      await page
        .getByRole("button", { name: "查看超量素材（2）", exact: true })
        .click();
      const viewer = page.getByRole("dialog", {
        name: "超量素材",
        exact: true,
      });
      await viewer.waitFor();
      assert.equal(
        await viewer.locator(".duel-material-list button").count(),
        2,
      );
      await viewer.locator(".duel-material-list button").nth(1).click();
      await viewer
        .locator(".duel-material-description")
        .getByText("素材卡片详情")
        .waitFor();
      assert.equal(actions.length, 0, "inspection must not respond");
      await viewer.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "返回响应", exact: true }).click();
      await confirm.waitFor();
      await page.locator(".duel-response-cards button").click();
      await page
        .locator(".duel-dialog")
        .getByRole("heading", { name: "增援", exact: true })
        .waitFor();
      assert.equal(actions.length, 0);
      await page.locator(".duel-dialog .duel-close").click();
      await confirm.waitFor();
      assert.equal(await page.locator(".duel-material-layer").count(), 2);
      assert.equal(
        await page
          .locator(".duel-material-layer")
          .first()
          .evaluate((e) => getComputedStyle(e).animationName),
        "duel-overlay-stack",
      );
      await page.screenshot({
        path: path.join(os.tmpdir(), `duel-material-response-${width}.png`),
      });
      await confirm.getByRole("button", { name: "响应", exact: true }).click();
      await page.locator(".duel-hand .duel-card").click();
      await page.locator(".duel-operation-modal").waitFor();
      assert.equal(
        actions.length,
        0,
        "acceptance only opens operation selection",
      );
      await page
        .locator(".duel-operation-modal")
        .getByRole("button", { name: "取消响应", exact: true })
        .click();
      assert.deepEqual(actions.at(-1).data, [255, 255, 255, 255]);
      const before = actions.length;
      ws.send(JSON.stringify({ type: "prompt", id: 2 }));
      await confirm.waitFor();
      await confirm
        .getByRole("button", { name: "不响应", exact: true })
        .click();
      await page.waitForFunction(() => true);
      assert.equal(actions.length, before + 1);
      assert.deepEqual(actions.at(-1).data, [255, 255, 255, 255]);
      state.prompt = {
        kind: "cards",
        message: 15,
        cancel: false,
        min: 1,
        max: 1,
        choices: [0, 1].map((sub) => ({
          index: sub,
          ref: { player: 1, location: 132, sequence: 2, sub },
        })),
      };
      ws.send(JSON.stringify({ type: "snapshot", state }));
      ws.send(JSON.stringify({ type: "prompt", id: 3 }));
      await page
        .getByRole("button", { name: "在场上选择", exact: true })
        .click();
      await page
        .getByRole("button", { name: "查看超量素材（2）", exact: true })
        .click();
      await viewer.locator(".duel-material-list button").nth(1).click();
      await viewer
        .locator(".duel-material-list button[aria-pressed=true]")
        .waitFor();
      await viewer
        .getByRole("button", { name: "确认素材（1）", exact: true })
        .click();
      assert.deepEqual(
        actions.at(-1).data,
        [1, 1],
        "detach the second copy, not the first",
      );
      state.prompt = null;
      state.cards[0].materials = [92125819];
      ws.send(JSON.stringify({ type: "snapshot", state }));
      await page
        .getByRole("button", { name: "查看超量素材（1）", exact: true })
        .waitFor();
      assert.equal(await page.locator(".duel-material-layer").count(), 1);
      assert.deepEqual(errors, []);
      console.log(
        "PASS materials, unobscured field inspection, response summary and cancellation",
        width,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
