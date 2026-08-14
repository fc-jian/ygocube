import { useTestDb, makeTournaments } from './helpers';
import { freeze, hardRevertTo, loadState, resetStateCache, TournamentState, unfreeze } from '../src/events/events.service';
import { DraftService } from '../src/draft/draft.service';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';
import { MatchesService } from '../src/matches/matches.service';
import { getDb } from '../src/db';

const fakeSrvpro = { createRoom: async () => ({ ok: true }), roomStatus: async () => ({ ok: false }), closeRoom: async () => ({ ok: true }) };

// passing（传递式）轮抽：每玩家 FIFO 牌堆队列，按轮发堆，队首堆选 1 张后顺时针传递（dev_docs/05 §3）
function setupPassing(name: string, n: number, poolSize: number, packSize: number, extra: Record<string, unknown> = {}) {
  const tournaments = makeTournaments();
  const cards = new CardsService();
  const pools = new PoolsService(cards);
  pools.create(name, cards.poolCodes().slice(0, poolSize));
  const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
  const tid = tournaments.create({ name, maxPlayers: n, cardPool: name, packSize, ...extra }, 'test').tid;
  for (let i = 0; i < n; i++) tournaments.join(tid, `p${i}`, `P${i}`);
  draft.startDraft(tid, 'test');
  return { tournaments, cards, draft, tid };
}

function seatsOf(state: TournamentState): string[] {
  return state.players.slice().sort((a, b) => a.seat - b.seat).map((p) => p.playerId);
}

function remainingOf(state: TournamentState, packIndex: number): number[] {
  const pack = state.packs.find((p) => p.index === packIndex)!;
  const taken = new Set(state.picks.filter((x) => x.packIndex === packIndex).map((x) => x.card));
  return pack.order.filter((c) => !taken.has(c));
}

// 所有有堆玩家各随机选 1 张；返回本轮实际操作次数
function driveOnce(draft: DraftService, tid: number): number {
  let acted = 0;
  let state = loadState(tid);
  for (const p of state.players) {
    const q = state.packQueues[p.playerId] ?? [];
    if (!q.length) continue;
    const remaining = remainingOf(state, q[0]);
    draft.pick(tid, p.playerId, remaining[Math.floor(Math.random() * remaining.length)]);
    acted++;
    state = loadState(tid);
  }
  return acted;
}

