import { useTestDb, TEST_POOL } from './helpers';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';
import { TournamentsService } from '../src/tournaments/tournaments.service';
import { ApiController } from '../src/api.controller';
import { AuthGuard } from '../src/auth/auth.guard';
import { Reflector } from '@nestjs/core';
import { config } from '../src/config';

function makeAuthContext(path: string, headers: Record<string, string>, method = 'POST') {
  const req: any = { path, headers, query: {}, body: {}, method, cookies: {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

describe('card pools', () => {
  beforeEach(() => useTestDb());

  it('creates a pool from exact codes and resolves it', () => {
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

  it('keeps an aliased card exact while exposing its rules identity separately', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const db = require('../src/db').getDb();
    const baseCode = 68468459;
    const aliasCode = 73819701;
    const insert = db.prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(baseCode, '阿不思的落胤', 0x21, '', 4, 1, 0x10, 1800, 0, 0, '阿不思的落胤', 3);
    insert.run(aliasCode, '白龙之落胤', 0x21, '', 4, 1, 0x10, 1800, 0, baseCode, '白龙之落胤', 3);
    expect(cards.canonicalCode(aliasCode)).toBe(baseCode);
    const info = cards.get(aliasCode);
    expect(info!.code).toBe(aliasCode);
  });

  it('keeps both alias-related cards in a pool and in search results', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const db = require('../src/db').getDb();
    const baseCode = 68_468_459;
    const aliasCode = 73_819_701;
    const insert = db.prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(baseCode, '阿不思的落胤', 0x21, '', 4, 1, 0x10, 1800, 0, 0, '阿不思的落胤', 3);
    insert.run(aliasCode, '白龙之落胤', 0x21, '这个卡名在规则上当作「阿不思的落胤」使用。', 4, 1, 0x10, 1800, 0, baseCode, '白龙之落胤 阿不思的落胤', 3);
    const pools = new PoolsService(cards);
    const pool = pools.create('both-alias-cards', [baseCode, aliasCode]).pool;
    expect(pool.codes).toEqual([baseCode, aliasCode]);
    expect(cards.search('白龙之落胤').map((card) => [card.code, card.name])).toContainEqual([aliasCode, '白龙之落胤']);
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
    const codes = cards.poolCodes();
    pools.create('dup', codes.slice(0, 3));
    expect(() => pools.create('dup', codes.slice(3, 4))).toThrow('POOL_EXISTS');
    const id = pools.list()[0].id;
    pools.remove(id);
    expect(pools.list().length).toBe(0);
  });

  it('accepts URL-safe pool names and rejects spaces/path/query/control characters', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const code = cards.poolCodes()[0];
    for (const name of ['A1', 'cube.v2', 'cube_v2', 'cube-v2']) {
      expect(pools.create(name, [code]).pool.name).toBe(name);
    }
    for (const name of ['', ' leading', 'trailing ', 'has space', 'a/b', 'a?b', 'a#b', 'a\nnew', 'x'.repeat(65)]) {
      expect(() => pools.create(name, [code])).toThrow('BAD_POOL_NAME');
    }
  });

  it('rejects empty/random-invalid pools and protects pools used by active tournaments', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    expect(() => pools.create('empty', [999_999_999])).toThrow('BAD_POOL_IMPORT');
    expect(() => pools.createRandom('random-zero', 0)).toThrow('BAD_PAYLOAD');
    expect(() => pools.createRandom('random-fraction', 1.5)).toThrow('BAD_PAYLOAD');

    const pool = pools.create('active-pool', cards.poolCodes().slice(0, 8)).pool;
    const tournaments = new TournamentsService(pools);
    const tid = tournaments.create({ name: 'active', maxPlayers: 2, cardPool: pool.name }, 'test').tid;
    try {
      pools.remove(pool.id);
      fail('expected POOL_IN_USE');
    } catch (error: any) {
      expect(error.message).toBe('POOL_IN_USE');
      expect(error.details).toMatchObject({ poolId: pool.id, tournaments: [{ id: tid, name: 'active', status: 'registration' }] });
    }
    tournaments.setPhase(tid, 'drafting', undefined, 'test');
    tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
    tournaments.setPhase(tid, 'finished', undefined, 'test');
    expect(() => pools.remove(pool.id)).not.toThrow();
    expect(() => pools.remove(pool.id)).toThrow('POOL_NOT_FOUND');
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

  it('creates an empty candidate pool and appends exact codes without duplicates', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const [mainCode, candidateCode] = cards.poolCodes().slice(0, 2);
    const pool = pools.create('candidate-empty', [mainCode]).pool;
    expect(pool.candidateCodes).toEqual([]);
    expect(pools.candidatePoolInfo(pool.name)).toMatchObject({
      poolId: pool.id,
      poolName: pool.name,
      poolCount: 1,
      candidateCount: 0,
      codes: [],
    });

    const first = pools.addCandidates(pool.name, [candidateCode, candidateCode]);
    expect(first.addedCodes).toEqual([candidateCode]);
    expect(first.alreadyCandidateCodes).toEqual([]);
    expect(first.codes).toEqual([candidateCode]);
    const second = pools.addCandidates(pool.name, [candidateCode]);
    expect(second.addedCodes).toEqual([]);
    expect(second.alreadyCandidateCodes).toEqual([candidateCode]);
    expect(pools.get(pool.id)?.candidateCodes).toEqual([candidateCode]);
  });

  it('never adds main-pool, missing, or token codes to the candidate pool', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const [mainCode, candidateCode] = cards.poolCodes().slice(0, 2);
    const tokenCode = 799999998;
    cards.poolCodes();
    require('../src/db').getDb().prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tokenCode, '候选衍生物', 0x4011, '', 1, 1, 1, 0, 0, 0, '候选衍生物', 3);
    const pool = pools.create('candidate-filter', [mainCode]).pool;
    const result = pools.addCandidates(pool.name, [mainCode, candidateCode, 999999999, tokenCode]);
    expect(result.addedCodes).toEqual([candidateCode]);
    expect(result.inPoolCodes).toEqual([mainCode]);
    expect(result.missingCodes).toEqual([999999999]);
    expect(result.filtered).toBe(1);
    expect(pools.get(pool.id)?.candidateCodes).toEqual([candidateCode]);
  });

  it('removes promoted candidate codes atomically when the main pool is updated', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const [mainCode, candidateCode, otherCode] = cards.poolCodes().slice(0, 3);
    const pool = pools.create('candidate-promote', [mainCode]).pool;
    pools.addCandidates(pool.name, [candidateCode, otherCode]);
    const result = pools.update(pool.id, [mainCode, candidateCode]);
    expect(result.candidateRemovedCodes).toEqual([candidateCode]);
    expect(result.pool.codes).toEqual([mainCode, candidateCode]);
    expect(result.pool.candidateCodes).toEqual([otherCode]);
    const row = require('../src/db').getDb().prepare('SELECT candidate_codes_json FROM card_pools WHERE id=?').get(pool.id) as { candidate_codes_json: string };
    expect(JSON.parse(row.candidate_codes_json)).toEqual([otherCode]);
  });

  it('returns three exact-code membership statuses for candidate search', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const [mainCode, candidateCode, absentCode] = cards.poolCodes().slice(0, 3);
    const pool = pools.create('candidate-status', [mainCode]).pool;
    pools.addCandidates(pool.name, [candidateCode]);
    const controller = new ApiController(null as any, null as any, null as any, null as any, cards, pools, null as any, null as any);
    const rows = controller.candidatePoolCards(pool.name, undefined as any, `${mainCode},${candidateCode},${absentCode}`) as any[];
    expect(rows.map((row) => [row.code, row.poolStatus, row.inPool, row.inCandidate])).toEqual([
      [mainCode, 'in_pool', true, false],
      [candidateCode, 'in_candidate', false, true],
      [absentCode, 'not_in_pool', false, false],
    ]);
  });

  it('exposes candidate preview metadata and protects the append endpoint at the controller boundary', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    const [mainCode, candidateCode] = cards.poolCodes().slice(0, 2);
    const pool = pools.create('candidate-controller', [mainCode]).pool;
    const controller = new ApiController(null as any, null as any, null as any, null as any, cards, pools, null as any, null as any);
    expect(controller.candidatePoolPreview(pool.name)).toMatchObject({
      poolId: pool.id,
      poolName: pool.name,
      candidateCount: 0,
      candidateUrl: `/pool/${pool.name}/candidate`,
    });
    expect(() => controller.addCandidateCards({ identity: undefined } as any, pool.name, { codes: [candidateCode] })).toThrow('AUTH_REQUIRED');
    const added = controller.addCandidateCards({ identity: { playerId: 'alice' } } as any, pool.name, { codes: [candidateCode] });
    expect(added.addedCodes).toEqual([candidateCode]);
  });

  it('requires a valid player token for candidate writes, including no-token tournaments', () => {
    const cards = new CardsService();
    const pools = new PoolsService(cards);
    pools.create(TEST_POOL, cards.poolCodes());
    const tournaments = new TournamentsService(pools);
    const tid = tournaments.create({ name: 'candidate-auth', maxPlayers: 2, cardPool: TEST_POOL }, 'test').tid;
    const player = tournaments.join(tid, 'alice', 'Alice');
    const guard = new AuthGuard(new Reflector());
    expect(() => guard.canActivate(makeAuthContext('/pools/test-pool/candidate/cards', {
      'x-tournament-id': String(tid),
      'x-player-id': 'alice',
    }))).toThrow();
    expect(guard.canActivate(makeAuthContext('/pools/test-pool/candidate/cards', {
      'x-tournament-id': String(tid),
      'x-player-id': 'alice',
      'x-token': player.token,
    }))).toBe(true);
    expect(() => guard.canActivate(makeAuthContext('/pools/test-pool/candidate/cards', {
      'x-tournament-id': String(tid),
      'x-player-id': 'alice',
      'x-token': config.admin.superToken,
    }))).toThrow();
    tournaments.setAuthRequired(tid, false, 'test');
    expect(() => guard.canActivate(makeAuthContext('/pools/test-pool/candidate/cards', {
      'x-tournament-id': String(tid),
      'x-player-id': 'alice',
    }))).toThrow();
    expect(guard.canActivate(makeAuthContext('/pools/test-pool/candidate/cards', {
      'x-tournament-id': String(tid),
      'x-player-id': 'alice',
      'x-token': player.token,
    }))).toBe(true);
  });

  it('token cards are filtered out with a warning count', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const pools = new PoolsService(cards);
    const db = require('../src/db').getDb();
    const tokenCode = 799999999;
    db.prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tokenCode, '测试衍生物', 0x4011, '', 1, 1, 1, 0, 0, 0, '测试衍生物', 3);
    const { pool, filtered } = pools.create('tok', [tokenCode, cards.poolCodes()[0]]);
    expect(filtered).toBeGreaterThan(0);
    expect(pool.codes.includes(tokenCode)).toBe(false);
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
    insert.run(baseCode, '阿不思的落胤', 0x21, '', 4, 1, 0x10, 1800, 0, 0, '阿不思的落胤', 3);
    insert.run(submittedCode, '白龙之落胤', 0x21, '', 4, 1, 0x10, 1800, 0, baseCode, '白龙之落胤', 3);
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
