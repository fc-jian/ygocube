import { Injectable } from '@nestjs/common';
import { getDb } from '../db';
import { CardsService } from '../cards/cards.service';

// Card pools: a pool is a plain-text list of card codes (one per line) or a random
// sample from the full card table (dev_docs/05 §9.3). Managed by the super admin.
export interface CardPool {
  id: number;
  name: string;
  codes: number[];
  createdAt: string;
}

// Pool names are used directly as public URL path segments. Keep the policy
// deliberately narrower than encodeURIComponent so every generated link is
// stable and cannot introduce another path/query segment.
export const POOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
}

@Injectable()
export class PoolsService {
  constructor(private cards: CardsService) {}

  list(): { id: number; name: string; count: number; createdAt: string; isDefault: boolean; url: string | null }[] {
    const setting = getDb().prepare("SELECT value FROM app_settings WHERE key='default_pool_id'").get() as { value: string } | undefined;
    const defaultId = setting ? Number(setting.value) : null;
    return (getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools ORDER BY name').all() as PoolRow[]).map(
      (r) => ({
        id: r.id,
        name: r.name,
        count: (JSON.parse(r.codes_json) as number[]).length,
        createdAt: r.created_at,
        isDefault: r.id === defaultId,
        // Historical databases may contain names that predate the URL policy.
        url: POOL_NAME_PATTERN.test(r.name) ? `/pool/${encodeURIComponent(r.name)}` : null,
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
    const { unique, filtered, missingCodes, entryWarnings } = this.filterCodes(codes);
    if (unique.length === 0) {
      throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: { missingCodes, entryWarnings } });
    }
    const exists = getDb().prepare('SELECT 1 FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    if (exists) throw new Error('POOL_EXISTS');
    const row = getDb()
      .prepare('INSERT INTO card_pools (name, codes_json, created_at) VALUES (?,?,?)')
      .run(name, JSON.stringify(unique), new Date().toISOString());
    return { pool: { id: Number(row.lastInsertRowid), name, codes: unique, createdAt: new Date().toISOString() }, filtered, missingCodes, entryWarnings };
  }

  createFromText(name: string, importText: string): { pool: CardPool } & PoolImportReport {
    name = normalizePoolName(name);
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
    const row = getDb().prepare('INSERT INTO card_pools (name, codes_json, created_at) VALUES (?,?,?)').run(name, JSON.stringify(unique), createdAt);
    return {
      pool: { id: Number(row.lastInsertRowid), name, codes: unique, createdAt },
      filtered,
      missingCodes,
      entryWarnings: warnings,
    };
  }

  createRandom(name: string, size = 1000): { pool: CardPool } & PoolImportReport {
    name = normalizePoolName(name);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('BAD_PAYLOAD');
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
    const row = getDb().prepare('INSERT INTO card_pools (name, codes_json, created_at) VALUES (?,?,?)').run(name, JSON.stringify(selected), createdAt);
    return {
      pool: { id: Number(row.lastInsertRowid), name, codes: selected, createdAt },
      filtered: 0,
      missingCodes: [],
      entryWarnings: [],
    };
  }

  get(id: number): CardPool | null {
    const row = getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
    return row ? { id: row.id, name: row.name, codes: JSON.parse(row.codes_json) as number[], createdAt: row.created_at } : null;
  }

  getByName(name: string): CardPool | null {
    const row = getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    return row ? { id: row.id, name: row.name, codes: JSON.parse(row.codes_json) as number[], createdAt: row.created_at } : null;
  }

  update(id: number, codes: number[]): { pool: CardPool } & PoolImportReport {
    const row = getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
    if (!row) throw new Error('POOL_NOT_FOUND');
    const { unique, filtered, missingCodes, entryWarnings } = this.filterCodes(codes);
    if (unique.length === 0) {
      throw Object.assign(new Error('BAD_POOL_IMPORT'), { details: { missingCodes, entryWarnings } });
    }
    getDb().prepare('UPDATE card_pools SET codes_json=? WHERE id=?').run(JSON.stringify(unique), id);
    return { pool: { id, name: row.name, codes: unique, createdAt: row.created_at }, filtered, missingCodes, entryWarnings };
  }

  remove(id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('BAD_PAYLOAD');
    const db = getDb();
    if (!this.get(id)) throw new Error('POOL_NOT_FOUND');
    const active = db.prepare("SELECT 1 FROM tournaments WHERE card_pool_id=? AND status!='finished' LIMIT 1").get(id);
    if (active) throw new Error('POOL_IN_USE');
    db.transaction(() => {
      db.prepare("DELETE FROM app_settings WHERE key='default_pool_id' AND value=?").run(String(id));
      db.prepare('DELETE FROM card_pools WHERE id=?').run(id);
    })();
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
