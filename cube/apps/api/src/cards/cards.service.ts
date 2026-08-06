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
  race: number;
  attribute: number;
  atk: number;
  def: number;
  alias: number;
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
}

interface CountRow {
  c: number;
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
    const count = (db.prepare('SELECT count(*) AS c FROM cards').get() as CountRow).c;
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
        const datas = cdb.prepare('SELECT id, type, level, race, attribute, atk, def, alias FROM datas').all() as DataRow[];
        const texts = cdb.prepare('SELECT id, name, desc FROM texts').all() as TextRow[];
        const nameByRow = new Map<number, TextRow>();
        for (const t of texts) nameByRow.set(t.id, t);
        const insert = db.prepare(
          'INSERT OR REPLACE INTO cards (code, name, type, desc, level, race, attribute, atk, def, alias) VALUES (?,?,?,?,?,?,?,?,?,?)',
        );
        db.transaction(() => {
          for (const d of datas) {
            const t = nameByRow.get(d.id);
            insert.run(d.id, t?.name ?? '', d.type, t?.desc ?? '', d.level ?? 0, d.race ?? 0, d.attribute ?? 0, d.atk ?? 0, d.def ?? 0, d.alias ?? 0);
          }
        })();
      } finally {
        cdb.close();
      }
    } else {
      // synthetic pool for tests/dev without a cdb
      const insert = db.prepare('INSERT OR REPLACE INTO cards (code, name, type) VALUES (?,?,?)');
      db.transaction(() => {
        for (let i = 0; i < 300; i++) {
          // every 10th card is an extra-deck monster (XYZ 0x800000) for zone tests
          const type = i % 10 === 0 ? 0x800021 : 0x21;
          insert.run(10000 + i, `测试卡牌 ${i + 1}`, type, '测试用效果文本', 4, 0, 0, 1500, 1000, 0);
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
    const r = getDb().prepare('SELECT code, name, type, desc, level, race, attribute, atk, def, alias FROM cards WHERE code=?').get(code) as CardRow | undefined;
    if (!r) return null;
    // 异画卡（alias != 0）统一返回原始卡（编号最小者），显示 code 始终为原始 code
    if (r.alias !== 0) {
      const base = getDb().prepare('SELECT code, name, type, desc, level, race, attribute, atk, def, alias FROM cards WHERE code=?').get(r.alias) as CardRow | undefined;
      if (base && base.alias === 0) return this.toInfo(base);
    }
    return this.toInfo(r);
  }

  private toInfo(r: CardRow): CardInfo {
    return {
      code: r.code,
      name: r.name,
      type: r.type,
      desc: r.desc ?? '',
      level: r.level ?? 0,
      race: r.race ?? 0,
      attribute: r.attribute ?? 0,
      atk: r.atk ?? 0,
      def: r.def ?? 0,
      alias: r.alias ?? 0,
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
    const like = `%${q}%`;
    // 全文本匹配：卡名 / 效果文本 / 编号（dev_docs/05 §6）
    const rows = getDb()
      .prepare('SELECT code, name, type, desc, level, race, attribute, atk, def, alias FROM cards WHERE name LIKE ? OR desc LIKE ? OR code LIKE ? LIMIT ?')
      .all(like, like, like, limit) as CardRow[];
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
