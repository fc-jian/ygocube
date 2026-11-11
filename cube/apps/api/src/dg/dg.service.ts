import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger,
  NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import {
  applyDgDrawingPatch, DG_DEFAULT_ROUND_SECONDS, DG_DEFAULT_SECONDS, DG_GUESS_COOLDOWN_MS, DG_MAX_SECONDS,
  type CardInfo, type CardSearchParams, type DgActionRequest, type DgCreateRequest, type DgDrawing,
  type DgDrawingPatch, type DgLastGuess, type DgLiveDrawing, type DgMode, type DgRelayPoints, type DgRoomSummary, type DgRoomView,
  type DgSession, type DgSettings, type DgSolve, type GuessCardRef, type GuessOpeningHint,
} from '@ygocube/shared';
import type { Response } from 'express';
import { safeHashEqual, sha256 } from '../auth/auth.guard';
import { CardsService, TYPE_TOKEN } from '../cards/cards.service';
import { getDb } from '../db';
import { GuessPoolsService } from '../guess/guess-pools.service';
import { buildOpeningHintOptions } from '../guess/opening-hints';
import { RealtimeService } from '../realtime/realtime.service';
import {
  activeRelayView, closeRelayStep, incomingDrawingVersion, RELAY_CHOICES, relayChainFor, relayOffers,
  relayStepAction, revealRelayChain, revealedRelayView, type RelayRound,
} from './dg-relay';

const MAX_PLAYERS = 16;
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
const DRAWING_WRITE_INTERVAL_MS = 80;

type Phase = DgRoomView['phase'];

interface Player {
  playerId: string;
  tokenHash: string;
  score: number;
  relayPoints?: DgRelayPoints;
}

interface Turn {
  number: number;
  drawerId: string;
  answer: CardInfo;
  drawingVersion: number | null;
  hint: GuessOpeningHint | null;
  guesses: (DgLastGuess & { playerId: string })[];
  solves: DgSolve[];
}

interface Room extends Omit<DgRoomSummary, 'playerCount' | 'mode'> {
  mode?: DgMode;
  version: number;
  phase: Phase;
  deadlineAt: number | null;
  settings: DgSettings;
  players: Player[];
  usedCodes: number[];
  turn: Turn | null;
  relay?: RelayRound;
}

interface RoomRow { state_json: string }

function drawingChannel(roomId: string, turn: number): string {
  return `dg:${roomId}:${turn}`;
}

function newPlayer(playerId: string): { player: Player; token: string } {
  const token = randomBytes(32).toString('hex');
  return { player: { playerId, tokenHash: sha256(token), score: 0 }, token };
}

function summary({ roomId, name, poolId, poolName, players, maxPlayers, mode = 'classic' }: Room): DgRoomSummary {
  return { roomId, name, poolId, poolName, playerCount: players.length, maxPlayers, mode };
}

function classicRoundSeconds({ roundSeconds, drawSeconds, guessSeconds }: DgSettings): number {
  if (roundSeconds !== undefined) return roundSeconds;
  if (drawSeconds === DG_DEFAULT_SECONDS && guessSeconds === DG_DEFAULT_SECONDS) return DG_DEFAULT_ROUND_SECONDS;
  return Math.min(DG_MAX_SECONDS, drawSeconds + guessSeconds);
}

