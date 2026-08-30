import { Injectable } from '@nestjs/common';
import { getDb } from '../db';
import { CardsService } from '../cards/cards.service';

// Card pools: a main pool is a plain-text list of card codes (one per line) or
// a random sample from the full card table (dev_docs/05 §9.3), managed by the
// super admin. Each row also owns an append-only candidate list that players
// may contribute to through the public candidate endpoint.
export interface CardPool {
  id: number;
  name: string;
  codes: number[];
  /** Append-only suggestions bound to this main pool. */
  candidateCodes: number[];
  createdAt: string;
}

// Pool names are used directly as public URL path segments. Keep the policy
// deliberately narrower than encodeURIComponent so every generated link is
// stable and cannot introduce another path/query segment.
export const POOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_POOL_CODES = 100_000;
const MAX_CANDIDATE_CODES_PER_REQUEST = 500;

export function normalizePoolName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('BAD_POOL_NAME');
  if (!POOL_NAME_PATTERN.test(value)) throw new Error('BAD_POOL_NAME');
  return value;
}

export interface PoolImportReport {
  /** Token cards that exist in the card database but cannot be drafted. */
  filtered: number;
  /** Submitted card codes that do not exist in the loaded card database. */
  missingCodes: number[];
  /** Every malformed, missing, or name-mismatched source line (1-based). */
  entryWarnings: PoolImportEntryWarning[];
}

export interface PoolImportEntryWarning {
  line: number;
  input: string;
  kind: 'invalid' | 'missing_code' | 'name_mismatch';
  code?: number;
  submittedName?: string;
  actualName?: string;
}

interface PoolImportEntry {
  code: number;
  line: number;
  input: string;
  submittedName?: string;
}

interface PoolRow {
  id: number;
  name: string;
  codes_json: string;
  created_at: string;
  candidate_codes_json: string | null;
}

export interface CandidatePoolInfo {
  poolId: number;
  poolName: string;
  poolCount: number;
  candidateCount: number;
  codes: number[];
}

export interface CandidatePoolAddResult extends CandidatePoolInfo {
  addedCodes: number[];
  alreadyCandidateCodes: number[];
  inPoolCodes: number[];
  missingCodes: number[];
  filtered: number;
}

@Injectable()
export class PoolsService {
  constructor(private cards: CardsService) {}

  private parseCodes(raw: string | null | undefined): number[] {
    try {
      const value = JSON.parse(raw ?? '[]');
      return Array.isArray(value)
        ? [...new Set(value.filter((code): code is number => Number.isSafeInteger(code) && code > 0))]
        : [];
    } catch {
      return [];
    }
  }

  private toPool(row: PoolRow): CardPool {
    return {
      id: row.id,
      name: row.name,
      codes: this.parseCodes(row.codes_json),
      candidateCodes: this.parseCodes(row.candidate_codes_json),
      createdAt: row.created_at,
    };
  }

  private candidateInfo(pool: CardPool): CandidatePoolInfo {
    return {
      poolId: pool.id,
      poolName: pool.name,
      poolCount: pool.codes.length,
      candidateCount: pool.candidateCodes.length,
      codes: [...pool.candidateCodes],
    };
  }

  list(): { id: number; name: string; count: number; candidateCount: number; createdAt: string; isDefault: boolean; url: string | null; candidateUrl: string | null }[] {
    const setting = getDb().prepare("SELECT value FROM app_settings WHERE key='default_pool_id'").get() as { value: string } | undefined;
    const defaultId = setting ? Number(setting.value) : null;
    return (getDb().prepare('SELECT id, name, codes_json, candidate_codes_json, created_at FROM card_pools ORDER BY name').all() as PoolRow[]).map(
      (r) => ({
        id: r.id,
        name: r.name,
        count: this.parseCodes(r.codes_json).length,
        candidateCount: this.parseCodes(r.candidate_codes_json).length,
        createdAt: r.created_at,
        isDefault: r.id === defaultId,
        // Historical databases may contain names that predate the URL policy.
        url: POOL_NAME_PATTERN.test(r.name) ? `/pool/${encodeURIComponent(r.name)}` : null,
        candidateUrl: POOL_NAME_PATTERN.test(r.name) ? `/pool/${encodeURIComponent(r.name)}/candidate` : null,
      }),
    );
  }

