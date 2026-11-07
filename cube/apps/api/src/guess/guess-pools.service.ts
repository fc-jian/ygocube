import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { GuessCardPage, GuessCardStats, GuessPoolCreateRequest, GuessPoolSummary } from '@ygocube/shared';
import { CardsService } from '../cards/cards.service';
import { getDb } from '../db';

const PAGE_SIZE = 24;

interface Pool {
  poolId: number;
  name: string;
  codes: number[] | null;
}

@Injectable()
export class GuessPoolsService {
  constructor(private readonly cards: CardsService) {}

  list(): GuessPoolSummary[] {
    return getDb().prepare(`
      SELECT id AS poolId, name, COALESCE(json_array_length(codes_json), ?) AS cardCount
      FROM guess_pools ORDER BY id
    `).all(this.cards.poolCodes().length) as GuessPoolSummary[];
  }

  get(poolId: number): Pool {
    const row = getDb().prepare('SELECT name, codes_json FROM guess_pools WHERE id = ?')
      .get(poolId) as { name: string; codes_json: string | null } | undefined;
    if (!row) throw new NotFoundException({ code: 'GUESS_POOL_NOT_FOUND' });
    return { poolId, name: row.name, codes: row.codes_json === null ? null : JSON.parse(row.codes_json) as number[] };
  }

  describe(poolId: number): GuessPoolSummary {
    const { name, codes } = this.get(poolId);
    return { poolId, name, cardCount: codes?.length ?? this.cards.poolCodes().length };
  }

  create({ name, codes }: GuessPoolCreateRequest): GuessPoolSummary {
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
    return { poolId: Number(result.lastInsertRowid), name, cardCount: codes.length };
  }

  availableCodes(codes: readonly number[] | null): number[] {
    const eligible = this.cards.poolCodes();
    if (codes === null) return eligible;
    const allowed = new Set(codes);
    return eligible.filter((code) => allowed.has(code));
  }

  search(query: string, page: number, codes: readonly number[] | null = null): GuessCardPage {
    const offset = page * PAGE_SIZE;
    const count = PAGE_SIZE + 1;
    const cards = query
      ? this.cards.search(query, count, { codes: codes === null ? undefined : new Set(codes), offset })
      : this.cards.getMany(this.availableCodes(codes).slice(offset, offset + count));
    return { cards: cards.slice(0, PAGE_SIZE), hasMore: cards.length > PAGE_SIZE };
  }

  browse(poolId: number, query: string, page: number): GuessCardPage {
    const result = this.search(query, page, this.get(poolId).codes);
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
