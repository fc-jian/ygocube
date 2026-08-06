import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { loadState, logEvent } from '../src/events/events.service';
import { DraftService } from '../src/draft/draft.service';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';
import { MatchesService } from '../src/matches/matches.service';

const fakeSrvpro = { createRoom: async () => ({ ok: true }), roomStatus: async () => ({ ok: false }), closeRoom: async () => ({ ok: true }) };

function setup(n: number) {
  const tournaments = makeTournaments();
  const cards = new CardsService();
  const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
  const tid = tournaments.create({ name: 'ph', maxPlayers: n, pickSeconds: 30, cardPool: TEST_POOL }, 'test').tid;
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
    expect(state.phaseDeadline).not.toBeNull();
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
    const tid = tournaments.create({ name: 'nodrop', maxPlayers: 3, cardPool: 'nodrop', dropMode: 'use_all' }, 'test').tid;
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
    const tid = tournaments.create({ name: 'dropleft', maxPlayers: 3, cardPool: 'dropleft', dropMode: 'drop_leftover' }, 'test').tid;
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
    const tid = tournaments.create({ name: 'dropexact', maxPlayers: 3, cardPool: 'dropexact', dropMode: 'drop_leftover_exact' }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(3);
    expect(state.droppedCards.length).toBe(8);
    // 32 cards: floor(32/9)=3, 3%3=0 -> still 3 packs; 34 cards: floor=3, 3%3=0
    // 用 38 张验证 trim：floor(38/9)=4, 4%3=1 -> 3 packs (27), 11 dropped
    p.create('dropexact2', cards.poolCodes().slice(0, 38));
    const tid2 = tournaments.create({ name: 'dropexact2', maxPlayers: 3, cardPool: 'dropexact2', dropMode: 'drop_leftover_exact' }, 'test').tid;
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

  it('deckbuilding sets a phase deadline', () => {
    const { tournaments, tid } = setup(3);
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    const state = loadState(tid);
    expect(state.status).toBe('deckbuilding');
    expect(state.phaseDeadline).not.toBeNull();
    expect(new Date(state.phaseDeadline!).getTime()).toBeGreaterThan(Date.now());
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
