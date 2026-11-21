import { AdminController } from '../src/admin.controller';
import { CardsService } from '../src/cards/cards.service';
import { DecksService } from '../src/decks/decks.service';
import { DraftService } from '../src/draft/draft.service';
import { loadState, logEvent } from '../src/events/events.service';
import { MatchesService } from '../src/matches/matches.service';
import { PoolsService } from '../src/pools/pools.service';
import { makeTournaments, TEST_POOL, useTestDb } from './helpers';

const fakeSrvpro = { createRoom: async () => ({ ok: true }), roomStatus: async () => ({ ok: false }), closeRoom: async () => ({ ok: true }) };

describe('admin match transition preflight', () => {
  beforeEach(() => useTestDb());

  it('starts drafting only after every player confirms the administrator request', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const tournaments = makeTournaments();
    const matches = new MatchesService(fakeSrvpro as any);
    const draft = new DraftService(cards, tournaments, pools, matches);
    const decks = new DecksService(cards, matches);
    const realtime = { emitPhase: jest.fn(), emitPause: jest.fn(), emitNotice: jest.fn() };
    const controller = new AdminController(tournaments, draft, decks, matches, pools, cards, realtime as any);
    const tid = tournaments.create({ name: 'admin-confirm', maxPlayers: 2, cardPool: TEST_POOL, draftMode: 'serial' }, 'creator').tid;
    tournaments.join(tid, 'p0', 'P0');
    tournaments.join(tid, 'p1', 'P1');
    const adminReq = { params: { tid: String(tid) }, identity: { isSuper: true } } as any;

    const requested = controller.startDraft(adminReq) as any;
    expect(requested).toMatchObject({ ok: true, pending: true, confirmedCount: 0, total: 2 });
    expect(loadState(tid).status).toBe('registration');
    expect(loadState(tid).packs).toHaveLength(0);
    expect(() => tournaments.join(tid, 'p2', 'P2')).toThrow('DRAFT_START_PENDING');
    expect(() => controller.phase(adminReq, { status: 'matches' })).toThrow('DRAFT_START_PENDING');

    expect(draft.confirmDraftStart(tid, 'p0').pending).toBe(true);
    expect(loadState(tid).status).toBe('registration');
    expect(draft.confirmDraftStart(tid, 'p1').started).toBe(true);
    expect(loadState(tid).status).toBe('drafting');
    draft.haltAllTimers(tid);
  });

  it.each(['passing', 'serial'] as const)('uses the confirmed roster for %s after a registration withdrawal', (mode) => {
    const cards = new CardsService();
    const tournaments = makeTournaments();
    const draft = new DraftService(cards, tournaments, new PoolsService(cards), new MatchesService(fakeSrvpro as any));
    const tid = tournaments.create({ name: 'confirmed roster', maxPlayers: 3, cardPool: TEST_POOL, draftMode: mode }, 'test').tid;
    for (const id of ['a', 'b', 'c']) tournaments.join(tid, id, id);
    tournaments.withdrawPlayer(tid, 'b', 'test');
    expect(draft.requestStartDraft(tid, 'test').total).toBe(2);
    expect(draft.confirmDraftStart(tid, 'a').pending).toBe(true);
    expect(draft.confirmDraftStart(tid, 'c').started).toBe(true);
    const state = loadState(tid);
    expect(state.draftParticipants).toEqual(['a', 'c']);
    expect(state.players.map(p => p.seat)).toEqual([0, -1, 1]);
    if (mode === 'passing') expect(Object.keys(state.packQueues).sort()).toEqual(['a', 'c']);
    else expect(state.pickCursor?.playerId).toBe('a');
    expect(() => tournaments.restorePlayer(tid, 'b', 'test')).toThrow('WRONG_PHASE');
    tournaments.withdrawPlayer(tid, 'c', 'test');
    tournaments.restorePlayer(tid, 'c', 'test');
    expect(loadState(tid).draftParticipants).toEqual(['a', 'c']);
    draft.haltAllTimers(tid);
  });

  it('warns without mutation, then repairs overflow and DSQs an undersized player after confirmation', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const tournaments = makeTournaments();
    const matches = new MatchesService(fakeSrvpro as any);
    const draft = new DraftService(cards, tournaments, pools, matches);
    const decks = new DecksService(cards, matches);
    const realtime = { emitPhase: jest.fn(), emitPause: jest.fn(), emitNotice: jest.fn() };
    const controller = new AdminController(tournaments, draft, decks, matches, pools, cards, realtime as any);
    const tid = tournaments.create({
      name: 'preflight', maxPlayers: 3, cardPool: TEST_POOL,
      mainMin: 3, mainMax: 4, extraMax: 2, sideMax: 2, maxCopies: 1,
    }, 'test').tid;
    for (const pid of ['p0', 'p1', 'departed']) tournaments.join(tid, pid, pid);
    tournaments.withdrawPlayer(tid, 'departed', 'test');
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    const codes = cards.allCodes().filter((code) => !cards.isExtraDeck(code)).slice(0, 6);
    for (const pid of ['p0', 'p1']) {
      for (let i = 0; i < 6; i++) {
        logEvent(tid, 'pick', 'pick', { playerId: pid, packIndex: 0, round: i, card: codes[i], auto: false, at: new Date().toISOString() }, pid);
      }
    }
    for (let i = 0; i < 5; i++) decks.move(tid, 'p0', codes[i], 'pool', 'main');
    for (let i = 0; i < 2; i++) decks.move(tid, 'p1', codes[i], 'pool', 'main');
    const req = { params: { tid: String(tid) }, identity: { isSuper: true } } as any;

    const preview = controller.phase(req, { status: 'matches', round: 1 }) as any;
    expect(preview.requires_confirmation).toBe(true);
    expect(preview.invalid_decks).toMatchObject([
      { playerId: 'p0', mainShortfall: 0, movedToSide: 1, returnedToPool: 0 },
      { playerId: 'p1', mainShortfall: 1, movedToSide: 0, returnedToPool: 0 },
    ]);
    expect(preview.preview_key).toEqual(expect.any(String));
    // A previously submitted layout can have a duplicate which no longer counts.
    const extra = cards.allCodes().find(code => cards.isExtraDeck(code))!;
    logEvent(tid, 'pick', 'pick', { playerId: 'p1', packIndex: 0, round: 7, card: extra, auto: false, at: new Date().toISOString() }, 'p1');
    logEvent(tid, 'deck', 'deck', { playerId: 'p1', deck: { ...loadState(tid).decks.p1, main: [codes[0], codes[0], extra] } }, 'test');
    const beforeCheck = tournaments.adminSummary(tid).lastEventSeq;
    const changed = controller.phase(req, { status: 'matches', confirm_invalid_decks: true, preview_key: preview.preview_key }) as any;
    expect(changed.requires_confirmation).toBe(true);
    expect(changed.preview_key).not.toBe(preview.preview_key);
    expect(changed.invalid_decks[1]).toMatchObject({ playerId: 'p1', mainShortfall: 2, returnedToPool: 1,
      issues: expect.arrayContaining([{ zone: 'main', reason: 'wrong-zone', code: extra }]) });
    expect(tournaments.adminSummary(tid).lastEventSeq).toBe(beforeCheck);
    expect(loadState(tid).status).toBe('deckbuilding');

    const confirmed = controller.phase(req, { status: 'matches', round: 1, confirm_invalid_decks: true }) as any;
    expect(confirmed.ok).toBe(true);
    const state = loadState(tid);
    expect(state.status).toBe('matches');
    expect(state.decks.p0.main).toHaveLength(4);
    expect(state.decks.p0.side).toHaveLength(1);
    expect(state.decks.p1.main).toEqual([codes[0]]);
    expect(state.decks.p1.extra).toEqual([extra]);
    expect(confirmed.repairs.map((r: { playerId: string }) => r.playerId)).toEqual(['p0', 'p1']);
    expect(state.players.find((p) => p.playerId === 'p1')?.eliminated).toBe(true);
    expect(state.matches).toHaveLength(1);
    expect(state.matches[0].playerB).toBe('(bye)');
  });

  it('rolls back a name change when another config field is invalid', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const tournaments = makeTournaments();
    const matches = new MatchesService(fakeSrvpro as any);
    const decks = new DecksService(cards, matches);
    const draft = new DraftService(cards, tournaments, pools, matches, decks);
    const realtime = { emitPhase: jest.fn(), emitPause: jest.fn(), emitNotice: jest.fn() };
    const controller = new AdminController(tournaments, draft, decks, matches, pools, cards, realtime as any);
    const tid = tournaments.create({ name: 'original', maxPlayers: 4, cardPool: TEST_POOL }, 'test').tid;
    const req = { params: { tid: String(tid) }, identity: { isSuper: true } } as any;

    expect(() => controller.updateTournamentConfig(req, {
      name: 'should-not-stick',
      mainMin: 100,
      mainMax: 80,
    })).toThrow('BAD_PAYLOAD');
    expect(loadState(tid).name).toBe('original');
  });
});
