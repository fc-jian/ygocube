import { decodeCardFields, parseSetCodes, CardsService } from '../src/cards/cards.service';
import { useTestDb } from './helpers';
import { getDb } from '../src/db';

describe('ygopro card metadata decoding', () => {
  beforeEach(() => useTestDb());

  it('unpacks level and both pendulum scales from the cdb level field', () => {
    expect(decodeCardFields(0x1000001, (8 << 24) | (1 << 16) | 4, 1200)).toEqual({
      level: 4,
      lscale: 8,
      rscale: 1,
      linkMarkers: 0,
      defense: 1200,
    });
  });

  it('keeps Link markers for display and raw defense sorting compatibility', () => {
    expect(decodeCardFields(0x4000021, 3, 0xa3)).toEqual({
      level: 3,
      lscale: 0,
      rscale: 0,
      linkMarkers: 0xa3,
      defense: 0xa3,
    });
  });

  it('decodes all four packed set codes without signed-64-bit loss', () => {
    const packed = (0x9002n << 48n) | (0x31n << 32n) | (0x20n << 16n) | 0x1n;
    expect(parseSetCodes(packed.toString())).toEqual([0x1, 0x20, 0x31, 0x9002]);
    expect(parseSetCodes(BigInt.asIntN(64, packed).toString())).toEqual([0x1, 0x20, 0x31, 0x9002]);
  });

  it('returns exact card metadata including race, attribute, and fields', () => {
    const cards = new CardsService();
    cards.poolCodes();
    getDb().prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias,
       setcodes_json, setnames_json, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      700000001, '字段测试卡', 0x21, '效果', 4, 0x2001, 0x21, 1800, 1200, 0,
      '[1,32]', '["正义盟军","测试字段"]', '字段测试卡 0x1 0x20', 3,
    );
    expect(cards.get(700000001)).toMatchObject({
      code: 700000001,
      name: '字段测试卡',
      race: 0x2001,
      attribute: 0x21,
      setCodes: [1, 32],
      setNames: ['正义盟军', '测试字段'],
    });
  });

  it('batch-loads exact codes in request order and removes duplicates/unknowns', () => {
    const cards = new CardsService();
    const [first, second] = cards.poolCodes().slice(0, 2);
    expect(cards.getMany([second, first, second, -1, 999_999_999]).map((card) => card.code))
      .toEqual([second, first]);
  });

  it('resolves alias chains and terminates cyclic alias data deterministically', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const db = getDb();
    const insert = db.prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(700000010, '链一', 0x21, '', 4, 1, 1, 0, 0, 700000011, '链一', 3);
    insert.run(700000011, '链二', 0x21, '', 4, 1, 1, 0, 0, 700000012, '链二', 3);
    insert.run(700000012, '链三', 0x21, '', 4, 1, 1, 0, 0, 0, '链三', 3);
    expect(cards.canonicalCode(700000010)).toBe(700000012);
    insert.run(700000012, '链三', 0x21, '', 4, 1, 1, 0, 0, 700000010, '链三', 3);
    // Card metadata is immutable after startup in production, so canonical
    // chains are cached per service instance. A fresh instance models a
    // metadata reload after this direct test-fixture mutation.
    const reloaded = new CardsService();
    expect(reloaded.canonicalCode(700000010)).toBe(700000010);
    expect(reloaded.canonicalCode(700000011)).toBe(700000010);
  });

  it('searches every keyword without an implicit result cap', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const insert = getDb().prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 60; i++) {
      insert.run(710000000 + i, `未截断卡 ${i}`, 0x21, '', 4, 1, 1, 0, 0, 0, `uncapped ${i}`, 3);
    }
    expect(cards.search('uncapped')).toHaveLength(60);
    expect(cards.search('uncapped').length).toBeGreaterThan(50);
  });

  it('requires all keywords and ranks literal name matches by count and keyword order', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const insert = getDb().prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(700000100, 'Alpha Beta', 0x21, '', 4, 1, 1, 0, 0, 0, 'alpha beta', 3);
    insert.run(700000101, 'Alpha Card', 0x21, '', 4, 1, 1, 0, 0, 0, 'alpha card beta', 3);
    insert.run(700000102, 'Beta Card', 0x21, '', 4, 1, 1, 0, 0, 0, 'beta card alpha', 3);
    insert.run(700000103, 'Neutral Card', 0x21, 'alpha beta', 4, 1, 1, 0, 0, 0, 'neutral card alpha beta', 3);
    insert.run(700000104, 'Alpha Only', 0x21, '', 4, 1, 1, 0, 0, 0, 'alpha only', 3);

    expect(cards.search('alpha beta').map((card) => card.code)).toEqual([
      700000100, // both keywords are in the literal name
      700000101, // first keyword is in the name
      700000102, // only the second keyword is in the name
      700000103, // both keywords are non-name matches
    ]);
    expect(cards.search('alpha beta').some((card) => card.code === 700000104)).toBe(false);
  });
});
