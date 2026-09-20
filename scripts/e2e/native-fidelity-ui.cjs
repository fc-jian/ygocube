const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const {
  initialState,
  packet,
} = require("../../cube/packages/duel-protocol/dist");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.argv[2] || "http://127.0.0.1:3100";
const apiPrefix = process.env.DUEL_API_BASE || "/api";
const u32 = (n) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    for (const [width, height, seat] of [
      [1440, 900, 0],
      [1366, 768, 1],
      [1024, 600, 0],
      [390, 844, 1],
      [844, 390, 0],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } }),
        actions = [],
        errors = [];
      page.setDefaultTimeout(7000);
      page.on("pageerror", (e) => errors.push(e.message));
      const own = seat,
        other = 1 - seat;
      const card = (player, location, sequence, code, more = {}) => ({
        player,
        location,
        sequence,
        code,
        position: 1,
        counters: {},
        materials: [],
        ...more,
      });
      const state = initialState();
      Object.assign(state, {
        seat,
        stage: "dueling",
        names: ["测试玩家一", "测试玩家二"],
        turn: 3,
        turnPlayer: seat,
        phase: 4,
      });
      state.cards = [
        card(own, 4, 0, 89631139, { atk: 3500, def: 2000, level: 8 }),
        card(other, 4, 2, 0, { position: 8 }),
        card(own, 4, 1, 61344030, {
          type: 0x800001,
          rank: 4,
          materials: [92125819],
        }),
        card(own, 4, 2, 1861629, { type: 0x4000001, link: 3, atk: 2300 }),
        card(own, 8, 1, 32807846, {
          equip: { player: own, location: 4, sequence: 0 },
        }),
        card(own, 2, 0, 92125819),
        card(own, 16, 0, 32807846),
        card(other, 16, 0, 89631139),
        card(own, 1, 0, 0),
        card(other, 1, 0, 0),
        card(other, 2, 0, 0),
      ];
      const info = [
        { code: 89631139, name: "青眼白龙", atk: 3000, def: 2500, level: 8 },
        { code: 61344030, name: "辉光子", atk: 1800, def: 1000, level: 4 },
        {
          code: 1861629,
          name: "解码语者",
          atk: 2300,
          def: 3,
          level: 3,
          type: 0x4000001,
        },
        { code: 32807846, name: "增援", type: 2 },
        { code: 92125819, name: "圣骑士", atk: 1800, def: 1000, level: 4 },
      ].map((c) => ({
        type: 1,
        atk: 0,
        def: 0,
        level: 4,
        desc: "用于核对网页操作、场上实时数值与可查看的卡片效果。",
        setNames: ["测试字段"],
        ...c,
      }));
      await page.route("**" + apiPrefix + "/public/duel/session", (r) =>
        r.fulfill({
          json: { ticket: "ui", wsPath: apiPrefix + "/native-fidelity-ui" },
        }),
      );
      await page.route("**" + apiPrefix + "/public/duel/cards", (r) =>
        r.fulfill({ json: info }),
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
      let ws,
        revision = 1;
      await page.routeWebSocket(
        "**" + apiPrefix + "/native-fidelity-ui",
        (socket) => {
          ws = socket;
          socket.onMessage((raw) => {
            const m = JSON.parse(raw);
            if (m.type === "auth") {
              socket.send(JSON.stringify({ type: "session" }));
              socket.send(JSON.stringify({ type: "snapshot", state }));
            } else if (m.type === "action") actions.push(m);
          });
        },
      );
      await page.goto(base + "/duel/play");
      await page.getByText("已连接", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const snap = async () => {
        ws.send(JSON.stringify({ type: "snapshot", state }));
        ws.send(JSON.stringify({ type: "prompt", id: revision++ }));
        await page.waitForTimeout(100);
      };
      const send = (m, body) =>
        ws.send(Buffer.from(packet(1, Uint8Array.from([m, ...body]))));
      const entity = (p, l, s) =>
        page.locator(`.duel-table [data-duel-ref="${p}:${l}:${s}"]`);
      const blue = entity(own, 4, 0);
      await blue.locator(".duel-stat .raised").waitFor();
      assert.equal(
        await blue.locator(".duel-stat .raised").innerText(),
        "3500",
      );
      assert.equal(
        await blue.locator(".duel-stat .lowered").innerText(),
        "2000",
      );
      assert.equal(
        await entity(own, 4, 2).locator(".duel-stat .link").innerText(),
        "L3",
      );
      await entity(own, 8, 1).hover();
      await blue.locator(".duel-relation-mark").waitFor();
      assert.equal(
        await blue.locator(".duel-relation-mark").innerText(),
        "装备",
      );
      const room = await page.locator(".duel-shell").boundingBox(),
        table = await page.locator(".duel-table").boundingBox();
      assert(
        table.y >= room.y - 1 && table.y + table.height <= height + 1,
        `field height overflow ${width}x${height}`,
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "horizontal overflow",
      );
      state.prompt = {
        kind: "command",
        message: 10,
        player: own,
        min: 0,
        max: 0,
        choices: [
          {
            index: 0,
            code: 89631139,
            ref: { player: own, location: 4, sequence: 0 },
            label: "attack",
            value: 1,
          },
          {
            index: 1,
            code: 89631139,
            ref: { player: own, location: 4, sequence: 0 },
            label: "position",
            value: 2,
          },
        ],
      };
      await snap();
      await blue.getByLabel("可以攻击").waitFor();
      await blue.click({ delay: 60 });
      const menu = page.getByRole("dialog", { name: "选择操作", exact: true });
      await menu.waitFor();
      const mr = await menu.boundingBox();
      assert(
        mr.x >= 0 &&
          mr.x + mr.width <= width + 1 &&
          mr.y + mr.height <= height + 1,
        "context menu fits viewport",
      );
      assert.equal(await menu.locator(".duel-operation-image").count(), 0);
      await menu.getByRole("button", { name: "攻击", exact: true }).dblclick();
      await page.waitForTimeout(80);
      assert.equal(actions.length, 1, "double click submits once");
      assert.deepEqual(actions.at(-1).data, [1, 0, 0, 0]);
      state.prompt = null;
      await snap();
      send(110, [own, 4, 0, 1, other, 4, 2, 8]);
      await page.locator(".duel-attack-trail").waitFor();
      assert.equal(
        await page.locator(".duel-attack-trail").getAttribute("data-defender"),
        `${other}:4:2`,
      );
      assert.equal(
        await page
          .locator(".duel-feedback")
          .evaluate((e) => getComputedStyle(e).pointerEvents),
        "none",
      );
      await entity(other, 4, 2).click();
      await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();
      send(91, [other, ...u32(1500)]);
      await page.locator(".duel-life-delta.damage").waitFor();
      assert.match(
        await page.locator(".duel-life-delta.damage").innerText(),
        /1,500/,
      );
      send(83, [1, other, 4, 2, 8]);
      await page.locator(".signal-target").waitFor();
      send(62, [...u32(61344030), own, 4, 5, 1]);
      await page.locator(".signal-summon").waitFor();
      if (width === 1440 || width === 390) {
        fs.mkdirSync(path.join(__dirname, "../../data/native-fidelity"), {
          recursive: true,
        });
        await page.screenshot({
          path: path.join(
            __dirname,
            `../../data/native-fidelity/duel-${width}.png`,
          ),
        });
      }
      await snap();
      assert.equal(
        await page.locator(".duel-feedback > *").count(),
        0,
        "snapshot clears previous visuals",
      );
      send(110, [other, 4, 2, 1, 0, 0, 0, 0]);
      await page.locator(".duel-attack-trail").waitFor();
      assert.equal(
        await page.locator(".duel-attack-trail").getAttribute("data-defender"),
        `player:${own}`,
      );
      await snap();
      send(90, [other, 1, ...u32(0)]);
      await page.locator(".duel-travel-card .duel-back").waitFor();
      assert.equal(
        await page.locator(".duel-travel-card img").count(),
        0,
        "opponent draw uses a card back",
      );
      await snap();
      send(41, [4, 0]);
      await page.locator(".duel-phase-banner").waitFor();
      state.disabled = 1 << (own * 16 + 5);
      await snap();
      assert.equal(
        await page.locator('[data-extra-slot="0"].disabled').count(),
        1,
      );
      state.rule = 3;
      await snap();
      assert.equal(await page.locator("[data-extra-slot]").count(), 0);
      state.rule = 5;
      state.chain = [
        {
          index: 1,
          code: 89631139,
          ref: { player: own, location: 4, sequence: 0 },
        },
        {
          index: 2,
          code: 89631139,
          ref: { player: own, location: 4, sequence: 0 },
        },
      ];
      await snap();
      const badges = await blue.locator(".duel-chain-marker").all();
      assert.equal(badges.length, 2);
      assert.notEqual(
        (await badges[0].boundingBox()).x,
        (await badges[1].boundingBox()).x,
      );
      state.cards[0].code = 92125819;
      await snap();
      assert.equal(
        await blue.locator(".duel-chain-marker").count(),
        0,
        "replacement card is not the old chain source",
      );
      state.chain = [];
      state.prompt = null;
      await snap();
      send(165, [seat, 6, ...u32(38723936)]);
      await page.waitForTimeout(100);
      assert(await page.locator('[data-pile="' + own + ':16"]').isDisabled());
      assert(await page.locator('[data-pile="' + other + ':16"]').isDisabled());
      send(165, [seat, 7, ...u32(38723936)]);
      await page.waitForTimeout(100);
      assert(await page.locator('[data-pile="' + own + ':16"]').isEnabled());
      state.prompt = {
        kind: "cards",
        message: 15,
        player: own,
        min: 1,
        max: 1,
        cancel: true,
        choices: [
          {
            index: 0,
            code: 92125819,
            ref: { player: own, location: 4, sequence: 0 },
          },
        ],
      };
      await snap();
      await page
        .getByRole("button", { name: "在场上选择", exact: true })
        .click();
      await blue.click();
      await page.waitForTimeout(60);
      assert.equal(actions.length, 2);
      assert.deepEqual(
        actions.at(-1).data,
        [1, 0],
        "one required card auto-confirms",
      );
      await blue.click();
      await page.waitForTimeout(60);
      assert.equal(actions.length, 2, "old selection cannot submit again");
      assert.deepEqual(errors, []);
      console.log(
        "PASS native field feedback, context actions, privacy, input guard",
        width,
        height,
        "seat",
        seat,
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
