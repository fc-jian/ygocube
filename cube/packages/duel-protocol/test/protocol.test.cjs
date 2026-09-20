const { test } = require("node:test");
const assert = require("node:assert/strict");
const p = require("../dist");
const bytes = (...xs) =>
  Uint8Array.from(
    xs.flatMap((x) => (typeof x === "number" ? [x] : Array.from(x))),
  );
const u32 = p.integer;
const card = (code, player = 0, loc = 4, seq = 0, sub = 0) =>
  bytes(u32(code), player, loc, seq, sub);
const short = (code, player = 0, loc = 4, seq = 0) =>
  bytes(u32(code), player, loc, seq);
test("framer handles every fragmentation boundary and multiple coalesced packets", () => {
  const a = p.packet(1, bytes(40, 0)),
    b = p.packet(3);
  const all = bytes(a, b);
  for (let i = 0; i < all.length; i++) {
    const f = new p.Framer();
    assert.deepEqual(
      [...f.feed(all.slice(0, i)), ...f.feed(all.slice(i))],
      [a, b],
    );
  }
  assert.throws(() => new p.Framer().feed(bytes(0, 0)));
});
test("battle attack entries contain interleaved direct-attack bytes", () => {
  const q = p.decodePrompt(
    bytes(10, 0, 0, 2, short(111), 1, short(222, 0, 4, 1), 0, 1, 1),
  );
  assert.equal(q.choices[1].code, 222);
  assert.equal(q.choices[1].value, 65537);
  assert.equal(q.choices[2].value, 2);
});
test("idle commands preserve original indices and command discriminators", () => {
  const q = p.decodePrompt(
    bytes(11, 0, 1, short(111), 0, 0, 0, 0, 1, short(222), u32(10000), 1, 1, 1),
  );
  assert.deepEqual(
    q.choices.map((c) => c.value),
    [0, 5, 6, 7, 8],
  );
});
test("effect yes/no, options, positions and declarations decode strictly", () => {
  assert.equal(
    p.decodePrompt(bytes(12, 0, card(123), u32(10000))).choices[0].value,
    1,
  );
  assert.equal(p.decodePrompt(bytes(13, 0, u32(456))).hint, 456);
  assert.deepEqual(
    p
      .decodePrompt(bytes(14, 0, 2, u32(10001), u32(10002)))
      .choices.map((c) => c.value),
    [0, 1],
  );
  assert.deepEqual(
    p.decodePrompt(bytes(19, 0, u32(123), 5)).choices.map((c) => c.value),
    [1, 4],
  );
  assert.equal(p.decodePrompt(bytes(142, 0, 1, u32(123))).opcodes[0], 123);
  assert.equal(p.decodePrompt(bytes(143, 0, 1, u32(999))).choices[0].value, 0);
});
test("chain flags include per-entry forced byte", () => {
  const q = p.decodePrompt(
    bytes(16, 0, 1, 0, u32(0), u32(0), 0, 1, card(123), u32(456)),
  );
  assert.equal(q.cancel, false);
  assert.equal(q.choices[0].description, 456);
});
test("card selection preserves host order, cancellation and xyz sub-index", () => {
  const q = p.decodePrompt(
    bytes(15, 0, 1, 1, 2, 2, card(222, 0, 132, 0, 2), card(111)),
  );
  assert.equal(q.choices[0].ref.sub, 2);
  assert.deepEqual([...p.encodeSelection(q, [1, 0])], [2, 1, 0]);
  assert.throws(() => p.encodeSelection(q, [0, 0]));
});
test("unselect choices preserve indices across both lists", () => {
  const q = p.decodePrompt(
    bytes(26, 0, 1, 0, 1, 2, 1, card(111), 1, card(222)),
  );
  assert(q.cancel);
  assert(q.choices[1].selected);
  assert.equal(q.choices[1].index, 1);
});
test("tribute supports double tribute; counter responses use little-endian uint16", () => {
  const q = p.decodePrompt(bytes(20, 0, 0, 2, 2, 1, card(111, 0, 4, 0, 2)));
  assert(p.selectionValid(q, [0]));
  const c = p.decodePrompt(
    bytes(22, 0, 1, 0, 3, 0, 2, short(111), 2, 0, short(222), 2, 0),
  );
  assert.deepEqual([...p.encodeSelection(c, [], [1, 2])], [1, 0, 2, 0]);
  assert(!p.selectionValid(c, [], [3, 0]));
});
test("sum choices include mandatory prefix and alternate levels", () => {
  const q = p.decodePrompt(
    bytes(
      23,
      0,
      0,
      u32(8),
      1,
      2,
      1,
      short(111),
      u32(3),
      1,
      short(222),
      u32((5 << 16) | 2),
    ),
  );
  assert(p.selectionValid(q, [0]));
  assert.deepEqual([...p.encodeSelection(q, [0])], [2, 0, 0]);
});
test("sort sends ranks in original wire order; place sends controller/location/sequence", () => {
  const q = p.decodePrompt(bytes(25, 0, 2, short(111), short(222)));
  assert.deepEqual([...p.encodeSelection(q, [1, 0])], [1, 0]);
  const z = p.decodePrompt(bytes(18, 0, 1, u32(0xfffffffe)));
  assert.deepEqual([...p.encodeSelection(z, [0])], [0, 4, 0]);
});
test("race and attribute masks and rock-paper-scissors", () => {
  const q = p.decodePrompt(bytes(141, 0, 2, u32(5)));
  assert.deepEqual([...p.encodeSelection(q, [0, 2])], [5, 0, 0, 0]);
  assert.equal(p.decodePrompt(bytes(132, 1)).choices.length, 3);
});
test("hidden draw and hand shuffle clear identities without fetching metadata", () => {
  const s = p.initialState();
  p.applyGame(s, bytes(4, 0, 5, u32(8000), u32(8000), 2, 0, 0, 0, 2, 0, 0, 0));
  p.applyGame(s, bytes(90, 1, 1, u32(0)));
  assert.equal(s.cards.find((c) => c.player === 1 && c.location === 2).code, 0);
  p.applyGame(s, bytes(90, 0, 1, u32(123)));
  p.applyGame(s, bytes(33, 0, 1, u32(0)));
  assert.equal(s.cards.find((c) => c.player === 0 && c.location === 2).code, 0);
});
test("movement into hidden location does not retain code, stats or material identity", () => {
  const s = p.initialState();
  p.applyGame(s, bytes(50, u32(123), 0, 0, 0, 0, 0, 4, 0, 1, u32(0)));
  p.applyGame(s, bytes(50, u32(0), 0, 4, 0, 1, 1, 2, 0, 0, u32(0)));
  assert.equal(s.cards[0].code, 0);
});
test("queries decode attack, materials and counters in flag order", () => {
  const s = p.initialState(),
    payload = bytes(
      u32(1 | 256 | 65536 | 131072),
      u32(123),
      u32(1800),
      u32(2),
      u32(111),
      u32(222),
      u32(1),
      3,
      0,
      2,
      0,
    );
  p.applyGame(s, bytes(7, 0, 4, 0, u32(payload.length + 4), payload));
  assert.equal(s.cards[0].atk, 1800);
  assert.deepEqual(s.cards[0].materials, [111, 222]);
  assert.equal(s.cards[0].counters[3], 2);
});
test("base stats and status queries preserve signed values and clear with hidden data", () => {
  for (const hiddenFlags of [0, 1]) {
    const s = p.initialState();
    const payload = bytes(
      u32(1 | 1024 | 2048 | 524288),
      u32(91231901), u32(-1), u32(2500), u32(0x4000001),
    );
    p.applyGame(s, bytes(7, 1, 4, 2, u32(payload.length + 4), payload));
    assert.equal(s.cards[0].baseAtk, -1);
    assert.equal(s.cards[0].baseDef, 2500);
    assert.equal(s.cards[0].status, 0x4000001);
    const hidden = hiddenFlags ? bytes(u32(1), u32(0)) : bytes(u32(0));
    p.applyGame(s, bytes(7, 1, 4, 2, u32(hidden.length + 4), hidden));
    assert.equal(s.cards[0].code, 0);
    for (const field of ["baseAtk", "baseDef", "status"])
      assert.equal(Object.hasOwn(s.cards[0], field), false);
  }
});
test("battle updates existing combatants' signed stats without changing identity or position", () => {
  const s = p.initialState();
  s.cards = [
    { player: 0, location: 4, sequence: 1, code: 32807846, position: 1,
      atk: 1800, def: 1200, baseAtk: 1800, baseDef: 1200, status: 1,
      counters: { 3: 2 }, materials: [123] },
    { player: 1, location: 4, sequence: 3, code: 91231901, position: 4,
      atk: 2500, def: 2000, baseAtk: 2500, baseDef: 2000,
      counters: {}, materials: [] },
    { player: 1, location: 4, sequence: 1, code: 89631139, position: 1,
      atk: 3000, def: 2500, counters: {}, materials: [] },
  ];
  const existing = [...s.cards], expected = structuredClone(s.cards);
  Object.assign(expected[0], { atk: 2300, def: -1 });
  Object.assign(expected[1], { atk: -2, def: 2700 });
  const battle = bytes(111,
    0, 4, 1, 8, u32(2300), u32(-1), 1,
    1, 4, 3, 1, u32(-2), u32(2700), 1);
  p.applyFrame(s, p.packet(1, battle));
  assert.deepEqual(s.cards, expected);
  existing.forEach((c, i) => assert.strictEqual(s.cards[i], c));
  assert.deepEqual(s.revealed, []);
  assert.deepEqual(s.logs, [`event:111:${Array.from(battle.subarray(1)).join(",")}`]);
});
test("battle preserves an unknown facedown target and attack logs expose no identity", () => {
  const s = p.initialState();
  s.cards = [
    { player: 0, location: 4, sequence: 0, code: 32807846, position: 1,
      counters: {}, materials: [] },
    { player: 1, location: 4, sequence: 2, code: 0, position: 8,
      counters: {}, materials: [] },
  ];
  const expected = structuredClone(s.cards);
  Object.assign(expected[0], { atk: 1900, def: 1200 });
  Object.assign(expected[1], { atk: 1500, def: 2100 });
  p.applyFrame(s, p.packet(1, bytes(111,
    0, 4, 0, 1, u32(1900), u32(1200), 0,
    1, 4, 2, 1, u32(1500), u32(2100), 0)));
  assert.deepEqual(s.cards, expected);
  assert.deepEqual(s.revealed, []);
  p.applyGame(s, bytes(110, 0, 4, 0, 1, 1, 4, 2, 1));
  assert.equal(s.logs.at(-1), "attack:32807846:0:0");
  assert.equal(s.logs.some((line) => line.startsWith("reveal:")), false);
});
test("battle tolerates missing combatants and direct attacks without creating cards", () => {
  const battle = (targetLocation) => bytes(111,
    0, 4, 0, 1, u32(1900), u32(1200), 0,
    1, targetLocation, 2, 4, u32(1500), u32(2100), 0);
  for (const [player, targetLocation, atk, def] of [
    [0, 4, 1900, 1200], // Missing target.
    [1, 4, 1500, 2100], // Missing attacker.
    [0, 0, 1900, 1200], // Direct attack has no target card.
  ]) {
    const s = p.initialState();
    s.cards = [{ player, location: 4, sequence: player ? 2 : 0,
      code: 0, position: 8, counters: {}, materials: [] }];
    const expected = { ...s.cards[0], atk, def };
    p.applyGame(s, battle(targetLocation));
    assert.deepEqual(s.cards, [expected]);
    assert.deepEqual(s.revealed, []);
  }
  const empty = p.initialState();
  p.applyGame(empty, battle(4));
  assert.deepEqual(empty.cards, []);
});
test("attack logs append directness while retaining code positions and hiding known facedown targets", () => {
  for (const player of [0, 1]) {
    for (const seat of [player, 2]) {
      const s = p.initialState();
      s.seat = seat;
      s.cards = [
        { player, location: 4, sequence: 0, code: 32807846, position: 1,
          counters: {}, materials: [] },
        { player: 1 - player, location: 4, sequence: 2, code: 91231901, position: 8,
          counters: {}, materials: [] },
      ];
      p.applyGame(s, bytes(110, player, 4, 0, 1, 1 - player, 4, 2, 1));
      assert.equal(s.logs.at(-1), "attack:32807846:0:0");
      p.applyGame(s, bytes(110, player, 4, 0, 1, 1 - player, 0, 0, 0));
      assert.equal(s.logs.at(-1), "attack:32807846:0:1");
      assert.equal(s.logs.join("\n").includes("91231901"), false);
      assert.equal(s.cards[1].position, 8);
      assert.deepEqual(s.revealed, []);
      s.cards[1].position = 4;
      p.applyGame(s, bytes(110, player, 4, 0, 1, 1 - player, 4, 2, 4));
      assert.deepEqual(s.logs.at(-1).split(":"), ["attack", "32807846", "91231901", "0"]);
      s.cards.pop();
      p.applyGame(s, bytes(110, player, 4, 0, 1, 1 - player, 4, 2, 4));
      assert.equal(s.logs.at(-1), "attack:32807846:0:0");
      assert.equal(s.cards.length, 1);
    }
  }
});
test("battle rejects every truncated payload and trailing bytes before changing state", () => {
  const initial = p.initialState();
  initial.cards = [{ player: 0, location: 4, sequence: 0, code: 32807846,
    position: 1, atk: 1800, def: 1200, counters: {}, materials: [] }];
  const battle = bytes(111,
    0, 4, 0, 1, u32(1900), u32(1200), 0,
    1, 4, 2, 1, u32(1500), u32(2100), 0);
  for (let length = 1; length < battle.length; length++) {
    const s = structuredClone(initial);
    assert.throws(() => p.applyFrame(s, p.packet(1, battle.slice(0, length))), /TRUNCATED_PACKET/);
    assert.deepEqual(s, initial);
  }
  const s = structuredClone(initial);
  assert.throws(() => p.applyGame(s, bytes(battle, 0)), /MESSAGE_LAYOUT_111/);
  assert.deepEqual(s, initial);
});
test("unsupported and truncated gameplay fails closed", () => {
  assert.throws(() => p.applyGame(p.initialState(), bytes(199)), /UNSUPPORTED/);
  assert.throws(() => p.decodePrompt(bytes(15, 0)));
});
test("Question hints lock each viewer independently without changing public grave data", () => {
  const s = p.initialState();
  s.seat = 1;
  s.cards = [0, 1].map((player) => ({ player, location: 16, sequence: 0,
    code: 32807846 + player, position: 1, counters: {}, materials: [] }));
  s.revealed = [91231901];
  const cards = structuredClone(s.cards), revealed = [...s.revealed];
  for (const [player, hintType, expected] of [
    [0, 6, [true, false]],
    [0, 6, [true, false]],
    [1, 6, [true, true]],
    [0, 7, [false, true]],
    [0, 7, [false, true]],
    [1, 7, [false, false]],
  ]) {
    const hint = bytes(165, player, hintType, u32(38723936));
    p.applyFrame(s, p.packet(1, hint));
    assert.deepEqual(s.graveLocked, expected);
    assert.deepEqual(s.cards, cards);
    assert.deepEqual(s.revealed, revealed);
    assert.equal(s.logs.at(-1), `event:165:${Array.from(hint.subarray(1)).join(",")}`);
  }
});
test("Question hints support legacy snapshots and ignore unrelated player hints", () => {
  const s = p.initialState();
  delete s.graveLocked;
  p.applyGame(s, bytes(165, 1, 7, u32(38723936)));
  assert.deepEqual(s.graveLocked, [false, false]);
  delete s.graveLocked;
  p.applyGame(s, bytes(165, 1, 6, u32(38723936)));
  assert.deepEqual(s.graveLocked, [false, true]);
  for (const [hintType, value] of [[6, 123], [7, 123], [1, 38723936], [5, 38723936]]) {
    p.applyGame(s, bytes(165, 1, hintType, u32(value)));
    assert.deepEqual(s.graveLocked, [false, true]);
  }
});
test("grave inspection locks default to false and reset on start and field reload", () => {
  const s = p.initialState();
  assert.deepEqual(s.graveLocked, [false, false]);
  const start = bytes(4, 0, 5, u32(8000), u32(8000), new Uint8Array(8));
  // Each empty player field has 7 monster, 8 spell, 5 pile, and 1 extra-up bytes.
  const emptyField = bytes(u32(8000), new Uint8Array(21));
  const reload = bytes(162, 5, emptyField, emptyField, 0);
  for (const frame of [start, reload]) {
    s.graveLocked = [true, true];
    p.applyFrame(s, p.packet(1, frame));
    assert.deepEqual(s.graveLocked, [false, false]);
  }
});
test("malformed player hints cannot partially change inspection locks", () => {
  const initial = p.initialState();
  initial.graveLocked = [false, true];
  const hint = bytes(165, 1, 7, u32(38723936));
  const invalid = [
    ...Array.from({ length: hint.length - 1 }, (_, i) => hint.slice(0, i + 1)),
    bytes(hint, 0),
    bytes(165, 2, 6, u32(38723936)),
  ];
  for (const frame of invalid) {
    const s = structuredClone(initial);
    assert.throws(() => p.applyGame(s, frame), /TRUNCATED_PACKET|MESSAGE_LAYOUT_165|INVALID_PLAYER/);
    assert.deepEqual(s, initial);
  }
});
test("declarable stack evaluates filters and excludes tokens/aliases", () => {
  const c = {
    code: 123,
    type: 1,
    race: 2,
    attribute: 4,
    alias: 0,
    setCodes: [0x1234],
  };
  assert(p.declarable(c, [1, 0x40000102]));
  assert(p.declarable(c, [0x234, 0x40000101]));
  assert(!p.declarable({ ...c, alias: 456 }, [1]));
  assert(!p.declarable({ ...c, type: 0x4000 }, [1]));
  assert(!p.declarable(c, [0x40000004]));
});
test("masked query segments may contain zero padding; identities and stats are cleared", () => {
  const s = p.initialState();
  p.applyGame(s, bytes(7, 1, 2, 0, u32(16), u32(257), u32(123), u32(1800)));
  p.applyGame(s, bytes(7, 1, 2, 0, u32(16), u32(0), u32(0), u32(0)));
  assert.equal(s.cards[0].code, 0);
  assert.equal(s.cards[0].atk, undefined);
});
test("reserved query flag 0x100000 carries no bytes in the native host", () => {
  const s = p.initialState();
  p.applyGame(s, bytes(7, 0, 4, 0, u32(8), u32(0x100000)));
  assert.equal(s.cards.length, 1);
});
test("engine seat changes preserve displayed player identities across first-player choice", () => {
  const s = p.initialState();
  s.lobbySeat = 1;
  s.lobbyNames = ["Alice", "Bob"];
  p.applyGame(s, bytes(4, 0, 5, u32(8000), u32(8000), 2, 0, 0, 0, 2, 0, 0, 0));
  assert.deepEqual(s.names, ["Bob", "Alice"]);
  assert.equal(s.seat, 0);
});
test("sum greater-than mode allows alternate high values and ignores max zero", () => {
  const q = p.decodePrompt(
    bytes(
      23,
      1,
      0,
      u32(8),
      0,
      0,
      0,
      2,
      short(111),
      u32((5 << 16) | 2),
      short(222),
      u32(4),
    ),
  );
  assert(p.selectionValid(q, [0, 1]));
});
test("grave-deck exchange returns extra monsters and resequences the deck", () => {
  const s = p.initialState();
  const make = (location, sequence, type = 1) => ({
    player: 0,
    location,
    sequence,
    type,
    code: 123,
    position: 1,
    materials: [],
    counters: {},
  });
  s.cards = [
    make(1, 0),
    make(16, 0, 0x40),
    make(16, 1),
    make(16, 2, 0x4000000),
    make(16, 3),
    make(64, 0),
  ];
  p.applyGame(s, bytes(35, 0));
  assert.deepEqual(
    s.cards.filter((c) => c.location === 1).map((c) => c.sequence),
    [0, 1],
  );
  assert.deepEqual(
    s.cards
      .filter((c) => c.location === 64)
      .map((c) => c.sequence)
      .sort(),
    [0, 1, 2],
  );
  assert.equal(s.cards.filter((c) => c.location === 16).length, 1);
});
test("hidden set-card shuffle preserves occupied zones; known permutation swaps objects", () => {
  const s = p.initialState();
  for (let i = 0; i < 2; i++)
    p.applyGame(s, bytes(50, u32(100 + i), 0, 0, 0, 0, 0, 8, i, 2, u32(0)));
  const first = s.cards[0];
  p.applyGame(
    s,
    bytes(36, 8, 2, 0, 8, 0, 2, 0, 8, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0),
  );
  assert.equal(s.cards.length, 2);
  assert.ok(s.cards.every((c) => c.code === 0 && c.location === 8));
  p.applyGame(
    s,
    bytes(36, 8, 2, 0, 8, 0, 2, 0, 8, 1, 2, 0, 8, 1, 2, 0, 8, 0, 2),
  );
  assert.equal(first.sequence, 1);
  assert.deepEqual(s.cards.map((c) => c.sequence).sort(), [0, 1]);
});
test("extra top confirmation skips face-up pendulum cards", () => {
  const s = p.initialState();
  s.cards = [2, 2, 1].map((position, sequence) => ({
    player: 0,
    location: 64,
    sequence,
    position,
    code: 0,
    materials: [],
    counters: {},
  }));
  p.applyGame(s, bytes(42, 0, 1, short(123, 0, 64, 0)));
  assert.equal(s.cards[1].code, 123);
  assert.equal(s.cards[2].code, 0);
});
test("declaration masks retain numeric values for arithmetic opcodes", () => {
  assert.equal(
    p.declarable(
      { code: 1, type: 0x40, race: 1, attribute: 1, alias: 0, setCodes: [] },
      [0x40, 0x40000102, 0x40, 0x40000001, 0x40000007],
    ),
    true,
  );
});
test('hand result exposes both gestures and waits for turn selection',()=>{
 const s=p.initialState();p.applyFrame(s,p.packet(3));
 assert.equal(s.stage,'hand');p.applyFrame(s,p.packet(5,bytes(2,1)));
 assert.deepEqual(s.handResult,[2,1]);assert.equal(s.stage,'waitingTurn');
 p.applyFrame(s,p.packet(4));assert.equal(s.stage,'turn');
 p.applyFrame(s,p.packet(3));assert.equal(s.stage,'hand');
});

