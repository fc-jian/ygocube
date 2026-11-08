import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import type {
  CardSearchParams, GuessActionRequest, GuessCardKind, GuessCardPage, GuessCardRef, GuessCreateRequest, GuessMove,
  GuessOpeningHint, GuessOpeningHintGroup, GuessRoomSummary,
  GuessPublicRoomView, GuessRoomView, GuessSession, GuessSpectatorView,
} from '@ygocube/shared';
import { safeHashEqual, sha256 } from '../auth/auth.guard';
import { CardsService, TYPE_TOKEN } from '../cards/cards.service';
import { getDb } from '../db';
import { GuessPoolsService } from './guess-pools.service';
import { drawOpeningHints } from './opening-hints';

const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
const EXPIRY_INTERVAL_MS = 60 * 1000;
const OPEN_ROOM_PHASES = "phase IN ('lobby', 'playing', 'between_rounds')";
const STARTED_ROOM_PHASES = "phase IN ('playing', 'between_rounds')";
type SystemFinishReason = NonNullable<GuessRoomView['finishReason']>;

interface Player {
  playerId: string;
  tokenHash: string;
  score: number;
  departed?: true;
}

interface Seat {
  playerId: string;
  code: number;
  points: number | null;
  attempts: number;
  openingHint?: GuessOpeningHint;
}

interface PreviousSurrender {
  round: number;
  playerId: string;
  code: number;
}

interface Round {
  number: number;
  seats: Seat[];
  currentPlayerId: string | null;
  lastMove: GuessMove | null;
  selectedCode?: number;
  hintPools?: Partial<Record<GuessOpeningHintGroup, number[]>>;
  previousSurrender?: PreviousSurrender;
}

