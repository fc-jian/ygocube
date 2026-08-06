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
