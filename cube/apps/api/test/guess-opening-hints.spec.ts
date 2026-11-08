import { buildOpeningHintOptions, drawOpeningHints } from '../src/guess/opening-hints';

const dragon = { code: 89631139, type: 0x11, level: 8, atk: 3000, def: 2500, attribute: 0x10, setCodes: [0xdd], alias: 0 };
const link = { code: 99999991, type: 0x4000021, level: 2, atk: 1600, def: 9000, attribute: 0x20, setCodes: [0x112], alias: 0 };
const xyz = {
  code: 99999992, type: 0x800021, level: 4, atk: -2, def: -2, attribute: 0x8, setCodes: [0x2a, 0x102a],
  alias: dragon.code, aliasKind: 'rule' as const,
};
const spell = { code: 99999993, type: 2, level: 0, atk: 0, def: 0, attribute: 0, setCodes: [0x20], alias: 0 };
const trap = { code: 99999994, type: 0x20004, level: 4, atk: 1600, def: 1900, attribute: 1, setCodes: [], alias: 0 };
const cards = [dragon, link, xyz, spell, trap];

describe('Guess opening hint options', () => {
  it('counts all twelve methods and excludes other seats from the candidate counts', () => {
    const answers = [dragon.code, link.code, spell.code];
    const { options: [dragonHints, linkHints, spellHints], pools } = buildOpeningHintOptions(cards, answers);
    expect(Object.fromEntries(dragonHints.map(({ method, group, candidateCount }) => [method, [group, candidateCount]]))).toEqual({
      deck: ['main-monster', 1], level: ['high-level', 1], attribute: ['light-wind', 2], attack: ['high-attack', 1],
      'summon-value': ['value-7-plus', 1], defense: ['high-defense', 1], 'release-era': ['through-2014', 1],
      'field-deck': ['field-main-monster', 1], 'field-size': ['small-field', 2], frame: ['regular-frame', 1],
      'combat-value': ['high-combat-value', 1], 'light-dark': ['light-dark', 1],
    });
    expect(linkHints).toEqual(expect.arrayContaining([
      { method: 'level', group: 'no-level', candidateCount: 2 },
      { method: 'summon-value', group: 'value-1-3', candidateCount: 1 },
      { method: 'defense', group: 'low-defense', candidateCount: 2 },
      { method: 'combat-value', group: 'medium-combat-value', candidateCount: 1 },
    ]));
    expect(linkHints.some(({ method }) => method === 'release-era')).toBe(false);
    expect(spellHints).toContainEqual({ method: 'deck', group: 'spell-trap', candidateCount: 2 });
    expect(spellHints).toContainEqual({ method: 'field-deck', group: 'field-spell-trap', candidateCount: 1 });
    const drawn = drawOpeningHints(cards, answers);
    drawn.hints.forEach((hint, index) => {
      expect([dragonHints, linkHints, spellHints][index]).toContainEqual(hint);
      expect(drawn.pools[hint.group]).toEqual(pools[hint.group]);
    });
  });

  it('uses the largest field per card, counts a base field once and handles unprinted values', () => {
    const extra = Array.from({ length: 13 }, (_, i) => ({ ...spell, code: 99999900 + i, setCodes: [0x112] }));
    const medium = Array.from({ length: 11 }, (_, i) => ({ ...spell, code: 99999920 + i, setCodes: [0x2a] }));
    const shared = { ...link, setCodes: [0x112, 0x2a] };
    const { options: [linkHints, xyzHints, trapHints] } = buildOpeningHintOptions(
      [shared, xyz, trap, ...extra, ...medium], [shared.code, xyz.code, trap.code],
    );
    expect(linkHints).toContainEqual({ method: 'field-size', group: 'large-field', candidateCount: 14 });
    expect(xyzHints).toContainEqual({ method: 'field-size', group: 'medium-field', candidateCount: 12 });
    expect(xyzHints).toContainEqual({ method: 'attack', group: 'low-attack', candidateCount: 1 });
    expect(xyzHints).toContainEqual({ method: 'combat-value', group: 'low-combat-value', candidateCount: 1 });
    expect(xyzHints).toHaveLength(11);
    expect(trapHints).toContainEqual({ method: 'defense', group: 'spell-trap', candidateCount: 25 });
    expect(trapHints).toContainEqual({ method: 'field-deck', group: 'no-field', candidateCount: 1 });
  });
});