test("field masks are relative to selecting player, including extra and pendulum zones", () => {
  for (const player of [0, 1]) {
    for (const message of [18, 24]) {
      for (const bit of [0, 5, 6, 8, 13, 14, 15, 16, 21, 22, 24, 29, 30, 31]) {
        const q = p.decodePrompt(bytes(message, player, 1, u32((~(1 << bit)) >>> 0)));
        assert.equal(q.choices.length, 1);
        assert.deepEqual([...p.encodeSelection(q, [bit])], [bit < 16 ? player : 1-player, bit % 16 < 8 ? 4 : 8, bit % 8]);
      }
    }
  }
});

test("search reveal consumes skip_panel before count and preserves following shuffle", () => {
  for (const skip of [0,1]) for (const player of [0,1]) {
    const s = p.initialState();
    p.applyGame(s,bytes(31,player,skip,2,u32(32807846),player,2,0,u32(91231901),player,2,1));
    assert.deepEqual(s.revealed,[32807846,91231901]);
    assert.equal(s.cards.filter(c=>c.location===2).length,2);
    p.applyGame(s,bytes(32,player));
  }
});

test("selection hint is consumed once and never leaks into command or chain menus", () => {
  const s = p.initialState();
  p.applyGame(s, bytes(2, 3, 0, u32(501)));
  p.applyGame(s, bytes(15, 0, 0, 1, 1, 1, card(123)));
  assert.equal(s.prompt.hint, 501);
  assert.equal(s.hint, 0);
  p.applyGame(s, bytes(2, 3, 0, u32(501)));
  p.applyGame(s, bytes(11, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1));
  assert.equal(s.prompt.hint, 0);
  assert.equal(s.hint, 0);
});

