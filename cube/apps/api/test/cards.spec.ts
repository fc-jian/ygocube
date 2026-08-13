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
    expect(cards.canonicalCode(700000010)).toBe(700000010);
    expect(cards.canonicalCode(700000011)).toBe(700000010);
  });
});