  defaultPool(): { id: number; name: string } | null {
    const row = getDb().prepare("SELECT p.id, p.name FROM app_settings s JOIN card_pools p ON p.id=CAST(s.value AS INTEGER) WHERE s.key='default_pool_id'").get() as { id: number; name: string } | undefined;
    return row ?? null;
  }

  setDefaultPool(id: number): { id: number; name: string } {
    const pool = this.get(id);
    if (!pool) throw new Error('POOL_NOT_FOUND');
    getDb().prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('default_pool_id',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(String(id), new Date().toISOString());
    return { id: pool.id, name: pool.name };
  }

  // A pool contains exact printed card codes. `datas.alias` remains available
  // to deck-rule validation, but must never collapse two physical pool cards.
  // Token cards are filtered, and every missing source code is reported.
  private filterCodes(codes: number[], entries: PoolImportEntry[] = []): { unique: number[] } & PoolImportReport {
    let filtered = 0;
    const unique: number[] = [];
    const seen = new Set<number>();
    const missingCodes: number[] = [];
    const seenMissing = new Set<number>();
    const entryWarnings: PoolImportEntryWarning[] = [];
    const validatedEntryCodes = new Set<number>();
    const entriesByCode = new Map<number, PoolImportEntry[]>();
    for (const entry of entries) {
      const list = entriesByCode.get(entry.code) ?? [];
      list.push(entry);
      entriesByCode.set(entry.code, list);
    }
    for (const submittedCode of codes) {
      // Name validation is tied to the exact printed card code. datas.alias is also
      // used for cards whose names are only treated as another card by the rules
      // (for example 白龙之落胤 -> 阿不思的落胤), so canonicalizing first would
      // report the rules name instead of the literal card-table name.
      const literalInfo = this.cards.getLiteral(submittedCode);
      const info = literalInfo;
      if (!info) {
        if (!seenMissing.has(submittedCode)) {
          seenMissing.add(submittedCode);
          missingCodes.push(submittedCode);
        }
        if (!validatedEntryCodes.has(submittedCode)) {
          validatedEntryCodes.add(submittedCode);
          for (const entry of entriesByCode.get(submittedCode) ?? []) {
            entryWarnings.push({ line: entry.line, input: entry.input, kind: 'missing_code', code: submittedCode, submittedName: entry.submittedName });
          }
        }
        continue;
      }
      if (!validatedEntryCodes.has(submittedCode)) {
        validatedEntryCodes.add(submittedCode);
        for (const entry of entriesByCode.get(submittedCode) ?? []) {
          if (entry.submittedName !== undefined && entry.submittedName !== literalInfo.name) {
            entryWarnings.push({
              line: entry.line,
              input: entry.input,
              kind: 'name_mismatch',
              code: submittedCode,
              submittedName: entry.submittedName,
              actualName: literalInfo.name,
            });
          }
        }
      }
      if (info.type & 0x4000) {
        filtered++;
        continue;
      }
      if (!seen.has(info.code)) {
        seen.add(info.code);
        unique.push(info.code);
      }
    }
    return { unique, filtered, missingCodes, entryWarnings };
  }

  create(name: string, codes: number[]): { pool: CardPool } & PoolImportReport {
    name = normalizePoolName(name);
    if (!Array.isArray(codes) || codes.length > MAX_POOL_CODES) throw new Error('BAD_PAYLOAD');
    const { unique, filtered, missingCodes, entryWarnings } = this.filterCodes(codes);
    if (unique.length === 0) {
      throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: { missingCodes, entryWarnings } });
    }
    const exists = getDb().prepare('SELECT 1 FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    if (exists) throw new Error('POOL_EXISTS');
    const row = getDb()
      .prepare('INSERT INTO card_pools (name, codes_json, created_at, candidate_codes_json) VALUES (?,?,?,?)')
      .run(name, JSON.stringify(unique), new Date().toISOString(), '[]');
    return { pool: { id: Number(row.lastInsertRowid), name, codes: unique, candidateCodes: [], createdAt: new Date().toISOString() }, filtered, missingCodes, entryWarnings };
  }