test('victory records the authoritative reason and chain preserves original activation area',()=>{
 const s=p.initialState();p.applyGame(s,bytes(5,1,3));assert.equal(s.winner,1);assert.equal(s.winReason,3);
 p.applyGame(s,bytes(70,u32(123),0,16,0,1,0,2,3,u32(0),1));
 assert.deepEqual(s.chain[0].originRef,{player:0,location:2,sequence:3});
});
test('chain activation reveals the card explicitly identified by the host',()=>{
 const s=p.initialState();s.cards=[{player:1,location:2,sequence:0,code:0,position:0,materials:[],counters:{}}];
 p.applyGame(s,bytes(70,u32(123),1,2,0,1,1,2,0,u32(0),1));assert.equal(s.cards[0].code,123);
});

test('public hand activation and reveal remain inspectable after resolution', () => {
  const s=p.initialState();
  s.cards=[{code:0,player:1,location:2,sequence:0,position:2,materials:[],counters:{}}];
  p.applyFrame(s,p.packet(1,bytes(70,card(32807846,1,2,0,2),1,2,0,u32(0),1)));
  assert.equal(s.cards[0].code,32807846);
  assert(s.logs.includes('activate:32807846:1:1:2'));
  p.applyFrame(s,p.packet(1,bytes(72,1)));
  p.applyFrame(s,p.packet(1,bytes(74)));
  assert(s.logs.includes('chain:72:1:32807846'));
  p.applyFrame(s,p.packet(1,bytes(31,1,0,1,short(89631139,1,2,0))));
  assert.deepEqual(s.revealed,[89631139]);
  assert(s.logs.includes('reveal:89631139:1'));
});
