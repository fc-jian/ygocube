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
test("unsupported and truncated gameplay fails closed", () => {
  assert.throws(() => p.applyGame(p.initialState(), bytes(199)), /UNSUPPORTED/);
  assert.throws(() => p.decodePrompt(bytes(15, 0)));
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
