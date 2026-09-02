import fs from 'fs';
import path from 'path';
import { decodeCardFields, parseSetCodes, CardsService, readCardNameEntries, readCardNameMap, selectYgocdbCardName } from '../src/cards/cards.service';
import { config } from '../src/config';
import { useTestDb } from './helpers';
import { getDb } from '../src/db';

describe('ygopro card metadata decoding', () => {
  beforeEach(() => useTestDb());

  it('selects literal names in sc/md/jp priority order and ignores blank values', () => {
    expect(selectYgocdbCardName({ sc_name: '  简体名  ', md_name: 'Master Duel', jp_name: '日本語' })).toBe('简体名');
    expect(selectYgocdbCardName({ sc_name: ' \t', md_name: '  Master Duel  ', jp_name: '日本語' })).toBe('Master Duel');
    expect(selectYgocdbCardName({ sc_name: '', md_name: ' ', jp_name: ' 日本語 ' })).toBe('日本語');
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

  it('uses mapped names for CDB rows and never falls back to texts.name', () => {
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
      expect(cards.get(900000013)?.name).toBe('');
      expect(cards.search('简体名称').map((card) => card.code)).toEqual([900000010]);
      for (const alias of ['中文名称', '论坛名称', 'OCG 名称', 'JP 假名', 'JP 名称', 'English Name']) {
        expect(cards.search(alias).map((card) => card.code)).toEqual([900000010]);
      }
      expect(cards.search('CDB 名称')).toEqual([]);
    } finally {
      config.server.cardsCdb = originalCdb;
      config.server.cardNamesJson = originalNames;
      fs.rmSync(cdbPath, { force: true });
      fs.rmSync(namesPath, { force: true });
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
    insert.run(700000010, '链一', 0x21, '', 4, 1, 1, 0, 0, 700000011, '链一', 5);
    insert.run(700000011, '链二', 0x21, '', 4, 1, 1, 0, 0, 700000012, '链二', 5);
    insert.run(700000012, '链三', 0x21, '', 4, 1, 1, 0, 0, 0, '链三', 5);
    expect(cards.canonicalCode(700000010)).toBe(700000012);
    insert.run(700000012, '链三', 0x21, '', 4, 1, 1, 0, 0, 700000010, '链三', 5);
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
