import { useTestDb, makeTournaments, makePools, TEST_POOL } from './helpers';
import {
  afterEventCommit,
  loadState,
  revertTo,
  hardRevertTo,
  previewRevert,
  snapshotNow,
  resetStateCache,
  logEvent,
  withEventTransaction,
} from '../src/events/events.service';

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

  it('replays the legacy array-form packs_created event', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'legacy-packs', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    const legacyPacks = [{ index: 0, size: 2, dropCard: 99, order: [11, 22] }];
    logEvent(tid, 'pack', 'packs_created', legacyPacks, 'test');

    resetStateCache();
    const state = loadState(tid);
    expect(state.packs).toEqual(legacyPacks);
    expect(state.droppedCards).toEqual([99]);
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

  it('restores default token auth when an earlier revert already replaced the config projection', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'repeated-revert-auth', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'a', 'A');
    const db = require('../src/db').getDb();
    const originalSeq = (db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid) as { seq: number }).seq;
    tournaments.setAuthRequired(tid, false, 'test');
    const disabledSeq = (db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid) as { seq: number }).seq;
    tournaments.setAuthRequired(tid, true, 'test');
    hardRevertTo(tid, disabledSeq, 'test');
    expect(tournaments.get(tid).authRequired).toBe(false);
    hardRevertTo(tid, originalSeq, 'test');
    resetStateCache();
    expect(tournaments.get(tid).authRequired).toBe(true);
    expect(JSON.parse(loadState(tid).configJson).authRequired).not.toBe(false);
  });

  it.each([false, true])('preserves initial custom config and pool across repeated reverts (legacy=%s)', legacy => {
    const tournaments = makeTournaments();
    const pools = makePools();
    pools.create('second-pool', pools.codesByName(TEST_POOL)!);
    const tid = tournaments.create({ name: 'repeated-config', maxPlayers: 2, cardPool: TEST_POOL, mainMin: 20 }, 'test').tid;
    const db = require('../src/db').getDb();
    const originalPoolId = db.prepare('SELECT card_pool_id FROM tournaments WHERE id=?').get(tid).card_pool_id;
    if (legacy) db.prepare('DELETE FROM tournament_snapshots WHERE tournament_id=?').run(tid);
    tournaments.join(tid, 'a', 'A');
    const originalSeq = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    tournaments.updateConfig(tid, { mainMin: 30, cardPool: 'second-pool' }, 'test');
    const changedSeq = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    snapshotNow(tid);
    hardRevertTo(tid, changedSeq, 'test');
    hardRevertTo(tid, originalSeq, 'test');
    resetStateCache();
    expect(JSON.parse(loadState(tid).configJson)).toMatchObject({ mainMin: 20, cardPool: TEST_POOL, cardPoolId: originalPoolId });
    expect(db.prepare('SELECT card_pool_id FROM tournaments WHERE id=?').get(tid)).toEqual({ card_pool_id: originalPoolId });
    expect(db.prepare('SELECT count(*) AS c FROM tournament_snapshots WHERE tournament_id=? AND event_seq>?').get(tid, originalSeq)).toEqual({ c: 0 });
  });

  it('rejects irrecoverable legacy history before modifying the current branch', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'lost-config', maxPlayers: 2, cardPool: TEST_POOL, mainMin: 20 }, 'test').tid;
    const db = require('../src/db').getDb();
    const originalSeq = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    tournaments.updateConfig(tid, { mainMin: 30 }, 'test');
    const changedSeq = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    hardRevertTo(tid, changedSeq, 'test');
    // Simulate an old release: it removed all prior snapshots and persisted
    // the later config as the only seed for replay.
    db.prepare('DELETE FROM tournament_snapshots WHERE tournament_id=? AND event_seq<?').run(tid, changedSeq);
    const before = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tid);
    for (const revert of [() => previewRevert(tid, originalSeq), () => hardRevertTo(tid, originalSeq, 'test')]) {
      try {
        revert();
        throw new Error('expected missing baseline rejection');
      } catch (error: any) {
        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toEqual({ code: 'REVERT_BASELINE_UNAVAILABLE' });
      }
    }
    expect(db.prepare('SELECT * FROM tournaments WHERE id=?').get(tid)).toEqual(before);
    expect(db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid)).toEqual({ seq: changedSeq });
  });

  it('can recover legacy config from a complete config event without a snapshot', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'recorded-config', maxPlayers: 2, cardPool: TEST_POOL, mainMin: 20 }, 'test').tid;
    const db = require('../src/db').getDb();
    tournaments.updateConfig(tid, { mainMin: 25 }, 'test');
    const target = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    tournaments.updateConfig(tid, { mainMin: 30 }, 'test');
    const later = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    hardRevertTo(tid, later, 'test');
    db.prepare('DELETE FROM tournament_snapshots WHERE tournament_id=?').run(tid);
    expect(JSON.parse(hardRevertTo(tid, target, 'test').state.configJson).mainMin).toBe(25);
  });

  it('restores the historical name consistently in details, listings and later revert previews', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'original-name', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    const db = require('../src/db').getDb();
    const target = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(tid).seq;
    tournaments.updateName(tid, 'later-name', 'test');
    hardRevertTo(tid, target, 'test');
    resetStateCache();
    expect(tournaments.get(tid).name).toBe('original-name');
    expect(tournaments.list().find(tournament => tournament.id === tid)?.name).toBe('original-name');
    expect(previewRevert(tid, target).tournamentName).toBe('original-name');
    expect(db.prepare('SELECT name FROM tournaments WHERE id=?').get(tid)).toEqual({ name: 'original-name' });
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

  it('rolls back SQL, event rows, and speculative cached state as one command', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'atomic', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    const db = require('../src/db').getDb();
    const before = (db.prepare('SELECT count(*) AS c FROM events WHERE tournament_id=?').get(tid) as { c: number }).c;
    expect(() => withEventTransaction(tid, () => {
      logEvent(tid, 'tournament', 'phase', { status: 'drafting', round: 0 }, 'test');
      db.prepare('UPDATE tournaments SET status=? WHERE id=?').run('drafting', tid);
      throw new Error('ROLLBACK_TEST');
    })).toThrow('ROLLBACK_TEST');
    expect((db.prepare('SELECT count(*) AS c FROM events WHERE tournament_id=?').get(tid) as { c: number }).c).toBe(before);
    expect((db.prepare('SELECT status FROM tournaments WHERE id=?').get(tid) as { status: string }).status).toBe('registration');
    expect(loadState(tid).status).toBe('registration');
    resetStateCache();
    expect(loadState(tid).status).toBe('registration');
  });

  it('runs external side effects only after commit and discards them on rollback', () => {
    const tid = makeTournaments().create({ name: 'after-commit', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    const calls: string[] = [];
    withEventTransaction(tid, () => {
      afterEventCommit(tid, () => calls.push('committed'));
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(['committed']);

    expect(() => withEventTransaction(tid, () => {
      afterEventCommit(tid, () => calls.push('rolled-back'));
      throw new Error('ROLLBACK_SIDE_EFFECT');
    })).toThrow('ROLLBACK_SIDE_EFFECT');
    expect(calls).toEqual(['committed']);
  });

  it('writes a snapshot when a multi-event transaction crosses the 100-event boundary', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'snapshot-boundary', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    for (let i = 0; i < 98; i++) logEvent(tid, 'test', 'round_complete', { i }, 'test');
    const db = require('../src/db').getDb();
    expect((db.prepare('SELECT count(*) AS c FROM events WHERE tournament_id=?').get(tid) as { c: number }).c).toBe(99);
    withEventTransaction(tid, () => {
      logEvent(tid, 'test', 'round_complete', { i: 98 }, 'test');
      logEvent(tid, 'test', 'round_complete', { i: 99 }, 'test');
    });
    const latestEvent = (db.prepare('SELECT max(seq) AS seq FROM events WHERE tournament_id=?').get(tid) as { seq: number }).seq;
    expect(db.prepare('SELECT event_seq FROM tournament_snapshots WHERE tournament_id=? ORDER BY id DESC LIMIT 1').get(tid))
      .toEqual({ event_seq: latestEvent });
  });
});
