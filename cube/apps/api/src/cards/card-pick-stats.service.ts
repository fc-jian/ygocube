import { Injectable } from '@nestjs/common';
import { getDb } from '../db';
import { loadState, TournamentState } from '../events/events.service';
import { CardPool, PoolsService } from '../pools/pools.service';

export interface CardPickStat {
  poolId: number;
  poolName: string;
  averagePickPosition: number;
  /** Mean one-based position normalized by each pack's actual size (0-100). */
  averagePickPercentage: number;
  /** Number of distinct packs contributing a sample for this exact code. */
  packCount: number;
  /** Number of distinct completed tournaments represented by those packs. */
  tournamentCount: number;
  /** Kept as the raw pick sample count for existing clients. */
  sampleCount: number;
}

interface TournamentRow {
  id: number;
  name: string;
  config_json: string;
  card_pool_id: number | null;
  updated_at: string;
}

interface Aggregate {
  positionSum: number;
  percentageSum: number;
  count: number;
  packKeys: Set<string>;
  tournamentIds: Set<number>;
}

interface CacheEntry {
  version: string;
  stats: Map<number, CardPickStat>;
}

/**
 * Rebuild exact-code pick positions from completed draft state.  The result is
 * cached only as a derived view; event changes, pool edits, tournament edits,
 * and hard reverts all change the cache key and are therefore reflected on the
 * next request without maintaining another mutable aggregate table.
 */
@Injectable()
export class CardPickStatsService {
  private cache = new Map<number, CacheEntry>();

  constructor(private pools: PoolsService) {}

  forPool(pool: CardPool): Map<number, CardPickStat> {
    // Callers may retain a pool object across an admin delete/edit. Resolve the
    // current row first so a deleted pool can never continue serving cached
    // statistics and a stale code list cannot be used for aggregation.
    const currentPool = this.pools.get(pool.id);
    if (!currentPool) {
      this.cache.delete(pool.id);
      return new Map();
    }
    pool = currentPool;
    const version = this.version(pool);
    const cached = this.cache.get(pool.id);
    if (cached?.version === version) return cached.stats;

    const totals = new Map<number, Aggregate>();
    const rows = getDb()
      .prepare('SELECT id, name, config_json, card_pool_id, updated_at FROM tournaments ORDER BY id')
      .all() as TournamentRow[];
    for (const row of rows) {
      if (/^test/i.test(row.name)) continue;
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(row.config_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The database column is the immutable pool identity. Legacy records
      // without it are intentionally excluded so a deleted/recreated name
      // cannot be mistaken for the original pool.
      if (row.card_pool_id !== pool.id) continue;
      let state: TournamentState;
      try {
        state = loadState(row.id);
      } catch {
        continue;
      }
      if (!this.isCompleteDraft(state)) continue;
      for (const pick of state.picks) {
        const pack = state.packs.find((candidate) => candidate.index === pick.packIndex);
        if (!pack || pack.order.length <= 0) continue;
        const position = Number(pick.round) + 1;
        const current = totals.get(pick.card) ?? {
          positionSum: 0,
          percentageSum: 0,
          count: 0,
          packKeys: new Set<string>(),
          tournamentIds: new Set<number>(),
        };
        current.positionSum += position;
        current.percentageSum += position / pack.order.length * 100;
        current.count += 1;
        current.packKeys.add(`${row.id}:${pack.index}`);
        current.tournamentIds.add(row.id);
        totals.set(pick.card, current);
      }
    }

    const stats = new Map<number, CardPickStat>();
    for (const [code, total] of totals) {
      if (!pool.codes.includes(code) || total.count <= 0) continue;
      stats.set(code, {
        poolId: pool.id,
        poolName: pool.name,
        averagePickPosition: total.positionSum / total.count,
        averagePickPercentage: total.percentageSum / total.count,
        packCount: total.packKeys.size,
        tournamentCount: total.tournamentIds.size,
        sampleCount: total.count,
      });
    }
    this.cache.set(pool.id, { version, stats });
    return stats;
  }

  forPoolId(poolId: number): Map<number, CardPickStat> {
    const pool = this.pools.get(poolId);
    return pool ? this.forPool(pool) : new Map();
  }

  /** Return stats for every currently existing pool, keyed by exact card code. */
  forAllPools(codes?: Set<number>): Map<number, CardPickStat[]> {
    const result = new Map<number, CardPickStat[]>();
    for (const listed of this.pools.list()) {
      const pool = this.pools.get(listed.id);
      if (!pool) continue;
      for (const [code, stat] of this.forPool(pool)) {
        if (codes && !codes.has(code)) continue;
        const rows = result.get(code) ?? [];
        rows.push(stat);
        result.set(code, rows);
      }
    }
    return result;
  }

  private version(pool: CardPool): string {
    const db = getDb();
    const event = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events').get() as { max_seq: number };
    const tournaments = db
      .prepare('SELECT count(*) AS count, COALESCE(MAX(updated_at), \'\') AS updated_at FROM tournaments')
      .get() as { count: number; updated_at: string };
    return `${event.max_seq}:${tournaments.count}:${tournaments.updated_at}:${JSON.stringify(pool.codes)}`;
  }

  private isCompleteDraft(state: TournamentState): boolean {
    if (state.status === 'registration' || state.status === 'drafting' || state.packs.length === 0) return false;
    const expected = state.packs.reduce((sum, pack) => sum + pack.order.length, 0);
    if (state.picks.length !== expected) return false;
    for (const pack of state.packs) {
      const picks = state.picks.filter((pick) => pick.packIndex === pack.index);
      if (picks.length !== pack.order.length) return false;
      const rounds = new Set<number>();
      const orderCounts = new Map<number, number>();
      const pickCounts = new Map<number, number>();
      for (const code of pack.order) orderCounts.set(code, (orderCounts.get(code) ?? 0) + 1);
      for (const pick of picks) {
        if (!Number.isInteger(pick.round) || pick.round < 0 || pick.round >= pack.order.length || rounds.has(pick.round)) return false;
        rounds.add(pick.round);
        pickCounts.set(pick.card, (pickCounts.get(pick.card) ?? 0) + 1);
      }
      if (rounds.size !== pack.order.length || pickCounts.size !== orderCounts.size) return false;
      for (const [code, count] of orderCounts) if (pickCounts.get(code) !== count) return false;
    }
    return true;
  }
}
