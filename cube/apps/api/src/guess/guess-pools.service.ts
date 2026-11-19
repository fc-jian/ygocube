import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { CardSearchParams, GuessCardPage, GuessCardStats, GuessPoolCreateRequest, GuessPoolSummary } from '@ygocube/shared';
import { CardsService, TYPE_TOKEN } from '../cards/cards.service';
import { getDb } from '../db';
import { config } from '../config';
import { guessPoolCsv } from './pool-csv';

const BROWSE_ONLY_POOL = 'EXISTS (SELECT 1 FROM guess_pool_policies p WHERE p.name_key=guess_pools.name_key AND p.browse_only=1)';
const DEFAULT_POOL_ID = `COALESCE((SELECT id FROM guess_pools JOIN guess_pool_policies USING (name_key)
  WHERE default_priority > 0 ORDER BY default_priority DESC, id LIMIT 1), -1)`;

interface Pool {
  poolId: number;
  name: string;
  codes: number[] | null;
  isDefault: boolean;
  browseOnly: boolean;
}

@Injectable()
export class GuessPoolsService implements OnModuleInit {
  constructor(private readonly cards: CardsService) {}

  onModuleInit(): void {
    const db = getDb();
    const saved = db.prepare('SELECT codes_json FROM guess_pools WHERE name_key = ?').pluck();
    const pending = config.server.poolData.guess.map((pool) => ({
      ...pool, savedCodes: saved.get(pool.key) as string | null | undefined,
    })).filter(({ previousCodes, savedCodes }) =>
      savedCodes === undefined || previousCodes.some((codes) => JSON.stringify(codes) === savedCodes),
    );
    if (!pending.length) return;
    const eligible = new Set(this.cards.poolCodes());
    const save = db.prepare(`
      INSERT INTO guess_pools (name, name_key, codes_json) VALUES (?, ?, ?)
      ON CONFLICT (name_key) DO UPDATE SET codes_json = excluded.codes_json
      WHERE guess_pools.codes_json = ? AND guess_pools.codes_json <> excluded.codes_json
    `);
    db.transaction(() => {
      for (const pool of pending) {
        if (!pool.codes.every((code) => eligible.has(code))) continue;
        const result = save.run(pool.name, pool.key, JSON.stringify(pool.codes), pool.savedCodes ?? null);
        if (result.changes && pool.savedCodes !== undefined) {
          // A hintless round used the live pool. Keep its old candidates until the next deal.
          db.prepare(`
            UPDATE guess_rooms SET state_json = json_set(state_json, '$.round.poolCodes', json(?))
            WHERE phase = 'playing'
              AND json_extract(state_json, '$.poolId') = (SELECT id FROM guess_pools WHERE name_key = ?)
              AND NOT COALESCE(json_extract(state_json, '$.expertMode'), 0)
              AND json_type(state_json, '$.round.poolCodes') IS NULL
              AND EXISTS (
                SELECT 1 FROM json_each(state_json, '$.round.seats') WHERE json_extract(value, '$.openingHint') IS NULL
              )
          `).run(pool.savedCodes, pool.key);
        }
      }
    }).immediate();
  }

  list(): GuessPoolSummary[] {
    const rows = getDb().prepare(`
      SELECT id AS poolId, name, COALESCE(json_array_length(codes_json), ?) AS cardCount,
        id = ${DEFAULT_POOL_ID} AS isDefault, ${BROWSE_ONLY_POOL} AS browseOnly
      FROM guess_pools ORDER BY isDefault DESC, id
    `).all(this.cards.poolCodes().length) as (Omit<GuessPoolSummary, 'isDefault' | 'browseOnly'> & {
      isDefault: number;
      browseOnly: number;
    })[];
    return rows.map((row) => ({ ...row, isDefault: row.isDefault === 1, browseOnly: row.browseOnly === 1 }));
  }

  get(poolId: number): Pool {
    const row = getDb().prepare(`
      SELECT name, codes_json, id = ${DEFAULT_POOL_ID} AS isDefault, ${BROWSE_ONLY_POOL} AS browseOnly
      FROM guess_pools WHERE id = ?
    `).get(poolId) as { name: string; codes_json: string | null; isDefault: number; browseOnly: number } | undefined;
    if (!row) throw new NotFoundException({ code: 'GUESS_POOL_NOT_FOUND' });
    return {
      poolId, name: row.name, isDefault: row.isDefault === 1,
      browseOnly: row.browseOnly === 1,
      codes: row.codes_json === null ? null : JSON.parse(row.codes_json) as number[],
    };
  }

  describe(poolId: number): GuessPoolSummary {
    const { name, codes, isDefault, browseOnly } = this.get(poolId);
    return { poolId, name, isDefault, browseOnly, cardCount: codes?.length ?? this.cards.poolCodes().length };
  }

  exportCsv(poolId: number): string {
    return guessPoolCsv(this.cards, this.availableCodes(this.get(poolId).codes));
  }

  create({ name, codes }: GuessPoolCreateRequest): GuessPoolSummary {
    const nameKey = name.normalize('NFKC').toLowerCase();
    if (config.server.poolData.guess.some((p) =>
      [p.name, ...p.aliases].some((name) => name.normalize('NFKC').toLowerCase() === nameKey))
      || getDb().prepare('SELECT 1 FROM guess_pools WHERE name = ? COLLATE NOCASE').get(name)) {
      throw new ConflictException({ code: 'GUESS_POOL_EXISTS' });
    }
    const eligible = new Set(this.cards.poolCodes());
    if (codes.some((code) => !eligible.has(code))) throw new BadRequestException({ code: 'GUESS_INVALID_POOL' });
    return this.insert(name, `name:${nameKey}`, codes);
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
    return { poolId: Number(result.lastInsertRowid), name, cardCount: codes.length, isDefault: false, browseOnly: false };
  }

  availableCodes(codes: readonly number[] | null, distinctArtworks = false): number[] {
    const eligible = this.cards.poolCodes();
    const allowed = codes === null ? null : new Set(codes);
    const available = allowed ? eligible.filter((code) => allowed.has(code)) : eligible;
    if (!distinctArtworks) return available;
    const seen = new Set<number>();
    return available.filter((code) => {
      const representative = this.cards.artworkCode(code);
      if (seen.has(representative)) return false;
      seen.add(representative);
      return true;
    });
  }

  cardDetails(codes: number[]) {
    return this.cards.getMany(codes).filter((card) => !(card.type & TYPE_TOKEN));
  }

  search(params: CardSearchParams, codes: readonly number[] | null = null): GuessCardPage {
    return this.cards.searchCatalog(params, codes === null ? undefined : new Set(codes));
  }

  browse(poolId: number, params: CardSearchParams, codeOrder?: ReadonlyMap<number, number>): GuessCardPage {
    const pool = this.get(poolId);
    if (pool.browseOnly && (params.sort !== 'relevance' || Object.values(params.filters).some((value) => value !== undefined))) {
      throw new BadRequestException({ code: 'GUESS_POOL_BROWSE_ONLY' });
    }
    const result = pool.browseOnly
      ? this.cards.searchCatalogNames(params, new Set(pool.codes ?? []), codeOrder)
      : this.cards.searchCatalog(params, pool.codes === null ? undefined : new Set(pool.codes), codeOrder);
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
