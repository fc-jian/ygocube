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
      name: 'preflight', maxPlayers: 2, cardPool: TEST_POOL,
      mainMin: 3, mainMax: 4, extraMax: 2, sideMax: 2, maxCopies: 1,
    }, 'test').tid;
    for (const pid of ['p0', 'p1']) tournaments.join(tid, pid, pid);
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
    expect(preview.invalid_decks).toHaveLength(2);
    expect(loadState(tid).status).toBe('deckbuilding');

    const confirmed = controller.phase(req, { status: 'matches', round: 1, confirm_invalid_decks: true }) as any;
    expect(confirmed.ok).toBe(true);
    const state = loadState(tid);
    expect(state.status).toBe('matches');
    expect(state.decks.p0.main).toHaveLength(4);
    expect(state.decks.p0.side).toHaveLength(1);
    expect(state.players.find((p) => p.playerId === 'p1')?.eliminated).toBe(true);
    expect(state.matches).toHaveLength(1);
    expect(state.matches[0].playerB).toBe('(bye)');
  });
});