interface Room {
  roomId: string;
  name: string;
  poolId: number;
  poolName: string;
  poolCount: number;
  phase: GuessRoomView['phase'];
  finishReason?: SystemFinishReason;
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

interface SubmittedGuessRow {
  playerId: string;
  code: number;
  outcome: 'correct' | 'incorrect';
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

function activePlayers(room: Room): Player[] {
  return room.players.filter((player) => !player.departed);
}

function summary(room: Room): GuessRoomSummary {
  return {
    roomId: room.roomId,
    name: room.name,
    playerCount: activePlayers(room).length,
    maxPlayers: room.poolCount,
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

function inactivityCutoff(now = Date.now()): string {
  return new Date(now - ROOM_IDLE_MS).toISOString();
}

function writeRoom(room: Room, event: object, now = new Date().toISOString()): void {
  const db = getDb();
  room.version++;
  db.prepare('INSERT INTO guess_room_events (room_id, version, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(room.roomId, room.version, JSON.stringify(event), now);
  db.prepare(`
    INSERT INTO guess_rooms (room_id, phase, state_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (room_id) DO UPDATE SET phase = excluded.phase,
      state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(room.roomId, room.players.length ? room.phase : 'closed', JSON.stringify(room), now);
}

function settleRooms(reason: SystemFinishReason, roomId?: string, phases = OPEN_ROOM_PHASES): number {
  const db = getDb();
  const now = Date.now();
  const where = [phases];
  const bindings: string[] = [];
  if (reason === 'inactivity') {
    where.push('updated_at <= ?');
    bindings.push(inactivityCutoff(now));
  }
  if (roomId !== undefined) {
    where.push('room_id = ?');
    bindings.push(roomId.toUpperCase());
  }
  const pending = db.prepare(`SELECT state_json FROM guess_rooms WHERE ${where.join(' AND ')}`);
  if (!pending.get(...bindings)) return 0;
  return db.transaction(() => {
    const rows = pending.all(...bindings) as RoomRow[];
    const finishedAt = new Date(now).toISOString();
    for (const row of rows) {
      const room = JSON.parse(row.state_json) as Room;
      room.phase = 'finished';
      room.finishReason = reason;
      if (room.round) {
        room.round.currentPlayerId = null;
        delete room.round.selectedCode;
      }
      writeRoom(room, { action: 'finish', reason }, finishedAt);
    }
    return rows.length;
  }).immediate();
}

export function settleOpenGuessRoomsForMaintenance(includeLobby = true): number {
  return settleRooms('maintenance', undefined, includeLobby ? OPEN_ROOM_PHASES : STARTED_ROOM_PHASES);
}

@Injectable()
export class GuessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GuessService.name);
  private expiryTimer?: ReturnType<typeof setInterval>;

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
    settleRooms('inactivity');
    if (!this.expiryTimer) {
      this.expiryTimer = setInterval(() => {
        try {
          settleRooms('inactivity');
        } catch (error) {
          this.logger.error('Failed to settle inactive Guess rooms', error);
        }
      }, EXPIRY_INTERVAL_MS);
      this.expiryTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  list(): GuessRoomSummary[] {
    const rows = getDb().prepare(`
      SELECT state_json FROM guess_rooms WHERE phase = 'lobby' AND updated_at > ?
        AND json_array_length(state_json, '$.players') < json_extract(state_json, '$.poolCount')
      ORDER BY updated_at DESC, room_id LIMIT 50
    `).all(inactivityCutoff()) as RoomRow[];
    return rows.map((row) => summary(JSON.parse(row.state_json) as Room));
  }

  create(input: GuessCreateRequest): GuessSession {
    const db = getDb();
    return db.transaction(() => {
      const pool = this.pools.get(input.poolId);
      const poolCount = this.pools.availableCodes(pool.codes).length;
      if (poolCount === 0) throw new BadRequestException({ code: 'GUESS_INVALID_POOL' });
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
      writeRoom(room, { action: 'create', ...input });
      return { token, room: this.view(room, player.playerId) };
    }).immediate();
  }

  join(roomId: string, playerId: string): GuessSession {
    settleRooms('inactivity', roomId);
    return getDb().transaction(() => {
      const room = this.load(roomId);
      this.requireJoinable(room);
      if (room.players.some((player) => player.playerId.toLowerCase() === playerId.toLowerCase())) {
        throw new ConflictException({ code: 'GUESS_PLAYER_EXISTS' });
      }
      const { playerCount, maxPlayers } = summary(room);
      if (playerCount >= maxPlayers) {
        throw new ConflictException({ code: 'GUESS_ROOM_FULL' });
      }
      const { player, token } = newPlayer(playerId);
      room.players.push(player);
      writeRoom(room, { action: 'join', playerId });
      return { token, room: this.view(room, playerId) };
    }).immediate();
  }

  state(roomId: string, authorization: string | undefined): GuessRoomView {
    settleRooms('inactivity', roomId);
    const room = this.load(roomId);
    return this.view(room, this.authenticate(room, authorization).playerId);
  }

  spectate(roomId: string): GuessSpectatorView {
    settleRooms('inactivity', roomId);
    return this.view(this.load(roomId));
  }

  search(roomId: string, authorization: string | undefined, params: CardSearchParams): GuessCardPage {
    const room = this.load(roomId);
    const { playerId } = this.authenticate(room, authorization);
    const codes = this.openingCandidates(room.round, playerId) ?? this.pools.get(room.poolId).codes;
    return this.pools.search(params, codes);
  }

  act(roomId: string, authorization: string | undefined, command: GuessActionRequest): GuessRoomView | null {
    settleRooms('inactivity', roomId);
    return getDb().transaction(() => {
      const room = this.load(roomId);
      const player = this.authenticate(room, authorization);
      const { playerId } = player;
      if (command.version !== room.version) throw new ConflictException({ code: 'GUESS_STALE_VERSION' });
      if (command.action === 'leave') {
        this.requireJoinable(room);
        this.depart(room, player);
        writeRoom(room, { action: 'leave', playerId });
        return null;
      }
      if (command.action === 'remove' || command.action === 'start' || command.action === 'next' || command.action === 'finish') {
        if (activePlayers(room)[0] !== player) throw new ForbiddenException({ code: 'GUESS_HOST_REQUIRED' });
        if (command.action === 'remove') {
          this.requirePhase(room, 'between_rounds');
          const target = activePlayers(room).find((member) => member.playerId === command.playerId);
          if (!target) throw new NotFoundException({ code: 'GUESS_PLAYER_NOT_IN_ROOM' });
          if (target === player) throw new BadRequestException({ code: 'GUESS_REMOVE_SELF' });
          this.depart(room, target);
          writeRoom(room, { action: 'remove', playerId, targetPlayerId: target.playerId });
        } else if (command.action === 'finish') {
          this.requirePhase(room, 'between_rounds');
          room.phase = 'finished';
          writeRoom(room, { action: 'finish', playerId });
        } else {
          if (command.action === 'next' && room.phase === 'playing') {
            this.advanceAfterSurrender(room, player);
          } else {
            this.requirePhase(room, command.action === 'start' ? 'lobby' : 'between_rounds');
            this.deal(room);
          }
          writeRoom(room, { action: command.action, playerId, round: room.round });
        }
      } else {
        this.applyTurn(room, player, command);
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
    const player = token && room.players.find((member) => !member.departed && safeHashEqual(token, member.tokenHash));
    if (!player) throw new UnauthorizedException({ code: 'GUESS_AUTH_REQUIRED' });
    return player;
  }

  private requirePhase(room: Room, phase: Room['phase']): void {
    if (room.phase !== phase) throw new ConflictException({ code: 'GUESS_WRONG_PHASE' });
  }

  private requireJoinable(room: Room): void {
    if (room.phase !== 'between_rounds') this.requirePhase(room, 'lobby');
  }

  private depart(room: Room, player: Player): void {
    if (room.phase === 'lobby') {
      room.players = room.players.filter((member) => member !== player);
    } else {
      player.departed = true;
      player.tokenHash = '';
      if (activePlayers(room).length === 0) room.phase = 'finished';
    }
  }

  private advanceAfterSurrender(room: Room, host: Player): void {
    const round = room.round;
    const seat = round?.seats.find((candidate) => candidate.playerId === round.currentPlayerId);
    const remaining = activePlayers(room).find((candidate) => candidate.playerId === seat?.playerId);
    if (!round || !seat || !remaining) throw new ConflictException({ code: 'GUESS_WRONG_PHASE' });
    // Both events and the completed-round statistics commit with the new deal.
    this.applyTurn(room, remaining, { action: 'surrender', version: room.version }, host.playerId);
    this.deal(room, { round: round.number, playerId: seat.playerId, code: seat.code });
  }

  private deal(room: Room, previousSurrender?: PreviousSurrender): void {
    const participants = activePlayers(room);
    const count = participants.length;
    if (count === 0) throw new ConflictException({ code: 'GUESS_NEED_PLAYERS' });
    const codes = this.pools.availableCodes(this.pools.get(room.poolId).codes);
    if (codes.length < count) throw new ConflictException({ code: 'GUESS_POOL_TOO_SMALL' });
    const answers = sample(codes, count);
    const { hints, pools: hintPools } = drawOpeningHints(this.cards.getMany(codes), answers, this.cards.poolFieldSizes());
    const seats = sample(participants, count).map((player, index) => ({
      playerId: player.playerId, code: answers[index], points: null, attempts: 0, openingHint: hints[index],
    }));
    room.round = {
      number: (room.round?.number ?? 0) + 1,
      seats,
      hintPools,
      currentPlayerId: seats[randomInt(count)].playerId,
      lastMove: null,
      previousSurrender,
    };
    room.phase = 'playing';
  }

  private openingCandidates(round: Round | null, playerId: string): number[] | undefined {
    const seat = round?.seats.find((entry) => entry.playerId === playerId);
    if (!round || !seat?.openingHint) return undefined;
    const visibleCodes = new Set(round.seats.filter((entry) => entry !== seat).map(({ code }) => code));
    return (round.hintPools?.[seat.openingHint.group] ?? []).filter((code) => !visibleCodes.has(code));
  }

  private guessCard(room: Room, playerId: string, code: number) {
    const card = this.cards.get(code);
    if (!card || (card.type & TYPE_TOKEN)) {
      throw new BadRequestException({ code: 'GUESS_CARD_NOT_IN_POOL' });
    }
    const candidates = this.openingCandidates(room.round, playerId);
    const allowed = candidates ?? this.pools.get(room.poolId).codes;
    if (allowed && !allowed.includes(code)) {
      throw new BadRequestException({ code: candidates ? 'GUESS_CARD_OUTSIDE_HINT' : 'GUESS_CARD_NOT_IN_POOL' });
    }
    if (this.submittedGuesses(room, playerId).some((guess) => guess.code === code && guess.outcome === 'incorrect')) {
      throw new ConflictException({ code: 'GUESS_CARD_ALREADY_GUESSED' });
    }
    return card;
  }

  private applyTurn(room: Room, player: Player, command: TurnCommand, forcedBy?: string): void {
    const move = this.play(room, player, command);
    writeRoom(room, { ...command, playerId: player.playerId, ...(move && { move }), ...(forcedBy && { forcedBy }) });
    const round = room.round!;
    if (round.currentPlayerId === null) this.pools.recordRound(room.poolId, room.roomId, round.number, round.seats);
  }

  private play(room: Room, player: Player, command: TurnCommand): GuessMove | null {
    const round = room.round;
    if (room.phase !== 'playing' || !round) throw new ConflictException({ code: 'GUESS_WRONG_PHASE' });
    const hostSkip = command.action === 'host-skip';
    if (hostSkip) {
      if (activePlayers(room)[0] !== player) throw new ForbiddenException({ code: 'GUESS_HOST_REQUIRED' });
    } else if (round.currentPlayerId !== player.playerId) {
      throw new ConflictException({ code: 'GUESS_NOT_YOUR_TURN' });
    }
    if (command.action === 'select') {
      round.selectedCode = this.guessCard(room, player.playerId, command.code).code;
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
      const card = this.guessCard(room, player.playerId, command.code);
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

  private submittedGuesses(room: Room, viewerId: string | null): SubmittedGuessRow[] {
    return getDb().prepare(`
      SELECT json_extract(event_json, '$.playerId') AS playerId,
        json_extract(event_json, '$.code') AS code, json_extract(event_json, '$.move.outcome') AS outcome
      FROM guess_room_events
      WHERE room_id = @roomId AND version <= @version AND version > COALESCE((
        SELECT version FROM guess_room_events
        WHERE room_id = @roomId AND version <= @version
          AND json_extract(event_json, '$.action') IN ('start', 'next')
        ORDER BY version DESC LIMIT 1
      ), 0)
        AND json_extract(event_json, '$.action') = 'guess'
        AND (@viewerId IS NULL OR json_extract(event_json, '$.playerId') = @viewerId)
        AND json_type(event_json, '$.code') = 'integer'
        AND json_extract(event_json, '$.move.outcome') IN ('correct', 'incorrect')
      GROUP BY playerId, code, outcome ORDER BY MIN(version)
    `).all({ roomId: room.roomId, version: room.version, viewerId }) as SubmittedGuessRow[];
  }

  private view(room: Room, viewerId: string): GuessRoomView;
  private view(room: Room): GuessSpectatorView;
  private view(room: Room, viewerId?: string): GuessRoomView | GuessSpectatorView {
    const round = room.round;
    const seats = round?.seats ?? [];
    const ownSeat = seats.find((seat) => seat.playerId === viewerId);
    const guesses = round ? this.submittedGuesses(room, viewerId ?? null) : [];
    const visibleSeats = seats.filter((seat) => viewerId === undefined
      ? seat.points != null
      : seat !== ownSeat || room.phase !== 'playing' || seat.points !== null);
    const visiblePlayers = new Set(visibleSeats.map((seat) => seat.playerId));
    const codes = [...visibleSeats.map((seat) => seat.code), ...guesses.map(({ code }) => code)];
    const previous = round?.previousSurrender;
    if (previous) codes.push(previous.code);
    if (ownSeat && !ownSeat.openingHint) codes.push(ownSeat.code);
    if (round?.selectedCode !== undefined) codes.push(round.selectedCode);
    const cards = new Map(this.cards.getMany(codes).map((card) => [card.code, card]));
    const reference = (code: number) => ({ code, name: cards.get(code)?.name ?? String(code).padStart(8, '0') });
    const currentGuess = round?.selectedCode === undefined ? undefined : cards.get(round.selectedCode);
    const seatsById = new Map(seats.map((seat) => [seat.playerId, seat]));
    const standings = room.players.map(({ playerId, score, departed }) => ({
      playerId, score, departed: departed === true, roundPoints: seatsById.get(playerId)?.points ?? null,
    }));
    const scores = new Map(standings.map((standing) => [standing.playerId, standing.score]));
    const players = round ? seats.map(({ playerId, code, points, openingHint }) => ({
      playerId, score: scores.get(playerId) ?? 0, roundPoints: points,
      card: visiblePlayers.has(playerId) ? cards.get(code) ?? null : null,
      openingHint: openingHint ? { method: openingHint.method, group: openingHint.group } : null,
    })) : standings.map(({ playerId, score }) => ({ playerId, score, roundPoints: null, card: null, openingHint: null }));
    const publicView: GuessPublicRoomView = {
      ...summary(room),
      version: room.version,
      phase: room.phase,
      finishReason: room.finishReason ?? null,
      round: round?.number ?? 0,
      poolCount: room.poolCount,
      hostId: activePlayers(room)[0]?.playerId ?? null,
      currentPlayerId: round?.currentPlayerId ?? null,
      currentGuess: currentGuess ? cardRef(currentGuess) : null,
      players,
      standings,
      lastMove: round?.lastMove ?? null,
      ...(previous && { previousSurrender: { round: previous.round, playerId: previous.playerId, card: reference(previous.code) } }),
    };
    if (viewerId === undefined) {
      return { ...publicView, guesses: guesses.map(({ playerId, code, outcome }) => ({ playerId, card: reference(code), outcome })) };
    }
    return {
      ...publicView,
      viewerId,
      viewerOpeningHint: ownSeat?.openingHint ?? null,
      viewerCardKind: ownSeat?.openingHint ? null : cardKind(ownSeat && cards.get(ownSeat.code)?.type),
      viewerGuesses: guesses.map(({ code }) => reference(code)),
      viewerWrongGuessCodes: guesses.filter(({ outcome }) => outcome === 'incorrect').map(({ code }) => code),
    };
  }
}
