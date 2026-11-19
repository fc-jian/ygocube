import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
function loadSource(file) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(file, "utf8"),
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
const load = (name) => loadSource(
  new URL(`../components/duel/${name}.ts`, import.meta.url),
);
const { insertDeckCard } = load("deck-edit");
const {
  canCancelSelection,
  createResponseGate,
  nativePromptDetails,
  secondaryResponse,
  selectionRange,
  shouldPassChain,
  shouldSubmitSelection,
  toggleSelection,
} = load("interaction");
const protocol = loadSource(
  new URL("../../../packages/duel-protocol/src/index.ts", import.meta.url),
);
const plain = (v) => JSON.parse(JSON.stringify(v));
const prompt = (kind, extra = {}) => ({
  kind, message: 15, player: 0, min: 1, max: 2,
  choices: [0, 1, 2].map((index) => ({ index })), ...extra,
});
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

test("selection caps preserve wire indices and permit deselection at the limit", () => {
  const p = prompt("cards", { choices: [4, 9, 12].map((index) => ({ index })) });
  const original = [];
  let indices = toggleSelection(p, original, 9);
  assert.equal(shouldSubmitSelection(p, indices, protocol.selectionValid(p, indices)), false);
  indices = toggleSelection(p, indices, 4);
  assert.equal(shouldSubmitSelection(p, indices, protocol.selectionValid(p, indices)), true);
  assert.deepEqual(Array.from(protocol.encodeSelection(p, indices)), [2, 9, 4]);
  assert.equal(toggleSelection(p, indices, 12), indices);
  assert.equal(toggleSelection(p, indices, 99), indices);
  assert.deepEqual(plain(toggleSelection(p, indices, 9)), [4]);
  assert.deepEqual(original, []);
  const single = prompt("cards", { min: 1, max: 1 });
  assert.equal(shouldSubmitSelection(single, [2], protocol.selectionValid(single, [2])), true);
});

test("hitting the cap never submits an invalid tribute or exact sum", () => {
  for (const kind of ["tribute", "sum"]) {
    const p = prompt(kind, {
      min: kind === "tribute" ? 3 : 2, max: 2, mode: 0, target: 3,
      choices: [{ index: 0, weight: 1 }, { index: 1, weight: 1 }, { index: 2, weight: 2 }],
    });
    const invalid = [0, 1];
    assert.equal(shouldSubmitSelection(p, invalid, protocol.selectionValid(p, invalid)), false);
    assert.equal(toggleSelection(p, invalid, 2), invalid);
    const valid = toggleSelection(p, toggleSelection(p, invalid, 1), 2);
    assert.equal(shouldSubmitSelection(p, valid, protocol.selectionValid(p, valid)), true);
    assert.deepEqual(Array.from(protocol.encodeSelection(p, valid)), [2, 0, 2]);
  }
});

test("mandatory sum cards do not count against the optional cap; greater-than max zero stays selectable", () => {
  const exact = prompt("sum", {
    min: 1, max: 1, mode: 0, target: 5,
    mandatory: [{ index: 0, weight: 3 }], choices: [{ index: 0, weight: 2 }],
  });
  const chosen = toggleSelection(exact, [], 0);
  assert.equal(shouldSubmitSelection(exact, chosen, protocol.selectionValid(exact, chosen)), true);
  assert.deepEqual(Array.from(protocol.encodeSelection(exact, chosen)), [2, 0, 0]);
  const greater = prompt("sum", {
    min: 0, max: 0, mode: 1, target: 5,
    choices: [{ index: 0, weight: 2 }, { index: 1, weight: 3 }],
  });
  const next = toggleSelection(greater, toggleSelection(greater, [], 0), 1);
  assert.deepEqual(plain(next), [0, 1]);
  assert.equal(shouldSubmitSelection(greater, next, protocol.selectionValid(greater, next)), true);
});

test("completed sort and declaration masks auto-submit their native wire encodings", () => {
  const sort = prompt("sort", { min: 3, max: 3 });
  const ranks = [2, 0, 1];
  assert.equal(shouldSubmitSelection(sort, ranks, protocol.selectionValid(sort, ranks)), true);
  assert.deepEqual(Array.from(protocol.encodeSelection(sort, ranks)), [1, 2, 0]);
  const mask = prompt("mask", {
    min: 2, max: 2, choices: [{ index: 0, value: 1 }, { index: 3, value: 8 }],
  });
  assert.equal(shouldSubmitSelection(mask, [3, 0], protocol.selectionValid(mask, [3, 0])), true);
  assert.deepEqual(Array.from(protocol.encodeSelection(mask, [3, 0])), [9, 0, 0, 0]);
  for (const kind of ["position", "command", "yesno", "unselect", "counter"])
    assert.equal(shouldSubmitSelection(prompt(kind, { max: 1 }), [0], true), false);
});

