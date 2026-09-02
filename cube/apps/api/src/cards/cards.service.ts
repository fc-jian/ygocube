import { Injectable } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { config } from '../config';
import type { CardPickStat } from './card-pick-stats.service';

// Card metadata: structural/effect data is imported from cards.cdb (itself a
// sqlite db with datas/texts tables, aligned by rowid).  The browser-visible
// card name is deliberately sourced from the external ygocdb mapping instead
// of cards.cdb's localized texts.name; this keeps literal names consistent
// across the API, pool imports, search and the web client.
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
  /** Only populated by public pool-card responses; false means search hit is outside the pool. */
  inPool?: boolean;
  inCandidate?: boolean;
  poolStatus?: 'in_pool' | 'not_in_pool' | 'in_candidate';
  pickStats?: CardPickStat[];
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

interface CardCacheVersionRow {
  c: number;
  current: number;
}

// Re-index existing card caches when the imported search/field metadata shape
// or the card-name source changes instead of serving a partially populated old
// cache.  Version 5 stores the display name and all localized name variants
// from ygocdb_cards in the searchable index.
const CARD_METADATA_VERSION = 5;
const MONSTER = 0x1;

type YgocdbCardRecord = {
  id?: unknown;
  cn_name?: unknown;
  sc_name?: unknown;
  md_name?: unknown;
  nwbbs_n?: unknown;
  cnocg_n?: unknown;
  jp_ruby?: unknown;
  jp_name?: unknown;
  en_name?: unknown;
};

export interface CardNameEntry {
  /** Name shown to users (sc_name -> md_name -> jp_name). */
  displayName: string;
  /** Every localized/printed name used by card search, in source order. */
  searchNames: string[];
}

const CARD_NAME_FIELDS = [
  'cn_name', 'sc_name', 'md_name', 'nwbbs_n', 'cnocg_n', 'jp_ruby', 'jp_name', 'en_name',
] as const;

/**
 * Select the literal name exposed to clients from one ygocdb record.
 * Whitespace-only values are treated as missing so a blank sc_name cannot
 * mask a useful md_name or jp_name.
 */
export function selectYgocdbCardName(record: YgocdbCardRecord | null | undefined): string {
  for (const key of ['sc_name', 'md_name', 'jp_name'] as const) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function cardNameEntry(record: YgocdbCardRecord): CardNameEntry {
  const searchNames: string[] = [];
  const seen = new Set<string>();
  for (const key of CARD_NAME_FIELDS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    searchNames.push(name);
  }
  return { displayName: selectYgocdbCardName(record), searchNames };
}

/**
 * Read the code -> card-name index used by the API.  The source
 * file is intentionally a runtime asset (assets/ is not tracked by Git), so
 * malformed or unavailable files fail closed to an empty map rather than
 * allowing cards.cdb names to leak back into the browser.
 */
export function readCardNameEntries(file: string): Map<number, CardNameEntry> {
  const out = new Map<number, CardNameEntry>();
  if (!file || !fs.existsSync(file)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`card name mapping parse failed (${file}):`, (error as Error).message);
    return out;
  }
  const records: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>)
      : [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as YgocdbCardRecord;
    const id = typeof record.id === 'number'
      ? record.id
      : typeof record.id === 'string' && /^\d+$/.test(record.id.trim())
        ? Number(record.id)
        : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const entry = cardNameEntry(record);
    // A malformed export can contain the same code more than once. Prefer a
    // non-empty name while retaining the first-seen value for deterministic
    // results when both records are populated.
    const previous = out.get(id);
    if (!previous) {
      out.set(id, entry);
      continue;
    }
    const mergedNames = [...previous.searchNames];
    const seen = new Set(mergedNames);
    for (const name of entry.searchNames) {
      if (!seen.has(name)) {
        seen.add(name);
        mergedNames.push(name);
      }
    }
    out.set(id, {
      displayName: previous.displayName || entry.displayName,
      searchNames: mergedNames,
    });
  }
  return out;
}

/** Read only the exact-code -> display-name portion of the name index. */
export function readCardNameMap(file: string): Map<number, string> {
  return new Map([...readCardNameEntries(file)].map(([id, entry]) => [id, entry.displayName]));
}

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
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*!setname\s+(0x[0-9a-fA-F]+|\d+)\s+([^\t\r\n]+)/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

