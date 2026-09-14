import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
function load(name) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        new URL(`../components/duel/${name}.ts`, import.meta.url),
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
  return exports;
}
const { insertDeckCard } = load("deck-edit");
const { secondaryResponse } = load("interaction");
const plain = (v) => JSON.parse(JSON.stringify(v));
test("dragging within main preserves duplicates, index boundaries and the original deck", () => {
  const d = { main: [1, 2, 1, 3], extra: [], side: [] };
  assert.deepEqual(
    plain(
      insertDeckCard(d, { code: 2, zone: "main", index: 1 }, "main", 1, 4).main,
    ),
    [1, 1, 3, 2],
  );
  assert.deepEqual(
    plain(
      insertDeckCard(d, { code: 1, zone: "main", index: 2 }, "main", 1, 0).main,
    ),
    [1, 1, 2, 3],
  );
  assert.deepEqual(d.main, [1, 2, 1, 3]);
  assert.equal(
    insertDeckCard(d, { code: 9, zone: "main", index: 2 }, "side", 1),
    d,
  );
});
test("extra monsters return from side to extra; invalid drops and full destinations preserve the source", () => {
  const d = { main: [1], extra: [2], side: [3] };
  assert.deepEqual(
    plain(insertDeckCard(d, { code: 3, zone: "side", index: 0 }, "main", 0x41)),
    { main: [1], extra: [2, 3], side: [] },
  );
  assert.equal(
    insertDeckCard(d, { code: 1, zone: "main", index: 0 }, "extra", 1),
    d,
  );
  const full = { ...d, side: Array(200).fill(3) };
  assert.equal(
    insertDeckCard(full, { code: 1, zone: "main", index: 0 }, "side", 1),
    full,
  );
  assert.equal(
    insertDeckCard(full, { code: 3, zone: "side", index: 0 }, "side", 1).side
      .length,
    200,
  );
});
test("right click cannot bypass required choices or partially completed selections", () => {
  assert.equal(
    secondaryResponse({ kind: "position", cancel: false }, 0, false),
    "none",
  );
  assert.equal(
    secondaryResponse({ kind: "cards", cancel: false }, 0, false),
    "none",
  );
  assert.equal(
    secondaryResponse({ kind: "cards", cancel: true }, 1, false),
    "none",
  );
  assert.equal(
    secondaryResponse({ kind: "cards", cancel: true }, 0, false),
    "cancel",
  );
  assert.equal(
    secondaryResponse({ kind: "tribute", cancel: false }, 2, true),
    "finish",
  );
  assert.equal(
    secondaryResponse({ kind: "sum", cancel: false }, 0, true),
    "finish",
  );
  assert.equal(secondaryResponse({ kind: "yesno" }, 0, false), "no");
  assert.equal(
    secondaryResponse({ kind: "chain", cancel: false }, 0, false),
    "none",
  );
  assert.equal(
    secondaryResponse({ kind: "unselect", cancel: false }, 0, true),
    "none",
  );
  assert.equal(
    secondaryResponse({ kind: "unselect", cancel: true }, 0, true),
    "cancel",
  );
});