test("Cancel and right click agree; valid partial selections finish instead of cancelling", () => {
  for (const kind of ["cards", "tribute"]) {
    const p = prompt(kind, { cancel: true });
    assert.equal(canCancelSelection(p, 0), true);
    assert.equal(secondaryResponse(p, 0, false), "cancel");
    assert.equal(canCancelSelection(p, 1), false);
    assert.equal(secondaryResponse(p, 1, false), "none");
    assert.equal(secondaryResponse(p, 1, true), "finish");
  }
  assert.equal(secondaryResponse(prompt("cards", { min: 0, cancel: true }), 0, true), "cancel");
  assert.equal(secondaryResponse(prompt("cards", { min: 0, cancel: false }), 0, true), "finish");
  assert.equal(secondaryResponse(prompt("place", { cancel: true }), 0, false), "cancel");
  assert.equal(secondaryResponse(prompt("place", { cancel: false }), 0, false), "none");
  assert.equal(secondaryResponse(prompt("sort", { cancel: true }), 1, false), "cancel");
});

test("native trigger and finishable flags survive decoding without changing the shared model", () => {
  const bytes = (...values) => Uint8Array.from(values.flatMap((v) => typeof v === "number" ? [v] : Array.from(v)));
  const wire = bytes(16, 0, 1, 0x7f, protocol.integer(0), protocol.integer(0),
    0, 0, protocol.integer(123), 0, 4, 0, 0, protocol.integer(0));
  const p = protocol.decodePrompt(wire);
  const details = nativePromptDetails(protocol.packet(1, wire));
  assert.equal(details.chainSpecialCount, 0x7f);
  assert.equal(shouldPassChain(p, "skip", details), false);
  const finish = protocol.packet(1, bytes(26, 0, 1, 0, 1, 2, 0, 0));
  const cancel = protocol.packet(1, bytes(26, 0, 0, 1, 1, 2, 0, 0));
  assert.equal(nativePromptDetails(finish).finishable, true);
  assert.equal(nativePromptDetails(cancel).finishable, false);
  assert.deepEqual(plain(nativePromptDetails(protocol.packet(1, bytes(1)))), {});
});

test("response preferences match native default, when-available, always and ignore semantics", () => {
  const optional = prompt("chain", { cancel: true });
  for (const special of [0, 1, 0x7f]) {
    const details = { chainSpecialCount: special };
    assert.equal(shouldPassChain(optional, "auto", details), special === 0);
    assert.equal(shouldPassChain(optional, "available", details), false);
    assert.equal(shouldPassChain(optional, "always", details), false);
    assert.equal(shouldPassChain(optional, "skip", details), special !== 0x7f);
    for (const preference of ["auto", "available", "always", "skip"])
      assert.equal(shouldPassChain({ ...optional, cancel: false }, preference, details), false);
  }
  const empty = { ...optional, choices: [] };
  assert.equal(shouldPassChain(empty, "always"), false);
  assert.equal(shouldPassChain(empty, "available"), true);
  assert.equal(shouldPassChain(optional, "auto"), false);
});

test("one shared gate blocks double click, confirm/right click and stale renders across revisions", () => {
  const gate = createResponseGate(), first = prompt("cards"), next = prompt("position");
  gate.begin(10);
  assert.equal(gate.canSend(10, first), false);
  gate.bind(first);
  const sent = [];
  const send = (revision, p, data) => {
    if (gate.claim(revision, p)) sent.push(Array.from(data));
  };
  send(10, first, protocol.encodeSelection(first, [0, 1]));
  send(10, first, protocol.integer(-1));
  send(10, first, protocol.encodeSelection(first, [0, 1]));
  assert.deepEqual(sent, [[2, 0, 1]]);
  gate.begin(11);
  // The new revision arrives before its binary prompt.
  send(11, first, protocol.integer(-1));
  gate.bind(next);
  send(10, first, protocol.integer(-1));
  send(11, first, protocol.integer(-1));
  send(11, next, protocol.integer(4));
  assert.deepEqual(sent, [[2, 0, 1], [4, 0, 0, 0]]);
  gate.reject(10, first);
  assert.equal(gate.claim(11, next), false);
});

test("retries re-arm only the current prompt and a reconnect cannot reuse a stale object", () => {
  const gate = createResponseGate(), p = prompt("cards");
  gate.begin(1); gate.bind(p);
  assert.equal(gate.claim(1, p), true);
  gate.reject(1, p);
  assert.equal(gate.claim(1, p), true);
  // MSG_RETRY restores the same object, under a fresh server revision.
  gate.begin(2); gate.bind(p);
  assert.equal(gate.claim(1, p), false);
  assert.equal(gate.claim(2, p), true);
  gate.bind(null);
  assert.equal(gate.canSend(2, p), false);
  const reconnected = prompt("cards");
  gate.begin(1); gate.bind(reconnected);
  assert.equal(gate.claim(1, p), false);
  assert.equal(gate.claim(1, reconnected), true);
});

test("prompt range labels omit meaningless and missing bounds", () => {
  assert.equal(selectionRange(prompt("cards", { min: 1, max: 1 })), "1");
  assert.equal(selectionRange(prompt("cards", { min: 1, max: 3 })), "1–3");
  for (const kind of ["position", "command", "yesno", "counter", "tribute"])
    assert.equal(selectionRange(prompt(kind)), "");
  assert.equal(selectionRange(prompt("cards", { min: undefined, max: undefined })), "");
  assert.equal(selectionRange(prompt("sum", { mode: 1, max: 0 })), "");
});
