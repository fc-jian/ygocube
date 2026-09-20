import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
function harness() {
  let now = 0,
    serial = 0;
  const timers = new Map(),
    exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        new URL("../components/duel/timeline.ts", import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2021,
        },
      },
    ).outputText,
    {
      exports,
      performance: { now: () => now },
      setTimeout: (fn, delay) => {
        timers.set(++serial, { fn, at: now + delay });
        return serial;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  );
  const tick = (ms) => {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  return { ...exports, tick, now: () => now };
}
test("stages and moves remain ordered with visible pauses before the next prompt", () => {
  const h = harness(),
    q = new h.DuelTimeline(),
    seen = [];
  q.push(() => seen.push("draw phase"), 950);
  q.push(() => seen.push("draw"), 480);
  q.push(() => seen.push("main phase"), 950);
  q.push(() => seen.push("prompt"));
  assert.deepEqual(seen, ["draw phase"]);
  h.tick(949);
  assert.equal(seen.length, 1);
  h.tick(1);
  assert.equal(seen.at(-1), "draw");
  h.tick(480);
  assert.equal(seen.at(-1), "main phase");
  h.tick(950);
  assert.equal(seen.at(-1), "prompt");
});
test("bursts accelerate without reordering or accumulating unbounded prompt delay", () => {
  const h = harness(),
    q = new h.DuelTimeline(),
    seen = [];
  for (let i = 0; i < 20; i++) q.push((scale) => seen.push([i, scale]), 950);
  q.push(() => seen.push(["prompt", 1]));
  h.tick(2501);
  assert.equal(seen.length, 21);
  assert.deepEqual(
    seen.slice(0, 20).map((v) => v[0]),
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert(seen[1][1] < 1);
  assert.equal(seen.at(-1)[0], "prompt");
});
test("snapshot reset discards old work and background flush catches up without animations", () => {
  const h = harness(),
    q = new h.DuelTimeline(),
    seen = [];
  q.push(() => {}, 950);
  q.push(() => seen.push("stale"), 950);
  q.clear();
  h.tick(3000);
  assert.deepEqual(seen, []);
  q.push(() => {}, 950);
  q.push((scale) => seen.push(scale), 950);
  q.push((scale) => seen.push(scale), 480);
  q.flush();
  assert.deepEqual(seen, [0, 0]);
  h.tick(3000);
  assert.equal(seen.length, 2);
});
test("wire clock and metadata never request presentation waits", () => {
  const h = harness();
  assert.equal(h.framePause(Uint8Array.of(0, 0, 0x18, 0)), 0);
  assert.equal(h.framePause(Uint8Array.of(0, 0, 1, 6)), 0);
  assert.equal(h.framePause(Uint8Array.of(0, 0, 1, 41)), 950);
  assert.equal(h.framePause(Uint8Array.of(0, 0, 1, 90, 0, 5)), 780);
});
