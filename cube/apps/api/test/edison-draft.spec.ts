import { rmSync } from 'node:fs';
import { CardsService } from '../src/cards/cards.service';
import { CardPickStatsService } from '../src/cards/card-pick-stats.service';
import { remainingCardsForPack } from '../src/cards/card-visibility';
import { closeDb, getDb } from '../src/db';
import { DecksService } from '../src/decks/decks.service';
import { DraftService } from '../src/draft/draft.service';
import { createEdisonPacks } from '../src/draft/edison-draft';
import { getConfig, hardRevertTo, loadState, logEvent, resetStateCache } from '../src/events/events.service';
import { PoolsService } from '../src/pools/pools.service';
import { TournamentsService } from '../src/tournaments/tournaments.service';
import { useTestDb } from './helpers';
import { config } from '../src/config';
import { parseInstancePools, readInstancePools } from '../src/pools/instance-pools';

const poolName = 'test-paired';
const inventory = [...Array<number>(553).fill(10001), ...Array<number>(82).fill(10000)];
const sum = (codes: number[], code: number) => codes.filter((value) => value === code).length;

describe('Edison Cube E3', () => {
  let cards: CardsService;
  let pools: PoolsService;
  let tournaments: TournamentsService;
  let draft: DraftService;
  let decks: DecksService;
  beforeEach(() => {
    useTestDb();
    cards = new CardsService();
    pools = new PoolsService(cards);
    tournaments = new TournamentsService(pools);
    decks = new DecksService(cards);
    draft = new DraftService(cards, tournaments, pools, {} as never, decks);
  });
  afterEach(() => { draft.onModuleDestroy(); jest.restoreAllMocks(); jest.useRealTimers(); });

  it('starts an unconfigured instance without importing another instance’s pools', () => {
    const firstDb = config.server.dbPath;
    closeDb();
    config.server.dbPath = firstDb + '.empty';
    config.server.poolData = readInstancePools(firstDb + '.absent', true);
    expect(pools.list()).toEqual([]);
    expect(() => readInstancePools(firstDb + '.absent', false)).toThrow();
    expect(() => parseInstancePools({ version: 1, draft: [{ name: 'bad', codes: [-1] }] })).toThrow();
    closeDb();
    rmSync(config.server.dbPath);
    config.server.dbPath = firstDb;
    expect(pools.getByName(poolName)?.codes).toEqual(inventory);
  });

  it('installs the exact counted inventory once and keeps edited quantities on restart', () => {
    const pool = pools.getByName(poolName)!;
    expect(pool.draftFormat).toBe('edison_e3');
    expect(pool.codes).toHaveLength(635);
    expect(new Set(pool.codes).size).toBe(2);
    expect(sum(pool.codes, 10001)).toBe(553);
    expect(pools.list().find((p) => p.id === pool.id)?.count).toBe(635);
    pools.addCandidates(poolName, [10002, 10002]);
    const saved = pools.update(pool.id, [10002, 10002, 10000]);
    expect(saved.candidateRemovedCodes).toEqual([10002]);
    closeDb();
    expect(pools.getByName(poolName)?.codes).toEqual([10002, 10002, 10000]);
    expect(pools.create('ordinary', [10001, 10001]).pool.codes).toEqual([10001]);
  });

  it.each([[2, 15], [3, 15], [4, 15], [5, 15], [6, 13], [7, 11], [8, 10], [9, 9]])(
    'deals %i seats without replacement with %i extra cards per second-round pack', (n, extraCount) => {
      const { packs, droppedCards } = createEdisonPacks(inventory, n, cards, true);
      expect(packs).toHaveLength(n * 3);
      for (const pack of packs) {
        expect(sum(pack.order, 10001)).toBe(20);
        expect(sum(pack.order, 10000)).toBe(pack.draftRound === 2 ? extraCount : 0);
      }
      const dealt = packs.flatMap((p) => p.order);
      expect([...dealt, ...droppedCards].sort()).toEqual([...inventory].sort());
    },
  );

  it('enforces the selected format when creating or editing an event', () => {
    pools.create('ordinary', [10001, 10002]);
    const { tid } = tournaments.create({ name: 'format', maxPlayers: 3, cardPool: 'ordinary' }, 'test');
    expect(() => tournaments.updateConfig(tid, { cardPool: poolName, maxPlayers: 10 }, 'test')).toThrow('BAD_PAYLOAD');
    const cfg = tournaments.updateConfig(tid, { cardPool: poolName, draftMode: 'serial', reseatEachRound: true, maxCopies: 7 }, 'test');
    expect(cfg).toMatchObject({ draftFormat: 'edison_e3', draftMode: 'passing', reseatEachRound: false, maxCopies: 3 });
    expect(tournaments.updateConfig(tid, { cardPool: 'ordinary', maxCopies: 1 }, 'test').draftFormat).toBeUndefined();
    expect(() => tournaments.create({ name: 'oversize', maxPlayers: 10, cardPool: poolName }, 'test')).toThrow('BAD_PAYLOAD');
    expect(() => createEdisonPacks(inventory.slice(100), 9, cards, false)).toThrow('INSUFFICIENT_PACK_RATIO');
  });

  it('keeps seats, passes once per hand in round direction, and finishes all single and paired picks', () => {
    jest.useFakeTimers();
    const pool = pools.getByName(poolName)!;
    pools.update(pool.id, inventory);
    const { tid } = tournaments.create({ name: 'E3 table', maxPlayers: 9, cardPool: poolName, draftMode: 'serial',
      packSize: 2, packCount: 1, reseatEachRound: true, pickSeconds: 3, reserveSeconds: 0 }, 'admin');
    const players = ['a', 'b', 'c'];
    for (const pid of players) tournaments.join(tid, pid, pid);
    tournaments.setSeats(tid, players, 'admin');
    draft.requestStartDraft(tid, 'admin');
    draft.confirmDraftStart(tid, players[0]);
    draft.confirmDraftStart(tid, players[1]);
    jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);
    draft.confirmDraftStart(tid, players[2]);
    const seats = () => [...loadState(tid).players].sort((a, b) => a.seat - b.seat).map((p) => p.playerId);
    const fixedSeats = seats();
    expect(fixedSeats).not.toEqual(players);
    expect(loadState(tid).packs).toHaveLength(9);
    expect(getConfig(loadState(tid)).packCount).toBe(9);
    expect(loadState(tid).droppedCards).toEqual([]);
    let autoChecked = false;
    let tailHands = 0;
    for (let pass = 0; pass < 60; pass++) {
      const round = Math.floor(pass / 20) + 1;
      expect(seats()).toEqual(fixedSeats);
      expect(loadState(tid).packsDealt).toBe(round * players.length);
      for (const [seat, pid] of fixedSeats.entries()) {
        const view = tournaments.stateForPlayer(tid, pid);
        const head = view.pack as { index: number; draftRound: number; requiresPair: boolean; cards: number[]; cardsLeft: number };
        expect(head.draftRound).toBe(round);
        expect(head.requiresPair).toBe(round === 2 && pass % 20 < 15);
        const expected = { index: head.index, cardsLeft: head.cardsLeft };
        if (round === 2 && !autoChecked) {
          expect(() => draft.pick(tid, pid, 10001)).toThrow('EDISON_PAIR_REQUIRED');
          expect(() => draft.pick(tid, pid, 10001, undefined, 10001)).toThrow('EDISON_PAIR_REQUIRED');
          expect(remainingCardsForPack(loadState(tid), head.index)).toHaveLength(35);
          draft.setPickAlternative(tid, pid, 10000, pid, expected);
          if (seat === 0) draft.setPickAlternative(tid, pid, 10001, pid, expected);
          if (seat < 2) continue;
          resetStateCache();
          expect(tournaments.stateForPlayer(tid, fixedSeats[0])).toMatchObject({ pickAlternative: 10001, pickAlternativePartner: 10000 });
          jest.advanceTimersByTime(3000);
          const picks = loadState(tid).picks.filter((p) => p.packIndex >= 3 && p.packIndex < 6);
          expect(picks).toHaveLength(6);
          expect(picks.every((p) => p.auto)).toBe(true);
          autoChecked = true;
          break;
        }
        draft.pick(tid, pid, 10001, undefined, head.requiresPair ? 10000 : undefined, expected);
        expect(() => draft.pick(tid, pid, 10001, undefined, head.requiresPair ? 10000 : undefined, expected)).toThrow();
        if (round === 2 && !head.requiresPair) tailHands++;
        if (head.cardsLeft > (head.requiresPair ? 2 : 1)) {
          const receiver = fixedSeats[(seat + (round === 2 ? 2 : 1)) % 3];
          expect(loadState(tid).packQueues[receiver].at(-1)).toBe(head.index);
        }
      }
    }
    resetStateCache();
    const state = loadState(tid);
    expect(state.status).toBe('deckbuilding');
    expect(tailHands).toBe(15);
    for (const pid of players) {
      const picked = state.picks.filter((p) => p.playerId === pid).map((p) => p.card);
      expect(sum(picked, 10001)).toBe(60);
      expect(sum(picked, 10000)).toBe(15);
      expect(state.decks[pid].main).toHaveLength(3);
      expect(state.decks[pid].extra).toHaveLength(3);
    }
    const stats = new CardPickStatsService(pools).forPool(pool);
    expect(stats.get(10000)?.sampleCount).toBe(45);
    expect(stats.get(10001)?.sampleCount).toBe(180);
    expect(getConfig(state).maxCopies).toBe(3);
    expect(() => draft.review(tid, players[0])).toThrow('WRONG_PHASE');
    logEvent(tid, 'phase', 'phase', { status: 'finished' }, 'test');
    for (const pid of players) {
      const review = draft.review(tid, pid);
      expect(review.hands).toHaveLength(60);
      expect(review.hands.filter((h) => h.selected.length === 2)).toHaveLength(15);
      expect(review.hands.flatMap((h) => h.selected)).toEqual(state.picks.filter((p) => p.playerId === pid).map((p) => p.card));
      expect(review.hands.some((h) => h.auto)).toBe(state.picks.some((p) => p.playerId === pid && p.auto));
    }
    const firstPair = getDb().prepare(`SELECT seq, payload_json FROM events WHERE tournament_id=?
      AND action='pick' AND json_extract(payload_json, '$.extraCard') IS NOT NULL ORDER BY seq LIMIT 1`).get(tid) as { seq: number; payload_json: string };
    const hand = JSON.parse(firstPair.payload_json);
    const restored = hardRevertTo(tid, firstPair.seq, 'admin').state;
    expect(restored.picks.slice(-2).map((p) => p.card)).toEqual([hand.card, hand.extraCard]);
    expect(restored.decks[hand.playerId].extra).toEqual([hand.extraCard]);
    expect(restored.packQueues).toEqual(hand.queues);
  });

  it('limits exact copies to material picks and rules names to three in moves, validation and repairs', () => {
    cards.poolCodes();
    getDb().prepare('UPDATE cards SET alias=10001 WHERE code=10002').run();
    const { tid } = tournaments.create({ name: 'copies', maxPlayers: 2, cardPool: poolName, mainMin: 0 }, 'test');
    tournaments.join(tid, 'a', 'A');
    logEvent(tid, 'tournament', 'phase', { status: 'deckbuilding', round: 0 }, 'test');
    for (const [round, card] of [10001, 10002, 10002, 10002].entries()) {
      logEvent(tid, 'pick', 'pick', { playerId: 'a', packIndex: 0, round, card, auto: false }, 'test');
    }
    decks.move(tid, 'a', 10001, 'pool', 'main');
    expect(() => decks.move(tid, 'a', 10001, 'pool', 'side')).toThrow('CARD_NOT_IN_POOL');
    decks.move(tid, 'a', 10002, 'pool', 'main');
    decks.move(tid, 'a', 10002, 'pool', 'side');
    expect(() => decks.move(tid, 'a', 10002, 'pool', 'side')).toThrow('CARD_NOT_IN_POOL');
    const invalid = { ...loadState(tid).decks.a, main: [10001, 10001], side: [] };
    expect(decks.validate(loadState(tid), invalid, 'a')).toContain('more copies of 10001 than drafted');
    logEvent(tid, 'deck', 'deck', { playerId: 'a', deck: invalid }, 'test');
    expect(decks.repairForMatches(tid, 'a').returnedToPool).toBe(1);
    decks.autoFix(tid, 'a');
    expect(loadState(tid).decks.a.main.sort()).toEqual([10001, 10002, 10002]);
  });
});
