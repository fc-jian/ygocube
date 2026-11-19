import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { loadState, logEvent, revertTo } from '../src/events/events.service';
import { DraftService } from '../src/draft/draft.service';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';
import { MatchesService } from '../src/matches/matches.service';
import { getDb } from '../src/db';

const fakeSrvpro = { createRoom: async () => ({ ok: true }), roomStatus: async () => ({ ok: false }), closeRoom: async () => ({ ok: true }) };

function setupDraft(n: number, pickSeconds = 30) {
  const tournaments = makeTournaments();
  const cards = new CardsService();
  const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
  // 本文件用例均验证 serial（旧串行）模式行为；passing 模式见 passing.spec.ts
  const tid = tournaments.create({ name: 'd', maxPlayers: n, pickSeconds, cardPool: TEST_POOL, draftMode: 'serial' }, 'test').tid;
  for (let i = 0; i < n; i++) tournaments.join(tid, `p${i}`, `P${i}`);
  draft.startDraft(tid, 'test');
  return { tournaments, cards, draft, tid };
}

describe('draft engine', () => {
  beforeEach(() => useTestDb());

  it('requires every registered player to confirm before an administrator start', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({ name: 'confirm-start', maxPlayers: 2, cardPool: TEST_POOL, draftMode: 'serial' }, 'creator').tid;
    tournaments.join(tid, 'p0', 'P0');
    tournaments.join(tid, 'p1', 'P1');

    const request = draft.requestStartDraft(tid, 'creator');
    expect(request.pending).toBe(true);
    expect(request.confirmedCount).toBe(0);
    expect(loadState(tid).status).toBe('registration');
    expect(() => draft.startDraft(tid, 'legacy-helper')).toThrow('DRAFT_START_PENDING');
    expect(loadState(tid).status).toBe('registration');
    expect(tournaments.stateForPlayer(tid, 'p0').draftStartConfirmation).toMatchObject({ pending: true, confirmed: false, total: 2 });

    const first = draft.confirmDraftStart(tid, 'p0');
    expect(first.pending).toBe(true);
    expect(first.confirmedCount).toBe(1);
    expect(loadState(tid).status).toBe('registration');

    const last = draft.confirmDraftStart(tid, 'p1');
    expect(last.started).toBe(true);
    expect(loadState(tid).status).toBe('drafting');
    expect(loadState(tid).draftStartConfirmation).toBeNull();
    draft.haltAllTimers(tid);
  });

  it('cancels an unconfirmed start request after one minute without creating packs', () => {
    jest.useFakeTimers();
    try {
      const tournaments = makeTournaments();
      const cards = new CardsService();
      const pools = new PoolsService(cards);
      const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
      const tid = tournaments.create({ name: 'confirm-timeout', maxPlayers: 2, cardPool: TEST_POOL, draftMode: 'serial' }, 'creator').tid;
      tournaments.join(tid, 'p0', 'P0');
      tournaments.join(tid, 'p1', 'P1');
      draft.requestStartDraft(tid, 'creator');

      jest.advanceTimersByTime(60_001);
      const state = loadState(tid);
      expect(state.status).toBe('registration');
      expect(state.packs).toHaveLength(0);
      expect(state.draftStartConfirmation).toBeNull();
      expect(() => draft.confirmDraftStart(tid, 'p0')).toThrow('DRAFT_START_NOT_PENDING');
      draft.haltAllTimers(tid);
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates packs of the configured default size and exposes dropped cards (drop_leftover_exact)', () => {
    const { tid, cards } = setupDraft(4);
    const tournaments = makeTournaments();
    const exactTid = tournaments.create({ name: 'dexact', maxPlayers: 4, pickSeconds: 30, cardPool: TEST_POOL, dropMode: 'drop_leftover_exact' }, 'test').tid;
    const { draft } = (() => {
      const cards2 = new CardsService();
      const d = new DraftService(cards2, tournaments, new PoolsService(cards2), new MatchesService(fakeSrvpro as any));
      for (let i = 0; i < 4; i++) tournaments.join(exactTid, `q${i}`, `Q${i}`);
      d.startDraft(exactTid, 'test');
      return { draft: d };
    })();
    void draft;
    const state = loadState(exactTid);
    const cfg = JSON.parse(state.configJson);
    expect(state.packs.length).toBeGreaterThan(0);
    expect(state.packs.length % 4).toBe(0); // exact mode keeps pack count a multiple of player count
    for (const p of state.packs) {
      expect(p.size).toBe(cfg.packSize);
      expect(p.order.length).toBe(p.size); // packs are full-sized (no per-pack drop)
    }
    // leftover pool cards are dropped publicly up front
    expect(Array.isArray(state.droppedCards)).toBe(true);
    const total = state.packs.length * state.packs[0].size + state.droppedCards.length;
    expect(total).toBeLessThanOrEqual(cards.poolCodes().length);
    // dropped list is part of the pool
    const pool = new Set(cards.poolCodes());
    for (const c of state.droppedCards) expect(pool.has(c)).toBe(true);
  });

  it('rotating misser: every player picks the same total number of cards', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // 3 players, 27 canonical cards -> 3 packs of 9 cards = 27 picks total
    const pool = cards.poolCodes().slice(0, 27);
    const p = new PoolsService(cards);
    p.create('eq', pool);
    const tid = tournaments.create({ name: 'eq', maxPlayers: 3, cardPool: 'eq', packSize: 9, draftMode: 'serial' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    // play the whole draft: pick the first remaining card on each turn
    let guard = 0;
    let state = loadState(tid);
    while (state.pickCursor && guard++ < 100) {
      const pack = state.packs.find((p) => p.index === state.pickCursor!.packIndex)!;
      const taken = new Set(state.picks.filter((x) => x.packIndex === pack.index).map((x) => x.card));
      const remaining = pack.order.filter((c) => !taken.has(c));
      draft.pick(tid, state.pickCursor.playerId, remaining[0]);
      state = loadState(tid);
    }
    expect(state.status).toBe('deckbuilding');
    expect(state.picks.length).toBe(27);
    expect(state.droppedCards.length).toBe(0); // 27 divides evenly
    const counts = new Map<string, number>();
    for (const pick of state.picks) counts.set(pick.playerId, (counts.get(pick.playerId) ?? 0) + 1);
    const values = [...counts.values()];
    expect(values.length).toBe(3);
    expect(values.every((v) => v === values[0])).toBe(true); // equal participation
  });

  it('clockwise rotation: orders are 1-2-3, 3-1-2, 2-3-1, 1-2-3 ...', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const p = new PoolsService(cards);
    p.create('rotpool', cards.poolCodes().slice(0, 27));
    const tid = tournaments.create({ name: 'rotpool', maxPlayers: 3, cardPool: 'rotpool', packSize: 9, draftMode: 'serial' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state0 = loadState(tid);
    const seats = state0.players.slice().sort((a, b) => a.seat - b.seat).map((p) => p.playerId);
    // pack 0 round 0 -> seat 0 (1-2-3)
    expect(state0.pickCursor!.playerId).toBe(seats[0]);
    // pick pack0: verify full order 0,1,2,0,1,2,0,1,2 (9 cards, no drop inside pack)
    const order: string[] = [];
    let guard = 0;
    let state = loadState(tid);
    while (state.pickCursor && state.pickCursor.packIndex === 0 && guard++ < 20) {
      order.push(state.pickCursor.playerId);
      const pack = state.packs[0];
      const taken = new Set(state.picks.filter((x) => x.packIndex === 0).map((x) => x.card));
      const remaining = pack.order.filter((c) => !taken.has(c));
      draft.pick(tid, state.pickCursor.playerId, remaining[0]);
      state = loadState(tid);
    }
    expect(order).toEqual([seats[0], seats[1], seats[2], seats[0], seats[1], seats[2], seats[0], seats[1], seats[2]]);
    // pack 1 starts at seat n-1 (3-1-2)
    state = loadState(tid);
    expect(state.pickCursor!.packIndex).toBe(1);
    expect(state.pickCursor!.playerId).toBe(seats[2]);
    // last picker of pack 0 = first picker of pack 1 (consecutive double pick)
    const lastPack0 = state.picks.filter((p) => p.packIndex === 0).at(-1)!.playerId;
    expect(state.pickCursor!.playerId).toBe(lastPack0);
  });

  it('snake rotation: pack advances after the last card; picks alternate direction', () => {
    const { draft, tid } = setupDraft(3);
    let state = loadState(tid);
    const pack0Size = state.packs[0].order.length; // n*3
    for (let i = 0; i < pack0Size; i++) {
      state = loadState(tid);
      const pack = state.packs.find((p) => p.index === state.pickCursor!.packIndex)!;
      const taken = new Set(state.picks.filter((x) => x.packIndex === pack.index).map((x) => x.card));
      const remaining = pack.order.filter((c) => !taken.has(c));
      draft.pick(tid, state.pickCursor!.playerId, remaining[0]);
    }
    state = loadState(tid);
    expect(state.pickCursor!.packIndex).toBe(1);
    expect(state.pickCursor!.round).toBe(0);
    // pack 1 is reversed: first picker is the last seat
    const seats = state.players.slice().sort((a, b) => a.seat - b.seat);
    expect(state.pickCursor!.playerId).toBe(seats[seats.length - 1].playerId);
  });

  it('auto-picks on timeout and records auto_picked', () => {
    jest.useFakeTimers();
    try {
      const { draft, tid } = setupDraft(2, 30);
      const cursor = loadState(tid).pickCursor!;
      jest.advanceTimersByTime(31000);
      const state = loadState(tid);
      const newPick = state.picks.find((p) => p.packIndex === cursor.packIndex && p.round === cursor.round);
      expect(newPick).toBeDefined();
      expect(newPick!.auto).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('picked cards join the left zones (deck) immediately, including auto-picks', () => {
    jest.useFakeTimers();
    try {
      const { draft, tid } = setupDraft(2, 30);
      const state0 = loadState(tid);
      const current = state0.pickCursor!.playerId;
      const deck0 = state0.decks[current];
      expect(deck0.main.length).toBe(0);
      // manual pick: card appears in main or extra by type
      const pack = state0.packs[0];
      const card = pack.order[0];
      draft.pick(tid, current, card);
      let s = loadState(tid);
      const d = s.decks[current];
      const inMain = d.main.includes(card);
      const inExtra = d.extra.includes(card);
      expect(inMain || inExtra).toBe(true);
      // auto pick: also joins the deck
      jest.advanceTimersByTime(31000);
      s = loadState(tid);
      const autoPick = s.picks.filter((p) => p.auto).at(-1);
      expect(autoPick).toBeDefined();
      const dd = s.decks[autoPick!.playerId];
      expect(dd.main.includes(autoPick!.card) || dd.extra.includes(autoPick!.card)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses picks when it is not your turn', () => {
    const { draft, tid } = setupDraft(2);
    const state = loadState(tid);
    const current = state.pickCursor!.playerId;
    const other = state.players.find((p) => p.playerId !== current)!.playerId;
    const pack = state.packs[0];
    expect(() => draft.pick(tid, other, pack.order[0])).toThrow('NOT_YOUR_TURN');
  });

  it('info hiding: stateForPlayer hides pack contents for non-current picker', () => {
    const { tournaments, tid } = setupDraft(3);
    const current = loadState(tid).pickCursor!.playerId;
    const other = tournaments.stateForPlayer(tid, current === 'p0' ? 'p1' : 'p0');
    expect(other.pack!.cards).toBeUndefined();
    expect(other.pack!.cardsLeft).toBeGreaterThan(0);
    const me = tournaments.stateForPlayer(tid, current);
    expect(Array.isArray(me.pack!.cards)).toBe(true);
  });

  it('preserves partial administrator seats and rejects duplicate legacy assignments', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({ name: 'partial-seats', maxPlayers: 3, cardPool: TEST_POOL, draftMode: 'serial' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    logEvent(tid, 'player', 'seat_assign', { p0: 2 }, 'test');
    draft.startDraft(tid, 'test');
    expect(Object.fromEntries(loadState(tid).players.map((player) => [player.playerId, player.seat]))).toEqual({ p0: 2, p1: 0, p2: 1 });

    const badTid = tournaments.create({ name: 'bad-seats', maxPlayers: 3, cardPool: TEST_POOL, draftMode: 'serial' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(badTid, `q${i}`, `Q${i}`);
    logEvent(badTid, 'player', 'seat_assign', { q0: 0, q1: 0 }, 'test');
    expect(() => draft.startDraft(badTid, 'test')).toThrow('BAD_SEAT_ASSIGNMENT');
    expect(loadState(badTid).status).toBe('registration');
  });

  it('pause: only an administrator can freeze and resume the draft', () => {
    const { draft, tid } = setupDraft(3);
    const state = loadState(tid);
    const current = state.pickCursor!.playerId;
    draft.pauseByAdmin(tid, 'creator');
    let s = loadState(tid);
    expect(s.pause!.pausedAt).not.toBeNull();
    expect(s.frozen).toBe(true);
    expect(() => draft.pick(tid, current, 0)).toThrow('FROZEN');
    draft.resumeByAdmin(tid, 'creator');
    s = loadState(tid);
    expect(s.pause).toBeNull();
    expect(s.frozen).toBe(false);
  });
});

describe('deckbuilding timeout crash regression (ROUND_EXISTS kills the process)', () => {
  beforeEach(() => useTestDb());

  it('does not throw when round 1 matches already exist (admin entered matches then rolled back)', () => {
    const { tournaments, draft, tid } = setupDraft(2);
    // 崩溃条件构造：status=deckbuilding + round 1 对阵已存在（管理台先进入对战后又回退到构筑）
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    logEvent(tid, 'tournament', 'phase', { status: 'deckbuilding', round: 0, deadlineAt: new Date(Date.now() + 100000).toISOString() }, 'test');
    logEvent(
      tid, 'match', 'match',
      { id: 1, round: 1, playerA: 'p0', playerB: 'p1', tableNo: 1, roomName: null, playerAPass: null, playerBPass: null, resultA: null, resultB: null, source: null, startedAt: null, finishedAt: null },
      'test',
    );
    // 修复前：deckbuildingTimeout 内 startRound 抛 ROUND_EXISTS 未捕获（定时器回调 = 进程崩溃）；
    // 修复后：不抛异常，比赛进入 matches 阶段
    expect(() => (draft as any).deckbuildingTimeout(tid)).not.toThrow();
    expect(loadState(tid).status).toBe('matches');
  });
});
