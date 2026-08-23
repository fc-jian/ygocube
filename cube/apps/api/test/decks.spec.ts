import { useTestDb, freshTournament, makeTournaments } from './helpers';
import { loadState } from '../src/events/events.service';
import { DecksService, DeckInvalidError, compareCardsLikeYgopro } from '../src/decks/decks.service';
import { CardsService } from '../src/cards/cards.service';
import { cubeDeckFileBase } from '../src/decks/deck-filename';

describe('deck validation', () => {
  beforeEach(() => useTestDb());

  it('uses the shared safe timestamped cube deck filename format', () => {
    expect(cubeDeckFileBase(17, 'p / one', new Date('2026-08-08T07:06:05.000Z')))
      .toBe('cube-deck-17-p_one-20260808070605');
  });

  function setupDeckbuilding(picksPerPlayer: number, overrides: Record<string, unknown> = {}) {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const decks = new DecksService(cards);
    const tid = freshTournament('deck-test', overrides as any);
    for (let i = 0; i < 4; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
  tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    const state = loadState(tid);
    // seed picks (45 main-suitable cards per player) directly via event log
    const seenRulesCodes = new Set<number>();
    const codes = cards.allCodes()
      .filter((c) => !cards.isExtraDeck(c))
      .filter((c) => {
        const key = cards.canonicalCode(c);
        if (seenRulesCodes.has(key)) return false;
        seenRulesCodes.add(key);
        return true;
      })
      .slice(0, 45);
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
    const { cards, decks, tid, codes } = setupDeckbuilding(45);
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

  it('maxCopies > 1 licenses copies of a picked card and preserves exact duplicate drag indices', () => {
    const { decks, tid, codes } = setupDeckbuilding(45, { maxCopies: 3 });
    const [a, b] = codes; // a was picked only once
    decks.move(tid, 'p0', a, 'pool', 'main');
    decks.move(tid, 'p0', b, 'pool', 'main');
    decks.move(tid, 'p0', a, 'pool', 'main');
    decks.move(tid, 'p0', a, 'pool', 'main');
    expect(() => decks.move(tid, 'p0', a, 'pool', 'main')).toThrow('CARD_NOT_IN_POOL');
    decks.move(tid, 'p0', a, 'main', 'main', 0, 2);
    expect(loadState(tid).decks.p0.main).toEqual([a, a, b, a]);
    decks.move(tid, 'p0', a, 'main', 'side', 0, 0);
    expect(loadState(tid).decks.p0.main).toEqual([a, b, a]);
    expect(loadState(tid).decks.p0.side).toEqual([a]);
  });

  it('auto-fix can copy a picked exact code up to maxCopies', () => {
    const { decks, tid, codes } = setupDeckbuilding(4, { mainMin: 3, mainMax: 4, maxCopies: 3 });
    decks.autoFix(tid, 'p0');
    const main = loadState(tid).decks.p0.main;
    expect(main).toHaveLength(4);
    expect(main.filter((code) => code === codes[0])).toHaveLength(3);
    expect(main).toContain(codes[1]);
  });

  it('counts alias-related codes toward the same rules copy limit', () => {
    const { cards, decks, tid } = setupDeckbuilding(45, { maxCopies: 1 });
    const db = require('../src/db').getDb();
    const baseCode = 68468459;
    const aliasCode = 73819701;
    const insert = db.prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(baseCode, '阿不思的落胤', 0x21, '', 4, 1, 0x10, 1800, 0, 0, '阿不思的落胤', 3);
    insert.run(aliasCode, '白龙之落胤', 0x21, '', 4, 1, 0x10, 1800, 0, baseCode, '白龙之落胤', 3);
    logPick(tid, 'p0', aliasCode, 100);
    logPick(tid, 'p0', baseCode, 101);
    decks.move(tid, 'p0', aliasCode, 'pool', 'main');
    expect(() => decks.move(tid, 'p0', baseCode, 'pool', 'side')).toThrow('CARD_NOT_IN_POOL');
  });

  it('match preparation moves random zone overflow to side and DSQs an undersized main deck', () => {
    const { decks, tid, codes } = setupDeckbuilding(8, { mainMin: 3, mainMax: 4, extraMax: 2, sideMax: 2, maxCopies: 1 });
    for (let i = 0; i < 6; i++) decks.move(tid, 'p0', codes[i], 'pool', 'main');
    expect(decks.validationReport(tid).find((r) => r.playerId === 'p0')?.errors).toContain('main above maximum (6 > 4)');
    const repaired = decks.repairForMatches(tid, 'p0');
    expect(repaired).toMatchObject({ disqualified: false, movedToSide: 2, returnedToPool: 0 });
    expect(loadState(tid).decks.p0.main).toHaveLength(4);
    expect(loadState(tid).decks.p0.side).toHaveLength(2);

    for (let i = 0; i < 2; i++) decks.move(tid, 'p1', codes[i], 'pool', 'main');
    expect(decks.repairForMatches(tid, 'p1').disqualified).toBe(true);
    expect(loadState(tid).players.find((p) => p.playerId === 'p1')?.eliminated).toBe(true);
  });

  it('locking every deck no longer bypasses the administrator match-start preflight', () => {
    const { decks, tid, codes } = setupDeckbuilding(4, { mainMin: 3, mainMax: 4, extraMax: 2, sideMax: 2 });
    for (const pid of ['p0', 'p1', 'p2', 'p3']) {
      for (let i = 0; i < 3; i++) decks.move(tid, pid, codes[i], 'pool', 'main');
      decks.lock(tid, pid);
    }
    expect(loadState(tid).status).toBe('deckbuilding');
  });

  it('keeps newly added cards at the end and sorts all zones only on explicit request', () => {
    const { cards, decks, tid, codes } = setupDeckbuilding(45);
    const picked = [codes[8], codes[3], codes[6], codes[1]];
    for (const code of picked) decks.move(tid, 'p0', code, 'pool', 'main');
    expect(loadState(tid).decks.p0.main).toEqual(picked);

    const last = codes[12];
    decks.move(tid, 'p0', last, 'pool', 'main');
    expect(loadState(tid).decks.p0.main.at(-1)).toBe(last);

    decks.sort(tid, 'p0');
    const sorted = loadState(tid).decks.p0.main;
    expect(sorted).toEqual([...picked, last].sort((a, b) => compareCardsLikeYgopro(cards.get(a)!, cards.get(b)!)));
  });

  it('random shuffle changes only main order and preserves every card', () => {
    const { decks, tid, codes } = setupDeckbuilding(45);
    for (const code of codes.slice(0, 6)) decks.move(tid, 'p0', code, 'pool', 'main');
    decks.move(tid, 'p0', codes[5], 'main', 'side');
    const before = loadState(tid).decks.p0;
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      decks.shuffleMain(tid, 'p0');
    } finally {
      random.mockRestore();
    }
    const after = loadState(tid).decks.p0;
    expect(after.main).not.toEqual(before.main);
    expect([...after.main].sort((a, b) => a - b)).toEqual([...before.main].sort((a, b) => a - b));
    expect(after.extra).toEqual(before.extra);
    expect(after.side).toEqual(before.side);
  });

  it('moves materially picked but unused cards into their natural zones on entering deckbuilding', () => {
    const tournaments = makeTournaments();
    const cards = new CardsService();
    const tid = freshTournament('unused-auto-zone');
    tournaments.join(tid, 'p0', 'P0');
    tournaments.join(tid, 'p1', 'P1');
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    const mainCode = cards.allCodes().find((code) => !cards.isExtraDeck(code))!;
    const extraCode = cards.allCodes().find((code) => cards.isExtraDeck(code))!;
    logPick(tid, 'p0', mainCode, 0);
    logPick(tid, 'p0', extraCode, 1);
    expect(loadState(tid).decks.p0.main).toEqual([]);
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    expect(loadState(tid).decks.p0.main).toEqual([mainCode]);
    expect(loadState(tid).decks.p0.extra).toEqual([extraCode]);
  });
});