function writeRoom(room: Room, event: object, now: number): void {
  const db = getDb();
  room.version++;
  db.prepare('INSERT INTO dg_room_events (room_id, version, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(room.roomId, room.version, JSON.stringify({ ...event, phase: room.phase, deadlineAt: room.deadlineAt }), now);
  db.prepare(`
    INSERT INTO dg_rooms (room_id, phase, deadline_at, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (room_id) DO UPDATE SET phase = excluded.phase, deadline_at = excluded.deadline_at,
      state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(room.roomId, room.phase, room.deadlineAt, JSON.stringify(room), now);
}

@Injectable()
export class DgService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DgService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly cards: CardsService,
    private readonly pools: GuessPoolsService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.advanceDueRooms(Date.now());
    this.timer = setInterval(() => {
      try {
        this.advanceDueRooms(Date.now());
      } catch (error) {
        this.logger.error('Failed to advance Draw & Guess rooms', error);
      }
    }, 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  list(): DgRoomSummary[] {
    const rows = getDb().prepare(`
      SELECT state_json FROM dg_rooms WHERE phase = 'lobby' AND deadline_at > ?
        AND json_array_length(state_json, '$.players') < json_extract(state_json, '$.maxPlayers')
      ORDER BY updated_at DESC, room_id LIMIT 50
    `).all(Date.now()) as RoomRow[];
    return rows.map(({ state_json }) => summary(JSON.parse(state_json) as Room));
  }

  create(input: DgCreateRequest): DgSession {
    const db = getDb();
    return db.transaction(() => {
      const pool = this.pools.get(input.poolId);
      const mode = input.mode ?? 'classic';
      const poolCount = this.pools.availableCodes(pool.codes).length;
      if (poolCount < (mode === 'relay' ? RELAY_CHOICES : 2)) throw new ConflictException({ code: 'DG_POOL_TOO_SMALL' });
      const maxPlayers = mode === 'relay' ? MAX_PLAYERS : Math.min(MAX_PLAYERS, poolCount);
      const exists = db.prepare('SELECT 1 FROM dg_rooms WHERE room_id = ?');
      let roomId = randomBytes(4).toString('hex').toUpperCase();
      while (exists.get(roomId)) roomId = randomBytes(4).toString('hex').toUpperCase();
      const { player, token } = newPlayer(input.playerId);
      const now = Date.now();
      const settings: DgSettings = {
        drawSeconds: input.drawSeconds ?? DG_DEFAULT_SECONDS,
        guessSeconds: input.guessSeconds ?? DG_DEFAULT_SECONDS,
        hintsEnabled: mode === 'classic' && (input.hintsEnabled ?? true),
      };
      if (mode === 'classic') settings.roundSeconds = input.roundSeconds ?? classicRoundSeconds(settings);
      const room: Room = {
        roomId, name: input.name, poolId: pool.poolId, poolName: pool.name, maxPlayers, mode,
        version: 0, phase: 'lobby', deadlineAt: now + ROOM_IDLE_MS,
        settings, players: [player], usedCodes: [], turn: null,
      };
      writeRoom(room, { action: 'create', name: room.name, poolId: room.poolId, playerId: player.playerId, mode, settings }, now);
      return { token, room: this.view(room, player.playerId) };
    }).immediate();
  }

  join(roomId: string, playerId: string): DgSession {
    return getDb().transaction(() => {
      const room = this.load(roomId);
      const now = Date.now();
      this.requirePhase(room, 'lobby', now);
      if (room.players.some((player) => player.playerId.toLowerCase() === playerId.toLowerCase())) {
        throw new ConflictException({ code: 'DG_PLAYER_EXISTS' });
      }
      if (room.players.length >= room.maxPlayers) throw new ConflictException({ code: 'DG_ROOM_FULL' });
      const { player, token } = newPlayer(playerId);
      room.players.push(player);
      room.deadlineAt = now + ROOM_IDLE_MS;
      writeRoom(room, { action: 'join', playerId }, now);
      return { token, room: this.view(room, playerId) };
    }).immediate();
  }

  state(roomId: string, authorization?: string): DgRoomView {
    this.advanceDueRooms(Date.now(), roomId.toUpperCase());
    const room = this.load(roomId);
    const viewer = authorization === undefined ? null : this.authenticate(room, authorization);
    return this.view(room, viewer?.playerId);
  }

  search(roomId: string, authorization: string | undefined, params: CardSearchParams) {
    const room = this.load(roomId);
    this.authenticate(room, authorization);
    return this.pools.search(params, this.pools.get(room.poolId).codes);
  }

  drawing(roomId: string, turnNumber: number): DgDrawing {
    const room = this.load(roomId);
    const version = room.turn?.number === turnNumber ? room.turn.drawingVersion : null;
    return this.readDrawing(room.roomId, version);
  }

  liveDrawing(roomId: string, turn: number): DgLiveDrawing {
    const room = this.load(roomId);
    if (room.phase !== 'drawing' || room.turn?.number !== turn || room.deadlineAt! <= Date.now()) {
      throw new NotFoundException({ code: 'DG_DRAWING_NOT_FOUND' });
    }
    const { revision, strokes } = this.readLiveDrawing(room.roomId, turn);
    return { revision, strokes };
  }

  subscribeDrawing(roomId: string, turn: number, response: Response): void {
    const snapshot = this.liveDrawing(roomId, turn);
    this.realtime.subscribe(drawingChannel(roomId.toUpperCase(), turn), response, snapshot);
  }

  updateDrawing(roomId: string, turnNumber: number, authorization: string | undefined, patch: DgDrawingPatch) {
    const changed = getDb().transaction(() => {
      const room = this.load(roomId);
      const player = this.authenticate(room, authorization);
      const now = Date.now();
      this.requirePhase(room, 'drawing', now);
      const turn = this.requireTurn(room, turnNumber);
      if (turn.drawerId !== player.playerId) throw new ForbiddenException({ code: 'DG_DRAWER_REQUIRED' });
      const current = this.readLiveDrawing(room.roomId, turnNumber);
      if (current.revision === patch.revision) return false;
      if (current.revision !== patch.baseRevision) throw new ConflictException({ code: 'DG_STALE_DRAWING' });
      if (current.revision !== null && now - current.updatedAt < DRAWING_WRITE_INTERVAL_MS) {
        throw new HttpException({ code: 'DG_DRAWING_RATE_LIMIT' }, HttpStatus.TOO_MANY_REQUESTS);
      }
      const updated = applyDgDrawingPatch(current, patch);
      if (!updated) throw new BadRequestException({ code: 'BAD_PAYLOAD' });
      writeRoom(room, { action: 'draw', turn: turnNumber, patch }, now);
      getDb().prepare(`
        INSERT INTO dg_live_drawings (room_id, turn, revision, strokes_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (room_id) DO UPDATE SET turn = excluded.turn, revision = excluded.revision,
          strokes_json = excluded.strokes_json, updated_at = excluded.updated_at
      `).run(room.roomId, turnNumber, updated.revision, JSON.stringify(updated.strokes), now);
      return true;
    }).immediate();
    if (changed) this.realtime.emit(drawingChannel(roomId.toUpperCase(), turnNumber), 'drawing', patch);
    return { revision: patch.revision };
  }

  relayIncoming(roomId: string, authorization: string | undefined, roundNumber: number, step: number): DgDrawing {
    const room = this.load(roomId);
    const viewer = this.authenticate(room, authorization);
    const round = room.relay;
    if (room.phase !== 'relay' || round?.number !== roundNumber || round.step !== step || relayStepAction(round) === 'draw') {
      throw new NotFoundException({ code: 'DG_DRAWING_NOT_FOUND' });
    }
    return this.readDrawing(room.roomId, incomingDrawingVersion(relayChainFor(round, room.players.indexOf(viewer)), step));
  }

  relayResult(roomId: string, roundNumber: number, chain: number) {
    const room = this.load(roomId);
    return revealedRelayView(this.revealedRound(room, roundNumber, chain), room.players, chain);
  }

  relayResultDrawing(roomId: string, roundNumber: number, chain: number, step: number): DgDrawing {
    const room = this.load(roomId);
    const round = this.revealedRound(room, roundNumber, chain);
    return this.readDrawing(room.roomId, round.chains[chain - 1].entries[step - 1]?.drawingVersion ?? null);
  }

  act(roomId: string, authorization: string | undefined, command: DgActionRequest): DgRoomView | null {
    const { result, closed } = getDb().transaction(() => {
      const room = this.load(roomId);
      const player = this.authenticate(room, authorization);
      const { playerId } = player;
      const now = Date.now();
      const editing = room.phase === 'drawing' ? room.turn!.number : null;
      let event: object;
      switch (command.action) {
        case 'start': {
          this.requirePhase(room, 'lobby', now);
          this.requireHost(room, player);
          if (room.players.length < 2) throw new ConflictException({ code: 'DG_NEED_PLAYERS' });
          const codes = this.poolCodes(room);
          if (room.mode === 'relay') {
            this.startRelay(room, codes, now);
            event = { action: 'start', playerId, relay: room.relay };
          } else {
            if (codes.length < room.players.length) throw new ConflictException({ code: 'DG_POOL_TOO_SMALL' });
            this.deal(room, codes, now);
            event = { action: 'start', playerId, turn: room.turn };
          }
          break;
        }
        case 'leave':
          this.requirePhase(room, 'lobby', now);
          room.players = room.players.filter((member) => member !== player);
          if (room.players.length === 0) this.finish(room);
          else room.deadlineAt = now + ROOM_IDLE_MS;
          event = { action: 'leave', playerId };
          break;
        case 'guess':
          this.requirePhase(room, room.phase === 'drawing' ? 'drawing' : 'guessing', now);
          event = this.guess(room, this.requireTurn(room, command.turn), player, command.code, now);
          break;
        case 'next':
        case 'finish':
          this.requirePhase(room, 'reveal', now);
          this.requireHost(room, player);
          this.requireTurn(room, command.turn);
          if (command.action === 'next') this.deal(room, this.poolCodes(room), now);
          else this.finish(room);
          event = { action: command.action, playerId, turn: room.turn };
          break;
        case 'relay-submit':
          this.submitRelay(room, player, command, now);
          event = { ...command, playerId };
          break;
        case 'relay-reveal':
        case 'relay-next':
        case 'relay-finish':
          this.afterRelay(room, player, command, now);
          event = { ...command, playerId, ...(command.action === 'relay-next' && { relay: room.relay }) };
          break;
      }
      writeRoom(room, event, now);
      const closed = editing !== null && room.phase !== 'drawing' ? this.removeLiveDrawing(room.roomId, editing) : null;
      return { result: command.action === 'leave' ? null : this.view(room, playerId), closed };
    }).immediate();
    if (closed) this.realtime.close(closed);
    return result;
  }

  private guess(room: Room, turn: Turn, player: Player, code: number, now: number): object {
    const { playerId } = player;
    if (playerId === turn.drawerId) throw new ForbiddenException({ code: 'DG_GUESSER_REQUIRED' });
    if (turn.solves.some((solve) => solve.playerId === playerId)) {
      throw new ConflictException({ code: 'DG_ALREADY_SOLVED' });
    }
    const last = turn.guesses.find((guess) => guess.playerId === playerId);
    if (last && now - last.at < DG_GUESS_COOLDOWN_MS) {
      throw new HttpException({ code: 'DG_GUESS_RATE_LIMIT' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const card = this.poolCard(room, code);
    const correct = code === turn.answer.code;
    turn.guesses = turn.guesses.filter((guess) => guess.playerId !== playerId);
    turn.guesses.push({ playerId, card: { code, name: card.name }, correct, at: now });
    const guessers = room.players.length - 1;
    const points = correct ? guessers - turn.solves.length : 0;
    let drawing: DgDrawing | undefined;
    if (correct) {
      turn.solves.push({ playerId, points });
      player.score += points;
      room.players.find((member) => member.playerId === turn.drawerId)!.score++;
      if (turn.solves.length === guessers) {
        if (room.phase === 'drawing') drawing = this.freezeLiveDrawing(room, turn);
        this.completeTurn(room);
      }
    }
    return { action: 'guess', playerId, turn: turn.number, code, correct, points, drawing };
  }

  private startRelay(room: Room, codes: number[], now: number): void {
    if (codes.length < RELAY_CHOICES) throw new ConflictException({ code: 'DG_POOL_TOO_SMALL' });
    room.relay = {
      rules: 'alternating', number: (room.relay?.number ?? 0) + 1, step: 1, revealedCount: 0,
      chains: relayOffers(codes, room.players.length).map((offer) => ({
        choices: this.cards.getMany(offer), answer: null, entries: [],
      })),
    };
    room.phase = 'relay';
    room.deadlineAt = now + room.settings.drawSeconds * 1000;
  }

  private submitRelay(room: Room, player: Player, command: Extract<DgActionRequest, { action: 'relay-submit' }>, now: number): void {
    this.requirePhase(room, 'relay', now);
    const round = this.requireRelay(room, command.round);
    if (command.step !== round.step) throw new ConflictException({ code: 'DG_STALE_RELAY' });
    const chain = relayChainFor(round, room.players.indexOf(player));
    if (chain.entries.length === round.step) throw new ConflictException({ code: 'DG_RELAY_SUBMITTED' });
    const action = relayStepAction(round);
    const { code, drawing } = command;
    if ((code !== undefined) !== (action !== 'draw') || (drawing !== undefined) !== (action !== 'guess')) {
      throw new BadRequestException({ code: 'BAD_PAYLOAD' });
    }
    let guess: GuessCardRef | null = null;
    if (action === 'opening') {
      const choice = chain.choices.find((card) => card.code === code);
      if (!choice) throw new BadRequestException({ code: 'DG_RELAY_CHOICE_REQUIRED' });
      chain.answer = choice;
    } else if (code !== undefined) {
      guess = { code, name: this.poolCard(room, code).name };
    }
    chain.entries.push({ guess, drawingVersion: drawing ? room.version + 1 : null });
    if (round.chains.every(({ entries }) => entries.length === round.step)) this.advanceRelay(room, round, now);
  }

  private advanceRelay(room: Room, round: RelayRound, now: number): void {
    if (closeRelayStep(round)) {
      const seconds = relayStepAction(round) === 'draw' ? room.settings.drawSeconds : room.settings.guessSeconds;
      room.deadlineAt = now + seconds * 1000;
    } else {
      revealRelayChain(round, room.players);
      room.phase = 'relay_reveal';
      room.deadlineAt = now + ROOM_IDLE_MS;
    }
  }

  private afterRelay(
    room: Room, player: Player, command: Extract<DgActionRequest, { action: 'relay-reveal' | 'relay-next' | 'relay-finish' }>, now: number,
  ): void {
    this.requirePhase(room, 'relay_reveal', now);
    this.requireHost(room, player);
    const round = this.requireRelay(room, command.round);
    if (command.action === 'relay-reveal') {
      if (round.revealedCount !== command.chain || round.revealedCount >= room.players.length) {
        throw new ConflictException({ code: 'DG_STALE_RELAY' });
      }
      revealRelayChain(round, room.players);
      room.deadlineAt = now + ROOM_IDLE_MS;
    } else {
      if (round.revealedCount < room.players.length) throw new ConflictException({ code: 'DG_WRONG_PHASE' });
      if (command.action === 'relay-next') this.startRelay(room, this.poolCodes(room), now);
      else this.finish(room);
    }
  }

  private advanceDueRooms(now: number, roomId?: string): void {
    const db = getDb();
    const condition = `deadline_at <= ? AND phase != 'reveal'${roomId === undefined ? '' : ' AND room_id = ?'}`;
    const args = roomId === undefined ? [now] : [now, roomId];
    if (!db.prepare(`SELECT 1 FROM dg_rooms WHERE ${condition} LIMIT 1`).get(...args)) return;
    const closed = db.transaction(() => {
      const closed: string[] = [];
      const rows = db.prepare(`SELECT state_json FROM dg_rooms WHERE ${condition}`).all(...args) as RoomRow[];
      for (const { state_json } of rows) {
        const room = JSON.parse(state_json) as Room;
        const previousPhase = room.phase;
        let drawing: DgDrawing | undefined;
        if (previousPhase === 'lobby') this.finish(room);
        else if (previousPhase === 'relay') this.advanceRelay(room, room.relay!, now);
        else if (previousPhase === 'relay_reveal') {
          const round = room.relay!;
          while (round.revealedCount < room.players.length) revealRelayChain(round, room.players);
          this.finish(room);
        } else {
          if (previousPhase === 'drawing') drawing = this.freezeLiveDrawing(room, room.turn!);
          this.completeTurn(room);
        }
        const progress = room.relay
          ? { round: room.relay.number, step: room.relay.step, revealedCount: room.relay.revealedCount }
          : { turn: room.turn };
        writeRoom(room, { action: 'timeout', previousPhase, ...progress, drawing }, now);
        if (previousPhase === 'drawing') closed.push(this.removeLiveDrawing(room.roomId, room.turn!.number));
      }
      return closed;
    }).immediate();
    for (const channel of closed) this.realtime.close(channel);
  }

  private poolCodes(room: Room): number[] {
    return this.pools.availableCodes(this.pools.get(room.poolId).codes);
  }

  private poolCard(room: Room, code: number): CardInfo {
    const card = this.cards.get(code);
    const { codes } = this.pools.get(room.poolId);
    if (!card || (card.type & TYPE_TOKEN) || (codes !== null && !codes.includes(code))) {
      throw new BadRequestException({ code: 'DG_CARD_NOT_IN_POOL' });
    }
    return card;
  }

  private readDrawing(roomId: string, version: number | null): DgDrawing {
    const row = version === null ? undefined : getDb().prepare('SELECT event_json FROM dg_room_events WHERE room_id = ? AND version = ?')
      .get(roomId, version) as { event_json: string } | undefined;
    if (!row) throw new NotFoundException({ code: 'DG_DRAWING_NOT_FOUND' });
    return (JSON.parse(row.event_json) as { drawing: DgDrawing }).drawing;
  }

  private readLiveDrawing(roomId: string, turn: number): DgLiveDrawing & { updatedAt: number } {
    const row = getDb().prepare('SELECT revision, strokes_json, updated_at FROM dg_live_drawings WHERE room_id = ? AND turn = ?')
      .get(roomId, turn) as { revision: string; strokes_json: string; updated_at: number } | undefined;
    return row ? { revision: row.revision, strokes: JSON.parse(row.strokes_json), updatedAt: row.updated_at }
      : { revision: null, strokes: [], updatedAt: 0 };
  }

  private freezeLiveDrawing(room: Room, turn: Turn): DgDrawing | undefined {
    const { strokes } = this.readLiveDrawing(room.roomId, turn.number);
    if (strokes.length === 0) return undefined;
    turn.drawingVersion = room.version + 1;
    return { strokes };
  }

  private removeLiveDrawing(roomId: string, turn: number): string {
    getDb().prepare('DELETE FROM dg_live_drawings WHERE room_id = ? AND turn = ?').run(roomId, turn);
    return drawingChannel(roomId, turn);
  }

  private revealedRound(room: Room, number: number, chain: number): RelayRound {
    const round = room.relay;
    if (round?.number !== number || chain > round.revealedCount) {
      throw new NotFoundException({ code: 'DG_RELAY_CHAIN_NOT_FOUND' });
    }
    return round;
  }

  private deal(room: Room, codes: number[], now: number): void {
    if (!codes.length) throw new ConflictException({ code: 'DG_POOL_TOO_SMALL' });
    const used = new Set(room.usedCodes);
    let remaining = codes.filter((code) => !used.has(code));
    if (remaining.length === 0) {
      room.usedCodes = [];
      remaining = codes;
    }
    const number = (room.turn?.number ?? 0) + 1;
    const drawer = room.players[(number - 1) % room.players.length];
    const code = remaining[randomInt(remaining.length)];
    const answer = this.cards.get(code)!;
    let hint: GuessOpeningHint | null = null;
    if (room.settings.hintsEnabled) {
      const catalog = this.cards.getMany(codes);
      const { options } = buildOpeningHintOptions(catalog, [code], this.cards.poolFieldSizes());
      const useful = options[0].filter(({ candidateCount }) => candidateCount < catalog.length);
      if (useful.length) hint = useful[randomInt(useful.length)];
    }
    room.usedCodes.push(code);
    room.turn = { number, drawerId: drawer.playerId, answer, drawingVersion: null, hint, guesses: [], solves: [] };
    room.phase = 'drawing';
    room.settings.roundSeconds = classicRoundSeconds(room.settings);
    room.deadlineAt = now + room.settings.roundSeconds * 1000;
  }

  private completeTurn(room: Room): void {
    room.phase = 'reveal';
    room.deadlineAt = null;
  }

  private finish(room: Room): void {
    room.phase = 'finished';
    room.deadlineAt = null;
  }

  private requireTurn(room: Room, turn: number): Turn {
    if (room.turn?.number !== turn) throw new ConflictException({ code: 'DG_STALE_TURN' });
    return room.turn;
  }

  private requireRelay(room: Room, number: number): RelayRound {
    if (room.relay?.number !== number) throw new ConflictException({ code: 'DG_STALE_RELAY' });
    return room.relay;
  }

  private requireHost(room: Room, player: Player): void {
    if (room.players[0] !== player) throw new ForbiddenException({ code: 'DG_HOST_REQUIRED' });
  }

  private requirePhase(room: Room, phase: Phase, now: number): void {
    if (room.phase !== phase || (room.deadlineAt !== null && room.deadlineAt <= now)) {
      throw new ConflictException({ code: 'DG_WRONG_PHASE' });
    }
  }

  private load(roomId: string): Room {
    const row = getDb().prepare('SELECT state_json FROM dg_rooms WHERE room_id = ?').get(roomId.toUpperCase()) as RoomRow | undefined;
    if (!row) throw new NotFoundException({ code: 'DG_ROOM_NOT_FOUND' });
    const room = JSON.parse(row.state_json) as Room;
    if (room.phase === 'reveal') room.deadlineAt = null;
    return room;
  }

  private authenticate(room: Room, authorization?: string): Player {
    const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
    const player = token && room.players.find(({ tokenHash }) => safeHashEqual(token, tokenHash));
    if (!player) throw new UnauthorizedException({ code: 'DG_AUTH_REQUIRED' });
    return player;
  }

  private view(room: Room, viewerId?: string): DgRoomView {
    const { phase, turn, relay, deadlineAt, settings } = room;
    const serverNow = Date.now();
    const last = viewerId === undefined ? undefined : turn?.guesses.find((guess) => guess.playerId === viewerId);
    const canSeeAnswer = phase === 'reveal' || phase === 'finished' || (viewerId !== undefined && viewerId === turn?.drawerId);
    const activeSeconds = phase === 'drawing' ? settings.roundSeconds ?? settings.drawSeconds : settings.guessSeconds;
    const hintAt = settings.hintsEnabled && deadlineAt !== null && (phase === 'drawing' || phase === 'guessing')
      ? deadlineAt - activeSeconds * 500 : null;
    const seat = room.players.findIndex(({ playerId }) => playerId === viewerId);
    return {
      ...summary(room), phase, version: room.version, serverNow,
      settings: room.mode === 'relay' ? settings : { ...settings, roundSeconds: classicRoundSeconds(settings) },
      deadlineAt: phase === 'lobby' || phase === 'relay_reveal' ? null : deadlineAt,
      hostId: room.players[0]?.playerId ?? null,
      players: room.players.map(({ playerId, score, relayPoints }) => room.mode === 'relay'
        ? { playerId, score, relayPoints: relayPoints ?? { guesses: 0, drawings: 0 } } : { playerId, score }),
      turn: turn && {
        number: turn.number, drawerId: turn.drawerId, hasDrawing: turn.drawingVersion !== null,
        answer: canSeeAnswer ? turn.answer : null,
        hintAt, hint: hintAt !== null && serverNow >= hintAt ? turn.hint : null,
        solves: turn.solves, drawerPoints: turn.solves.length,
      },
      relay: relay ? phase === 'relay' ? activeRelayView(relay, seat)
        : { kind: 'reveal', round: relay.number, revealedCount: relay.revealedCount } : null,
      viewerId: viewerId ?? null,
      viewerLastGuess: last ? { card: last.card, correct: last.correct, at: last.at } : null,
    };
  }
}
