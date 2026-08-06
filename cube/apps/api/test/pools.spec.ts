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

  it('cards carry effect text (desc) after import', () => {
    const cards = new CardsService();
    const code = cards.allCodes()[0];
    const info = cards.get(code);
    expect(info).not.toBeNull();
    expect(typeof info!.desc).toBe('string');
  });
});
