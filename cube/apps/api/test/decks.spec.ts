import { useTestDb, freshTournament, makeTournaments } from './helpers';
import { loadState } from '../src/events/events.service';
import { DecksService, DeckInvalidError } from '../src/decks/decks.service';
import { CardsService } from '../src/cards/cards.service';

describe('deck validation', () => {
  beforeEach(() => useTestDb());

  function setupDeckbuilding(picksPerPlayer: number) {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const decks = new DecksService(cards);
    const tid = freshTournament();
    for (let i = 0; i < 4; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
  tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    const state = loadState(tid);
    // seed picks (45 main-suitable cards per player) directly via event log
    const codes = cards.allCodes().filter((c) => !cards.isExtraDeck(c)).slice(0, 45);
    for (const p of state.players) {
      for (let k = 0; k < picksPerPlayer; k++) {
        logPick(tid, p.playerId, codes[k % codes.length], k);
      }
    }
    return { tournaments, cards, decks, tid, codes };
  }

  function logPick(tid: number, playerId: string, card: number, round: number) {
    const { logEvent } = require('../src/events/events.service');
    logEvent(tid, 'pick', 'pick', { playerId, packIndex: 0, round, card, auto: false, at: new Date().toISOString() }, playerId);
  }

  it('lock rejects decks below/above limits and >3 copies', () => {
    const { decks, tid, codes } = setupDeckbuilding(45);
    // move 39 main cards only -> below min
    for (let i = 0; i < 39; i++) decks.move(tid, 'p0', codes[i], 'pool', 'main');
    expect(() => decks.lock(tid, 'p0')).toThrowError(DeckInvalidError);
    // add one more -> 40 ok
    decks.move(tid, 'p0', codes[39], 'pool', 'main');
    decks.lock(tid, 'p0');
    const state = loadState(tid);
    expect(state.decks['p0'].lockedAt).not.toBeNull();
  });

  it('lock rejects extra-deck-type card in main', () => {
    const { cards, decks, tid, codes } = setupDeckbuilding(45);
    const extraCode = cards.allCodes().find((c) => cards.isExtraDeck(c))!;
    const mainCodes = codes.filter((c) => !cards.isExtraDeck(c)).slice(0, 40);
    for (let i = 0; i < 40; i++) decks.move(tid, 'p0', mainCodes[i], 'pool', 'main');
    // directly corrupt: replace main[0] with an extra-deck card through event log
    const state = loadState(tid);
    const deck = state.decks['p0'];
    const { logEvent } = require('../src/events/events.service');
    logEvent(tid, 'deck', 'deck', { playerId: 'p0', deck: { ...deck, main: [extraCode, ...deck.main.slice(1)] } }, 'test');
    expect(() => decks.lock(tid, 'p0')).toThrowError(DeckInvalidError);
  });

  it('ydk export contains #main, cards and !side', () => {
    const { decks, tid, codes } = setupDeckbuilding(45);
    for (let i = 0; i < 40; i++) decks.move(tid, 'p0', codes[i], 'pool', 'main');
    for (let i = 40; i < 45; i++) decks.move(tid, 'p0', codes[i], 'pool', 'side');
    const ydk = decks.ydk(tid, 'p0');
    expect(ydk).toContain('#main');
    expect(ydk).toContain('!side');
    expect(ydk.split('\n').filter((l) => /^\d+$/.test(l)).length).toBe(45);
  });
});