describe('passing draft: round-based dealing', () => {
  beforeEach(() => useTestDb());

  it('only round 0 is dealt initially; next round is dealt only after the round fully drains', () => {
    // 3 人 54 卡 packSize 9 → 6 堆 = 2 整轮
    const { draft, tid } = setupPassing('pq', 3, 54, 9, { reseatEachRound: false });
    const state = loadState(tid);
    const seats = seatsOf(state);
    expect(state.packs.length).toBe(6);
    expect(state.packsDealt).toBe(3); // 只发了第 0 轮
    expect(state.pickCursor).toBeNull(); // passing 不用全局光标
    for (let k = 0; k < 3; k++) expect(state.packQueues[seats[k]]).toEqual([k]);
    for (const pid of seats) expect(state.pickDeadlines[pid]).not.toBeNull();
    // 打完第 0 轮（27 张）：中途不得发新堆
    let picks = 0;
    while (loadState(tid).packsDealt === 3 && picks < 27) {
      driveOnce(draft, tid);
      picks = loadState(tid).picks.length;
    }
    expect(picks).toBe(27);
    const s2 = loadState(tid);
    expect(s2.packsDealt).toBe(6); // 第 1 轮已发
    for (let k = 0; k < 3; k++) expect(s2.packQueues[seats[k]]).toEqual([3 + k]);
    // 打完进入构筑
    while (loadState(tid).status === 'drafting') driveOnce(draft, tid);
    const s3 = loadState(tid);
    expect(s3.status).toBe('deckbuilding');
    expect(s3.picks.length).toBe(54);
  });

  it('partial last round (evenPackCount off) is dealt to random DISTINCT players', () => {
    // 3 人 45 卡 packSize 9 → 5 堆：第 0 轮 3 堆 + 残轮 2 堆
    const { draft, tid } = setupPassing('pq2', 3, 45, 9, { evenPackCount: false });
    let state = loadState(tid);
    expect(state.packs.length).toBe(5);
    expect(state.packsDealt).toBe(3);
    // 打完第 0 轮
    while (loadState(tid).packsDealt === 3) driveOnce(draft, tid);
    state = loadState(tid);
    expect(state.packsDealt).toBe(5);
    const lengths = seatsOf(state).map((pid) => state.packQueues[pid].length).sort();
    expect(lengths).toEqual([0, 1, 1]); // 残轮 2 堆分给 2 名互斥玩家
    const allQueued = Object.values(state.packQueues).flat();
    expect(allQueued.slice().sort((a, b) => a - b)).toEqual([3, 4]);
    // 打完残轮进构筑：共 45 次选牌
    while (loadState(tid).status === 'drafting') driveOnce(draft, tid);
    expect(loadState(tid).picks.length).toBe(45);
  });

  it('pick passes the pack to the next clockwise seat; exhausted pack dies', () => {
    // 2 人 4 卡 packSize 2 → 2 堆（1 轮）
    const { draft, tid } = setupPassing('pp', 2, 4, 2);
    let state = loadState(tid);
    const seats = seatsOf(state);
    const [a, b] = seats;
    expect(state.packQueues[a]).toEqual([0]);
    expect(state.packQueues[b]).toEqual([1]);
    // A 从堆 0 选 1 张（还剩 1 张）→ 堆 0 传给 B 的队尾
    draft.pick(tid, a, remainingOf(loadState(tid), 0)[0]);
    state = loadState(tid);
    expect(state.packQueues[a]).toEqual([]);
    expect(state.packQueues[b]).toEqual([1, 0]);
    expect(state.pickDeadlines[a]).toBeNull(); // 无堆可选，不计时
    // A 队列空：再选报 NOT_YOUR_TURN
    expect(() => draft.pick(tid, a, 0)).toThrow('NOT_YOUR_TURN');
    // B 选堆 1 第一张 → 堆 1 传给 A
    draft.pick(tid, b, remainingOf(loadState(tid), 1)[0]);
    state = loadState(tid);
    expect(state.packQueues[a]).toEqual([1]);
    expect(state.packQueues[b]).toEqual([0]);
    // A 选堆 1 的最后一张 → 空堆消亡，不再传递
    draft.pick(tid, a, remainingOf(loadState(tid), 1)[0]);
    state = loadState(tid);
    expect(state.packQueues[a]).toEqual([]);
    expect(state.packQueues[b]).toEqual([0]);
  });

  it('full random draft ends in deckbuilding; every card picked exactly once', () => {
    // 3 人 54 卡 packSize 9 → 2 轮共 54 次选牌
    const { draft, tid } = setupPassing('pc', 3, 54, 9);
    let guard = 0;
    while (loadState(tid).status === 'drafting' && guard++ < 200) driveOnce(draft, tid);
    const state = loadState(tid);
    expect(state.status).toBe('deckbuilding');
    expect(state.picks.length).toBe(54);
    expect(new Set(state.picks.map((p) => p.card)).size).toBe(54);
    expect(state.phaseDeadline).toBeNull();
    // 整轮 ×2：每人 18 张
    for (const p of state.players) {
      expect(state.picks.filter((x) => x.playerId === p.playerId).length).toBe(18);
      const deck = state.decks[p.playerId];
      expect(deck.main.length + deck.extra.length + deck.side.length).toBe(18);
    }
  });

  it('arbitrary pack size is fair when pack count is a player-count multiple, and reports cards remaining', () => {
    // 3 players, 6 packs of 8: two complete rounds, so each player gets 16 cards.
    const { tournaments, draft, tid } = setupPassing('any-pack-size', 3, 48, 8, { reseatEachRound: false });
    const seats = seatsOf(loadState(tid));
    let view = tournaments.stateForPlayer(tid, seats[0]);
    expect(view.cardsRemainingExact).toBe(true);
    expect(view.cardsRemainingToDraft).toBe(16);
    draft.pick(tid, seats[0], remainingOf(loadState(tid), 0)[0]);
    view = tournaments.stateForPlayer(tid, seats[0]);
    expect(view.cardsRemainingToDraft).toBe(15);
    while (loadState(tid).status === 'drafting') driveOnce(draft, tid);
    for (const pid of seats) expect(loadState(tid).picks.filter((p) => p.playerId === pid)).toHaveLength(16);
  });

  it('event replay reproduces queues/deadlines/reserves/dealt exactly', () => {
    const { draft, tid } = setupPassing('pr', 3, 54, 9);
    for (let i = 0; i < 7; i++) driveOnce(draft, tid);
    const live = loadState(tid);
    const snapOf = (s: TournamentState) =>
      JSON.stringify({ queues: s.packQueues, deadlines: s.pickDeadlines, reserves: s.pickReserves, dealt: s.packsDealt, picks: s.picks, decks: s.decks });
    const snapshot = snapOf(live);
    resetStateCache();
    expect(snapOf(loadState(tid))).toBe(snapshot);
  });
});

