import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const exports = {};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      new URL("../components/duel/native-visuals.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
      },
    },
  ).outputText,
  { exports },
);
const { nativeVisuals, monsterStatus } = exports;
const u32 = (n) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const frame = (m, body) => Uint8Array.from([body.length + 2, 0, 1, m, ...body]);
const state = {
  seat: 0,
  lp: [6500, 9000],
  cards: [],
  turn: 3,
  turnPlayer: 1,
  phase: 4,
};
test("motion artwork obeys destination visibility and never recovers a hidden code", () => {
  const move = (player, location, position, code = 123) =>
    nativeVisuals(
      state,
      frame(50, [
        ...u32(code),
        player,
        4,
        0,
        1,
        player,
        location,
        1,
        position,
        ...u32(0),
      ]),
      [8000, 8000],
    )[0];
  assert.equal(move(1, 32, 2).code, 0);
  assert.equal(move(1, 32, 1).code, 123);
  assert.equal(move(0, 32, 2).code, 123);
  assert.equal(move(0, 1, 2).code, 0);
  assert.equal(move(1, 2, 1).code, 0);
  assert.equal(move(0, 2, 1, 0).code, 0);
  assert.equal(move(1, 16, 1).code, 123);
  const observer = { ...state, seat: 7 };
  const draw = frame(90, [0, 1, ...u32(123)]);
  assert.equal(nativeVisuals(observer, draw, [])[0].code, 0);
  assert.equal(nativeVisuals(state, draw, [])[0].code, 123);
});
test("attack target references distinguish a facedown monster from a direct attack", () => {
  const hidden = nativeVisuals(
    state,
    frame(110, [0, 4, 2, 1, 1, 4, 0, 8]),
    [],
  )[0];
  assert.equal(hidden.kind, "attack");
  assert.equal(hidden.to.location, 4);
  assert.equal(hidden.to.sequence, 0);
  const direct = nativeVisuals(
    state,
    frame(110, [1, 4, 2, 1, 0, 0, 0, 0]),
    [],
  )[0];
  assert.equal(direct.to.location, 0);
  assert.equal(direct.to.player, 0);
  assert.equal("code" in hidden, false);
});
test("summon, target and LP cues preserve native references, signs and meaning", () => {
  const summon = nativeVisuals(
    state,
    frame(62, [...u32(123), 1, 4, 6, 1]),
    [],
  )[0];
  assert.equal(summon.label, "特殊召唤");
  assert.equal(summon.ref.sequence, 6);
  const targets = nativeVisuals(
    state,
    frame(83, [2, 0, 4, 2, 1, 1, 4, 0, 8]),
    [],
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[1].ref.player, 1);
  assert.equal(
    nativeVisuals(state, frame(91, [0, ...u32(1500)]), [8000, 8000])[0].amount,
    -1500,
  );
  assert.equal(
    nativeVisuals(state, frame(92, [1, ...u32(1000)]), [8000, 8000])[0].amount,
    1000,
  );
  assert.equal(
    nativeVisuals(state, frame(94, [0, ...u32(6500)]), [8000, 8000])[0].amount,
    -1500,
  );
  assert.equal(
    nativeVisuals(state, frame(100, [0, ...u32(500)]), [8000, 8000])[0].label,
    "支付",
  );
  assert.equal(nativeVisuals(state, frame(83, [2]), []).length, 0);
});
test("field stats use live values and correct Link/Xyz semantics", () => {
  const printed = { type: 1, atk: 2000, def: 1000, level: 4 };
  const c = { type: 0x800001, rank: 5, atk: 2500, def: 500 };
  assert.equal(monsterStatus(c, printed).badge, "阶5");
  assert.equal(monsterStatus(c, printed).atkTone, "raised");
  assert.equal(monsterStatus(c, printed).defTone, "lowered");
  assert.equal(
    monsterStatus({ ...c, type: 0x4000001, link: 3, atk: -1 }, printed).def,
    "L3",
  );
  assert.equal(monsterStatus({ ...c, atk: -1 }, printed).atk, "?");
});
