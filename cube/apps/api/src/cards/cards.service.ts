import { Injectable } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { config } from '../config';

// Card metadata: imported from cards.cdb (itself a sqlite db with datas/texts tables,
// aligned by rowid) — dev_docs/05 §8. Pics never stored here (dev_docs/06 §5).
export interface CardInfo {
  code: number;
  name: string;
  type: number;
  desc: string;
  level: number;
  lscale: number;
  rscale: number;
  linkMarkers: number;
  race: number;
  attribute: number;
  atk: number;
  def: number;
  alias: number;
  setCodes: number[];
  setNames: string[];
}

interface DataRow {
  id: number;
  type: number;
  level: number;
  race: number;
  attribute: number;
  atk: number;
  def: number;
  alias: number;
  setcode_text: string;
}

interface TextRow {
  id: number;
  name: string;
  desc: string;
}

interface CardRow {
  code: number;
  name: string;
  type: number;
  desc: string;
  level: number;
  race: number;
  attribute: number;
  atk: number;
  def: number;
  alias: number;
  lscale: number;
  rscale: number;
  link_markers: number;
  setcodes_json: string;
  setnames_json: string;
  search_text: string;
  metadata_version: number;
}

interface CountRow {
  c: number;
}

const CARD_METADATA_VERSION = 2;
const MONSTER = 0x1;

const RACE_NAMES: Record<number, string> = {
  0x1: '战士族', 0x2: '魔法师族', 0x4: '天使族', 0x8: '恶魔族', 0x10: '不死族', 0x20: '机械族',
  0x40: '水族', 0x80: '炎族', 0x100: '岩石族', 0x200: '鸟兽族', 0x400: '植物族', 0x800: '昆虫族',
  0x1000: '雷族', 0x2000: '龙族', 0x4000: '兽族', 0x8000: '兽战士族', 0x10000: '恐龙族',
  0x20000: '鱼族', 0x40000: '海龙族', 0x80000: '爬虫类族', 0x100000: '念动力族',
  0x200000: '幻神兽族', 0x400000: '创造神族', 0x800000: '幻龙族', 0x1000000: '电子界族', 0x2000000: '幻想魔族',
};
const ATTRIBUTE_NAMES: Record<number, string> = { 1: '地', 2: '水', 4: '炎', 8: '风', 16: '光', 32: '暗', 64: '神' };

function bitLabels(value: number, labels: Record<number, string>): string[] {
  return Object.entries(labels).filter(([bit]) => (value & Number(bit)) !== 0).map(([, label]) => label);
}

function typeLabels(type: number): string[] {
  const out: string[] = [];
  if (type & MONSTER) {
    if (type & 0x40) out.push('融合');
    if (type & 0x2000) out.push('同调');
    if (type & 0x800000) out.push('XYZ', '超量');
    if (type & 0x4000000) out.push('连接', 'Link');
    if (type & 0x1000000) out.push('灵摆');
    if (type & 0x1000) out.push('调整');
    if (type & 0x200000) out.push('反转');
    if (type & 0x10) out.push('通常');
    if (type & 0x20) out.push('效果');
    out.push('怪兽');
  } else if (type & 0x2) {
    if (type & 0x10000) out.push('速攻');
    else if (type & 0x20000) out.push('永续');
    else if (type & 0x40000) out.push('装备');
    else if (type & 0x80000) out.push('场地');
    if (type & 0x100000) out.push('仪式');
    out.push('魔法');
  } else if (type & 0x4) {
    if (type & 0x20000) out.push('永续');
    else if (type & 0x100000) out.push('反击');
    out.push('陷阱');
  }
  return out;
}

export function parseSetCodes(raw: string): number[] {
  let packed: bigint;
  try { packed = BigInt.asUintN(64, BigInt(raw || '0')); } catch { return []; }
  const out: number[] = [];
  for (let i = 0n; i < 4n; i++) {
    const code = Number((packed >> (i * 16n)) & 0xffffn);
    if (code) out.push(code);
  }
  return out;
}

export function decodeCardFields(type: number, packedLevelValue: number, rawDefense: number) {
  const packedLevel = Number(packedLevelValue ?? 0) >>> 0;
  return {
    level: packedLevel & 0xff,
    lscale: (packedLevel >>> 24) & 0xff,
    rscale: (packedLevel >>> 16) & 0xff,
    linkMarkers: type & 0x4000000 ? Number(rawDefense ?? 0) : 0,
    defense: Number(rawDefense ?? 0),
  };
}