describe('passing draft: evenPackCount', () => {
  beforeEach(() => useTestDb());

  it('explicit packCount not a multiple of players is rejected', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    pools.create('ev', cards.poolCodes().slice(0, 60));
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({ name: 'ev', maxPlayers: 3, cardPool: 'ev', packSize: 9, packCount: 4 }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    expect(() => draft.startDraft(tid, 'test')).toThrow('PACKCOUNT_NOT_MULTIPLE');
    expect(loadState(tid).status).toBe('registration'); // 未进入选牌
  });

  it('auto packCount rounds down to a multiple of players when evenPackCount is on', () => {
    // 3 人 45 卡 packSize 9：floor=5 → 取整为 3；余下 18 张按 drop 规则公开
    const { tid } = setupPassing('ev2', 3, 45, 9, { dropPublic: true });
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(45 - 27);
  });

  it('evenPackCount off keeps the un-rounded count', () => {
    const { tid } = setupPassing('ev3', 3, 45, 9, { evenPackCount: false });
    expect(loadState(tid).packs.length).toBe(5);
  });
});

describe('passing draft: explicit packCount inference', () => {
  beforeEach(() => useTestDb());

  it('packCount <= floor(pool/packSize): fixed count, remaining pool discarded', () => {
    // 3 人 54 卡 packSize 9：上限 maxFull=6，显式 3 → 固定 3 堆，弃置 54-27=27
    const { tid } = setupPassing('pc1', 3, 54, 9, { packCount: 3, dropPublic: true });
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(27);
  });

  it('packCount > floor(pool/packSize) with evenPackCount off: use-all, ceil count, no drops', () => {
    // 3 人 44 卡 packSize 9：maxFull=4，显式 5 > 4 → 用尽卡池 ceil(44/9)=5 堆，末堆 8 张，不弃置
    const { tid } = setupPassing('pc2', 3, 44, 9, { packCount: 5, evenPackCount: false });
    const state = loadState(tid);
    expect(state.packs.length).toBe(5);
    expect(state.packs[4].size).toBe(8); // 末堆可不满
    expect(state.droppedCards.length).toBe(0);
  });

  it('packCount > floor(pool/packSize) with evenPackCount on: use-all then rounds down to a multiple', () => {
    // 3 人 45 卡 packSize 9：maxFull=5，显式 6 > 5 → ceil=5，再向下取整到 3，弃置 45-27=18
    const { tid } = setupPassing('pc3', 3, 45, 9, { packCount: 6, dropPublic: true });
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(18);
  });
});

