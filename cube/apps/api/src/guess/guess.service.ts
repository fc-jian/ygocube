import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import type {
  GuessActionRequest, GuessCardKind, GuessCardPage, GuessCardRef, GuessCreateRequest, GuessMove, GuessRoomSummary,
  GuessRoomView, GuessSession,
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
  selectedCode?: number;
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
type TurnCommand = Extract<GuessActionRequest, { action: 'select' | 'guess' | 'skip' | 'host-skip' | 'surrender' }>;

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

function cardKind(type = 0): GuessCardKind | null {
  if (type & 0x1) return 'monster';
  if (type & 0x2) return 'spell';
  if (type & 0x4) return 'trap';
  return null;
}

function cardRef({ code, name }: GuessCardRef): GuessCardRef {
  return { code, name };
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
    return db.transaction(() => {
      const pool = this.pools.get(input.poolId);
      const poolCount = this.pools.availableCodes(pool.codes).length;
      if (poolCount < 2) throw new BadRequestException({ code: 'GUESS_INVALID_POOL' });
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
        const move = this.play(room, player, command);
        this.write(room, { ...command, playerId, ...(move && { move }) });
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

  private poolCard(room: Room, code: number) {
    const card = this.cards.get(code);
    const poolCodes = this.pools.get(room.poolId).codes;
    if (!card || (card.type & TYPE_TOKEN) || (poolCodes && !poolCodes.includes(code))) {
      throw new BadRequestException({ code: 'GUESS_CARD_NOT_IN_POOL' });
    }
    return card;
  }

  private play(room: Room, player: Player, command: TurnCommand): GuessMove | null {
    const round = room.round;
    if (room.phase !== 'playing' || !round) throw new ConflictException({ code: 'GUESS_WRONG_PHASE' });
    const hostSkip = command.action === 'host-skip';
    if (hostSkip) {
      if (room.players[0] !== player) throw new ForbiddenException({ code: 'GUESS_HOST_REQUIRED' });
    } else if (round.currentPlayerId !== player.playerId) {
      throw new ConflictException({ code: 'GUESS_NOT_YOUR_TURN' });
    }
    if (command.action === 'select') {
      round.selectedCode = this.poolCard(room, command.code).code;
      return null;
    }

    const index = round.seats.findIndex((seat) => seat.playerId === round.currentPlayerId);
    const seat = round.seats[index];
    const remaining = round.seats.filter((seat) => seat.points === null).length;
    const move: GuessMove = { playerId: seat.playerId, points: null, outcome: 'skipped' };
    if (command.action === 'surrender') {
      if (remaining !== 1) throw new ConflictException({ code: 'GUESS_SURRENDER_TOO_EARLY' });
      move.points = 0;
      move.outcome = 'surrendered';
    } else if (command.action === 'guess') {
      const card = this.poolCard(room, command.code);
      move.card = cardRef(card);
      if (card.code === seat.code) {
        move.points = remaining;
        move.outcome = 'correct';
        player.score += remaining;
      } else {
        move.outcome = 'incorrect';
      }
    } else if (hostSkip) {
      move.skippedBy = player.playerId;
    }
    if (command.action !== 'surrender') seat.attempts++;
    seat.points = move.points;
    round.lastMove = move;
    delete round.selectedCode;
    const clockwise = round.seats.slice(index + 1).concat(round.seats.slice(0, index + 1));
    round.currentPlayerId = clockwise.find((candidate) => candidate.points === null)?.playerId ?? null;
    if (round.currentPlayerId === null) {
      room.phase = 'between_rounds';
    }
    return move;
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

  private guessCodes(room: Room, viewerId: string): number[] {
    const rows = getDb().prepare(`
      SELECT json_extract(event_json, '$.code') AS code FROM guess_room_events
      WHERE room_id = @roomId AND version <= @version AND version > COALESCE((
        SELECT version FROM guess_room_events
        WHERE room_id = @roomId AND version <= @version
          AND json_extract(event_json, '$.action') IN ('start', 'next')
        ORDER BY version DESC LIMIT 1
      ), 0)
        AND json_extract(event_json, '$.action') = 'guess'
        AND json_extract(event_json, '$.playerId') = @viewerId
        AND json_type(event_json, '$.code') = 'integer'
      GROUP BY code ORDER BY MIN(version)
    `).all({ roomId: room.roomId, version: room.version, viewerId }) as { code: number }[];
    return rows.map(({ code }) => code);
  }

  private view(room: Room, viewerId: string): GuessRoomView {
    const round = room.round;
    const ownSeat = round?.seats.find((seat) => seat.playerId === viewerId);
    const guesses = round ? this.guessCodes(room, viewerId) : [];
    const codes = [...(round?.seats.map((seat) => seat.code) ?? []), ...guesses];
    if (round?.selectedCode !== undefined) codes.push(round.selectedCode);
    const cards = new Map(this.cards.getMany(codes).map((card) => [card.code, card]));
    const currentGuess = round?.selectedCode === undefined ? undefined : cards.get(round.selectedCode);
    const players = round
      ? round.seats.map((seat) => ({
        playerId: seat.playerId,
        score: room.players.find((player) => player.playerId === seat.playerId)!.score,
        roundPoints: seat.points,
        card: seat === ownSeat && seat.points === null ? null : cards.get(seat.code) ?? null,
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
      viewerCardKind: cardKind(ownSeat && cards.get(ownSeat.code)?.type),
      viewerGuesses: guesses.map((code) => ({ code, name: cards.get(code)?.name ?? String(code).padStart(8, '0') })),
      currentPlayerId: round?.currentPlayerId ?? null,
      currentGuess: currentGuess ? cardRef(currentGuess) : null,
      players,
      lastMove: round?.lastMove ?? null,
    };
  }
}
