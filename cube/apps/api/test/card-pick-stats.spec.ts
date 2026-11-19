import { useTestDb } from './helpers';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';
import { TournamentsService } from '../src/tournaments/tournaments.service';
import { DraftService } from '../src/draft/draft.service';
import { MatchesService } from '../src/matches/matches.service';
import { CardPickStatsService } from '../src/cards/card-pick-stats.service';
import { loadState } from '../src/events/events.service';

const fakeSrvpro = { createRoom: async () => ({ ok: true }), roomStatus: async () => ({ ok: false }), closeRoom: async () => ({ ok: true }) };

describe('card pick statistics', () => {
  beforeEach(() => useTestDb());

  it('aggregates exact codes at one-based positions only after a complete draft', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const pool = pools.create('stats-pool', cards.poolCodes().slice(0, 4)).pool;
    const tournaments = new TournamentsService(pools);
    const tid = tournaments.create({ name: 'Stats Showcase', maxPlayers: 2, cardPool: pool.name, packSize: 2, packCount: 2, evenPackCount: true, draftMode: 'serial' }, 'creator').tid;
    tournaments.join(tid, 'p0', 'P0');
    tournaments.join(tid, 'p1', 'P1');
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    draft.startDraft(tid, 'creator');
    const statsService = new CardPickStatsService(pools);
    expect(statsService.forPool(pool).size).toBe(0); // still drafting

    let state = loadState(tid);
    let guard = 0;
    while (state.pickCursor && guard++ < 20) {
      const pack = state.packs.find((item) => item.index === state.pickCursor!.packIndex)!;
      const taken = new Set(state.picks.filter((pick) => pick.packIndex === pack.index).map((pick) => pick.card));
      const card = pack.order.find((code) => !taken.has(code))!;
      draft.pick(tid, state.pickCursor.playerId, card);
      state = loadState(tid);
    }
    expect(state.status).toBe('deckbuilding');
    const stats = statsService.forPool(pool);
    expect(stats.size).toBe(4);
    for (const code of pool.codes) {
      const row = stats.get(code);
      expect(row).toEqual(expect.objectContaining({ poolId: pool.id, poolName: pool.name, sampleCount: 1 }));
      expect([1, 2]).toContain(row!.averagePickPosition);
      expect(row!.averagePickPercentage).toBe(row!.averagePickPosition / 2 * 100);
      expect(row!.packCount).toBe(1);
      expect(row!.tournamentCount).toBe(1);
    }
  });

  it('normalizes positions by each pack actual size, including a short final pack', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const pool = pools.create('stats-short-pack', cards.poolCodes().slice(0, 4)).pool;
    const tournaments = new TournamentsService(pools);
    const tid = tournaments.create({ name: 'Stats Short Pack', maxPlayers: 2, cardPool: pool.name, packSize: 3, packCount: 2, evenPackCount: true, draftMode: 'serial' }, 'creator').tid;
    tournaments.join(tid, 'p0', 'P0');
    tournaments.join(tid, 'p1', 'P1');
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    draft.startDraft(tid, 'creator');
    let state = loadState(tid);
    while (state.pickCursor) {
      const pack = state.packs.find((item) => item.index === state.pickCursor!.packIndex)!;
      const picked = new Set(state.picks.filter((pick) => pick.packIndex === pack.index).map((pick) => pick.card));
      draft.pick(tid, state.pickCursor.playerId, pack.order.find((code) => !picked.has(code))!);
      state = loadState(tid);
    }
    const stats = new CardPickStatsService(pools).forPool(pool);
    expect(stats.size).toBe(4);
    const shortPack = state.packs.find((pack) => pack.order.length === 1)!;
    const shortPick = state.picks.find((pick) => pick.packIndex === shortPack.index)!;
    const shortStat = stats.get(shortPick.card)!;
    expect(shortStat.averagePickPosition).toBe(1);
    expect(shortStat.averagePickPercentage).toBe(100);
    expect(shortStat.packCount).toBe(1);
    expect(shortStat.tournamentCount).toBe(1);
  });

  it('excludes test-prefixed tournaments and missing/legacy pool ids', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const pool = pools.create('stats-filter-pool', cards.poolCodes().slice(0, 4)).pool;
    const tournaments = new TournamentsService(pools);
    const tid = tournaments.create({ name: 'test-stat-fixture', maxPlayers: 2, cardPool: pool.name, packSize: 2, packCount: 2, evenPackCount: true, draftMode: 'serial' }, 'creator').tid;
    tournaments.join(tid, 'p0', 'P0');
    tournaments.join(tid, 'p1', 'P1');
    const draft = new DraftService(cards, tournaments, pools, new MatchesService(fakeSrvpro as any));
    draft.startDraft(tid, 'creator');
    let state = loadState(tid);
    while (state.pickCursor) {
      const pack = state.packs.find((item) => item.index === state.pickCursor!.packIndex)!;
      const picked = new Set(state.picks.filter((pick) => pick.packIndex === pack.index).map((pick) => pick.card));
      draft.pick(tid, state.pickCursor.playerId, pack.order.find((code) => !picked.has(code))!);
      state = loadState(tid);
    }
    expect(new CardPickStatsService(pools).forPool(pool).size).toBe(0);
  });
});
