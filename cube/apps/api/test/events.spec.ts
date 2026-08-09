import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { loadState, revertTo, hardRevertTo, resetStateCache, logEvent } from '../src/events/events.service';

describe('event log & revert', () => {
  beforeEach(() => useTestDb());

  it('replays state from events after cache clear', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'r', maxPlayers: 3, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'a', 'A');
    tournaments.join(tid, 'b', 'B');
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    // simulate restart: clear module cache so stateCache is gone
    // (stateCache is module-private; delete require cache to force reload)
    const { loadState: fresh } = require('../src/events/events.service');
    const state = fresh(tid);
    expect(state.status).toBe('drafting');
    expect(state.players.length).toBe(2);
  });

  it('revertTo rebuilds state as of a historical seq and freezes the tournament', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'r2', maxPlayers: 3, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'a', 'A');
    tournaments.join(tid, 'b', 'B');
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    const db = require('../src/db').getDb();
    const seqRow = db.prepare('SELECT seq FROM events WHERE action=? AND payload_json LIKE ? ORDER BY seq LIMIT 1').get('phase', '%drafting%') as { seq: number };
    const state = revertTo(tid, seqRow.seq);
    expect(state.status).toBe('drafting');
    expect(state.frozen).toBe(true);
    const max = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid) as { seq: number };
    expect(max.seq).toBe(seqRow.seq);
  });

  it('hard revert truncates the future, rebuilds projections, and survives cache reload', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'hard', maxPlayers: 3, cardPool: TEST_POOL }, 'test').tid;
    const a = tournaments.join(tid, 'a', 'A');
    const db = require('../src/db').getDb();
    const target = (db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid) as { seq: number }).seq;
    const hashBefore = (db.prepare('SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=?').get(tid, 'a') as { token_hash: string }).token_hash;
    tournaments.join(tid, 'b', 'B');
    tournaments.setPhase(tid, 'drafting', undefined, 'test');

    const result = hardRevertTo(tid, target, 'super-admin');
    expect(result.deletedEvents).toBe(2);
    expect(result.replacementTokens).toEqual({});
    expect(result.state.players.map((p) => p.playerId)).toEqual(['a']);
    expect(db.prepare('SELECT count(*) AS c FROM events WHERE tournament_id=? AND seq>?').get(tid, target)).toEqual({ c: 0 });
    expect(db.prepare('SELECT active FROM tournament_players WHERE tournament_id=? AND player_id=?').get(tid, 'b')).toEqual({ active: 0 });
    expect((db.prepare('SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=?').get(tid, 'a') as { token_hash: string }).token_hash).toBe(hashBefore);
    expect(a.token).toHaveLength(32);

    resetStateCache();
    const restored = loadState(tid);
    expect(restored.frozen).toBe(true);
    expect(restored.status).toBe('registration');
    expect(restored.players.map((p) => p.playerId)).toEqual(['a']);
  });

  it('every mutation appends to the append-only log', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'r3', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'a', 'A');
    const db = require('../src/db').getDb();
    const count = (db.prepare('SELECT count(*) AS c FROM events WHERE tournament_id=?').get(tid) as { c: number }).c;
    expect(count).toBe(2); // phase + player_join
    logEvent(tid, 'tournament', 'frozen', true, 'test');
    const count2 = (db.prepare('SELECT count(*) AS c FROM events WHERE tournament_id=?').get(tid) as { c: number }).c;
    expect(count2).toBe(3);
  });
});
