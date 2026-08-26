import { Injectable } from '@nestjs/common';
import { getDb } from '../db';
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
  status: string;
  updated_at: string;
}

interface StatisticalPack {
  index: number;
  order: number[];
}

interface StatisticalPick {
  packIndex: number;
  round: number;
  card: number;
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
  private static readonly CACHE_LIMIT = 32;
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
    if (cached?.version === version) {
      this.cache.delete(pool.id);
      this.cache.set(pool.id, cached);
      return cached.stats;
    }

    const totals = new Map<number, Aggregate>();
    const rows = getDb()
      .prepare('SELECT id, name, status, updated_at FROM tournaments WHERE card_pool_id=? ORDER BY id')
      .all(pool.id) as TournamentRow[];
    for (const row of rows) {
      if (/^test/i.test(row.name)) continue;
      if (row.status === 'registration' || row.status === 'drafting') continue;
      const draft = this.rebuildDraft(row.id);
      if (!draft || !this.isCompleteDraft(draft.packs, draft.picks)) continue;
      const packByIndex = new Map(draft.packs.map((pack) => [pack.index, pack]));
      for (const pick of draft.picks) {
        const pack = packByIndex.get(pick.packIndex);
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
    const poolCodes = new Set(pool.codes);
    for (const [code, total] of totals) {
      if (!poolCodes.has(code) || total.count <= 0) continue;
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
    this.cache.delete(pool.id);
    this.cache.set(pool.id, { version, stats });
    while (this.cache.size > CardPickStatsService.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
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
    const tournaments = db
      .prepare(`SELECT count(DISTINCT t.id) AS count,
        COALESCE(MAX(t.updated_at), '') AS updated_at,
        COALESCE(MAX(e.seq), 0) AS max_seq
        FROM tournaments t LEFT JOIN events e ON e.tournament_id=t.id
        WHERE t.card_pool_id=?`)
      .get(pool.id) as { count: number; updated_at: string; max_seq: number };
    return `${tournaments.max_seq}:${tournaments.count}:${tournaments.updated_at}:${JSON.stringify(pool.codes)}`;
  }

  private rebuildDraft(tid: number): { packs: StatisticalPack[]; picks: StatisticalPick[] } | null {
    const rows = getDb()
      .prepare("SELECT action, payload_json FROM events WHERE tournament_id=? AND action IN ('packs_created','pick') ORDER BY seq")
      .all(tid) as { action: string; payload_json: string }[];
    let packs: StatisticalPack[] = [];
    const picks: StatisticalPick[] = [];
    try {
      for (const row of rows) {
        const payload: unknown = JSON.parse(row.payload_json);
        if (row.action === 'packs_created') {
          // Before pack metadata was added, packs_created was stored as the
          // array itself. Accept both shapes so restored historical drafts
          // participate in statistics exactly like new drafts.
          const rawPacks: unknown[] | null = Array.isArray(payload)
            ? payload
            : (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).packs)
              ? (payload as Record<string, unknown>).packs as unknown[]
              : null);
          if (!rawPacks) return null;
          packs = rawPacks.map((raw) => {
            const pack = raw as Record<string, unknown>;
            return { index: Number(pack.index), order: Array.isArray(pack.order) ? pack.order.map(Number) : [] };
          });
        } else {
          if (!payload || typeof payload !== 'object') return null;
          const pick = payload as Record<string, unknown>;
          picks.push({ packIndex: Number(pick.packIndex), round: Number(pick.round), card: Number(pick.card) });
        }
      }
    } catch {
      return null;
    }
    return packs.length ? { packs, picks } : null;
  }

  private isCompleteDraft(packs: StatisticalPack[], allPicks: StatisticalPick[]): boolean {
    const expected = packs.reduce((sum, pack) => sum + pack.order.length, 0);
    if (allPicks.length !== expected) return false;
    for (const pack of packs) {
      if (!Number.isSafeInteger(pack.index) || pack.order.some((code) => !Number.isSafeInteger(code) || code <= 0)) return false;
      const picks = allPicks.filter((pick) => pick.packIndex === pack.index);
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
