import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { useTestDb, freshTournament } from './helpers';
import { getDb, ensureMatchTableIntegrity } from '../src/db';
import { dropState, loadState, logEvent } from '../src/events/events.service';
import { inspectMatchTables, repairMatchTables } from '../src/maintenance/match-tables';

describe('offline match table reconciliation', () => {
  let tid: number, backup: string;
  beforeEach(() => {
    useTestDb(); tid = freshTournament('legacy-match');
    backup = path.join(os.tmpdir(), `match-repair-${crypto.randomUUID()}.sqlite`);
    const db = getDb();
    db.exec('ALTER TABLE matches RENAME TO legacy_matches; CREATE TABLE matches AS SELECT * FROM legacy_matches; DROP TABLE legacy_matches;');
    for (const id of [1, 2]) {
      const match = { id, round: 2, tableNo: 1, playerA: `a${id}`, playerB: `b${id}`, roomName: null, resultA: 2, resultB: 1, source: 'srvpro', startedAt: null, finishedAt: '2026-10-01T00:00:00Z' };
      db.prepare('INSERT INTO matches(id,tournament_id,round,table_no,player_a,player_b,result_a,result_b) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, tid, 2, 1, match.playerA, match.playerB, 2, 1);
      logEvent(tid, 'match', 'match', match, 'fixture');
    }
    logEvent(tid, 'frozen', 'frozen', true, 'fixture');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ensureMatchTableIntegrity(db);
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(backup, { force: true }); });
  function plan() {
    const value = inspectMatchTables().plan;
    value.changes.forEach((change, index) => { change.tableNo = index + 1; });
    return value;
  }
  it('protects new matches without preventing score updates on legacy records', () => {
    const db = getDb();
    expect(() => db.prepare('INSERT INTO matches(id,tournament_id,round,table_no) VALUES(3,?,2,1)').run(tid)).toThrow('duplicate match table');
    expect(() => db.prepare('UPDATE matches SET result_a=3 WHERE id=1').run()).not.toThrow();
  });
  it('does not mask database failures other than duplicate constraints', () => {
    const error = Object.assign(new Error('disk unavailable'), { code: 'SQLITE_IOERR' });
    expect(() => ensureMatchTableIntegrity({ exec: () => { throw error; } } as any)).toThrow(error);
  });
  it('never overwrites an existing backup', async () => {
    fs.writeFileSync(backup, 'preserve');
    await expect(repairMatchTables(plan(), backup)).rejects.toThrow('EEXIST');
    expect(fs.readFileSync(backup, 'utf8')).toBe('preserve');
    expect(inspectMatchTables().conflicts).toHaveLength(2);
  });
  it('backs up, preserves both matches and scores, and appends replayable table corrections', async () => {
    await repairMatchTables(plan(), backup);
    expect(fs.existsSync(backup)).toBe(true);
    expect(inspectMatchTables().conflicts).toEqual([]);
    dropState(tid);
    expect(loadState(tid).matches.map(match => [match.id, match.tableNo, match.resultA, match.resultB])).toEqual([[1, 1, 2, 1], [2, 2, 2, 1]]);
    expect((getDb().prepare('PRAGMA index_list(matches)').all() as any[]).some(row => row.name === 'idx_matches_tid_round_table' && row.unique === 1)).toBe(true);
  });
  it('refuses stale plans before mutation', async () => {
    const value = plan(); logEvent(tid, 'notice', 'notice', {}, 'fixture');
    await expect(repairMatchTables(value, backup)).rejects.toThrow('STALE_REPAIR_PLAN');
    expect(inspectMatchTables().conflicts).toHaveLength(2);
  });
  it('rolls back SQL and replay when the operator leaves conflicting assignments', async () => {
    const value = plan(); value.changes[1].tableNo = 1;
    const count = (getDb().prepare('SELECT count(*) AS n FROM events').get() as any).n;
    await expect(repairMatchTables(value, backup)).rejects.toThrow('REPAIR_STILL_DUPLICATE');
    expect((getDb().prepare('SELECT count(*) AS n FROM events').get() as any).n).toBe(count);
    expect(loadState(tid).matches.map(match => match.tableNo)).toEqual([1, 1]);
  });
  it('refuses mismatched event results and unfrozen tournaments', async () => {
    getDb().prepare('UPDATE matches SET result_a=9 WHERE id=2').run();
    await expect(repairMatchTables(plan(), backup)).rejects.toThrow('MATCH_REPLAY_MISMATCH');
    fs.rmSync(backup);
    getDb().prepare('UPDATE matches SET result_a=2 WHERE id=2').run();
    logEvent(tid, 'frozen', 'frozen', false, 'fixture');
    await expect(repairMatchTables(plan(), backup)).rejects.toThrow('REPAIR_REQUIRES_FROZEN_TOURNAMENT');
  });
});