describe('passing draft: reserve time', () => {
  beforeEach(() => useTestDb());

  it('overrun deducts from reserve first; auto-pick only after reserve is exhausted', () => {
    jest.useFakeTimers();
    try {
      // pickSeconds 1s + reserve 5s
      const { draft, tid } = setupPassing('rs', 3, 27, 9, { pickSeconds: 1, reserveSeconds: 5 });
      void draft;
      // 1.5s：基础时间已过，但 reserve 未耗尽 → 无自动选
      jest.advanceTimersByTime(1500);
      expect(loadState(tid).picks.length).toBe(0);
      // 到 6.5s：reserve 也耗尽 → 三人各自动选 1 张
      jest.advanceTimersByTime(5000);
      const state = loadState(tid);
      const autos = state.picks.filter((p) => p.auto);
      expect(autos.length).toBe(3);
      expect(new Set(autos.map((p) => p.playerId)).size).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('partial reserve usage keeps the remainder (no refresh)', () => {
    jest.useFakeTimers();
    try {
      const { draft, tid } = setupPassing('rs2', 2, 8, 4, { pickSeconds: 10, reserveSeconds: 100 });
      const seats = seatsOf(loadState(tid));
      const me = seats[0];
      // 12.5s 后手动选（基础 10s + 用了 2.5s reserve）
      jest.advanceTimersByTime(12500);
      draft.pick(tid, me, remainingOf(loadState(tid), loadState(tid).packQueues[me][0])[0]);
      let state = loadState(tid);
      expect(state.pickReserves[me]).toBe(97500); // 100s - 2.5s
      // 新 deadline = now + 10s + 97.5s；对手超时点不受影响（自己的 reserve 独立）
      expect(state.pickReserves[seats[1]]).toBe(100000);
      // 再推进 10.5s：我又在 reserve 中（剩 97s），不自动选
      jest.advanceTimersByTime(10500);
      state = loadState(tid);
      expect(state.picks.filter((p) => p.playerId === me && p.auto).length).toBe(0);
      void state;
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the player\'s last clicked alternative when the timer auto-picks', () => {
    jest.useFakeTimers();
    try {
      const { draft, tid } = setupPassing('alternative-timeout', 2, 8, 4, { pickSeconds: 1, reserveSeconds: 0 });
      const state = loadState(tid);
      const playerId = seatsOf(state)[0];
      const packIndex = state.packQueues[playerId][0];
      const alternative = remainingOf(state, packIndex)[2];
      draft.setPickAlternative(tid, playerId, alternative, playerId);
      jest.advanceTimersByTime(1100);
      const picked = loadState(tid).picks.find((p) => p.playerId === playerId);
      expect(picked?.auto).toBe(true);
      expect(picked?.card).toBe(alternative);
      expect(loadState(tid).pickAlternatives?.[playerId]).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reverting restores the reserve balance from the selected event branch', () => {
    const { draft, tid } = setupPassing('reserve-revert', 2, 8, 4, { reserveSeconds: 100 });
    const playerId = seatsOf(loadState(tid))[0];
    draft.addReserveSeconds(tid, playerId, 30, 'admin');
    const db = getDb();
    const target = (db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid) as { seq: number }).seq;
    draft.addReserveSeconds(tid, playerId, 40, 'admin');
    expect(loadState(tid).pickReserves[playerId]).toBe(170000);
    const result = hardRevertTo(tid, target, 'admin');
    expect(result.state.pickReserves[playerId]).toBe(130000);
    resetStateCache();
    expect(loadState(tid).pickReserves[playerId]).toBe(130000);
  });
});

describe('passing draft: timers, pause, admin transitions', () => {
  beforeEach(() => useTestDb());

  it('per-player timeout auto-picks independently (reserveSeconds=0)', () => {
    jest.useFakeTimers();
    try {
      const { tid } = setupPassing('pt', 3, 27, 9, { pickSeconds: 30, reserveSeconds: 0 });
      jest.advanceTimersByTime(31000);
      const state = loadState(tid);
      // 三名玩家各有队首堆 → 各自动选 1 张
      const autos = state.picks.filter((p) => p.auto);
      expect(autos.length).toBe(3);
      expect(new Set(autos.map((p) => p.playerId)).size).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('majority pause freezes immediately; resume preserves exact per-player time', () => {
    jest.useFakeTimers();
    try {
      const { tournaments, draft, tid } = setupPassing('ppz', 3, 27, 9, { pickSeconds: 30, reserveSeconds: 0 });
      const state = loadState(tid);
      const seats = seatsOf(state);
      jest.advanceTimersByTime(10000);
      draft.proposePause(tid, seats[0]);
      draft.votePause(tid, seats[1], true); // 2/3 过半
      let s = loadState(tid);
      expect(s.pause!.pausedAt).not.toBeNull(); // passing 立即暂停（无需等选牌）
      expect(s.pause!.pausedDeadlines).toBeDefined();
      expect(Object.keys(s.pause!.pausedDeadlines!).length).toBe(3);
      for (const ms of Object.values(s.pause!.pausedDeadlines!)) expect(ms).toBe(20000);
      const pausedView = tournaments.stateForPlayer(tid, seats[0]);
      expect((pausedView.pack as any).deadlineAt).toBeNull();
      expect((pausedView.pack as any).pausedRemainingMs).toBe(20000);
      expect(() => draft.pick(tid, seats[0], remainingOf(loadState(tid), 0)[0])).toThrow('PAUSED');
      // 暂停期间计时器冻结：推进 60s 也不会有自动选牌
      jest.advanceTimersByTime(60000);
      expect(loadState(tid).picks.length).toBe(0);
      // 注意：pauseExpired 会自动恢复（pauseSeconds 默认 300s > 60s，此处未触发）
      draft.resume(tid, seats[0]);
      s = loadState(tid);
      expect(s.pause).toBeNull();
      for (const pid of seats) expect(s.pickDeadlines[pid]).not.toBeNull();
      // 恢复后仍只有暂停前剩下的 20s，而不是重置成完整 30s。
      jest.advanceTimersByTime(19000);
      expect(loadState(tid).picks.length).toBe(0);
      jest.advanceTimersByTime(2000);
      expect(loadState(tid).picks.filter((p) => p.auto).length).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('admin freeze preserves exact passing countdown instead of consuming or resetting it', () => {
    jest.useFakeTimers();
    try {
      const { draft, tid } = setupPassing('admin-freeze', 3, 27, 9, { pickSeconds: 30, reserveSeconds: 0 });
      jest.advanceTimersByTime(7000);
      draft.freezeTimers(tid);
      freeze(tid, 'test');
      const frozen = loadState(tid);
      for (const ms of Object.values(frozen.frozenTimers!.passing!)) expect(ms).toBe(23000);
      jest.advanceTimersByTime(60000);
      expect(loadState(tid).picks.length).toBe(0);
      unfreeze(tid);
      draft.resumeFrozenTimers(tid);
      jest.advanceTimersByTime(22000);
      expect(loadState(tid).picks.length).toBe(0);
      jest.advanceTimersByTime(2000);
      expect(loadState(tid).picks.filter((p) => p.auto).length).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('admin deckbuilding request pends until the round drains (no extra deal)', () => {
    // 3 人 54 卡 packSize 9 → 6 堆，开局只发第 0 轮（3 堆）
    const { tournaments, draft, tid } = setupPassing('pe', 3, 54, 9);
    // 本轮未选完：置 pendingPhase，不立即切换
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    let state = loadState(tid);
    expect(state.status).toBe('drafting');
    expect(state.pendingPhase).toBe('deckbuilding');
    expect(state.packsDealt).toBe(3);
    // 打完本轮 → 进入构筑，且不发下一轮
    while (loadState(tid).status === 'drafting') driveOnce(draft, tid);
    state = loadState(tid);
    expect(state.status).toBe('deckbuilding');
    expect(state.pendingPhase).toBeNull();
    expect(state.packsDealt).toBe(3); // 未发第 1 轮
    expect(state.picks.length).toBe(27);
    const deals = getDb()
      .prepare("SELECT COUNT(*) AS c FROM events WHERE tournament_id=? AND entity='draft' AND action='deal'")
      .get(tid) as { c: number };
    expect(deals.c).toBe(0);
  });

  it('admin deckbuilding request with all queues empty enters immediately; rollback keeps state', () => {
    // 3 人 27 卡 packSize 9 → 3 堆一轮；自然选完进构筑后回退，再请求时队列已空 → 立即切换
    const { tournaments, draft, tid } = setupPassing('pe2', 3, 27, 9);
    while (loadState(tid).status === 'drafting') driveOnce(draft, tid);
    expect(loadState(tid).status).toBe('deckbuilding');
    // 回退到选牌：队列（已空）保留，不产生 serial 光标
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    let state = loadState(tid);
    expect(state.status).toBe('drafting');
    expect(state.pickCursor).toBeNull();
    // 队列全空：再次请求立即进入构筑（无 pending）
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    state = loadState(tid);
    expect(state.status).toBe('deckbuilding');
    expect(state.pendingPhase).toBeNull();
  });
});

describe('passing draft: player-facing state', () => {
  beforeEach(() => useTestDb());

  it('stateForPlayer: own head pack visible, queue lengths and reserve exposed', () => {
    const { tournaments, draft, tid } = setupPassing('ps', 3, 27, 9, { reserveSeconds: 300 });
    const state = loadState(tid);
    const seats = seatsOf(state);
    const me = tournaments.stateForPlayer(tid, seats[0]);
    const mePack = me.pack as any;
    expect(mePack).not.toBeNull();
    expect(mePack.isMyTurn).toBe(true);
    expect(mePack.queueLength).toBe(1);
    expect(mePack.reserveMs).toBe(300000);
    expect(Array.isArray(mePack.cards)).toBe(true);
    expect(mePack.cards.length).toBe(9);
    // 只能看到自己队首堆（堆 0），看不到别人队列里的堆内容
    expect(mePack.index).toBe(0);
    expect(me.queueLengths).toEqual(seats.map((pid) => ({ playerId: pid, length: 1 })));
    // 其他玩家视角同理：看到的是他们自己的队首堆
    const other = tournaments.stateForPlayer(tid, seats[1]);
    expect((other.pack as any).index).toBe(1);
    // After picking before the previous seat has passed a pack to us, our
    // queue is temporarily empty; the reserve bank must still be visible.
    draft.pick(tid, seats[0], mePack.cards[0]);
    const waiting = tournaments.stateForPlayer(tid, seats[0]);
    expect(waiting.pack).toBeNull();
    expect(waiting.draftReserveMs).toBe(300000);
  });
});

  it('reseatEachRound (default): seats are reshuffled before the next round is dealt', () => {
    const { tournaments, draft, tid } = setupPassing('res1', 3, 54, 9);
    const initial = seatsOf(loadState(tid));
    let picks = 0;
    while (loadState(tid).packsDealt === 3 && picks < 27) {
      driveOnce(draft, tid);
      picks = loadState(tid).picks.length;
    }
    const s2 = loadState(tid);
    expect(s2.packsDealt).toBe(6);
    // 第二轮发堆前必须发生第二次 seat_assign（每轮随机重排，默认开）
    const nSeats = getDb().prepare('SELECT COUNT(*) c FROM events WHERE tournament_id=? AND action=?').get(tid, 'seat_assign') as { c: number };
    expect(nSeats.c).toBe(2);
    // 座位仍是 0..n-1 全排列（重排不丢人）；第二轮堆 k 发给座位 k 的玩家
    const after = seatsOf(s2);
    expect(after.length).toBe(3);
    const view = tournaments.stateForPlayer(tid, after[0]);
    expect(view.players.map((p) => p.playerId)).toEqual(after);
    expect(view.queueLengths!.map((q) => q.playerId)).toEqual(after);
    for (const [pid, q] of Object.entries(s2.packQueues)) {
      const seat = s2.players.find((p) => p.playerId === pid)!.seat;
      expect(q).toEqual([3 + seat]);
    }
    void initial;
  });

  it('reseatEachRound=false keeps seats for later rounds', () => {
    const { draft, tid } = setupPassing('res2', 3, 54, 9, { reseatEachRound: false });
    const initial = seatsOf(loadState(tid));
    let picks = 0;
    while (loadState(tid).packsDealt === 3 && picks < 27) {
      driveOnce(draft, tid);
      picks = loadState(tid).picks.length;
    }
    const s2 = loadState(tid);
    expect(s2.packsDealt).toBe(6);
    expect(seatsOf(s2)).toEqual(initial);
    const nSeats = getDb().prepare('SELECT COUNT(*) c FROM events WHERE tournament_id=? AND action=?').get(tid, 'seat_assign') as { c: number };
    expect(nSeats.c).toBe(1); // 只有 startDraft 的初始分配
  });
