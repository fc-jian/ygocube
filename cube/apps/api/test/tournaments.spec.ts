import { loadState } from '../src/events/events.service';
import { useTestDb, makeTournaments, TEST_POOL, freshTournament } from './helpers';

// Error code of a thrown Error('CODE') or HttpException({ code: 'CODE' }).
function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    return e.response?.code ?? e.message;
  }
}

describe('tournament card pool validation', () => {
  beforeEach(() => useTestDb());

  it('create rejects a missing cardPool', () => {
    const tournaments = makeTournaments();
    expect(errorCode(() => tournaments.create({ name: 'nopool', maxPlayers: 4 }, 'test'))).toBe('BAD_PAYLOAD');
  });

  it('create rejects an empty cardPool', () => {
    const tournaments = makeTournaments();
    expect(errorCode(() => tournaments.create({ name: 'emptypool', maxPlayers: 4, cardPool: '' }, 'test'))).toBe('BAD_PAYLOAD');
  });

  it("create rejects the 'full' pool", () => {
    const tournaments = makeTournaments();
    expect(() => tournaments.create({ name: 'fullpool', maxPlayers: 4, cardPool: 'full' }, 'test')).toThrow('POOL_NOT_FOUND');
  });

  it('create rejects a nonexistent pool name', () => {
    const tournaments = makeTournaments();
    expect(() => tournaments.create({ name: 'ghost', maxPlayers: 4, cardPool: 'no-such-pool' }, 'test')).toThrow('POOL_NOT_FOUND');
  });

  it('create accepts an existing pool name', () => {
    const tournaments = makeTournaments();
    const { tid } = tournaments.create({ name: 'ok', maxPlayers: 4, cardPool: TEST_POOL }, 'test');
    expect(tid).toBeGreaterThan(0);
  });

  it("updateConfig rejects 'full' and unknown pools, accepts an existing pool", () => {
    const tournaments = makeTournaments();
    const tid = freshTournament();
    expect(() => tournaments.updateConfig(tid, { cardPool: 'full' }, 'test')).toThrow('POOL_NOT_FOUND');
    expect(() => tournaments.updateConfig(tid, { cardPool: 'no-such-pool' }, 'test')).toThrow('POOL_NOT_FOUND');
    expect(errorCode(() => tournaments.updateConfig(tid, { cardPool: '' }, 'test'))).toBe('BAD_PAYLOAD');
    const cfg = tournaments.updateConfig(tid, { cardPool: TEST_POOL }, 'test');
    expect(cfg.cardPool).toBe(TEST_POOL);
  });
});

describe('admin player management', () => {
  beforeEach(() => useTestDb());

  it('removePlayer clears player, picks and deck; blocked during matches', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'x', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'p1', 'P1');
    tournaments.join(tid, 'p2', 'P2');
    const { logEvent } = require('../src/events/events.service');
    logEvent(tid, 'player', 'pick', { playerId: 'p1', packIndex: 0, round: 0, card: 1, auto: false }, 'p1');
    tournaments.removePlayer(tid, 'p1', 'admin');
    const s = loadState(tid);
    expect(s.players.some((p) => p.playerId === 'p1')).toBe(false);
    expect(s.picks.some((p) => p.playerId === 'p1')).toBe(false);
    expect(s.decks['p1']).toBeUndefined();
    expect(() => tournaments.removePlayer(tid, 'nobody', 'admin')).toThrow('PLAYER_NOT_FOUND');
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    tournaments.setPhase(tid, 'matches', undefined, 'test');
    expect(() => tournaments.removePlayer(tid, 'p2', 'admin')).toThrow('WRONG_PHASE');
  });

  it('resetPlayerToken returns a fresh token whose hash is stored', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'x', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'p1', 'P1');
    const { token } = tournaments.resetPlayerToken(tid, 'p1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = require('../src/db').getDb()
      .prepare('SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=?')
      .get(tid, 'p1');
    expect(row.token_hash).toBe(require('crypto').createHash('sha256').update(token).digest('hex'));
    expect(() => tournaments.resetPlayerToken(tid, 'nobody')).toThrow('PLAYER_NOT_FOUND');
  });
});
