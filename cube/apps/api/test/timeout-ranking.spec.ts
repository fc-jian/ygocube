import { useTestDb, makeTournaments } from './helpers';
import { getConfig, loadState, resetStateCache } from '../src/events/events.service';
import { DraftService } from '../src/draft/draft.service';
import { CardsService } from '../src/cards/cards.service';
import { CardPickStatsService, CardPickStat } from '../src/cards/card-pick-stats.service';
import { PoolsService } from '../src/pools/pools.service';
import { MatchesService } from '../src/matches/matches.service';

for (const mode of ['passing', 'serial'] as const) {
  describe(`${mode} timeout ranking`, () => {
    let draft: DraftService;
    beforeEach(() => { useTestDb(); jest.useFakeTimers(); });
    afterEach(() => { draft?.onModuleDestroy(); jest.restoreAllMocks(); jest.useRealTimers(); });
    function setup() {
      const cards = new CardsService(), pools = new PoolsService(cards), tournaments = makeTournaments();
      pools.create('ranking', cards.poolCodes().slice(0, 8));
      const stats = new CardPickStatsService(pools);
      const lookup = jest.spyOn(stats, 'forPoolId');
      draft = new DraftService(cards, tournaments, pools, new MatchesService({} as any), undefined, stats);
      const tid = tournaments.create({name:'test-ranking',maxPlayers:2,cardPool:'ranking',packSize:4,draftMode:mode,pickSeconds:1,reserveSeconds:0}, 'test').tid;
      for (let i=0;i<2;i++) tournaments.join(tid, `p${i}`, `P${i}`);
      draft.startDraft(tid, 'test');
      const state = loadState(tid);
      const pid = mode === 'serial' ? state.pickCursor!.playerId : state.players[0].playerId;
      const packIndex = mode === 'serial' ? state.pickCursor!.packIndex : state.packQueues[pid][0];
      const codes = state.packs.find(p=>p.index===packIndex)!.order;
      const rank = (values: Array<[number, number]>) => lookup.mockReturnValue(new Map(values.map(([code, percentage]) => [code, {averagePickPercentage:percentage} as CardPickStat])));
      const expire = () => {
        jest.advanceTimersByTime(1100);
        const pick = loadState(tid).picks.find(p=>p.playerId===pid && p.packIndex===packIndex)!;
        expect(pick.auto).toBe(true);
        resetStateCache();
        expect(loadState(tid).picks).toContainEqual(pick);
        return pick.card;
      };
      return {tid,pid,codes,rank,expire,lookup,poolId:getConfig(state).cardPoolId};
    }
    it('chooses the lowest percentage over unranked cards without rounding', () => {
      const t=setup(); t.rank([[t.codes[0],50],[t.codes[1],20.004],[t.codes[2],20.003]]);
      expect(t.expire()).toBe(t.codes[2]);expect(t.lookup).toHaveBeenCalledWith(t.poolId);
    });
    it('keeps the last clicked alternative ahead of the statistics', () => {
      const t=setup();t.rank([[t.codes[0],1]]);
      draft.setPickAlternative(t.tid,t.pid,t.codes[1],t.pid);
      draft.setPickAlternative(t.tid,t.pid,t.codes[2],t.pid);
      expect(t.expire()).toBe(t.codes[2]);
    });
    it.each([0,0.999])('randomizes only among tied best cards (random=%s)', random => {
      const t=setup();t.rank([[t.codes[0],10],[t.codes[1],30],[t.codes[2],10]]);
      jest.spyOn(Math,'random').mockReturnValue(random);
      expect(t.expire()).toBe(t.codes[random===0?0:2]);
    });
    it('falls back to random remaining cards when no statistics exist', () => {
      const t=setup();t.rank([]);jest.spyOn(Math,'random').mockReturnValue(0.999);
      expect(t.expire()).toBe(t.codes.at(-1));
    });
    it('ignores non-finite statistics rather than blocking the timeout', () => {
      const t=setup();t.rank([[t.codes[0],NaN],[t.codes[1],Infinity],[t.codes[2],60]]);
      expect(t.expire()).toBe(t.codes[2]);
    });
  });
}
