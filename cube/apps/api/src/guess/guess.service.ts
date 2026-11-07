import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import type {
  GuessActionRequest, GuessCardPage, GuessCreateRequest, GuessMove, GuessRoomSummary, GuessRoomView, GuessSession,
} from '@ygocube/shared';
import { safeHashEqual, sha256 } from '../auth/auth.guard';
import { CardsService, TYPE_TOKEN } from '../cards/cards.service';
import { getDb } from '../db';
import { GuessPoolsService } from './guess-pools.service';

const MAX_PLAYERS = 8;

interface Player {
  playerId: string;
  tokenHash: string;
  score: number;
}

interface Seat {
  playerId: string;
  code: number;
  points: number | null;
  attempts: number;
}

interface Round {
  number: number;
  seats: Seat[];
  currentPlayerId: string | null;
  lastMove: GuessMove | null;
}

interface Room {
  roomId: string;
  name: string;
  poolId: number;
  poolName: string;
  poolCount: number;
  phase: GuessRoomView['phase'];
  players: Player[];
  version: number;
  round: Round | null;
}

type LegacyRound = Omit<Round, 'seats'> & { seats: Omit<Seat, 'attempts'>[] };
type LegacyRoom = Omit<Room, 'poolId' | 'poolName' | 'round'> & {
  poolCodes: number[] | null;
  roundCount: number;
  round: LegacyRound | null;
};
type LegacyEvent =
  | { action: 'start' | 'next'; round: LegacyRound }
  | { action: 'guess' | 'surrender'; playerId: string; move: GuessMove }
  | { action: 'create' | 'join' | 'leave' };

interface RoomRow {
  state_json: string;
}

