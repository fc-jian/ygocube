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

interface PoolRow {
  id: number;
  name: string;
  codes_json: string;
  created_at: string;
}

@Injectable()
export class PoolsService {
  constructor(private cards: CardsService) {}

  list(): { id: number; name: string; count: number; createdAt: string }[] {
    return (getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools ORDER BY name').all() as PoolRow[]).map(
      (r) => ({ id: r.id, name: r.name, count: (JSON.parse(r.codes_json) as number[]).length, createdAt: r.created_at }),
    );
  }

  // 异画卡（alias）只保留原始卡（编号最小者）；token 卡不允许进入卡池，自动过滤并警告
  private filterCodes(codes: number[]): { unique: number[]; filtered: number } {
    const canonical = [...new Set(codes.map((c) => this.cards.canonicalCode(c)))];
    let filtered = 0;
    const unique = canonical.filter((c) => {
      const info = this.cards.get(c);
      if (!info) return false;
      if (info.type & 0x4000) {
        filtered++;
        return false;
      }
      return true;
    });
    return { unique, filtered };
  }

  create(name: string, codes: number[]): { pool: CardPool; filtered: number } {
    if (!name.trim()) throw new Error('BAD_PAYLOAD');
    const { unique, filtered } = this.filterCodes(codes);
    const exists = getDb().prepare('SELECT 1 FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    if (exists) throw new Error('POOL_EXISTS');
    const row = getDb()
      .prepare('INSERT INTO card_pools (name, codes_json, created_at) VALUES (?,?,?)')
      .run(name, JSON.stringify(unique), new Date().toISOString());
    return { pool: { id: Number(row.lastInsertRowid), name, codes: unique, createdAt: new Date().toISOString() }, filtered };
  }

  createRandom(name: string, size = 1000): { pool: CardPool; filtered: number } {
    const pool = this.cards.poolCodes();
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return this.create(name, shuffled.slice(0, Math.max(0, Math.min(size, shuffled.length))));
  }

  get(id: number): CardPool | null {
    const row = getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
    return row ? { id: row.id, name: row.name, codes: JSON.parse(row.codes_json) as number[], createdAt: row.created_at } : null;
  }

  update(id: number, codes: number[]): { pool: CardPool; filtered: number } {
    const row = getDb().prepare('SELECT id, name, codes_json, created_at FROM card_pools WHERE id=?').get(id) as PoolRow | undefined;
    if (!row) throw new Error('POOL_NOT_FOUND');
    const { unique, filtered } = this.filterCodes(codes);
    getDb().prepare('UPDATE card_pools SET codes_json=? WHERE id=?').run(JSON.stringify(unique), id);
    return { pool: { id, name: row.name, codes: unique, createdAt: row.created_at }, filtered };
  }

  remove(id: number): void {
    getDb().prepare('DELETE FROM card_pools WHERE id=?').run(id);
  }

  codesByName(name: string): number[] | null {
    const row = getDb().prepare('SELECT codes_json FROM card_pools WHERE name=?').get(name) as PoolRow | undefined;
    return row ? (JSON.parse(row.codes_json) as number[]) : null;
  }

  resolve(poolRef: string | undefined): number[] {
    if (!poolRef || poolRef === 'full') return this.cards.poolCodes();
    const codes = this.codesByName(poolRef);
    if (!codes) throw new Error('POOL_NOT_FOUND');
    return codes;
  }
}
