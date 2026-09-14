// Deterministic browser regression using the real DuelClient and controlled server messages.
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const { initialState } = require("../../cube/packages/duel-protocol/dist");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const base = process.argv[2] || "http://127.0.0.1:3100";
const apiPrefix = process.env.DUEL_API_BASE || "/api";
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
      ].map((c) => ({
        ...c,
        type: 1,
        atk: 2000,
        def: 1000,
        level: 4,
        setNames: ["测试字段"],
      }));
      await page.route("**" + apiPrefix + "/public/duel/session", (r) =>
        r.fulfill({ json: { ticket: "ui", wsPath: apiPrefix + "/duel-ui-test" } }),
      );
      await page.route("**" + apiPrefix + "/public/duel/cards", (r) =>
        r.fulfill({ json: infos }),
      );
      await page.route("**" + apiPrefix + "/public/duel/descriptions", (r) =>
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
      await page.routeWebSocket("**" + apiPrefix + "/duel-ui-test", (socket) => {
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

      await page.getByText("已连接", { exact: true }).waitFor();
      let revision = 10;
      const snapshot = async () => {
        ws.send(JSON.stringify({ type: "snapshot", state }));
        ws.send(JSON.stringify({ type: "prompt", id: revision++ }));
        await page.waitForTimeout(150);
      };
      state.prompt = null;
      state.cards.push(
        ...[
          { player: 1, location: 32, sequence: 0, code: 89631139, position: 1 },
          { player: 1, location: 32, sequence: 1, code: 92125819, position: 2 },
          { player: 0, location: 64, sequence: 0, code: 61344030, position: 2 },
          { player: 0, location: 64, sequence: 1, code: 92125819, position: 1 },
        ].map((c) => ({ ...c, materials: [], counters: {} })),
      );
      await snapshot();
      const pile = page.locator(".duel-banished.opponent-pile .duel-pile");
      assert.match(await pile.innerText(), /2\(1\)/);
      assert.equal(
        await pile.locator(".duel-pile-art .duel-image").count(),
        0,
        "face-down top must use card back",
      );
      await pile.click();
      const hidden = page.locator(".duel-zone-browser .duel-card").nth(1);
      assert.equal(await hidden.getAttribute("data-card-code"), null);
      assert.match(await hidden.innerText(), /里侧/);
      await page.locator(".duel-dialog .duel-close").click();
      state.prompt = {
        kind: "command",
        message: 11,
        choices: [
          {
            index: 0,
            code: 61344030,
            value: 1,
            ref: { player: 0, location: 64, sequence: 0 },
            label: "special",
          },
        ],
      };
      await snapshot();
      await page
        .locator(".duel-half:not(.opponent) .duel-pile")
        .first()
        .click();
      await page.getByRole("button", { name: "查看该区域全部卡片" }).click();
      assert.equal(
        await page.locator(".duel-zone-browser .duel-card").count(),
        2,
      );
      await page.locator(".duel-dialog .duel-close").click();
      state.logs = ["turn:1:0", "activate:32807846:1:1:2", "reveal:89631139:1"];
      state.prompt = null;
      await snapshot();
      await page.getByRole("button", { name: "对局记录", exact: true }).click();
      await page.locator(".duel-history-list button").first().click();
      await page
        .locator(".duel-description")
        .filter({ hasText: "检索战士族" })
        .waitFor();
      await page.locator(".duel-dialog .duel-close").click();
      state.cards.push({
        player: 1,
        location: 2,
        sequence: 0,
        code: 0,
        position: 2,
        materials: [],
        counters: {},
      });
      await snapshot();
      const protocol = require("../../cube/packages/duel-protocol/dist");
      ws.send(
        Buffer.from(
          protocol.packet(
            1,
            Uint8Array.from([
              70,
              ...protocol.integer(32807846),
              1,
              2,
              0,
              2,
              1,
              2,
              0,
              ...protocol.integer(0),
              1,
            ]),
          ),
        ),
      );
      await page
        .locator(".effect-activate")
        .filter({ hasText: "效果发动" })
        .waitFor();
      assert.equal(
        await page
          .locator('.opponent-hand .duel-card[data-card-code="32807846"]')
          .count(),
        1,
      );
      await page.locator(".duel-chain-strip button").click();
      await page.getByText("字段：测试字段", { exact: true }).last().waitFor();
      await page.locator(".duel-dialog .duel-close").click();
      state.revealed = [89631139, 32807846];
      await snapshot();
      assert.equal(
        await page.locator(".duel-reveal-grid .duel-reveal-art").count(),
        2,
      );
      await page.locator(".duel-reveal-modal .duel-close").click();
      state.revealed = [];
      state.stage = "siding";
      state.winner = 0;
      state.winReason = 3;
      state.deck = { main: [89631139, 61344030], side: [92125819] };
      await snapshot();
      await page.getByText(/上一局：胜利/).waitFor();
      assert.match(
        await page.locator(".duel-side-result").innerText(),
        /时间|超时/,
      );
      state.stage = "dueling";
      state.winner = undefined;
      state.time = [10, 10];
      state.timePlayer = 0;
      await snapshot();
      const { packet } = require("../../cube/packages/duel-protocol/dist");
      ws.send(Buffer.from(packet(0x18, Uint8Array.of(0, 0, 10, 0))));
      await page.waitForTimeout(1200);
      assert.match(
        await page.locator(".duel-score small").first().innerText(),
        /8秒/,
      );
      ws.send(Buffer.from(packet(0x18, Uint8Array.of(0, 0, 10, 0))));
      await page.waitForTimeout(200);
      assert.match(
        await page.locator(".duel-score small").first().innerText(),
        /9秒/,
        "same value TIME_LIMIT must re-anchor",
      );
      await page.evaluate(() => {
        const header = document.createElement("div");
        header.id = "height-test";
        header.style.height = "80px";
        document.querySelector(".duel-playing").before(header);
      });
      await page.waitForTimeout(200);
      let gap = await page
        .locator(".duel-playing")
        .evaluate((e) => innerHeight - e.getBoundingClientRect().bottom);
      assert(
        Math.abs(gap) < 4,
        "initial height follows inserted header: " + gap,
      );
      await page.evaluate(() =>
        document.querySelector("#height-test").remove(),
      );
      await page.waitForTimeout(200);
      gap = await page
        .locator(".duel-playing")
        .evaluate((e) => innerHeight - e.getBoundingClientRect().bottom);
      assert(Math.abs(gap) < 4, "height follows removed header: " + gap);
      assert.deepEqual(errors, []);
      console.log(
        "PASS duel information, privacy, region browsing, side result, clock and height",
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