  createFromText(name: string, importText: string): { pool: CardPool } & PoolImportReport {
    name = normalizePoolName(name);
    if (typeof importText !== 'string' || Buffer.byteLength(importText, 'utf8') > 512 * 1024) throw new Error('BAD_PAYLOAD');
    const entries: PoolImportEntry[] = [];
    const entryWarnings: PoolImportEntryWarning[] = [];
    for (const [index, raw] of String(importText ?? '').split(/\r?\n/).entries()) {
      const input = raw.trim();
      if (!input) continue;
      const match = raw.match(/^\s*(\d+)\s*(?:\t\s*([^\t]+?)\s*)?$/);
      if (!match || (raw.includes('\t') && !match[2]?.trim())) {
        entryWarnings.push({ line: index + 1, input: raw, kind: 'invalid' });
        continue;
      }
      const code = Number(match[1]);
      if (!Number.isSafeInteger(code) || code <= 0) {
        entryWarnings.push({ line: index + 1, input: raw, kind: 'invalid' });
        continue;
      }
      entries.push({ code, line: index + 1, input: raw, ...(match[2] !== undefined ? { submittedName: match[2].trim() } : {}) });
    }
    if (entries.length === 0) {
      // Preserve the report instead of silently creating an empty pool from wholly malformed input.
      throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: entryWarnings });
    }
    const { unique, filtered, missingCodes, entryWarnings: validationWarnings } = this.filterCodes(entries.map((entry) => entry.code), entries);
    const warnings = [...entryWarnings, ...validationWarnings].sort((a, b) => a.line - b.line);
    if (unique.length === 0) throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: warnings });
    const exists = getDb().prepare('SELECT 1 FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    if (exists) throw new Error('POOL_EXISTS');
    const createdAt = new Date().toISOString();
    const row = getDb().prepare('INSERT INTO card_pools (name, codes_json, created_at, candidate_codes_json) VALUES (?,?,?,?)').run(name, JSON.stringify(unique), createdAt, '[]');
    return {
      pool: { id: Number(row.lastInsertRowid), name, codes: unique, candidateCodes: [], createdAt },
      filtered,
      missingCodes,
      entryWarnings: warnings,
    };
  }

  createRandom(name: string, size = 1000): { pool: CardPool } & PoolImportReport {
    name = normalizePoolName(name);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_POOL_CODES) throw new Error('BAD_PAYLOAD');
    const pool = this.cards.poolCodes();
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // poolCodes() is exact-code, deduplicated, and token-free. Store the sample
    // directly so alias metadata cannot randomly shrink a pool.
    const selected = shuffled.slice(0, Math.max(0, Math.min(size, shuffled.length)));
    const exists = getDb().prepare('SELECT 1 FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    if (exists) throw new Error('POOL_EXISTS');
    const createdAt = new Date().toISOString();
    const row = getDb().prepare('INSERT INTO card_pools (name, codes_json, created_at, candidate_codes_json) VALUES (?,?,?,?)').run(name, JSON.stringify(selected), createdAt, '[]');
    return {
      pool: { id: Number(row.lastInsertRowid), name, codes: selected, candidateCodes: [], createdAt },
      filtered: 0,
      missingCodes: [],
      entryWarnings: [],
    };
  }

  get(id: number): CardPool | null {
    const row = getDb().prepare('SELECT id, name, codes_json, candidate_codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
    return row ? this.toPool(row) : null;
  }

  getByName(name: string): CardPool | null {
    const row = getDb().prepare('SELECT id, name, codes_json, candidate_codes_json, created_at FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    return row ? this.toPool(row) : null;
  }

  candidatePoolInfo(name: string): CandidatePoolInfo {
    const pool = this.getByName(name);
    if (!pool) throw new Error('POOL_NOT_FOUND');
    return this.candidateInfo(pool);
  }

  update(id: number, codes: number[]): { pool: CardPool; candidateRemovedCodes: number[] } & PoolImportReport {
    const row = getDb().prepare('SELECT id, name, codes_json, candidate_codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
    if (!row) throw new Error('POOL_NOT_FOUND');
    if (!Array.isArray(codes) || codes.length > MAX_POOL_CODES) throw new Error('BAD_PAYLOAD');
    const { unique, filtered, missingCodes, entryWarnings } = this.filterCodes(codes);
    if (unique.length === 0) {
      throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: { missingCodes, entryWarnings } });
    }
    const result = getDb().transaction(() => {
      const current = getDb().prepare('SELECT id, name, codes_json, candidate_codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
      if (!current) throw new Error('POOL_NOT_FOUND');
      const currentCandidates = this.parseCodes(current.candidate_codes_json);
      const mainSet = new Set(unique);
      const candidateRemovedCodes = currentCandidates.filter((code) => mainSet.has(code));
      const remainingCandidates = currentCandidates.filter((code) => !mainSet.has(code));
      getDb().prepare('UPDATE card_pools SET codes_json=?, candidate_codes_json=? WHERE id=?')
        .run(JSON.stringify(unique), JSON.stringify(remainingCandidates), id);
      return {
        pool: { id, name: current.name, codes: unique, candidateCodes: remainingCandidates, createdAt: current.created_at },
        candidateRemovedCodes,
      };
    })();
    return { ...result, filtered, missingCodes, entryWarnings };
  }

  /**
   * Add exact card codes to a pool's append-only candidate list.  The parent
   * pool is read and written in the same transaction as the candidate list so
   * a concurrent main-pool promotion cannot create an overlap.
   */
  addCandidates(name: string, codes: number[]): CandidatePoolAddResult {
    name = normalizePoolName(name);
    if (!Array.isArray(codes) || codes.length > MAX_CANDIDATE_CODES_PER_REQUEST || codes.some((code) => !Number.isSafeInteger(code) || code <= 0)) {
      throw new Error('BAD_PAYLOAD');
    }
    const requested = [...new Set(codes)];
    const { unique, filtered, missingCodes } = this.filterCodes(requested);
    const db = getDb();
    return db.transaction(() => {
      const row = db.prepare('SELECT id, name, codes_json, candidate_codes_json, created_at FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
      if (!row) throw new Error('POOL_NOT_FOUND');
      const pool = this.toPool(row);
      const mainSet = new Set(pool.codes);
      const candidateSet = new Set(pool.candidateCodes);
      const inPoolCodes = unique.filter((code) => mainSet.has(code));
      const alreadyCandidateCodes = unique.filter((code) => !mainSet.has(code) && candidateSet.has(code));
      const addedCodes = unique.filter((code) => !mainSet.has(code) && !candidateSet.has(code));
      const nextCandidates = [...pool.candidateCodes, ...addedCodes];
      if (addedCodes.length > 0) {
        db.prepare('UPDATE card_pools SET candidate_codes_json=? WHERE id=?').run(JSON.stringify(nextCandidates), pool.id);
      }
      return {
        ...this.candidateInfo({ ...pool, candidateCodes: nextCandidates }),
        addedCodes,
        alreadyCandidateCodes,
        inPoolCodes,
        missingCodes,
        filtered,
      };
    })();
  }

  remove(id: number): { id: number } {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('BAD_PAYLOAD');
    const db = getDb();
    const result = db.transaction(() => {
      const pool = this.get(id);
      if (!pool) throw new Error('POOL_NOT_FOUND');

      // Keep an in-use pool intact.  Besides the immutable card_pool_id, check
      // legacy tournaments that predate that column and only retained the pool
      // name in config_json; deleting either kind would make a future draft
      // impossible.  Do the check in the same write transaction as DELETE so a
      // concurrent tournament creation cannot race the safety guard.
      const candidates = db.prepare(
        "SELECT id, name, status, card_pool_id, config_json FROM tournaments WHERE status!='finished'",
      ).all() as { id: number; name: string; status: string; card_pool_id: number | null; config_json: string }[];
      const activeTournaments = candidates
        .filter((tournament) => {
          if (tournament.card_pool_id === id) return true;
          try {
            const config = JSON.parse(tournament.config_json) as { cardPool?: unknown };
            return config.cardPool === pool.name;
          } catch {
            return false;
          }
        })
        .map(({ id: tournamentId, name, status }) => ({ id: tournamentId, name, status }));
      if (activeTournaments.length > 0) {
        throw Object.assign(new Error('POOL_IN_USE'), {
          details: { poolId: id, poolName: pool.name, tournaments: activeTournaments },
        });
      }

      db.prepare("DELETE FROM app_settings WHERE key='default_pool_id' AND value=?").run(String(id));
      const deleted = db.prepare('DELETE FROM card_pools WHERE id=?').run(id);
      if (deleted.changes !== 1) throw new Error('POOL_NOT_FOUND');
      return { id };
    })();
    return result;
  }

  codesByName(name: string): number[] | null {
    return this.getByName(name)?.codes ?? null;
  }

  resolve(poolRef: string | undefined): number[] {
    if (!poolRef || poolRef === 'full') return this.cards.poolCodes();
    const codes = this.codesByName(poolRef);
    if (!codes) throw new Error('POOL_NOT_FOUND');
    return codes;
  }

  isExtraDeck(code: number): boolean {
    return this.cards.isExtraDeck(code);
  }
}