function readSetNames(file: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^!setname\s+(0x[0-9a-fA-F]+|\d+)\s+([^\t\r\n]+)/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

function isExtraDeckType(type: number): boolean {
  // this codebase's TYPES_EXTRA_DECK (FUSION 0x40 | SYNCHRO 0x2000 | XYZ 0x800000 | LINK 0x4000000)
  return (type & 0x4802040) !== 0;
}

@Injectable()
export class CardsService {
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    const db = getDb();
    const count = (db.prepare('SELECT count(*) AS c FROM cards WHERE metadata_version>=?').get(CARD_METADATA_VERSION) as CountRow).c;
    if (count > 0) {
      this.loaded = true;
      return;
    }
    let cdbPath = config.server.cardsCdb;
    if (!fs.existsSync(cdbPath)) {
      cdbPath = path.join(__dirname, '..', '..', '..', '..', config.server.cardsCdb);
    }
    if (fs.existsSync(cdbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const cdb = new Database(cdbPath, { readonly: true });
      try {
        // cdb quirk: `id` is the INTEGER PRIMARY KEY (rowid alias) — select by `id`, not `rowid`
        const datas = cdb.prepare('SELECT id, type, level, race, attribute, atk, def, alias, CAST(setcode AS TEXT) AS setcode_text FROM datas').all() as DataRow[];
        const texts = cdb.prepare('SELECT id, name, desc FROM texts').all() as TextRow[];
        const setNameMap = readSetNames(config.server.stringsConf);
        const nameByRow = new Map<number, TextRow>();
        for (const t of texts) nameByRow.set(t.id, t);
        const insert = db.prepare(
          `INSERT OR REPLACE INTO cards
           (code, name, type, desc, level, lscale, rscale, link_markers, race, attribute, atk, def, alias,
            setcodes_json, setnames_json, search_text, metadata_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        db.transaction(() => {
          for (const d of datas) {
            const t = nameByRow.get(d.id);
            const { level, lscale, rscale, linkMarkers, defense } = decodeCardFields(d.type, d.level, d.def);
            const setCodes = parseSetCodes(d.setcode_text);
            const setNames = setCodes.map((c) => setNameMap.get(c)).filter((x): x is string => !!x);
            const labels = [
              t?.name ?? '', String(d.id), String(d.id).padStart(8, '0'), t?.desc ?? '',
              ...typeLabels(d.type), ...bitLabels(d.race ?? 0, RACE_NAMES), ...bitLabels(d.attribute ?? 0, ATTRIBUTE_NAMES),
              `等级 ${level}`, `星级 ${level}`, `攻击力 ${d.atk ?? 0}`,
              ...(d.type & 0x4000000 ? [] : [`守备力 ${defense}`]),
              ...(d.type & 0x800000 ? [`阶级 ${level}`, `RANK ${level}`] : []),
              ...(d.type & 0x4000000 ? [`LINK ${level}`, `LINK-${level}`, `连接标记 ${linkMarkers}`] : []),
              ...(d.type & 0x1000000 ? [`刻度 ${lscale} ${rscale}`] : []),
              ...setNames,
            ];
            insert.run(d.id, t?.name ?? '', d.type, t?.desc ?? '', level, lscale, rscale, linkMarkers,
              d.race ?? 0, d.attribute ?? 0, d.atk ?? 0, defense, d.alias ?? 0,
              JSON.stringify(setCodes), JSON.stringify(setNames), labels.join(' ').toLowerCase(), CARD_METADATA_VERSION);
          }
        })();
      } finally {
        cdb.close();
      }
    } else {
      // synthetic pool for tests/dev without a cdb
      const insert = db.prepare(`INSERT OR REPLACE INTO cards
        (code, name, type, desc, level, race, attribute, atk, def, alias, search_text, metadata_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        for (let i = 0; i < 300; i++) {
          // every 10th card is an extra-deck monster (XYZ 0x800000) for zone tests
          const type = i % 10 === 0 ? 0x800021 : 0x21;
          insert.run(10000 + i, `测试卡牌 ${i + 1}`, type, '测试用效果文本', 4, 0, 0, 1500, 1000, 0,
            `测试卡牌 ${i + 1} ${10000 + i} 测试用效果文本`, CARD_METADATA_VERSION);
        }
      })();
    }
    this.loaded = true;
  }

  allCodes(): number[] {
    this.ensureLoaded();
    return (getDb().prepare('SELECT code FROM cards').all() as CardRow[]).map((r) => r.code);
  }

  get(code: number): CardInfo | null {
    this.ensureLoaded();
    const r = getDb().prepare('SELECT * FROM cards WHERE code=?').get(code) as CardRow | undefined;
    if (!r) return null;
    // 异画卡（alias != 0）统一返回原始卡（编号最小者），显示 code 始终为原始 code
    if (r.alias !== 0) {
      const base = getDb().prepare('SELECT * FROM cards WHERE code=?').get(r.alias) as CardRow | undefined;
      if (base && base.alias === 0) return this.toInfo(base);
    }
    return this.toInfo(r);
  }

  /** Exact card-table row for a submitted code, without applying datas.alias. */
  getLiteral(code: number): CardInfo | null {
    this.ensureLoaded();
    const r = getDb().prepare('SELECT * FROM cards WHERE code=?').get(code) as CardRow | undefined;
    return r ? this.toInfo(r) : null;
  }

  private toInfo(r: CardRow): CardInfo {
    return {
      code: r.code,
      name: r.name,
      type: r.type,
      desc: r.desc ?? '',
      level: r.level ?? 0,
      lscale: r.lscale ?? 0,
      rscale: r.rscale ?? 0,
      linkMarkers: r.link_markers ?? 0,
      race: r.race ?? 0,
      attribute: r.attribute ?? 0,
      atk: r.atk ?? 0,
      def: r.def ?? 0,
      alias: r.alias ?? 0,
      setCodes: JSON.parse(r.setcodes_json ?? '[]'),
      setNames: JSON.parse(r.setnames_json ?? '[]'),
    };
  }

  // 异画卡（alias 指向原始卡）→ 返回原始卡 code；否则原样返回
  canonicalCode(code: number): number {
    const r = getDb().prepare('SELECT code, alias FROM cards WHERE code=?').get(code) as { code: number; alias: number } | undefined;
    if (r && r.alias !== 0) return r.alias;
    return code;
  }

  // 卡池用码表：只含原始卡（异画并入原始，去重），且排除 token 卡（0x4000）
  poolCodes(): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const code of this.allCodes()) {
      const c = this.canonicalCode(code);
      if (seen.has(c)) continue;
      const info = this.get(c);
      if (!info) continue;
      if (info.type & 0x4000) continue; // token 不允许进入卡池
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  isExtraDeck(code: number): boolean {
    const c = this.get(code);
    return c ? isExtraDeckType(c.type) : false;
  }

  search(q: string, limit = 50): CardInfo[] {
    this.ensureLoaded();
    const like = `%${q.toLowerCase()}%`;
    // 全文本匹配：卡名/效果/编号以及所有前端展示的规范化标签。
    const rows = getDb()
      .prepare('SELECT * FROM cards WHERE search_text LIKE ? LIMIT ?')
      .all(like, limit) as CardRow[];
    // 搜索结果同样规范化：异画并到原始卡（显示 code 恒为原始 code），按 code 去重
    const dedup = new Map<number, CardInfo>();
    for (const r of rows) {
      const c = this.get(r.code);
      if (c) dedup.set(c.code, c);
    }
    return [...dedup.values()];
  }

  // resolve a card image under a ygopro root: <root>/pics/<code>.jpg,
  // <root>/expansions/pics/<code>.jpg, or <root>/expansions/<pack>/pics/<code>.jpg
  resolvePicPath(code: number): string | null {
    const root = config.pics.ygoproRoot;
    if (!root || !fs.existsSync(root)) return null;
    const candidates = [
      path.join(root, 'pics', `${code}.jpg`),
      path.join(root, 'expansions', 'pics', `${code}.jpg`),
    ];
    const expansions = path.join(root, 'expansions');
    if (fs.existsSync(expansions)) {
      try {
        for (const entry of fs.readdirSync(expansions)) {
          candidates.push(path.join(expansions, entry, 'pics', `${code}.jpg`));
        }
      } catch {
        // ignore unreadable expansion dirs
      }
    }
    return candidates.find((c) => fs.existsSync(c)) ?? null;
  }

  // low-res avif thumbnail stored server-side: <avifDir>/<code>.avif (dev_docs/06 §5)
  resolveAvifPath(code: number): string | null {
    const dir = config.pics.avifDir;
    if (!dir || !fs.existsSync(dir)) return null;
    const file = path.join(dir, `${code}.avif`);
    return fs.existsSync(file) ? file : null;
  }
}