function resolveStringsConf(configured: string, cdbPath: string): string {
  const candidates = [
    configured,
    path.join(path.dirname(cdbPath), 'strings.conf'),
    path.join(process.cwd(), 'ygopro', 'strings.conf'),
    path.join(process.cwd(), 'srvpro', 'ygopro', 'strings.conf'),
  ].filter(Boolean);
  return candidates.find((candidate, index) => candidates.indexOf(candidate) === index && fs.existsSync(candidate)) ?? '';
}

function isExtraDeckType(type: number): boolean {
  // this codebase's TYPES_EXTRA_DECK (FUSION 0x40 | SYNCHRO 0x2000 | XYZ 0x800000 | LINK 0x4000000)
  return (type & 0x4802040) !== 0;
}

@Injectable()
export class CardsService {
  private loaded = false;
  private readonly canonicalCodes = new Map<number, number>();
  private readonly cardSearchNames = new Map<number, string[]>();
  private cdbMetadataLoaded = false;
  private expansionPicDirs: string[] | null = null;

  private ensureLoaded(): void {
    if (this.loaded) return;
    const db = getDb();
    let cdbPath = config.server.cardsCdb;
    if (!fs.existsSync(cdbPath)) {
      cdbPath = path.join(__dirname, '..', '..', '..', '..', config.server.cardsCdb);
    }
    this.cdbMetadataLoaded = fs.existsSync(cdbPath);
    // Load the name index even when the metadata rows are already current so
    // ranking can recognize localized aliases without another database read.
    const cardNameEntries = readCardNameEntries(config.server.cardNamesJson);
    this.cardSearchNames.clear();
    for (const [code, entry] of cardNameEntries) this.cardSearchNames.set(code, entry.searchNames);
    const cache = db.prepare(
      'SELECT count(*) AS c, sum(CASE WHEN metadata_version>=? THEN 1 ELSE 0 END) AS current FROM cards',
    ).get(CARD_METADATA_VERSION) as CardCacheVersionRow;
    // The SQLite cache does not know when cards.cdb is replaced by a resource
    // deployment.  Re-index a real CDB on every process start so newly synced
    // rows and changed text are visible immediately; retain the early return
    // only for the synthetic test/dev catalogue used when no CDB is present.
    if (!this.cdbMetadataLoaded && cache.c > 0 && cache.current === cache.c) {
      this.loaded = true;
      return;
    }
    if (fs.existsSync(cdbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const cdb = new Database(cdbPath, { readonly: true });
      try {
        // cdb quirk: `id` is the INTEGER PRIMARY KEY (rowid alias) — select by `id`, not `rowid`
        const datas = cdb.prepare('SELECT id, type, level, race, attribute, atk, def, alias, CAST(setcode AS TEXT) AS setcode_text FROM datas').all() as DataRow[];
        const texts = cdb.prepare('SELECT id, desc FROM texts').all() as TextRow[];
        if (cardNameEntries.size === 0) {
          console.warn(`card name mapping is empty or unavailable (${config.server.cardNamesJson}); cards will be exposed without localized names`);
        }
        const setNameMap = readSetNames(resolveStringsConf(config.server.stringsConf, cdbPath));
        const nameByRow = new Map<number, TextRow>();
        for (const t of texts) nameByRow.set(t.id, t);
        const insert = db.prepare(
          `INSERT OR REPLACE INTO cards
           (code, name, type, desc, level, lscale, rscale, link_markers, race, attribute, atk, def, alias,
            setcodes_json, setnames_json, search_text, metadata_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        db.transaction(() => {
          // A metadata rebuild is a snapshot replacement, not an upsert. If a
          // newer cards.cdb removed an entry, retaining the stale old row would
          // make it searchable and eligible for future pools indefinitely.
          db.prepare('DELETE FROM cards').run();
          for (const d of datas) {
            const t = nameByRow.get(d.id);
            // Do not fall back to texts.name: the mapping is the sole source
            // of browser-visible names.  Unknown records stay searchable by
            // code/metadata but never reintroduce the CDB localization.
            const literalName = cardNameEntries.get(d.id)?.displayName ?? '';
            const { level, lscale, rscale, linkMarkers, defense } = decodeCardFields(d.type, d.level, d.def);
            const setCodes = parseSetCodes(d.setcode_text);
            const setNames = setCodes.map((c) => setNameMap.get(c)).filter((x): x is string => !!x);
            const labels = [
              ...(cardNameEntries.get(d.id)?.searchNames ?? []),
              literalName, String(d.id), String(d.id).padStart(8, '0'), t?.desc ?? '',
              ...typeLabels(d.type), ...bitLabels(d.race ?? 0, RACE_NAMES), ...bitLabels(d.attribute ?? 0, ATTRIBUTE_NAMES),
              `等级 ${level}`, `星级 ${level}`, `攻击力 ${d.atk ?? 0}`,
              ...(d.type & 0x4000000 ? [] : [`守备力 ${defense}`]),
              ...(d.type & 0x800000 ? [`阶级 ${level}`, `RANK ${level}`] : []),
              ...(d.type & 0x4000000 ? [`LINK ${level}`, `LINK-${level}`, `连接标记 ${linkMarkers}`] : []),
              ...(d.type & 0x1000000 ? [`刻度 ${lscale} ${rscale}`] : []),
              ...setNames,
              ...setCodes.flatMap((code) => [String(code), `0x${code.toString(16)}`]),
            ];
            insert.run(d.id, literalName, d.type, t?.desc ?? '', level, lscale, rscale, linkMarkers,
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
        db.prepare('DELETE FROM cards').run();
        for (let i = 0; i < 500; i++) {
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
    return (getDb().prepare('SELECT code FROM cards ORDER BY code').all() as CardRow[]).map((r) => r.code);
  }

  get(code: number): CardInfo | null {
    this.ensureLoaded();
    const r = getDb().prepare('SELECT * FROM cards WHERE code=?').get(code) as CardRow | undefined;
    if (!r) return null;
    return this.toInfo(r);
  }

  /** Batch exact-code lookup while preserving first-seen request order. */
  getMany(codes: readonly number[]): CardInfo[] {
    this.ensureLoaded();
    const requested = [...new Set(codes.filter((code) => Number.isSafeInteger(code) && code > 0))];
    if (requested.length === 0) return [];
    const byCode = new Map<number, CardRow>();
    // Stay below conservative SQLite bind-variable limits used by older builds.
    for (let offset = 0; offset < requested.length; offset += 500) {
      const batch = requested.slice(offset, offset + 500);
      const placeholders = batch.map(() => '?').join(',');
      const rows = getDb().prepare(`SELECT * FROM cards WHERE code IN (${placeholders})`).all(...batch) as CardRow[];
      for (const row of rows) byCode.set(row.code, row);
    }
    return requested.map((code) => byCode.get(code)).filter((row): row is CardRow => !!row).map((row) => this.toInfo(row));
  }

  /** Exact card-table row for a submitted code, without applying datas.alias. */
  getLiteral(code: number): CardInfo | null {
    this.ensureLoaded();
    const r = getDb().prepare('SELECT * FROM cards WHERE code=?').get(code) as CardRow | undefined;
    return r ? this.toInfo(r) : null;
  }

  private toInfo(r: CardRow): CardInfo {
    const parseArray = (raw: string | null | undefined): unknown[] => {
      try {
        const value = JSON.parse(raw ?? '[]');
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    };
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
      setCodes: parseArray(r.setcodes_json).filter((value): value is number => typeof value === 'number'),
      setNames: parseArray(r.setnames_json).filter((value): value is string => typeof value === 'string'),
    };
  }

  // Resolve the YGOPro rules identity without changing the externally visible
  // card identity. Alias chains are unusual but possible in imported data;
  // the visited set prevents malformed cycles from looping forever.
  canonicalCode(code: number): number {
    this.ensureLoaded();
    const cached = this.canonicalCodes.get(code);
    if (cached !== undefined) return cached;
    let current = code;
    const visited = new Set<number>();
    while (!visited.has(current)) {
      visited.add(current);
      const r = getDb().prepare('SELECT alias FROM cards WHERE code=?').get(current) as { alias: number } | undefined;
      if (!r || !r.alias || r.alias === current) {
        for (const visitedCode of visited) this.canonicalCodes.set(visitedCode, current);
        return current;
      }
      current = r.alias;
    }
    // Malformed cyclic alias data still needs one stable rules key so that
    // copy-limit accounting cannot depend on which member was queried first.
    const canonical = Math.min(...visited);
    for (const visitedCode of visited) this.canonicalCodes.set(visitedCode, canonical);
    return canonical;
  }

  // Card-pool identity is the exact printed code. `datas.alias` is a rules
  // relationship, not a reason to remove a physical card from a cube.
  poolCodes(): number[] {
    this.ensureLoaded();
    return (getDb().prepare('SELECT code FROM cards WHERE (type & 0x4000)=0 ORDER BY code').all() as { code: number }[])
      .map((row) => row.code);
  }

  isExtraDeck(code: number): boolean {
    const c = this.get(code);
    return c ? isExtraDeckType(c.type) : false;
  }

  /**
   * Search literal card rows by an AND query and rank name hits first.
   *
   * The old implementation treated the whole query as one substring and
   * applied a default LIMIT 50.  That made a normal space-separated query
   * fail and silently hid cards after the first page (the draft UI then cut
   * that result to 30 as well).  Search is intentionally uncapped by default;
   * callers that need a bounded result can still pass an explicit limit.
   *
   * Ranking is deterministic:
   *  1. cards matching more query tokens in the literal card name;
   *  2. for ties, a name hit on an earlier token wins;
   *  3. code order is the stable final tie-breaker.
   * A card only enters the result when every token occurs somewhere in its
   * indexed text (name, description, fields, type/stat labels, or code).
   */
  search(q: string, limit?: number): CardInfo[] {
    this.ensureLoaded();
    const tokens = [...new Set(String(q ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .trim()
      .split(/\s+/u)
      .filter(Boolean))];
    if (!tokens.length) return [];

    // search_text is normalized at import time. Escape LIKE metacharacters so
    // a user searching for '%' or '_' still gets literal matching semantics.
    const escapeLike = (token: string) => token.replace(/[\\%_]/g, '\\$&');
    const clauses = tokens.map(() => "search_text LIKE ? ESCAPE '\\'").join(' AND ');
    const rows = getDb()
      .prepare(`SELECT * FROM cards WHERE ${clauses}`)
      .all(...tokens.map((token) => `%${escapeLike(token)}%`)) as CardRow[];

    const ranked = rows.map((row) => {
      const names = (this.cardSearchNames.get(row.code) ?? (this.cdbMetadataLoaded ? [] : [row.name ?? '']))
        .map((name) => name.normalize('NFKC').toLowerCase());
      // A token counts as a name hit when it occurs in any localized name,
      // while the display name remains the sc/md/jp fallback selected above.
      const nameMatches = tokens.map((token) => names.some((name) => name.includes(token)));
      return { row, nameMatches, nameMatchCount: nameMatches.filter(Boolean).length };
    });
    ranked.sort((a, b) => {
      if (a.nameMatchCount !== b.nameMatchCount) return b.nameMatchCount - a.nameMatchCount;
      for (let i = 0; i < tokens.length; i++) {
        if (a.nameMatches[i] !== b.nameMatches[i]) return a.nameMatches[i] ? -1 : 1;
      }
      return a.row.code - b.row.code;
    });

    const infos = ranked.map(({ row }) => this.toInfo(row));
    if (limit === undefined || !Number.isFinite(limit)) return infos;
    return infos.slice(0, Math.max(0, Math.floor(limit)));
  }

  // resolve a card image under a ygopro root: <root>/pics/<code>.jpg,
  // <root>/expansions/pics/<code>.jpg, or <root>/expansions/<pack>/pics/<code>.jpg
  resolvePicPath(code: number): string | null {
    const root = config.pics.ygoproRoot;
    if (!root || !fs.existsSync(root)) return null;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return null;
    }
    const candidates = [
      path.join(root, 'pics', `${code}.jpg`),
      path.join(root, 'expansions', 'pics', `${code}.jpg`),
    ];
    if (this.expansionPicDirs === null) {
      const expansions = path.join(root, 'expansions');
      this.expansionPicDirs = [];
      if (fs.existsSync(expansions)) {
        try {
          this.expansionPicDirs = fs.readdirSync(expansions)
            .map((entry) => path.join(expansions, entry, 'pics'));
        } catch {
          // Ignore unreadable expansion dirs. This immutable deployment asset
          // list is rebuilt when the process restarts.
        }
      }
    }
    for (const dir of this.expansionPicDirs) candidates.push(path.join(dir, `${code}.jpg`));
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const real = fs.realpathSync(candidate);
        if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) return real;
      } catch {
        // A disappearing or unreadable asset is treated as not found.
      }
    }
    return null;
  }

  // low-res avif thumbnail stored server-side: <avifDir>/<code>.avif (dev_docs/06 §5)
  resolveAvifPath(code: number): string | null {
    const dir = config.pics.avifDir;
    if (!dir || !fs.existsSync(dir)) return null;
    const file = path.join(dir, `${code}.avif`);
    if (!fs.existsSync(file)) return null;
    try {
      const root = fs.realpathSync(dir);
      const real = fs.realpathSync(file);
      return real === root || real.startsWith(`${root}${path.sep}`) ? real : null;
    } catch {
      return null;
    }
  }
}
