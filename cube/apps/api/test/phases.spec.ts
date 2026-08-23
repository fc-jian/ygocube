import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { freeze, loadState, logEvent, unfreeze } from '../src/events/events.service';
import { DraftService } from '../src/draft/draft.service';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';
import { MatchesService } from '../src/matches/matches.service';

const fakeSrvpro = { createRoom: async () => ({ ok: true }), roomStatus: async () => ({ ok: false }), closeRoom: async () => ({ ok: true }) };

function setup(n: number) {
  const tournaments = makeTournaments();
  const cards = new CardsService();
  const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
  // serial 模式：本文件部分用例依赖 pickCursor 语义（passing 见 passing.spec.ts）
  const tid = tournaments.create({ name: 'ph', maxPlayers: n, pickSeconds: 30, cardPool: TEST_POOL, draftMode: 'serial' }, 'test').tid;
  for (let i = 0; i < n; i++) tournaments.join(tid, `p${i}`, `P${i}`);
  return { tournaments, draft, tid };
}

describe('phase rules', () => {
  beforeEach(() => useTestDb());

  it('registration cannot jump straight into deckbuilding', () => {
    const { tournaments, tid } = setup(3);
    expect(() => tournaments.setPhase(tid, 'deckbuilding', undefined, 'test')).toThrow('DRAFT_NOT_STARTED');
  });

  it('manual deckbuilding mid-pack: waits for the CURRENT PACK to finish, then preserves progress', () => {
    const { tournaments, draft, tid } = setup(3);
    draft.startDraft(tid, 'test');
    let state = loadState(tid);
    const pack0Size = state.packs[0].order.length;
    // admin requests deckbuilding mid-pack
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    state = loadState(tid);
    expect(state.pendingPhase).toBe('deckbuilding');
    expect(state.status).toBe('drafting'); // waits for the pack
    // finish the current pack -> transition to deckbuilding
    for (let i = 0; i < pack0Size; i++) {
      state = loadState(tid);
      const pack = state.packs.find((p) => p.index === state.pickCursor!.packIndex)!;
      const taken = new Set(state.picks.filter((x) => x.packIndex === pack.index).map((x) => x.card));
      const remaining = pack.order.filter((c) => !taken.has(c));
      draft.pick(tid, state.pickCursor!.playerId, remaining[0]);
    }
    state = loadState(tid);
    expect(state.status).toBe('deckbuilding');
    expect(state.pendingPhase).toBeNull();
    // progress preserved: cursor positioned at the next pack start
    expect(state.pickCursor!.packIndex).toBe(1);
    expect(state.pickCursor!.round).toBe(0);
    expect(state.phaseDeadline).toBeNull(); // default deckbuilding is unlimited
    // rollback: resume drafting from the preserved cursor
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    state = loadState(tid);
    expect(state.status).toBe('drafting');
    expect(state.pickCursor!.packIndex).toBe(1);
    expect(state.pickCursor!.round).toBe(0);
    expect(state.phaseDeadline).toBeNull();
  });

  it('dropMode=use_all: pack count need not divide; last pack may be short', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // 29 cards, 3 players, x3 -> 9 per pack; use_all: 4 packs, last has 2
    const pool = cards.poolCodes().slice(0, 29);
    const p = new PoolsService(cards);
    p.create('nodrop', pool);
    const tid = tournaments.create({ name: 'nodrop', maxPlayers: 3, cardPool: 'nodrop', dropMode: 'use_all', packSize: 9, evenPackCount: false }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(4);
    expect(state.packs[0].order.length).toBe(9);
    expect(state.packs[3].order.length).toBe(2);
    expect(state.droppedCards.length).toBe(0);
  });

  it('dropMode=drop_leftover: only the remainder is dropped, no multiple-of-n requirement', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // 31 cards, 3 players, x3 -> 9 per pack: floor(31/9)=3 packs (27 cards), 4 dropped, no multiple-of-3 trimming
    const pool = cards.poolCodes().slice(0, 31);
    const p = new PoolsService(cards);
    p.create('dropleft', pool);
    const tid = tournaments.create({ name: 'dropleft', maxPlayers: 3, cardPool: 'dropleft', dropMode: 'drop_leftover', packSize: 9, dropPublic: true }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(4);
  });

  it('dropMode=drop_leftover_exact: dropped remainder AND pack count is a multiple of players', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const pool = cards.poolCodes().slice(0, 35); // floor(35/9)=3, 3%3=0 -> 3 packs (27), 8 dropped
    const p = new PoolsService(cards);
    p.create('dropexact', pool);
    const tid = tournaments.create({ name: 'dropexact', maxPlayers: 3, cardPool: 'dropexact', dropMode: 'drop_leftover_exact', packSize: 9, dropPublic: true }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(8);
    // 32 cards: floor(32/9)=3, 3%3=0 -> still 3 packs; 34 cards: floor=3, 3%3=0
    // 用 38 张验证 trim：floor(38/9)=4, 4%3=1 -> 3 packs (27), 11 dropped
    p.create('dropexact2', cards.poolCodes().slice(0, 38));
    const tid2 = tournaments.create({ name: 'dropexact2', maxPlayers: 3, cardPool: 'dropexact2', dropMode: 'drop_leftover_exact', packSize: 9, dropPublic: true }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid2, `p${i}`, `P${i}`);
    draft.startDraft(tid2, 'test');
    const s2 = loadState(tid2);
    expect(s2.packs.length).toBe(3);
    expect(s2.droppedCards.length).toBe(38 - 27);
  });

  it('legacy dropLeftover=false maps to use_all (config compat)', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'legacy', maxPlayers: 3, cardPool: TEST_POOL, dropLeftover: false }, 'test').tid;
    void tid;
    // 仅验证 create 时的映射：config 里 dropMode 应为 use_all
    const row = require('../src/db').getDb().prepare('SELECT config_json FROM tournaments WHERE id=?').get(tid) as { config_json: string };
    const cfg = JSON.parse(row.config_json);
    expect(cfg.dropMode).toBe('use_all');
  });

  it('deckbuilding is unlimited by default and retains an explicit deadline option', () => {
    const { tournaments, tid } = setup(3);
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    expect(loadState(tid).phaseDeadline).toBeNull();

    const finite = makeTournaments();
    const finiteTid = finite.create({ name: 'finite', maxPlayers: 3, cardPool: TEST_POOL, deckbuildingSeconds: 120 }, 'test').tid;
    for (let i = 0; i < 3; i++) finite.join(finiteTid, `f${i}`, `F${i}`);
    finite.setPhase(finiteTid, 'drafting', undefined, 'test');
    finite.setPhase(finiteTid, 'deckbuilding', undefined, 'test');
    const finiteState = loadState(finiteTid);
    expect(finiteState.phaseDeadline).not.toBeNull();
    expect(new Date(finiteState.phaseDeadline!).getTime()).toBeGreaterThan(Date.now());
  });

  it('admin freeze preserves a finite deckbuilding countdown exactly', () => {
    jest.useFakeTimers();
    try {
      const { tournaments, draft, tid } = setup(3);
      tournaments.updateConfig(tid, { deckbuildingSeconds: 120 }, 'test');
      tournaments.setPhase(tid, 'drafting', undefined, 'test');
      tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
      jest.advanceTimersByTime(20000);
      draft.freezeTimers(tid);
      freeze(tid, 'test');
      expect(loadState(tid).frozenTimers!.deckbuilding).toBe(100000);
      jest.advanceTimersByTime(60000);
      expect(loadState(tid).status).toBe('deckbuilding');
      unfreeze(tid);
      draft.resumeFrozenTimers(tid);
      const left = new Date(loadState(tid).phaseDeadline!).getTime() - Date.now();
      expect(left).toBe(100000);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('player membership', () => {
  beforeEach(() => useTestDb());

  it('stateForPlayer rejects players who did not join', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'm', maxPlayers: 3, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'a', 'A');
    expect(() => tournaments.stateForPlayer(tid, 'stranger')).toThrow('PLAYER_NOT_FOUND');
  });
});

describe('snapshot replay with shared global event seq', () => {
  beforeEach(() => useTestDb());

  it('replaying after a snapshot does not duplicate players when other tournaments own earlier seqs', () => {
    const tournaments = makeTournaments();
    const { getDb } = require('../src/db');
    // 另一个比赛先占用全局事件 seq（模拟生产环境多比赛共享全局自增）
    const other = tournaments.create({ name: 'other', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    for (let i = 0; i < 55; i++) logEvent(other, 'tournament', 'config', { noise: i }, 'test');
    // 目标比赛：写满 100+ 事件以触发快照（maybeSnapshot 每 100 事件一次）
    const tid = tournaments.create({ name: 'snap', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    for (let i = 0; i < 4; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    const { logEvent: log } = require('../src/events/events.service');
    // 触发快照：事件计数到 100（4 join + 96 条杂项）
    for (let i = 0; i < 96; i++) log(tid, 'tournament', 'config', { noise: i }, 'test');
    const snaps = getDb().prepare('SELECT seq, event_seq FROM tournament_snapshots WHERE tournament_id=?').all(tid);
    expect(snaps.length).toBe(1);
    expect(snaps[0].event_seq).toBeGreaterThan(snaps[0].seq); // 全局 seq 与相对计数不同
    // 清除缓存强制从事件重放（模拟重启）
    const { resetStateCache } = require('../src/events/events.service');
    resetStateCache();
    const state = loadState(tid);
    expect(state.players.map((p) => p.playerId).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('legacy snapshots without event_seq are ignored (no double replay)', () => {
    const tournaments = makeTournaments();
    const { getDb } = require('../src/db');
    const tid = tournaments.create({ name: 'legacy-snap', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    for (let i = 0; i < 4; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    // 手工插入一条旧格式快照（event_seq 为 NULL，seq 为相对计数）
    const st = loadState(tid);
    getDb()
      .prepare('INSERT INTO tournament_snapshots (tournament_id, seq, event_seq, state_json, created_at) VALUES (?,?,?,?,?)')
      .run(tid, 4, null, JSON.stringify(st), new Date().toISOString());
    const { resetStateCache } = require('../src/events/events.service');
    resetStateCache();
    const state = loadState(tid);
    expect(state.players.map((p) => p.playerId).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
  });
});

describe('pack strategy', () => {
  beforeEach(() => useTestDb());

  function setupPool(codes: number[]): string {
    const cards = new CardsService();
    const p = new PoolsService(cards);
    p.create('stratpool', codes);
    return 'stratpool';
  }

  it('main_then_extra: all main cards precede all extra cards across packs', () => {
    const cards = new CardsService();
    const all = cards.poolCodes();
    // 取 10 张主卡 + 4 张额外卡
    const mainCodes = all.filter((c) => (cards.get(c)!.type & 0x4802040) === 0).slice(0, 10);
    const extraCodes = all.filter((c) => (cards.get(c)!.type & 0x4802040) !== 0).slice(0, 4);
    const pool = [...mainCodes, ...extraCodes];
    const tournaments = makeTournaments();
    const p = new PoolsService(cards);
    p.create('mte', pool);
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({ name: 'mte', maxPlayers: 3, cardPool: 'mte', dropMode: 'use_all', packStrategy: 'main_then_extra' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    const flat = state.packs.flatMap((pk) => pk.order);
    expect(flat.length).toBe(14);
    // 前 10 张全部是主卡，后 4 张全部是额外卡
    for (const c of flat.slice(0, 10)) expect(cards.get(c)!.type & 0x4802040).toBe(0);
    for (const c of flat.slice(10)) expect(cards.get(c)!.type & 0x4802040).not.toBe(0);
  });

  it('stratify: every pack contains both main and extra cards in proportion', () => {
    const cards = new CardsService();
    const all = cards.poolCodes();
    const mainCodes = all.filter((c) => (cards.get(c)!.type & 0x4802040) === 0).slice(0, 60);
    const extraCodes = all.filter((c) => (cards.get(c)!.type & 0x4802040) !== 0).slice(0, 30);
    const tournaments = makeTournaments();
    const p = new PoolsService(cards);
    p.create('str', [...mainCodes, ...extraCodes]);
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // Keep this test focused on stratification rather than the global default pack size.
    const tid = tournaments.create({ name: 'str', maxPlayers: 3, cardPool: 'str', dropMode: 'use_all', packStrategy: 'stratify', packSize: 9 }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    const packs = state.packs;
    expect(packs.length).toBeGreaterThanOrEqual(4); // 90 卡 / 9 = 10 堆
    for (const pk of packs) {
      const extraCount = pk.order.filter((c) => (cards.get(c)!.type & 0x4802040) !== 0).length;
      // 整体 extra 占比 1/3：每堆 extra 占比应接近 1/3（容忍 ±25%）
      const frac = extraCount / pk.order.length;
      expect(frac).toBeGreaterThan(0.08);
      expect(frac).toBeLessThan(0.58);
    }
  });
});

describe('explicit per-pack extra ratio', () => {
  beforeEach(() => useTestDb());

  function setupRatioPool(name: string, mainCount: number, extraCount: number) {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const main = cards.poolCodes().filter((code) => !cards.isExtraDeck(code)).slice(0, mainCount);
    const extra = cards.poolCodes().filter((code) => cards.isExtraDeck(code)).slice(0, extraCount);
    pools.create(name, [...main, ...extra]);
    return { cards, pools };
  }

  it('gives every full pack the requested ratio and overrides packStrategy', () => {
    const { cards, pools } = setupRatioPool('ratio', 36, 12);
    const tournaments = makeTournaments();
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({
      name: 'ratio', maxPlayers: 2, cardPool: 'ratio', packSize: 24, packCount: 2,
      packStrategy: 'main_then_extra', extraRatioPercent: 25, dropPublic: true,
    }, 'test').tid;
    for (let i = 0; i < 2; i++) tournaments.join(tid, `ratio-p${i}`, `Ratio P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs).toHaveLength(2);
    for (const pack of state.packs) {
      expect(pack.order).toHaveLength(24);
      expect(pack.order.filter((code) => cards.isExtraDeck(code))).toHaveLength(6);
      expect(pack.order.filter((code) => !cards.isExtraDeck(code))).toHaveLength(18);
    }
    const drafted = state.packs.flatMap((pack) => pack.order);
    expect(new Set(drafted).size).toBe(drafted.length);
    expect(state.droppedCards).toHaveLength(0);
  });

  it('uses the actual size for a short final pack', () => {
    const { cards, pools } = setupRatioPool('ratio-short', 12, 13);
    const tournaments = makeTournaments();
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({
      name: 'ratio-short', maxPlayers: 2, cardPool: 'ratio-short', packSize: 24, packCount: 2,
      evenPackCount: true, extraRatioPercent: 50,
    }, 'test').tid;
    for (let i = 0; i < 2; i++) tournaments.join(tid, `short-p${i}`, `Short P${i}`);
    draft.startDraft(tid, 'test');
    const packs = loadState(tid).packs;
    expect(packs.map((pack) => pack.order.length)).toEqual([24, 1]);
    expect(packs[0].order.filter((code) => cards.isExtraDeck(code))).toHaveLength(12);
    expect(packs[1].order.filter((code) => cards.isExtraDeck(code))).toHaveLength(1);
  });

  it('rejects an unavailable ratio before writing packs or phase events', () => {
    const { cards, pools } = setupRatioPool('ratio-shortage', 24, 0);
    const tournaments = makeTournaments();
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({
      name: 'ratio-shortage', maxPlayers: 2, cardPool: 'ratio-shortage', packSize: 12, packCount: 2,
      extraRatioPercent: 25,
    }, 'test').tid;
    for (let i = 0; i < 2; i++) tournaments.join(tid, `shortage-p${i}`, `Shortage P${i}`);
    try {
      draft.startDraft(tid, 'test');
      throw new Error('expected INSUFFICIENT_PACK_RATIO');
    } catch (error) {
      expect((error as Error).message).toBe('INSUFFICIENT_PACK_RATIO');
      expect((error as Error & { details: Record<string, number> }).details).toMatchObject({
        extraRatioPercent: 25,
        requiredMain: 18,
        availableMain: 24,
        requiredExtra: 6,
        availableExtra: 0,
      });
    }
    const state = loadState(tid);
    expect(state.status).toBe('registration');
    expect(state.packs).toEqual([]);
    expect(state.picks).toEqual([]);
  });
});

  it('packSize accepts any number (no multiple-of-players requirement)', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // 3 人，每堆 10 张（非 3 的倍数）：31 张卡 use_all -> ceil(31/10)=4 堆（10,10,10,1）
    const p = new PoolsService(cards);
    p.create('anypack', cards.poolCodes().slice(0, 31));
    const tid = tournaments.create({ name: 'anypack', maxPlayers: 3, cardPool: 'anypack', dropMode: 'use_all', packSize: 10, evenPackCount: false }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(4);
    expect(state.packs[0].order.length).toBe(10);
    expect(state.packs[2].order.length).toBe(10);
    expect(state.packs[3].order.length).toBe(1);
    expect(state.droppedCards.length).toBe(0);
  });

  it('legacy packSizeMultiple still yields n*multiple packs', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const p = new PoolsService(cards);
    p.create('legacypack', cards.poolCodes().slice(0, 40));
    // 3 人 × 3 = 9/堆（旧语义，不传 packSize）
    const tid = tournaments.create({ name: 'legacypack', maxPlayers: 3, cardPool: 'legacypack', dropMode: 'use_all', packSizeMultiple: 3 }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs[0].order.length).toBe(9);
    expect(state.packs[0].order.length).toBe(9); // 显式 legacy 参数优先，不使用新默认 18
  });

  it('packCount fixes the number of packs; remainder is dropped', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const p = new PoolsService(cards);
    p.create('pk', cards.poolCodes().slice(0, 40));
    const tid = tournaments.create({ name: 'pk', maxPlayers: 3, cardPool: 'pk', packSize: 9, packCount: 3, dropPublic: true }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(3); // 27 张进堆
    expect(state.packs[0].order.length).toBe(9);
    expect(state.droppedCards.length).toBe(40 - 27); // 剩余 13 张全部随机丢弃
  });

  it('initial random discard preserves the pool main/extra ratio for every pack strategy', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const mainCodes = cards.poolCodes().filter((code) => !cards.isExtraDeck(code)).slice(0, 80);
    const extraCodes = cards.poolCodes().filter((code) => cards.isExtraDeck(code)).slice(0, 20);
    pools.create('proportional-drop', [...mainCodes, ...extraCodes]);
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({
      name: 'proportional-drop', maxPlayers: 3, cardPool: 'proportional-drop',
      packSize: 10, packCount: 5, evenPackCount: false, packStrategy: 'random', dropPublic: true,
    }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    const drafted = state.packs.flatMap((pack) => pack.order);
    expect(drafted).toHaveLength(50);
    expect(drafted.filter((code) => cards.isExtraDeck(code))).toHaveLength(10);
    expect(state.droppedCards).toHaveLength(50);
    expect(state.droppedCards.filter((code) => cards.isExtraDeck(code))).toHaveLength(10);
  });

  it('packCount above the pool limit switches to use-all (no discard, last pack may be short)', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const p = new PoolsService(cards);
    p.create('pk2', cards.poolCodes().slice(0, 40));
    const tid = tournaments.create({ name: 'pk2', maxPlayers: 3, cardPool: 'pk2', packSize: 9, packCount: 99, evenPackCount: false }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    // 显式 99 > maxFull floor(40/9)=4 → 推断为用尽卡池：ceil(40/9)=5 堆，末堆 4 张，不弃置
    expect(state.packs.length).toBe(5);
    expect(state.packs[4].order.length).toBe(4);
    expect(state.droppedCards.length).toBe(0);
  });

  it('dropPublic=false removes dropped cards without exposing them', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const p = new PoolsService(cards);
    p.create('priv', cards.poolCodes().slice(0, 31));
    const tid = tournaments.create({ name: 'priv', maxPlayers: 3, cardPool: 'priv', packSize: 9, dropMode: 'drop_leftover', dropPublic: false }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(0); // 丢弃 4 张但不公开
  });

  it('startOffset: snake offsets when packSize is a multiple of players; random otherwise (serial)', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // 倍数场景：3 人 packSize 9 -> 每堆蛇形偏移 (n-(k%n))%n
    const p = new PoolsService(cards);
    p.create('off1', cards.poolCodes().slice(0, 40));
    const t1 = tournaments.create({ name: 'off1', maxPlayers: 3, cardPool: 'off1', packSize: 9, draftMode: 'serial' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(t1, `p${i}`, `P${i}`);
    draft.startDraft(t1, 'test');
    const s1 = loadState(t1);
    for (const pk of s1.packs) expect(pk.startOffset).toBe((3 - (pk.index % 3)) % 3);
    // 非倍数场景：3 人 packSize 10 -> 每堆随机起始，偏移只需落在 [0,3) 内
    p.create('off2', cards.poolCodes().slice(0, 60));
    const t2 = tournaments.create({ name: 'off2', maxPlayers: 3, cardPool: 'off2', packSize: 10, draftMode: 'serial' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(t2, `p${i}`, `P${i}`);
    draft.startDraft(t2, 'test');
    const s2 = loadState(t2);
    for (const pk of s2.packs) {
      expect(pk.startOffset).toBeGreaterThanOrEqual(0);
      expect(pk.startOffset).toBeLessThan(3);
    }
  });

  it('dropPublic defaults to false (dropped cards not exposed)', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const p = new PoolsService(cards);
    p.create('priv2', cards.poolCodes().slice(0, 31));
    const tid = tournaments.create({ name: 'priv2', maxPlayers: 3, cardPool: 'priv2', packSize: 9 }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(0); // 丢弃 4 张但默认不公开
  });