function sample<T>(values: readonly T[], count: number): T[] {
  const items = [...values];
  for (let index = 0; index < count; index++) {
    const other = randomInt(index, items.length);
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items.slice(0, count);
}

function newPlayer(playerId: string) {
  const token = randomBytes(32).toString('hex');
  return { player: { playerId, tokenHash: sha256(token), score: 0 }, token };
}

function summary(room: Room): GuessRoomSummary {
  return {
    roomId: room.roomId,
    name: room.name,
    playerCount: room.players.length,
    maxPlayers: Math.min(room.poolCount, MAX_PLAYERS),
    poolId: room.poolId,
    poolName: room.poolName,
  };
}

@Injectable()
export class GuessService implements OnModuleInit {
  constructor(private readonly cards: CardsService, private readonly pools: GuessPoolsService) {}

  onModuleInit(): void {
    const db = getDb();
    db.transaction(() => {
      const rows = db.prepare(`
        SELECT state_json FROM guess_rooms WHERE phase != 'closed' AND json_type(state_json, '$.poolId') IS NULL
      `).all() as RoomRow[];
      const history = db.prepare('SELECT event_json FROM guess_room_events WHERE room_id = ? ORDER BY version');
      const save = db.prepare('UPDATE guess_rooms SET state_json = ? WHERE room_id = ?');
      for (const row of rows) {
        const { poolCodes, roundCount: _roundCount, round, ...room } = JSON.parse(row.state_json) as LegacyRoom;
        const pool = poolCodes === null ? this.pools.get(0) : this.pools.importLegacy(room.roomId, room.name, poolCodes);
        let replay: Round | null = null;
        // Old snapshots stored points but not the number of turns used to get them.
        const events = history.all(room.roomId) as { event_json: string }[];
        for (const entry of events) {
          const event = JSON.parse(entry.event_json) as LegacyEvent;
          if (event.action === 'start' || event.action === 'next') {
            replay = { ...event.round, seats: event.round.seats.map((seat) => ({ ...seat, attempts: 0 })) };
          } else if (replay && (event.action === 'guess' || event.action === 'surrender')) {
            const seat = replay.seats.find((candidate) => candidate.playerId === event.playerId)!;
            if (event.action === 'guess') seat.attempts++;
            seat.points = event.move.points;
            if (replay.seats.every((candidate) => candidate.points !== null)) {
              this.pools.recordRound(pool.poolId, room.roomId, replay.number, replay.seats);
            }
          }
        }
        const upgraded: Room = {
          ...room, poolId: pool.poolId, poolName: pool.name,
          round: round && {
            ...round,
            seats: round.seats.map((seat) => ({
              ...seat,
              attempts: replay?.seats.find((candidate) => candidate.playerId === seat.playerId)?.attempts ?? 0,
            })),
          },
        };
        save.run(JSON.stringify(upgraded), room.roomId);
      }
    }).immediate();
  }

  list(): GuessRoomSummary[] {
    const rows = getDb().prepare(`
      SELECT state_json FROM guess_rooms WHERE phase = 'lobby'
        AND json_array_length(state_json, '$.players') < MIN(?, json_extract(state_json, '$.poolCount'))
      ORDER BY updated_at DESC, room_id LIMIT 50
    `).all(MAX_PLAYERS) as RoomRow[];
    return rows.map((row) => summary(JSON.parse(row.state_json) as Room));
  }

  create(input: GuessCreateRequest): GuessSession {
    const db = getDb();
    const pool = this.pools.get(input.poolId);
    const poolCount = this.pools.availableCodes(pool.codes).length;
    if (poolCount < 2) throw new BadRequestException({ code: 'GUESS_INVALID_POOL' });
    return db.transaction(() => {
      const exists = db.prepare('SELECT 1 FROM guess_rooms WHERE room_id = ?');
      let roomId = randomBytes(4).toString('hex').toUpperCase();
      while (exists.get(roomId)) roomId = randomBytes(4).toString('hex').toUpperCase();
      const { player, token } = newPlayer(input.playerId);
      const room: Room = {
        roomId,
        name: input.name,
        poolId: pool.poolId,
        poolName: pool.name,
        poolCount,
        phase: 'lobby',
        players: [player],
        version: 0,
        round: null,
      };
      this.write(room, { action: 'create', ...input });
      return { token, room: this.view(room, player.playerId) };
    }).immediate();
  }

  join(roomId: string, playerId: string): GuessSession {
    return getDb().transaction(() => {
      const room = this.load(roomId);
      this.requirePhase(room, 'lobby');
      if (room.players.some((player) => player.playerId.toLowerCase() === playerId.toLowerCase())) {
        throw new ConflictException({ code: 'GUESS_PLAYER_EXISTS' });
      }
      if (room.players.length >= summary(room).maxPlayers) {
        throw new ConflictException({ code: 'GUESS_ROOM_FULL' });
      }
      const { player, token } = newPlayer(playerId);
      room.players.push(player);
      this.write(room, { action: 'join', playerId });
      return { token, room: this.view(room, playerId) };
    }).immediate();
  }

  state(roomId: string, authorization: string | undefined): GuessRoomView {
    const room = this.load(roomId);
    return this.view(room, this.authenticate(room, authorization).playerId);
  }

  search(roomId: string, authorization: string | undefined, query: string, page: number): GuessCardPage {
    const room = this.load(roomId);
    this.authenticate(room, authorization);
    return this.pools.search(query, page, this.pools.get(room.poolId).codes);
  }

  act(roomId: string, authorization: string | undefined, command: GuessActionRequest): GuessRoomView | null {
    return getDb().transaction(() => {
      const room = this.load(roomId);
      const player = this.authenticate(room, authorization);
      const { playerId } = player;
      if (command.version !== room.version) throw new ConflictException({ code: 'GUESS_STALE_VERSION' });
      if (command.action === 'leave') {
        this.requirePhase(room, 'lobby');
        room.players = room.players.filter((member) => member !== player);
        this.write(room, { action: 'leave', playerId });
        return null;
      }
      if (command.action === 'start' || command.action === 'next' || command.action === 'finish') {
        if (room.players[0] !== player) throw new ForbiddenException({ code: 'GUESS_HOST_REQUIRED' });
        this.requirePhase(room, command.action === 'start' ? 'lobby' : 'between_rounds');
        if (command.action === 'finish') {
          room.phase = 'finished';
          this.write(room, { action: 'finish', playerId });
        } else {
          this.deal(room);
          this.write(room, { action: command.action, playerId, round: room.round });
        }
      } else {
        const move = this.play(room, player, command.action === 'guess' ? command.code : null);
        this.write(room, { ...command, playerId, move });
        const round = room.round!;
        if (round.currentPlayerId === null) this.pools.recordRound(room.poolId, room.roomId, round.number, round.seats);
      }
      return this.view(room, playerId);
    }).immediate();
  }

  private load(roomId: string): Room {
    const row = getDb().prepare("SELECT state_json FROM guess_rooms WHERE room_id = ? AND phase != 'closed'")
      .get(roomId.toUpperCase()) as RoomRow | undefined;
    if (!row) throw new NotFoundException({ code: 'GUESS_ROOM_NOT_FOUND' });
    return JSON.parse(row.state_json) as Room;
  }

  private authenticate(room: Room, authorization: string | undefined): Player {
    const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
    const player = token && room.players.find((member) => safeHashEqual(token, member.tokenHash));
    if (!player) throw new UnauthorizedException({ code: 'GUESS_AUTH_REQUIRED' });
    return player;
  }

  private requirePhase(room: Room, phase: Room['phase']): void {
    if (room.phase !== phase) throw new ConflictException({ code: 'GUESS_WRONG_PHASE' });
  }

  private deal(room: Room): void {
    const count = room.players.length;
    if (count < 2) throw new ConflictException({ code: 'GUESS_NEED_PLAYERS' });
    const codes = this.pools.availableCodes(this.pools.get(room.poolId).codes);
    if (codes.length < count) throw new ConflictException({ code: 'GUESS_POOL_TOO_SMALL' });
    const answers = sample(codes, count);
    const seats = sample(room.players, count).map((player, index) => ({
      playerId: player.playerId, code: answers[index], points: null, attempts: 0,
    }));
    room.round = {
      number: (room.round?.number ?? 0) + 1,
      seats,
      currentPlayerId: seats[randomInt(count)].playerId,
      lastMove: null,
    };
    room.phase = 'playing';
  }

  private play(room: Room, player: Player, code: number | null): GuessMove {
    const round = room.round;
    if (room.phase !== 'playing' || !round) throw new ConflictException({ code: 'GUESS_WRONG_PHASE' });
    if (round.currentPlayerId !== player.playerId) throw new ConflictException({ code: 'GUESS_NOT_YOUR_TURN' });
    const remaining = round.seats.filter((seat) => seat.points === null).length;
    if (code === null) {
      if (remaining !== 1) throw new ConflictException({ code: 'GUESS_SURRENDER_TOO_EARLY' });
    } else {
      const card = this.cards.get(code);
      const poolCodes = this.pools.get(room.poolId).codes;
      if (!card || (card.type & TYPE_TOKEN) || (poolCodes && !poolCodes.includes(code))) {
        throw new BadRequestException({ code: 'GUESS_CARD_NOT_IN_POOL' });
      }
    }
    const index = round.seats.findIndex((seat) => seat.playerId === player.playerId);
    const seat = round.seats[index];
    if (code !== null) seat.attempts++;
    seat.points = code === null ? 0 : code === seat.code ? remaining : null;
    player.score += seat.points ?? 0;
    round.lastMove = {
      playerId: player.playerId,
      points: seat.points,
      outcome: code === null ? 'surrendered' : seat.points === null ? 'incorrect' : 'correct',
    };
    const clockwise = round.seats.slice(index + 1).concat(round.seats.slice(0, index + 1));
    round.currentPlayerId = clockwise.find((candidate) => candidate.points === null)?.playerId ?? null;
    if (round.currentPlayerId === null) {
      room.phase = 'between_rounds';
    }
    return round.lastMove;
  }

  private write(room: Room, event: object): void {
    const db = getDb();
    const now = new Date().toISOString();
    room.version++;
    db.prepare('INSERT INTO guess_room_events (room_id, version, event_json, created_at) VALUES (?, ?, ?, ?)')
      .run(room.roomId, room.version, JSON.stringify(event), now);
    db.prepare(`
      INSERT INTO guess_rooms (room_id, phase, state_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (room_id) DO UPDATE SET phase = excluded.phase,
        state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(room.roomId, room.players.length ? room.phase : 'closed', JSON.stringify(room), now);
  }

  private view(room: Room, viewerId: string): GuessRoomView {
    const round = room.round;
    const visibleSeats = round?.seats.filter((seat) => seat.playerId !== viewerId || seat.points !== null) ?? [];
    const cards = new Map(this.cards.getMany(visibleSeats.map((seat) => seat.code)).map((card) => [card.code, card]));
    const players = round
      ? round.seats.map((seat) => ({
        playerId: seat.playerId,
        score: room.players.find((player) => player.playerId === seat.playerId)!.score,
        roundPoints: seat.points,
        card: visibleSeats.includes(seat) ? cards.get(seat.code) ?? null : null,
      }))
      : room.players.map(({ playerId, score }) => ({ playerId, score, roundPoints: null, card: null }));
    return {
      ...summary(room),
      version: room.version,
      phase: room.phase,
      round: round?.number ?? 0,
      poolCount: room.poolCount,
      hostId: room.players[0].playerId,
      viewerId,
      currentPlayerId: round?.currentPlayerId ?? null,
      players,
      lastMove: round?.lastMove ?? null,
    };
  }
}
