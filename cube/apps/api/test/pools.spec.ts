import { useTestDb } from './helpers';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';

describe('card pools', () => {
  beforeEach(() => useTestDb());

  it('creates a pool from codes and resolves it (alt-art canonicalized)', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const codes = cards.poolCodes().slice(0, 10);
    const { pool } = pools.create('small', codes);
    expect(pool.codes.length).toBe(10);
    expect(pools.codesByName('small')).toEqual(codes);
    expect(pools.resolve('small')!.length).toBe(10);
    expect(pools.resolve('full').length).toBeGreaterThan(100);
    expect(() => pools.resolve('missing')).toThrow('POOL_NOT_FOUND');
  });

  it('alt-art codes are canonicalized to the original card', () => {
    const cards = new CardsService();
    const db = require('../src/db').getDb();
    const alt = db.prepare('SELECT code, alias FROM cards WHERE alias != 0 LIMIT 1').get() as { code: number; alias: number } | undefined;
    if (!alt) {
      // synthetic pool has no aliases; skip
      expect(true).toBe(true);
      return;
    }
    expect(cards.canonicalCode(alt.code)).toBe(alt.alias);
    const info = cards.get(alt.code);
    expect(info!.code).toBe(alt.alias);
  });

  it('random pool samples from the full card table with dedupe', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const { pool } = pools.createRandom('sample-1000', 1000);
    expect(pool.codes.length).toBe(Math.min(1000, cards.poolCodes().length));
    expect(new Set(pool.codes).size).toBe(pool.codes.length);
  });

  it('rejects duplicate names and removes pools', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    pools.create('dup', [1, 2, 3]);
    expect(() => pools.create('dup', [4])).toThrow('POOL_EXISTS');
    const id = pools.list()[0].id;
    pools.remove(id);
    expect(pools.list().length).toBe(0);
  });

  it('persists one default pool and clears the setting when that pool is removed', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const first = pools.create('first', cards.poolCodes().slice(0, 5)).pool;
    const second = pools.create('second', cards.poolCodes().slice(5, 10)).pool;
    expect(pools.defaultPool()).toBeNull();
    expect(pools.setDefaultPool(second.id)).toEqual({ id: second.id, name: 'second' });
    expect(pools.list().find((p) => p.id === second.id)?.isDefault).toBe(true);
    expect(pools.list().find((p) => p.id === first.id)?.isDefault).toBe(false);
    pools.remove(second.id);
    expect(pools.defaultPool()).toBeNull();
  });

  it('token cards are filtered out with a warning count', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const tokenCode = 10000 + Math.floor(Math.random() * 300);
    // synthetic pool has no tokens; with the real cdb there are token-typed cards
    const db = require('../src/db').getDb();
    const token = db.prepare('SELECT code FROM cards WHERE (type & 0x4000) != 0 LIMIT 1').get() as { code: number } | undefined;
    if (!token) {
      expect(true).toBe(true);
      return;
    }
    const { pool, filtered } = pools.create('tok', [token.code, cards.poolCodes()[0]]);
    expect(filtered).toBeGreaterThan(0);
    expect(pool.codes.includes(token.code)).toBe(false);
  });

  it('reports every unique unknown submitted code instead of silently dropping it', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const validCode = cards.poolCodes()[0];
    const unknownA = 999_999_991;
    const unknownB = 999_999_992;
    const { pool, missingCodes } = pools.create('with-missing', [validCode, unknownA, unknownA, unknownB]);
    expect(pool.codes).toEqual([validCode]);
    expect(missingCodes).toEqual([unknownA, unknownB]);
  });

  it('imports code or code<TAB>name and reports every bad source line', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const [first, second] = cards.poolCodes().slice(0, 2);
    const firstName = cards.get(first)!.name;
    const unknown = 999_999_993;
    const result = pools.createFromText('named-import', [
      String(first),
      `${second}\t错误卡名`,
      `${unknown}\t不存在`,
      'not-a-code',
      `${first}\t${firstName}`,
    ].join('\n'));
    expect(result.pool.codes).toEqual([first, second]);
    expect(result.missingCodes).toEqual([unknown]);
    expect(result.entryWarnings).toEqual([
      expect.objectContaining({ line: 2, kind: 'name_mismatch', code: second, submittedName: '错误卡名', actualName: cards.get(second)!.name }),
      expect.objectContaining({ line: 3, kind: 'missing_code', code: unknown }),
      expect.objectContaining({ line: 4, kind: 'invalid', input: 'not-a-code' }),
    ]);
  });

  it('validates an aliased code against its literal name, not its rules-treated name', () => {
    const cards = new CardsService();
    cards.poolCodes(); // initialize the synthetic card table before adding fixtures
    const db = require('../src/db').getDb();
    const baseCode = 68_468_459;
    const submittedCode = 73_819_701;
    const insert = db.prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(baseCode, '阿不思的落胤', 0x21, '', 4, 1, 0x10, 1800, 0, 0, '阿不思的落胤', 2);
    insert.run(submittedCode, '白龙之落胤', 0x21, '', 4, 1, 0x10, 1800, 0, baseCode, '白龙之落胤', 2);
    const pools = new PoolsService(cards);

    const literal = pools.createFromText('literal-alias-name', `${submittedCode}\t白龙之落胤`);
    expect(literal.entryWarnings).toEqual([]);

    const rulesName = pools.createFromText('rules-alias-name', `${submittedCode}\t阿不思的落胤`);
    expect(rulesName.entryWarnings).toEqual([
      expect.objectContaining({
        line: 1,
        kind: 'name_mismatch',
        code: submittedCode,
        submittedName: '阿不思的落胤',
        actualName: '白龙之落胤',
      }),
    ]);
  });

  it('rejects a wholly malformed text import with the complete warning report', () => {
    const pools = new PoolsService(new CardsService());
    try {
      pools.createFromText('bad-import', 'bad\n123\t\n');
      throw new Error('expected BAD_POOL_IMPORT');
    } catch (error) {
      expect((error as Error).message).toBe('BAD_POOL_IMPORT');
      expect((error as Error & { details: unknown[] }).details).toHaveLength(2);
    }
  });

  it('cards carry effect text (desc) after import', () => {
    const cards = new CardsService();
    const code = cards.allCodes()[0];
    const info = cards.get(code);
    expect(info).not.toBeNull();
    expect(typeof info!.desc).toBe('string');
  });
});
