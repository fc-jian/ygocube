import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { CardSearchParams, GuessCardPage, GuessCardStats, GuessPoolCreateRequest, GuessPoolSummary } from '@ygocube/shared';
import { CardsService, TYPE_TOKEN } from '../cards/cards.service';
import { getDb } from '../db';
import { config } from '../config';

const DEFAULT_POOL_ID = `COALESCE((SELECT guess_pools.id FROM guess_pools JOIN json_each(?) p
  ON guess_pools.name_key = json_extract(p.value, '$.key')
  WHERE json_extract(p.value, '$.defaultPriority') > 0
  ORDER BY json_extract(p.value, '$.defaultPriority') DESC, guess_pools.id LIMIT 1), -1)`;
function priorities(): string {
  return JSON.stringify(config.server.poolData.guess.map(({ key, defaultPriority }) => ({ key, defaultPriority })));
}

interface Pool {
  poolId: number;
  name: string;
  codes: number[] | null;
  isDefault: boolean;
}

@Injectable()
export class GuessPoolsService implements OnModuleInit {
  constructor(private readonly cards: CardsService) {}

  onModuleInit(): void {
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM guess_pools WHERE name_key = ?');
    const pending = config.server.poolData.guess.filter((pool) => pool.defaultPriority > 0 && !exists.get(pool.key));
    if (!pending.length) return;
    const eligible = new Set(this.cards.poolCodes());
    const insert = db.prepare(`
      INSERT INTO guess_pools (name, name_key, codes_json) VALUES (?, ?, ?)
      ON CONFLICT (name_key) DO NOTHING
    `);
    db.transaction(() => {
      for (const pool of pending) {
        if (pool.codes.every((code) => eligible.has(code))) {
          insert.run(pool.name, pool.key, JSON.stringify(pool.codes));
        }
      }
    }).immediate();
  }

  list(): GuessPoolSummary[] {
    const rows = getDb().prepare(`
      SELECT id AS poolId, name, COALESCE(json_array_length(codes_json), ?) AS cardCount,
        id = ${DEFAULT_POOL_ID} AS isDefault
      FROM guess_pools ORDER BY isDefault DESC, id
    `).all(this.cards.poolCodes().length, priorities()) as (Omit<GuessPoolSummary, 'isDefault'> & { isDefault: number })[];
    return rows.map((row) => ({ ...row, isDefault: row.isDefault === 1 }));
  }

  get(poolId: number): Pool {
    const row = getDb().prepare(`
      SELECT name, codes_json, id = ${DEFAULT_POOL_ID} AS isDefault FROM guess_pools WHERE id = ?
    `).get(priorities(), poolId) as { name: string; codes_json: string | null; isDefault: number } | undefined;
    if (!row) throw new NotFoundException({ code: 'GUESS_POOL_NOT_FOUND' });
    return {
      poolId, name: row.name, isDefault: row.isDefault === 1,
      codes: row.codes_json === null ? null : JSON.parse(row.codes_json) as number[],
    };
  }

  describe(poolId: number): GuessPoolSummary {
    const { name, codes, isDefault } = this.get(poolId);
    return { poolId, name, isDefault, cardCount: codes?.length ?? this.cards.poolCodes().length };
  }

  create({ name, codes }: GuessPoolCreateRequest): GuessPoolSummary {
    // Older databases retain the previous built-in name.
    if (config.server.poolData.guess.some((pool) => pool.name === name || pool.aliases.includes(name))) {
      throw new ConflictException({ code: 'GUESS_POOL_EXISTS' });
    }
    const eligible = new Set(this.cards.poolCodes());
    if (codes.some((code) => !eligible.has(code))) throw new BadRequestException({ code: 'GUESS_INVALID_POOL' });
    return this.insert(name, `name:${name.toLowerCase()}`, codes);
  }

  importLegacy(roomId: string, name: string, codes: number[]): GuessPoolSummary {
    return this.insert(`${name} [${roomId}]`, `legacy:${roomId}`, codes);
  }

  private insert(name: string, nameKey: string, codes: number[]): GuessPoolSummary {
    const result = getDb().prepare(`
      INSERT INTO guess_pools (name, name_key, codes_json) VALUES (?, ?, ?)
      ON CONFLICT (name_key) DO NOTHING
    `).run(name, nameKey, JSON.stringify([...codes].sort((a, b) => a - b)));
    if (!result.changes) throw new ConflictException({ code: 'GUESS_POOL_EXISTS' });
    return { poolId: Number(result.lastInsertRowid), name, cardCount: codes.length, isDefault: false };
  }

  availableCodes(codes: readonly number[] | null): number[] {
    const eligible = this.cards.poolCodes();
    if (codes === null) return eligible;
    const allowed = new Set(codes);
    return eligible.filter((code) => allowed.has(code));
  }

  cardDetails(codes: number[]) {
    return this.cards.getMany(codes).filter((card) => !(card.type & TYPE_TOKEN));
  }

  search(params: CardSearchParams, codes: readonly number[] | null = null): GuessCardPage {
    return this.cards.searchCatalog(params, codes === null ? undefined : new Set(codes));
  }

  browse(poolId: number, params: CardSearchParams): GuessCardPage {
    const result = this.search(params, this.get(poolId).codes);
    if (!result.cards.length) return result;
    const codes = result.cards.map((card) => card.code);
    const rows = getDb().prepare(`
      SELECT code, COUNT(*) AS appearances, AVG(guess_turns) AS averageGuessTurns
      FROM guess_round_cards WHERE pool_id = ? AND code IN (${codes.map(() => '?').join(',')})
      GROUP BY code
    `).all(poolId, ...codes) as (GuessCardStats & { code: number })[];
    const stats = new Map(rows.map(({ code, ...stat }) => [code, stat]));
    return {
      ...result,
      cards: result.cards.map((card) => ({
        ...card,
        stats: stats.get(card.code) ?? { appearances: 0, averageGuessTurns: null },
      })),
    };
  }

  recordRound(poolId: number, roomId: string, roundNumber: number, seats: readonly {
    code: number;
    points: number | null;
    attempts: number;
  }[]): void {
    const insert = getDb().prepare(`
      INSERT INTO guess_round_cards (room_id, round_number, pool_id, code, guess_turns) VALUES (?, ?, ?, ?, ?)
    `);
    for (const { code, points, attempts } of seats) {
      insert.run(roomId, roundNumber, poolId, code, (points ?? 0) > 0 ? attempts : null);
    }
  }
}
