import fs from 'fs';
import path from 'path';
import { cardAliasKind, decodeCardFields, parseSetCodes, CardsService, readCardNameEntries, readCardNameMap, selectYgocdbCardName } from '../src/cards/cards.service';
import { config } from '../src/config';
import { useTestDb } from './helpers';
import { getDb } from '../src/db';

describe('ygopro card metadata decoding', () => {
  beforeEach(() => useTestDb());

  it('selects literal names through the complete localized fallback order', () => {
    expect(selectYgocdbCardName({ sc_name: '  简体名  ', md_name: 'Master Duel', jp_name: '日本語' })).toBe('简体名');
    expect(selectYgocdbCardName({ sc_name: ' \t', md_name: '  Master Duel  ', jp_name: '日本語' })).toBe('Master Duel');
    expect(selectYgocdbCardName({ sc_name: '', md_name: ' ', jp_name: ' 日本語 ' })).toBe('日本語');
    expect(selectYgocdbCardName({ sc_name: '', md_name: '', jp_name: ' ', cn_name: ' 中文后备名 ', en_name: 'English fallback' })).toBe('中文后备名');
    expect(selectYgocdbCardName({ sc_name: '', md_name: '', jp_name: '', cn_name: ' \t', en_name: ' English fallback ' })).toBe('English fallback');
    expect(selectYgocdbCardName({ sc_name: '', md_name: '', jp_name: ' ' })).toBe('');
  });

  it('reads a code-to-name mapping from object or array exports', () => {
    const file = path.join('/tmp', `ygocube-card-names-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({
      first: { id: 900000001, sc_name: '第一名称', md_name: '备用名称' },
      second: { id: '900000002', sc_name: '', md_name: '第二名称' },
      ignored: { id: 0, jp_name: '无效' },
    }));
    try {
      expect([...readCardNameMap(file).entries()]).toEqual([
        [900000001, '第一名称'],
        [900000002, '第二名称'],
      ]);
      expect(readCardNameEntries(file).get(900000001)?.searchNames).toEqual(['第一名称', '备用名称']);
    } finally {
      fs.rmSync(file, { force: true });
    }
    const arrayFile = path.join('/tmp', `ygocube-card-names-array-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(arrayFile, JSON.stringify([{ id: 900000003, jp_name: '数组名称' }]));
    try {
      expect(readCardNameMap(arrayFile).get(900000003)).toBe('数组名称');
    } finally {
      fs.rmSync(arrayFile, { force: true });
    }
  });

  it('prefers mapped names and falls back to the literal CDB name', () => {
    const cdbPath = path.join('/tmp', `ygocube-card-cdb-${process.pid}-${Date.now()}.cdb`);
    const namesPath = path.join('/tmp', `ygocube-card-names-${process.pid}-${Date.now()}.json`);
    const Database = require('better-sqlite3');
    const cdb = new Database(cdbPath);
    cdb.exec('CREATE TABLE datas (id INTEGER PRIMARY KEY, type INTEGER, level INTEGER, race INTEGER, attribute INTEGER, atk INTEGER, def INTEGER, alias INTEGER, setcode INTEGER)');
    cdb.exec('CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT)');
    const add = cdb.prepare('INSERT INTO datas (id,type,level,race,attribute,atk,def,alias,setcode) VALUES (?,?,?,?,?,?,?,?,?)');
    const addText = cdb.prepare('INSERT INTO texts (id,name,desc) VALUES (?,?,?)');
    for (const id of [900000010, 900000011, 900000012, 900000013]) {
      add.run(id, 0x21, 4, 1, 1, 1500, 1000, 0, 0);
      addText.run(id, `CDB 名称 ${id}`, `效果 ${id}`);
    }
    cdb.close();
    fs.writeFileSync(namesPath, JSON.stringify({
      a: {
        id: 900000010,
        cn_name: '中文名称',
        sc_name: '简体名称',
        md_name: 'MD 名称',
        nwbbs_n: '论坛名称',
        cnocg_n: 'OCG 名称',
        jp_ruby: 'JP 假名',
        jp_name: 'JP 名称',
        en_name: 'English Name',
      },
      b: { id: 900000011, sc_name: ' ', md_name: 'MD 名称' },
      c: { id: 900000012, sc_name: '', md_name: '', jp_name: '其他日文名称' },
      d: { id: 900000013, sc_name: '', md_name: '', jp_name: '' },
    }));
    const originalCdb = config.server.cardsCdb;
    const originalNames = config.server.cardNamesJson;
    config.server.cardsCdb = cdbPath;
    config.server.cardNamesJson = namesPath;
    try {
      const cards = new CardsService();
      expect(cards.get(900000010)?.name).toBe('简体名称');
      expect(cards.get(900000011)?.name).toBe('MD 名称');
      expect(cards.get(900000012)?.name).toBe('其他日文名称');
      expect(cards.get(900000013)?.name).toBe('CDB 名称 900000013');
      expect(cards.search('简体名称').map((card) => card.code)).toEqual([900000010]);
      for (const alias of ['中文名称', '论坛名称', 'OCG 名称', 'JP 假名', 'JP 名称', 'English Name']) {
        expect(cards.search(alias).map((card) => card.code)).toEqual([900000010]);
      }
      expect(cards.search('CDB 名称 900000013').map((card) => card.code)).toEqual([900000013]);
    } finally {
      config.server.cardsCdb = originalCdb;
      config.server.cardNamesJson = originalNames;
      fs.rmSync(cdbPath, { force: true });
      fs.rmSync(namesPath, { force: true });
    }
  });

  it('distinguishes artwork names from rules-name aliases without changing exact identities', () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'ygocube-artwork-'));
    const cdbPath = path.join(dir, 'cards.cdb');
    const namesPath = path.join(dir, 'names.json');
    const Database = require('better-sqlite3');
    const cdb = new Database(cdbPath);
    cdb.exec('CREATE TABLE datas (id INTEGER PRIMARY KEY, type INTEGER, level INTEGER, race INTEGER, attribute INTEGER, atk INTEGER, def INTEGER, alias INTEGER, setcode INTEGER)');
    cdb.exec('CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT)');
    for (const [id, alias] of [[1000,0],[1001,1000],[1002,1000],[1019,1000],[1020,1000],[2000,1000],[3001,3000]]) {
      cdb.prepare('INSERT INTO datas VALUES (?,33,4,1,1,1500,1000,?,0)').run(id, alias);
      cdb.prepare('INSERT INTO texts VALUES (?,?,?)').run(id, `CDB-${id}`, `Effect-${id}`);
    }
    cdb.close();
    fs.writeFileSync(namesPath, JSON.stringify([
      {id:1000,sc_name:'原版译名',en_name:'OriginalName'},
      {id:1002,sc_name:'异画独立译名'},
      {id:2000,sc_name:'规则卡独立译名'},
    ]));
    const originalCdb = config.server.cardsCdb, originalNames = config.server.cardNamesJson;
    config.server.cardsCdb = cdbPath; config.server.cardNamesJson = namesPath;
    try {
      const cards = new CardsService();
      expect(cards.get(1001)).toMatchObject({code:1001,name:'原版译名',alias:1000,aliasKind:'artwork',aliasName:'原版译名',desc:'Effect-1001'});
      expect(cards.get(1002)?.name).toBe('异画独立译名');
      expect(cards.get(1019)?.aliasKind).toBe('artwork');
      expect(cards.get(1020)).toMatchObject({name:'CDB-1020',aliasKind:'rule'});
      expect(cards.get(2000)).toMatchObject({name:'规则卡独立译名',aliasKind:'rule',aliasName:'原版译名'});
      expect(cards.get(3001)?.name).toBe('CDB-3001');
      expect(cards.search('OriginalName').map(c=>c.code).sort()).toEqual([1000,1001,1002,1019]);
      expect(cards.search('1001').some(c=>c.code===1001)).toBe(true);
      expect(cards.canonicalCode(1001)).toBe(1000);
      expect(cards.canonicalCode(2000)).toBe(1000);
      expect(cardAliasKind(5405695,5405694)).toBe('rule');
      expect(cardAliasKind(1000,1000)).toBeUndefined();
    } finally {
      config.server.cardsCdb = originalCdb; config.server.cardNamesJson = originalNames;
      fs.rmSync(dir, {recursive:true,force:true});
    }
  });

  it('rebuilds the metadata cache when a deployed CDB is replaced', () => {
    const cdbPath = path.join('/tmp', `ygocube-card-refresh-${process.pid}-${Date.now()}.cdb`);
    const namesPath = path.join('/tmp', `ygocube-card-refresh-names-${process.pid}-${Date.now()}.json`);
    const Database = require('better-sqlite3');
    const writeCdb = (rows: Array<[number, string]>) => {
      fs.rmSync(cdbPath, { force: true });
      const cdb = new Database(cdbPath);
      cdb.exec('CREATE TABLE datas (id INTEGER PRIMARY KEY, type INTEGER, level INTEGER, race INTEGER, attribute INTEGER, atk INTEGER, def INTEGER, alias INTEGER, setcode INTEGER)');
      cdb.exec('CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT)');
      const add = cdb.prepare('INSERT INTO datas (id,type,level,race,attribute,atk,def,alias,setcode) VALUES (?,?,?,?,?,?,?,?,?)');
      const addText = cdb.prepare('INSERT INTO texts (id,name,desc) VALUES (?,?,?)');
      for (const [id, name] of rows) {
        add.run(id, 0x21, 4, 1, 1, 1500, 1000, 0, 0);
        addText.run(id, name, `效果 ${id}`);
      }
      cdb.close();
    };
    writeCdb([[900000020, '旧卡']]);
    fs.writeFileSync(namesPath, JSON.stringify({
      a: { id: 900000020, sc_name: '旧卡名' },
      b: { id: 900000021, sc_name: '新卡名' },
    }));
    const originalCdb = config.server.cardsCdb;
    const originalNames = config.server.cardNamesJson;
    config.server.cardsCdb = cdbPath;
    config.server.cardNamesJson = namesPath;
    try {
      expect(new CardsService().get(900000020)?.name).toBe('旧卡名');
      writeCdb([[900000020, '旧卡'], [900000021, '新卡']]);
      const refreshed = new CardsService();
      expect(refreshed.get(900000021)?.name).toBe('新卡名');
    } finally {
      config.server.cardsCdb = originalCdb;
      config.server.cardNamesJson = originalNames;
      fs.rmSync(cdbPath, { force: true });
      fs.rmSync(namesPath, { force: true });
    }
  });

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
    insert.run(700000010, '链一', 0x21, '', 4, 1, 1, 0, 0, 700000011, '链一', 6);
    insert.run(700000011, '链二', 0x21, '', 4, 1, 1, 0, 0, 700000012, '链二', 6);
    insert.run(700000012, '链三', 0x21, '', 4, 1, 1, 0, 0, 0, '链三', 6);
    expect(cards.getMany([700000010])[0].aliasName).toBe('链二');
    expect(cards.getMany([700000012])[0].aliasName).toBe('');
    expect(cards.canonicalCode(700000010)).toBe(700000012);
    insert.run(700000012, '链三', 0x21, '', 4, 1, 1, 0, 0, 700000010, '链三', 6);
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

  it('never returns token/derivative cards from user-facing search', () => {
    const cards = new CardsService();
    cards.poolCodes();
    const insert = getDb().prepare(`INSERT OR REPLACE INTO cards
      (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(710000100, '可搜索的普通卡', 0x21, '', 4, 1, 1, 0, 0, 0, 'only-searchable', 5);
    insert.run(710000101, '不应出现的衍生物', 0x4011, '', 1, 1, 1, 0, 0, 0, 'only-searchable', 5);
    expect(cards.search('only-searchable').map((card) => card.code)).toEqual([710000100]);
    expect(cards.poolCodes()).not.toContain(710000101);
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


describe('expansion catalogue', () => {
  beforeEach(() => useTestDb());
  it('loads host overlays, searches new cards, rejects tokens and removes withdrawn cards on rebuild', () => {
    const dir = fs.mkdtempSync('/tmp/ygocube-expansion-');
    const old = config.server.cardsCdb;
    const Database = require('better-sqlite3');
    const write = (name: string, rows: [number, string, number][]) => {
      const cdb = new Database(path.join(dir, name));
      cdb.exec('CREATE TABLE datas (id INTEGER PRIMARY KEY, type INTEGER, level INTEGER, race INTEGER, attribute INTEGER, atk INTEGER, def INTEGER, alias INTEGER, setcode INTEGER); CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT)');
      for (const [id, name, type] of rows) {
        cdb.prepare('INSERT INTO datas VALUES (?, ?, 4, 1, 1, 1500, 1000, 0, 0)').run(id, type);
        cdb.prepare('INSERT INTO texts VALUES (?, ?, ?)').run(id, name, name + '效果');
      }
      cdb.close();
    };
    try {
      fs.mkdirSync(path.join(dir, 'expansions'));
      write('cards.cdb', [[100200001, '原版', 33]]);
      write('expansions/test-release.cdb', [[100200002, '先行怪兽Ａ', 33], [100200003, '先行衍生物', 0x4001]]);
      write('expansions/test-update.cdb', [[100200001, '更新版', 33]]);
      config.server.cardsCdb = path.join(dir, 'cards.cdb');
      const cards = new CardsService();
      expect(cards.get(100200001)?.desc).toBe('更新版效果');
      expect(cards.search('先行怪兽').map(c => c.code)).toEqual([100200002]);
      expect(cards.search('先行怪兽Ａ').map(c => c.code)).toEqual([100200002]);
      expect(cards.search('先行怪兽A').map(c => c.code)).toEqual([100200002]);
      expect(cards.search('100200002').map(c => c.code)).toEqual([100200002]);
      expect(cards.search('先行衍生物')).toEqual([]);
      expect(cards.get(100200002)?.type).toBe(33);
      const expansion = new Database(path.join(dir, 'expansions/test-release.cdb'));
      expansion.exec("ALTER TABLE texts ADD COLUMN str1 TEXT; UPDATE texts SET str1='先行效果选项' WHERE id=100200002");
      expansion.close();
      const { DuelService } = require('../src/duel/duel.service');
      const duel = new DuelService(cards);
      expect(duel.descriptions([100200002 * 16])[100200002 * 16]).toBe('先行效果选项');
      const { PoolsService } = require('../src/pools/pools.service');
      expect(new PoolsService(cards).create('expansion-test', [100200002]).pool.codes).toEqual([100200002]);
      fs.unlinkSync(path.join(dir, 'expansions/test-release.cdb'));
      expect(new CardsService().get(100200002)).toBeNull();
      fs.writeFileSync(path.join(dir, 'expansions/broken.cdb'), 'invalid');
      expect(() => new CardsService().get(100200001)).toThrow();
      expect(getDb().prepare('SELECT desc FROM cards WHERE code=100200001').get()).toEqual({desc: '更新版效果'});
    } finally {
      config.server.cardsCdb = old;
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
