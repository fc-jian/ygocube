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

  it('dropLeftover=false: pack count need not divide; last pack may be short', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    // 29 cards, 3 players, x3 -> 9 per pack; no-drop mode: 4 packs, last has 2
    const pool = cards.poolCodes().slice(0, 29);
    const p = new PoolsService(cards);
    p.create('nodrop', pool);
    const tid = tournaments.create({ name: 'nodrop', maxPlayers: 3, cardPool: 'nodrop', dropLeftover: false }, 'test').tid;
    for (let i = 0; i < 3; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    draft.startDraft(tid, 'test');
    const state = loadState(tid);
    expect(state.packs.length).toBe(4);
    expect(state.packs[0].order.length).toBe(9);
    expect(state.packs[3].order.length).toBe(2);
    expect(state.droppedCards.length).toBe(0);
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
