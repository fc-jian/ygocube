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
    const cfg = JSON.parse(loadState(tid).configJson);
    expect(cfg.packSize).toBe(24);
    expect(cfg.pickSeconds).toBe(40);
    expect(cfg.reserveSeconds).toBe(400);
    expect(cfg.packCount).toBe(16); // four default rounds for four players
    expect(cfg.deckbuildingSeconds).toBeNull();
    expect(cfg.matchFormat).toBe('swiss');
    expect(cfg.swissRoundCount).toBe(3);
  });

  it('materializes recommended Swiss settings and validates manual settings', () => {
    const tournaments = makeTournaments();
    const small = tournaments.create({ name: 'recommended-small', maxPlayers: 8, cardPool: TEST_POOL }, 'test').tid;
    expect(JSON.parse(loadState(small).configJson)).toMatchObject({ matchFormat: 'swiss', swissRoundCount: 3, playoffSize: 0 });
    const tid = tournaments.create({ name: 'recommended', maxPlayers: 12, cardPool: TEST_POOL }, 'test').tid;
    expect(JSON.parse(loadState(tid).configJson)).toMatchObject({ matchFormat: 'swiss', swissRoundCount: 4, playoffSize: 4 });
    expect(() => tournaments.create({ name: 'bad', maxPlayers: 8, cardPool: TEST_POOL, matchFormat: 'swiss', swissRoundCount: 4, playoffSize: 16 }, 'test')).toThrow('FORMAT_PLAYER_COUNT');
    const cfg = tournaments.updateMatchFormat(tid, { matchFormat: 'double_elimination', playoffSize: 0 }, 'test');
    expect(cfg.matchFormat).toBe('double_elimination');
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

  it('allows a player to change display name during registration and replays it', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'rename', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'p1', '旧名称');

    expect(tournaments.updateDisplayName(tid, 'p1', '新名称', 'p1')).toEqual({ playerId: 'p1', displayName: '新名称' });
    expect(loadState(tid).players.find((p) => p.playerId === 'p1')?.displayName).toBe('新名称');
    expect(require('../src/db').getDb().prepare('SELECT display_name FROM tournament_players WHERE tournament_id=? AND player_id=?').get(tid, 'p1').display_name).toBe('新名称');

    const { resetStateCache } = require('../src/events/events.service');
    resetStateCache();
    expect(loadState(tid).players.find((p) => p.playerId === 'p1')?.displayName).toBe('新名称');
  });

  it('tracks registration readiness for every player and replays it', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'ready', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'p1', 'P1');
    tournaments.join(tid, 'p2', 'P2');

    expect(loadState(tid).players.map((p) => p.ready)).toEqual([false, false]);
    expect(tournaments.setPlayerReady(tid, 'p1', true, 'p1')).toEqual({ playerId: 'p1', ready: true });
    expect(tournaments.get(tid).players.find((p) => p.playerId === 'p1')?.ready).toBe(true);
    expect(tournaments.stateForPlayer(tid, 'p2').players.find((p) => p.playerId === 'p1')?.ready).toBe(true);

    const { resetStateCache } = require('../src/events/events.service');
    resetStateCache();
    expect(loadState(tid).players.find((p) => p.playerId === 'p1')?.ready).toBe(true);
    tournaments.setPlayerReady(tid, 'p1', false, 'p1');
    expect(loadState(tid).players.find((p) => p.playerId === 'p1')?.ready).toBe(false);
  });

  it('blocks display name changes after drafting starts and rejects invalid names', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'rename-phase', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'p1', 'P1');
    expect(() => tournaments.updateDisplayName(tid, 'p1', '', 'p1')).toThrow('BAD_DISPLAY_NAME');
    expect(() => tournaments.updateDisplayName(tid, 'p1', 'x\nname', 'p1')).toThrow('BAD_DISPLAY_NAME');
    tournaments.setPhase(tid, 'drafting', undefined, 'admin');
    expect(() => tournaments.updateDisplayName(tid, 'p1', 'P1-new', 'p1')).toThrow('WRONG_PHASE');
  });

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
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const row = require('../src/db').getDb()
      .prepare('SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=?')
      .get(tid, 'p1');
    expect(row.token_hash).toBe(require('crypto').createHash('sha256').update(token).digest('hex'));
    expect(() => tournaments.resetPlayerToken(tid, 'nobody')).toThrow('PLAYER_NOT_FOUND');
  });

  it('withdraws players without deleting history and allows restore before matches', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'x', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'p1', 'P1');
    tournaments.withdrawPlayer(tid, 'p1', 'admin');
    expect(loadState(tid).players[0].withdrawn).toBe(true);
    tournaments.restorePlayer(tid, 'p1', 'admin');
    expect(loadState(tid).players[0].withdrawn).toBe(false);
  });
});
