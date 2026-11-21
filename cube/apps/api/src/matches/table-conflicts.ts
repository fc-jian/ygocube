import type Database from 'better-sqlite3';

interface ConflictRow {
  id: number; tournament_id: number; round: number; table_no: number;
  player_a: string; player_b: string; result_a: number | null; result_b: number | null;
}

export function conflictingMatchRows(db: Database.Database, tournamentId?: number): ConflictRow[] {
  return db.prepare(`
    SELECT m.id, m.tournament_id, m.round, m.table_no, m.player_a, m.player_b, m.result_a, m.result_b
    FROM matches m JOIN (
      SELECT tournament_id, round, table_no FROM matches
      ${tournamentId === undefined ? '' : 'WHERE tournament_id=?'}
      GROUP BY tournament_id, round, table_no HAVING count(*) > 1
    ) conflicts USING (tournament_id, round, table_no)
    ORDER BY m.tournament_id, m.round, m.table_no, m.id
  `).all(...(tournamentId === undefined ? [] : [tournamentId])) as ConflictRow[];
}
