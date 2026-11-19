import { cardStatusForDeckbuilding, cardsSeenByPlayer } from '../src/cards/card-visibility';
import { TournamentState } from '../src/events/events.service';

function stateFor(mode: 'serial' | 'passing'): TournamentState {
  return {
    id: 1,
    name: 'visibility',
    configJson: '{}',
    status: 'drafting',
    round: 0,
    frozen: false,
    players: [
      { playerId: 'p0', displayName: 'P0', seat: 0, eliminated: false },
      { playerId: 'p1', displayName: 'P1', seat: 1, eliminated: false },
      { playerId: 'p2', displayName: 'P2', seat: 2, eliminated: false },
    ],
    packs: [
      { index: 0, size: 3, dropCard: null, order: [101, 102, 103] },
      { index: 1, size: 2, dropCard: null, order: [201, 202] },
    ],
    droppedCards: [],
    picks: [
      { playerId: 'p0', packIndex: 0, round: 0, card: 101, auto: false, at: '2026-08-14T00:00:00.000Z' },
      { playerId: 'p1', packIndex: 0, round: 1, card: 102, auto: false, at: '2026-08-14T00:00:01.000Z' },
    ],
    pickCursor: mode === 'serial' ? { packIndex: 0, round: 2, playerId: 'p2', deadlineAt: null } : null,
    packQueues: mode === 'passing' ? { p0: [], p1: [], p2: [0, 1] } : {},
    pickDeadlines: {},
    packsDealt: mode === 'passing' ? 2 : 0,
    pickReserves: {},
    pause: null,
    decks: {},
    matches: [],
    phaseDeadline: null,
    pendingPhase: null,
    draftStartConfirmation: null,
    frozenTimers: null,
    competition: null,
  };
}

describe('card visibility reconstruction', () => {
  it('marks only cards remaining when each serial player picks', () => {
    const state = stateFor('serial');
    expect([...cardsSeenByPlayer(state, 'p0')]).toEqual([101, 102, 103]);
    expect([...cardsSeenByPlayer(state, 'p1')]).toEqual([102, 103]);
    expect([...cardsSeenByPlayer(state, 'p2')]).toEqual([103]);
    expect(cardsSeenByPlayer(state, 'p1').has(101)).toBe(false);
  });

  it('shows only the passing queue head and keeps future queues unknown', () => {
    const state = stateFor('passing');
    expect([...cardsSeenByPlayer(state, 'p2')]).toEqual([103]);
    expect(cardsSeenByPlayer(state, 'p2').has(201)).toBe(false);
    expect(cardsSeenByPlayer(state, 'p2').has(202)).toBe(false);
  });

  it('uses global deckbuilding status instead of per-player seen history', () => {
    const state = stateFor('serial');
    state.status = 'deckbuilding';
    state.packs = [{ index: 0, size: 2, dropCard: null, order: [101, 102] }];
    state.picks = [
      { playerId: 'p0', packIndex: 0, round: 0, card: 101, auto: false, at: '2026-08-14T00:00:00.000Z' },
      { playerId: 'p1', packIndex: 0, round: 0, card: 102, auto: false, at: '2026-08-14T00:00:01.000Z' },
    ];
    const pool = [101, 102, 103];
    expect(cardStatusForDeckbuilding(state, 'p0', pool, 999)).toBe('not_in_pool');
    expect(cardStatusForDeckbuilding(state, 'p0', pool, 103)).toBe('dropped');
    expect(cardStatusForDeckbuilding(state, 'p0', pool, 101)).toBe('picked');
    expect(cardStatusForDeckbuilding(state, 'p0', pool, 102)).toBe('other_picked');
  });
});
