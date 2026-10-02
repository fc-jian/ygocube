import crypto from 'crypto';
import fs from 'fs';
import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { dropState, loadState, logEvent } from '../events/events.service';

export type MatchTablePlan = { version: 1; fingerprint: string; changes: { tournamentId: number; matchId: number; tableNo: number | null }[] };
function fingerprint(db: Database.Database = getDb()): string {
  // Include event/snapshot content as well as projections so an old plan cannot
  // overwrite a newer match or a reverted tournament.
  const tables = ['matches', 'events', 'tournament_snapshots', 'tournaments'];
  const hash = crypto.createHash('sha256');
  for (const table of tables) hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return hash.digest('hex');
}
export function inspectMatchTables(db: Database.Database = getDb()): { plan: MatchTablePlan; conflicts: unknown[] } {
  const rows = db.prepare(`SELECT m.id, m.tournament_id, m.round, m.table_no, m.player_a, m.player_b, m.result_a, m.result_b
    FROM matches m JOIN (SELECT tournament_id, round, table_no FROM matches GROUP BY tournament_id,round,table_no HAVING count(*)>1) d
    ON m.tournament_id=d.tournament_id AND m.round=d.round AND m.table_no=d.table_no ORDER BY m.tournament_id,m.round,m.table_no,m.id`).all() as any[];
  return { conflicts: rows, plan: { version: 1, fingerprint: fingerprint(db), changes: rows.map(row => ({ tournamentId: row.tournament_id, matchId: row.id, tableNo: null })) } };
}
export async function repairMatchTables(plan: MatchTablePlan, backupPath: string): Promise<void> {
  if (plan.version !== 1 || !Array.isArray(plan.changes) || !plan.changes.length) throw new Error('EMPTY_REPAIR_PLAN');
  const db = getDb();
  if (fingerprint() !== plan.fingerprint) throw new Error('STALE_REPAIR_PLAN');
  // Reserve a new path atomically; never overwrite an existing backup or DB.
  fs.closeSync(fs.openSync(backupPath, 'wx', 0o600));
  await db.backup(backupPath);
  const tids = [...new Set(plan.changes.map(change => change.tournamentId))];
  try {
    db.transaction(() => {
      if (fingerprint() !== plan.fingerprint) throw new Error('STALE_REPAIR_PLAN');
      const expected = inspectMatchTables().plan.changes.map(change => `${change.tournamentId}:${change.matchId}`).sort();
      const supplied = plan.changes.map(change => `${change.tournamentId}:${change.matchId}`).sort();
      if (JSON.stringify(expected) !== JSON.stringify(supplied)) throw new Error('INCOMPLETE_REPAIR_PLAN');
      for (const tid of tids) {
        dropState(tid);
        if (!loadState(tid).frozen) throw new Error('REPAIR_REQUIRES_FROZEN_TOURNAMENT');
      }
      for (const change of plan.changes) {
        if (!Number.isSafeInteger(change.tableNo) || Number(change.tableNo) < 1) throw new Error('REPAIR_TABLE_REQUIRED');
        const state = loadState(change.tournamentId);
        const match = state.matches.find(value => value.id === change.matchId);
        const row = db.prepare('SELECT * FROM matches WHERE id=? AND tournament_id=?').get(change.matchId, change.tournamentId) as any;
        if (!match || !row || row.round !== match.round || row.player_a !== match.playerA || row.player_b !== match.playerB
          || row.result_a !== match.resultA || row.result_b !== match.resultB || row.table_no !== match.tableNo) throw new Error('MATCH_REPLAY_MISMATCH');
        const updated = { ...match, tableNo: Number(change.tableNo) };
        logEvent(change.tournamentId, 'match', 'match', updated, 'offline-match-table-repair');
        db.prepare('UPDATE matches SET table_no=? WHERE id=?').run(updated.tableNo, match.id);
        db.prepare('INSERT INTO admin_actions(tournament_id,actor,action,detail_json,created_at) VALUES(?,?,?,?,?)')
          .run(change.tournamentId, 'offline-match-table-repair', 'repair_match_table', JSON.stringify({ matchId: match.id, from: match.tableNo, to: updated.tableNo }), new Date().toISOString());
      }
      // Fail the entire transaction if either replay or SQL still has conflicts.
      for (const tid of tids) {
        const keys = loadState(tid).matches.map(match => `${match.round}:${match.tableNo}`);
        if (new Set(keys).size !== keys.length) throw new Error('REPAIR_STILL_DUPLICATE');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_tid_round_table ON matches(tournament_id,round,table_no)');
    })();
  } finally { for (const tid of tids) dropState(tid); }
}
