import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type {
  DgActionRequest, DgDrawing, DgDrawingPatch, DgLiveDrawing, DgRelayChainView, DgRoomView,
  DgSession, GuessCardPage, GuessPoolSummary,
} from '@ygocube/shared';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { AuthGuard } from '../src/auth/auth.guard';
import { CardsService } from '../src/cards/cards.service';
import { config } from '../src/config';
import { closeDb, getDb } from '../src/db';
import { DgController } from '../src/dg/dg.controller';
import { DgService } from '../src/dg/dg.service';
import { GuessController } from '../src/guess/guess.controller';
import { GuessPoolsService } from '../src/guess/guess-pools.service';
import { GuessService } from '../src/guess/guess.service';
import { RealtimeService } from '../src/realtime/realtime.service';
import { useTestDb } from './helpers';

describe('Draw & Guess HTTP game', () => {
  const codes = [10000, 10001, 10002];
  const drawing: DgDrawing = { strokes: [{ color: '#a23e17', width: 10, points: [[1, 5], [150, 200]] }] };
  let app: INestApplication;
  let base: string;
  let poolId: number;
  let now: number;

  async function request<T = { code: string }>(path: string, token?: string, body?: unknown, adminToken?: string) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.text();
    return { status: response.status, body: (json ? JSON.parse(json) : null) as T };
  }

  beforeAll(async () => {
    useTestDb();
    config.admin.superToken = 'draw-guess-fixture';
    const cards = new CardsService();
    cards.poolCodes();
    getDb().prepare('UPDATE cards SET type = ? WHERE code = ?').run(0x10002, codes[1]);
    getDb().prepare('UPDATE cards SET type = ?, level = 3 WHERE code = ?').run(0x4000021, codes[2]);
    getDb().prepare("UPDATE cards SET setcodes_json = '[256]' WHERE code IN (?, ?)").run(codes[0], codes[2]);
    const module = await Test.createTestingModule({
      controllers: [DgController, GuessController],
      providers: [DgService, GuessService, GuessPoolsService, RealtimeService, { provide: CardsService, useValue: cards },
        { provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const pool = await request<GuessPoolSummary>('/games/guess/pools', undefined, { name: 'Shared game pool', codes }, config.admin.superToken);
    expect(pool.status).toBe(201);
    poolId = pool.body.poolId;
  });

  beforeEach(() => {
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (app) await app.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm', '.pre-auth-migration.bak']) fs.rmSync(config.server.dbPath + suffix, { force: true });
  });

  const rooms = '/games/dg/rooms';
  const act = <T = DgRoomView>(path: string, token: string, command: DgActionRequest) => request<T>(`${path}/action`, token, command);
  const state = async (path: string, token?: string) => (await request<DgRoomView>(path, token)).body;
  const firstPatch = (): DgDrawingPatch => ({
    baseRevision: null, revision: randomUUID(), strokeIndex: 0, pointIndex: 0, strokes: drawing.strokes,
  });

  async function classicRoles(path: string, room: DgRoomView, ...players: DgSession[]) {
    const artist = players.find(({ room: player }) => player.viewerId === room.turn?.drawerId);
    if (!artist) throw new Error('Expected a classic artist');
    const guessers = players.filter((player) => player !== artist);
    const answer = (await state(path, artist.token)).turn!.answer!;
    return { artist, guessers, answer };
  }

  async function relayRoom(relayPool: number, guests = ['Bert', 'Cy']) {
    const { body: host, status } = await request<DgSession>(rooms, undefined, {
      name: 'Relay room', playerId: 'Ada', poolId: relayPool, mode: 'relay', drawSeconds: 10, guessSeconds: 12,
    });
    expect(status).toBe(201);
    const path = `${rooms}/${host.room.roomId}`;
    const players = [host];
    for (const playerId of guests) {
      const { body, status } = await request<DgSession>(`${path}/join`, undefined, { playerId });
      expect(status).toBe(201);
      players.push(body);
    }
    return { path, players };
  }

  function activeRelay(room: DgRoomView) {
    if (room.relay?.kind !== 'active') throw new Error('Expected an active relay');
    return room.relay;
  }

  it('hides the card and hint, reuses the pool, and scores concurrent guesses in accepted order', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, { name: 'Draw room', playerId: 'Artist', poolId });
    const path = `${rooms}/${host.room.roomId}`;
    expect(host.room.settings).toMatchObject({ roundSeconds: 180, hintsEnabled: true });
    getDb().prepare("UPDATE dg_rooms SET state_json = json_remove(state_json, '$.mode', '$.settings.roundSeconds') WHERE room_id = ?")
      .run(host.room.roomId);
    expect((await state(path)).mode).toBe('classic');
    expect((await act(path, host.token, { action: 'start' })).status).toBe(409);
    const { body: first } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'First' });
    const { body: second } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Second' });
    expect((await act(path, first.token, { action: 'start' })).status).toBe(403);
    const { body: active } = await act(path, host.token, { action: 'start' });
    const { artist, guessers, answer: { code } } = await classicRoles(path, active, host, first, second);
    const [guesser, otherGuesser] = guessers;
    expect(codes).toContain(code);
    expect(active.deadlineAt).toBe(now + 180_000);
    expect((await state(path, guesser.token)).turn).toMatchObject({ answer: null, hint: null, hintAt: now + 90_000, hasDrawing: false });
    expect((await state(path)).turn?.answer).toBeNull();
    expect((await request(`${path}/drawing/1`)).status).toBe(404);
    expect((await request(`${path}/cards`)).status).toBe(401);
    const filtered = await request<GuessCardPage>(`${path}/cards?category=2`, first.token);
    expect(filtered.body.cards.map((card) => card.code)).toEqual([codes[1]]);
    const live = `${path}/drawing/1/live`;
    const malformed = { ...firstPatch(), strokes: [{ color: 'red', width: 10, points: [[0, 1]] }] };
    expect((await request(live, artist.token, malformed)).status).toBe(400);
    expect((await request(live, artist.token, firstPatch())).status).toBe(200);
    expect((await request(`${path}/drawing/1`)).status).toBe(404);
    expect((await act(path, artist.token, { action: 'guess', turn: 1, code })).status).toBe(403);
    expect((await act(path, guesser.token, { action: 'guess', turn: 1, code: 10003 })).status).toBe(400);

    now += 89_999;
    expect((await state(path, guesser.token)).turn?.hint).toBeNull();
    now++;
    expect((await state(path, guesser.token)).turn?.hint?.candidateCount).toBeLessThan(codes.length);
    const wrong = codes.find((candidate) => candidate !== code)!;
    expect((await act(path, guesser.token, { action: 'guess', turn: 1, code: wrong })).body.viewerLastGuess?.correct).toBe(false);
    expect(await state(path, guesser.token)).toMatchObject({ phase: 'drawing', deadlineAt: active.deadlineAt });
    expect((await state(path, otherGuesser.token)).viewerLastGuess).toBeNull();
    expect(await act(path, guesser.token, { action: 'guess', turn: 1, code })).toEqual({
      status: 429, body: { code: 'DG_GUESS_RATE_LIMIT' },
    });
    now += 1000;
    const attempts = await Promise.all(guessers.map(({ token }) => act(path, token, { action: 'guess', turn: 1, code })));
    expect(attempts.map(({ status }) => status)).toEqual([200, 200]);
    const result = await state(path);
    expect(result).toMatchObject({ phase: 'reveal', deadlineAt: null });
    expect(result.turn?.answer?.code).toBe(code);
    expect(result.turn?.drawerPoints).toBe(2);
    expect(result.turn?.solves.map(({ points }) => points)).toEqual([2, 1]);
    expect(result.turn?.solves.map(({ playerId }) => playerId).sort()).toEqual(guessers.map(({ room }) => room.viewerId).sort());
    expect((await request<DgDrawing>(`${path}/drawing/1`)).body).toEqual(drawing);

    now += 10_000;
    expect((await state(path)).phase).toBe('reveal');
    expect((await act(path, first.token, { action: 'next', turn: 1 })).status).toBe(403);
    expect((await act(path, first.token, { action: 'finish', turn: 1 })).status).toBe(403);
    const { body: next } = await act(path, host.token, { action: 'next', turn: 1 });
    expect(next.phase).toBe('drawing');
    expect(next.turn?.number).toBe(2);
    expect(next.turn?.drawerId).not.toBe(active.turn?.drawerId);
    expect((await classicRoles(path, next, host, first, second)).answer.code).not.toBe(code);
    expect(next.players).toEqual(result.players);
    expect((await request(`${path}/drawing/1`)).status).toBe(404);
  });

  it('recovers drawing deadlines from SQLite, applies custom timers, and keeps hints off', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, {
      name: 'Timed room', playerId: 'Artist', poolId, roundSeconds: 10, hintsEnabled: false,
    });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guest' });
    const { body: started } = await act(path, host.token, { action: 'start' });
    expect(started.deadlineAt).toBe(now + 10_000);

    now += 10_000;
    closeDb();
    const restarted = new DgService(app.get(CardsService), app.get(GuessPoolsService), app.get(RealtimeService));
    restarted.onModuleInit();
    restarted.onModuleDestroy();
    expect((await state(path)).phase).toBe('reveal');
    expect((await state(path)).turn).toMatchObject({ hasDrawing: false, drawerPoints: 0, solves: [] });

    const { body: next } = await act(path, host.token, { action: 'next', turn: 1 });
    expect(next).toMatchObject({ phase: 'drawing', turn: { number: 2 } });
    expect(next.turn?.drawerId).not.toBe(started.turn?.drawerId);
    const { artist, guessers: [guesser], answer: { code } } = await classicRoles(path, next, host, guest);
    expect((await request(`${path}/drawing/2/live`, artist.token, firstPatch())).status).toBe(200);
    closeDb();
    expect((await request<DgLiveDrawing>(`${path}/drawing/2/live`)).body.strokes).toEqual(drawing.strokes);
    now += 5000;
    expect((await state(path, guesser.token)).turn).toMatchObject({ hint: null, hintAt: null });
    now += 5000;
    expect((await act(path, guesser.token, { action: 'guess', turn: 2, code })).status).toBe(409);
    expect(await state(path)).toMatchObject({ phase: 'reveal', deadlineAt: null, turn: { hasDrawing: true } });
    expect((await request<DgDrawing>(`${path}/drawing/2`)).body).toEqual(drawing);
    now += 10_000;
    expect((await state(path)).phase).toBe('reveal');
    expect((await act(path, host.token, { action: 'finish', turn: 1 })).status).toBe(409);
    const { body: final } = await act(path, host.token, { action: 'finish', turn: 2 });
    expect(final.phase).toBe('finished');
    expect(final.players.map(({ score }) => score)).toEqual([0, 0]);
  });

  it('streams versioned edits and freezes the drawing when everyone guesses it', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, { name: 'Live canvas', playerId: 'Artist', poolId });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guesser' });
    const { body: started } = await act(path, host.token, { action: 'start' });
    const { artist, guessers: [guesser], answer: { code } } = await classicRoles(path, started, host, guest);
    const livePath = `${path}/drawing/1/live`;
    const signal = AbortSignal.timeout(4000);
    const stream = await fetch(base + `${path}/drawing/1/stream`, { signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    async function event(name: string) {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          expect(frame.split('\n')).toContain(`event: ${name}`);
          return JSON.parse(data.slice(6));
        }
        const { done, value } = await reader.read();
        if (done) throw new Error(`Missing ${name} event`);
        buffered += decoder.decode(value, { stream: true });
      }
    }
    try {
      expect(await event('snapshot')).toEqual({ revision: null, strokes: [] });
      const first = firstPatch();
      expect((await request(livePath, undefined, first)).status).toBe(401);
      expect((await request(livePath, guesser.token, first)).status).toBe(403);
      expect((await request(livePath, artist.token, first)).body).toEqual({ revision: first.revision });
      expect(await event('drawing')).toEqual(first);
      const version = (await state(path)).version;
      expect((await request(livePath, artist.token, first)).body).toEqual({ revision: first.revision });
      expect((await state(path)).version).toBe(version);
      expect((await request(livePath, artist.token, firstPatch())).status).toBe(409);

      const extend: DgDrawingPatch = {
        baseRevision: first.revision, revision: randomUUID(), strokeIndex: 0, pointIndex: 2,
        strokes: [{ ...drawing.strokes[0], points: [[300, 300]] }],
      };
      expect((await request(livePath, artist.token, extend)).status).toBe(429);
      now += 100;
      expect((await request(livePath, artist.token, extend)).status).toBe(200);
      expect(await event('drawing')).toEqual(extend);
      const { strokes } = (await request<DgLiveDrawing>(livePath)).body;
      expect(strokes[0].points).toEqual([[1, 5], [150, 200], [300, 300]]);

      const clear = { baseRevision: extend.revision, revision: randomUUID(), strokeIndex: 0, pointIndex: 0, strokes: [] };
      now += 100;
      expect((await request(livePath, artist.token, clear)).status).toBe(200);
      expect(await event('drawing')).toEqual(clear);
      expect((await request<DgLiveDrawing>(livePath)).body).toEqual({ revision: clear.revision, strokes: [] });
      const restore = { ...firstPatch(), baseRevision: clear.revision, strokes };
      now += 100;
      expect((await request(livePath, artist.token, restore)).status).toBe(200);
      expect(await event('drawing')).toEqual(restore);
      expect((await state(path)).turn?.answer).toBeNull();
      expect((await act(path, artist.token, { action: 'guess', turn: 1, code })).status).toBe(403);
      const guessed = await act(path, guesser.token, { action: 'guess', turn: 1, code });
      expect(guessed.body).toMatchObject({ phase: 'reveal', deadlineAt: null, turn: { hasDrawing: true, drawerPoints: 1 } });
      expect(await event('closed')).toBeNull();
      expect((await request<DgDrawing>(`${path}/drawing/1`)).body).toEqual({ strokes });
      expect((await request(livePath)).status).toBe(404);
      expect((await request(livePath, artist.token, restore)).status).toBe(409);
    } finally {
      await reader.cancel();
    }
  });

  it('persists a shuffled order with the guest first and offers only eligible hints', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, { name: 'Live guesses', playerId: 'Artist', poolId });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guest' });
    jest.spyOn(crypto, 'randomInt').mockImplementationOnce(() => 1);
    const { body: started } = await act(path, host.token, { action: 'start' });
    expect(started.turn).toMatchObject({ number: 1, drawerId: 'Guest', answer: null });
    const dealt: number[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      const [artist, guesser] = turn % 2 === 1 ? [guest, host] : [host, guest];
      const active = await state(path, artist.token);
      expect(active.turn).toMatchObject({ number: turn, drawerId: artist.room.viewerId });
      const { code, type } = active.turn!.answer!;
      dealt.push(code);
      now += 90_000;
      const { hint } = (await state(path, guesser.token)).turn!;
      expect(hint?.candidateCount).toBeLessThan(codes.length);
      if (type & 1) {
        const methods = ['attack', 'summon-value', 'release-era'];
        if (!(type & 0x4000000)) methods.push('defense');
        expect(methods).toContain(hint?.method);
      } else {
        expect(hint).toEqual({ method: 'field-size', group: 'no-field', candidateCount: 1 });
      }
      const { body: result } = await act(path, guesser.token, { action: 'guess', turn, code });
      expect(result).toMatchObject({ phase: 'reveal', deadlineAt: null });
      expect(result.players.map(({ score }) => score)).toEqual([turn, turn]);
      if (turn === 1) closeDb();
      if (turn < 4) expect((await act(path, host.token, { action: 'next', turn })).body.phase).toBe('drawing');
    }
    expect(dealt.slice(0, 3).sort()).toEqual(codes);
    expect(codes).toContain(dealt[3]);
  });

  it('uses release eras for Spells and Traps when field size cannot narrow the pool', async () => {
    const spell = 83764719;
    const trap = 10045474;
    const insert = getDb().prepare('INSERT INTO cards (code, name, type) VALUES (?, ?, ?)');
    insert.run(spell, 'Monster Reborn', 0x2);
    insert.run(trap, 'Infinite Impermanence', 0x4);
    const pool = app.get(GuessPoolsService).create({ name: 'Release era pool', codes: [spell, trap] });
    const { body: host } = await request<DgSession>(rooms, undefined, {
      name: 'Release era hints', playerId: 'Host', poolId: pool.poolId, roundSeconds: 10,
    });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guest' });
    let active = (await act(path, host.token, { action: 'start' })).body;
    for (const turn of [1, 2]) {
      const { guessers: [guesser], answer: { code } } = await classicRoles(path, active, host, guest);
      expect((await state(path, guesser.token)).turn?.hint).toBeNull();
      now += 5000;
      expect((await state(path, guesser.token)).turn?.hint).toEqual({
        method: 'release-era', group: code === spell ? 'through-2014' : '2015-2019', candidateCount: 1,
      });
      expect((await act(path, guesser.token, { action: 'guess', turn, code })).body.phase).toBe('reveal');
      if (turn === 1) active = (await act(path, host.token, { action: 'next', turn })).body;
    }
  });

  it('preserves a legacy turn while suppressing its card-type hint', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, {
      name: 'Legacy room', playerId: 'Artist', poolId, roundSeconds: 10, drawSeconds: 10, guessSeconds: 12,
    });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guest' });
    const { body: started } = await act(path, host.token, { action: 'start' });
    const { artist } = await classicRoles(path, started, host, guest);
    expect((await request(`${path}/drawing/1/live`, artist.token, firstPatch())).status).toBe(200);
    now += 10_000;
    expect((await state(path)).phase).toBe('reveal');
    const setLegacyPhase = getDb().prepare(`
      UPDATE dg_rooms SET phase = @phase, deadline_at = @deadline,
        state_json = json_set(json_remove(state_json, '$.settings.roundSeconds', '$.drawerOrder'),
          '$.phase', @phase, '$.deadlineAt', @deadline, '$.turn.drawerId', 'Artist',
          '$.turn.hint', json('{"method":"deck","group":"main-monster","candidateCount":2}'))
      WHERE room_id = @roomId
    `);
    const roomId = host.room.roomId;
    setLegacyPhase.run({ roomId, phase: 'guessing', deadline: now + 12_000 });
    expect(await state(path)).toMatchObject({
      phase: 'guessing', deadlineAt: now + 12_000, turn: { hintAt: now + 6000, hint: null, answer: null, hasDrawing: true },
    });
    now += 6000;
    expect((await state(path, guest.token)).turn?.hint).toBeNull();
    now += 6000;
    expect(await state(path)).toMatchObject({ phase: 'reveal', deadlineAt: null });
    setLegacyPhase.run({ roomId, phase: 'reveal', deadline: now + 10_000 });
    now += 11_000;
    expect(await state(path)).toMatchObject({ phase: 'reveal', deadlineAt: null, turn: { number: 1 } });
    expect((await act(path, host.token, { action: 'next', turn: 1 })).body).toMatchObject({
      phase: 'drawing', deadlineAt: now + 22_000, settings: { roundSeconds: 22 }, turn: { drawerId: 'Guest' },
    });
  });

  it('finishes a stored combined relay under its original rules and starts an alternating round', async () => {
    const dealCodes = Array.from({ length: 9 }, (_, index) => 10000 + index);
    const pool = app.get(GuessPoolsService).create({ name: 'Relay pool', codes: dealCodes });
    const { path, players } = await relayRoom(pool.poolId);
    const [ada, bert, cy] = players.map(({ token }) => token);
    const room = (await act(path, ada, { action: 'start' })).body;
    expect(room.mode).toBe('relay');
    expect(room.deadlineAt).toBe(now + 10_000);
    expect(room.settings.hintsEnabled).toBe(false);
    getDb().prepare("UPDATE dg_rooms SET state_json = json_remove(state_json, '$.relay.rules') WHERE room_id = ?").run(room.roomId);
    expect((await state(path)).relay).toMatchObject({ step: 1, choices: [], hasIncomingDrawing: false });
    const offers = await Promise.all(players.map(async ({ token }) => {
      const view = await state(path, token);
      expect(view.deadlineAt).toBe(room.deadlineAt);
      return activeRelay(view).choices.map(({ code }) => code);
    }));
    expect(offers.map(({ length }) => length)).toEqual([3, 3, 3]);
    expect(offers.flat().sort((a, b) => a - b)).toEqual(dealCodes);
    const [answerA, answerB, answerC] = offers.map(([code]) => code);
    const sketches: DgDrawing[] = Array.from({ length: 9 }, (_, index) => ({
      strokes: [{ color: '#a23e17', width: 5, points: [[index, 50]] }],
    }));
    const submit = (token: string, step: number, code: number, drawingIndex: number) =>
      act(path, token, { action: 'relay-submit', round: 1, step, code, drawing: sketches[drawingIndex] });

    expect((await submit(bert, 1, answerA, 1)).status).toBe(400);
    expect((await submit(ada, 1, answerA, 0)).body.relay).toMatchObject({ step: 1, viewerSubmitted: true, submittedCount: 1 });
    expect((await submit(ada, 1, answerA, 0)).status).toBe(409);
    expect((await request(`${path}/relay/1/incoming/2`, bert)).status).toBe(404);
    expect((await request(`${path}/relay/1/chains/1/drawings/1`)).status).toBe(404);
    const openings = await Promise.all([submit(bert, 1, answerB, 1), submit(cy, 1, answerC, 2)]);
    expect(openings.map(({ status }) => status)).toEqual([200, 200]);

    const next = await state(path, bert);
    expect(next.deadlineAt).toBe(now + 12_000);
    expect(next.turn).toBeNull();
    expect(next.relay).toMatchObject({ step: 2, stepCount: 3, action: 'combined', choices: [], hasIncomingDrawing: true, submittedCount: 0 });
    expect((await request(`${path}/relay/1/incoming/2`)).status).toBe(401);
    const received = await Promise.all([ada, bert, cy].map((token) => request<DgDrawing>(`${path}/relay/1/incoming/2`, token)));
    expect(received.map(({ body }) => body)).toEqual([sketches[2], sketches[0], sketches[1]]);
    expect((await submit(bert, 1, answerA, 3)).status).toBe(409);
    expect((await submit(ada, 2, answerC, 3)).body.players.every(({ score }) => score === 0)).toBe(true);
    expect((await state(path, ada)).viewerLastGuess).toBeNull();
    expect((await request(`${path}/relay/1/chains/1`)).status).toBe(404);
    expect((await submit(bert, 2, answerA, 4)).status).toBe(200);
    expect((await submit(cy, 2, answerA, 5)).body.relay).toMatchObject({ step: 3, submittedCount: 0 });
    expect((await request<DgDrawing>(`${path}/relay/1/incoming/3`, cy)).body).toEqual(sketches[4]);

    const last = await Promise.all([submit(ada, 3, answerB, 6), submit(bert, 3, answerA, 7), submit(cy, 3, answerA, 8)]);
    expect(last.map(({ status }) => status)).toEqual([200, 200, 200]);
    const firstReveal = await state(path);
    expect(firstReveal.relay).toEqual({ kind: 'reveal', round: 1, revealedCount: 1 });
    expect(firstReveal.players.map(({ score }) => score)).toEqual([1, 2, 1]);
    const chain = (await request<DgRelayChainView>(`${path}/relay/1/chains/1`)).body;
    expect(chain.answer.code).toBe(answerA);
    expect(chain.steps.map(({ playerId, correct }) => [playerId, correct])).toEqual([['Ada', null], ['Bert', true], ['Cy', true]]);
    expect((await request<DgDrawing>(`${path}/relay/1/chains/1/drawings/3`)).body).toEqual(sketches[8]);
    expect((await request(`${path}/relay/1/chains/2`)).status).toBe(404);
    expect((await act(path, bert, { action: 'relay-reveal', round: 1, chain: 1 })).status).toBe(403);
    expect((await act(path, ada, { action: 'relay-next', round: 1 })).status).toBe(409);
    expect((await act(path, ada, { action: 'relay-reveal', round: 1, chain: 1 })).body.relay).toMatchObject({ revealedCount: 2 });
    expect((await act(path, ada, { action: 'relay-reveal', round: 1, chain: 1 })).status).toBe(409);
    const all = (await act(path, ada, { action: 'relay-reveal', round: 1, chain: 2 })).body;
    expect(all.players.map(({ score, relayPoints }) => ({ score, relayPoints }))).toEqual([
      { score: 3, relayPoints: { guesses: 2, drawings: 1 } },
      { score: 2, relayPoints: { guesses: 1, drawings: 1 } },
      { score: 3, relayPoints: { guesses: 1, drawings: 2 } },
    ]);
    const newRound = (await act(path, ada, { action: 'relay-next', round: 1 })).body;
    expect(newRound.relay).toMatchObject({ kind: 'active', round: 2, step: 1, stepCount: 2, action: 'opening', submittedCount: 0 });
    expect(newRound.players).toEqual(all.players);
    expect((await submit(ada, 1, answerA, 0)).status).toBe(409);
  });

  it('alternates private sketches and guesses, scoring the prompt the artist received', async () => {
    const dealCodes = Array.from({ length: 12 }, (_, index) => 10000 + index);
    const pool = app.get(GuessPoolsService).create({ name: 'Alternating relay pool', codes: dealCodes });
    const { path, players } = await relayRoom(pool.poolId, ['Bert', 'Cy', 'Dee']);
    const started = (await act(path, players[0].token, { action: 'start' })).body;
    expect(started.relay).toMatchObject({ step: 1, stepCount: 4, action: 'opening' });
    const offers = await Promise.all(players.map(async ({ token }) => activeRelay(await state(path, token)).choices));
    expect(offers.flat().map(({ code }) => code).sort((a, b) => a - b)).toEqual(dealCodes);
    const [answerA, answerB, answerC, answerD] = offers.map(([card]) => card.code);
    const sketches: DgDrawing[] = Array.from({ length: 8 }, (_, index) => ({
      strokes: [{ color: '#a23e17', width: 5, points: [[index, 50]] }],
    }));
    const submit = (seat: number, step: number, entry: { code: number; drawing?: DgDrawing } | { drawing: DgDrawing; code?: never }) =>
      act(path, players[seat].token, { action: 'relay-submit', round: 1, step, ...entry });

    expect((await submit(0, 1, { code: answerA })).status).toBe(400);
    expect((await submit(0, 1, { code: answerA, drawing: sketches[0] })).body.relay).toMatchObject({ step: 1, submittedCount: 1 });
    expect((await request(`${path}/relay/1/incoming/2`, players[1].token)).status).toBe(404);
    for (const seat of [1, 2, 3]) {
      expect((await submit(seat, 1, { code: offers[seat][0].code, drawing: sketches[seat] })).status).toBe(200);
    }
    const secondStep = await state(path, players[1].token);
    expect(secondStep.deadlineAt).toBe(now + 12_000);
    expect(secondStep.relay).toMatchObject({ step: 2, action: 'guess', prompt: null, choices: [], hasIncomingDrawing: true });
    expect((await request(`${path}/relay/1/incoming/2`)).status).toBe(401);
    const received = await Promise.all(players.map(({ token }) => request<DgDrawing>(`${path}/relay/1/incoming/2`, token)));
    expect(received.map(({ body }) => body)).toEqual([sketches[3], sketches[0], sketches[1], sketches[2]]);
    expect((await submit(1, 2, { code: answerB, drawing: sketches[1] })).status).toBe(400);
    for (const [seat, code] of [answerD, answerB, answerB, answerC].entries()) {
      expect((await submit(seat, 2, { code })).status).toBe(200);
    }

    const drawingStep = await state(path, players[2].token);
    expect(drawingStep.deadlineAt).toBe(now + 10_000);
    expect(drawingStep.relay).toMatchObject({ step: 3, action: 'draw', prompt: { code: answerB }, hasIncomingDrawing: false });
    expect((await state(path)).relay).toMatchObject({ step: 3, prompt: null });
    expect((await request(`${path}/relay/1/incoming/3`, players[2].token)).status).toBe(404);
    expect((await request(`${path}/relay/1/chains/1`)).status).toBe(404);
    expect((await submit(2, 3, { code: answerA, drawing: sketches[6] })).status).toBe(400);
    for (const seat of [0, 1, 2, 3]) expect((await submit(seat, 3, { drawing: sketches[seat + 4] })).status).toBe(200);

    const lastStep = await state(path, players[3].token);
    expect(lastStep.deadlineAt).toBe(now + 12_000);
    expect(lastStep.relay).toMatchObject({ step: 4, action: 'guess', prompt: null, hasIncomingDrawing: true });
    expect((await request<DgDrawing>(`${path}/relay/1/incoming/4`, players[3].token)).body).toEqual(sketches[6]);
    expect(lastStep.players.every(({ score }) => score === 0)).toBe(true);
    for (const [seat, code] of [answerB, answerC, answerD, answerB].entries()) expect((await submit(seat, 4, { code })).status).toBe(200);

    const revealed = await state(path);
    expect(revealed.relay).toEqual({ kind: 'reveal', round: 1, revealedCount: 1 });
    expect(revealed.players.map(({ score }) => score)).toEqual([0, 0, 1, 1]);
    const { body: chain } = await request<DgRelayChainView>(`${path}/relay/1/chains/1`);
    expect(chain.answer.code).toBe(answerA);
    expect(chain.steps).toMatchObject([
      { playerId: 'Ada', action: 'opening', hasDrawing: true },
      { playerId: 'Bert', action: 'guess', guess: { code: answerB }, correct: false, receivedFromStep: 1, hasDrawing: false },
      { playerId: 'Cy', action: 'draw', prompt: { code: answerB }, hasDrawing: true },
      { playerId: 'Dee', action: 'guess', guess: { code: answerB }, correct: true, receivedFromStep: 3, hasDrawing: false },
    ]);
    expect((await request(`${path}/relay/1/chains/1/drawings/2`)).status).toBe(404);
    expect((await request<DgDrawing>(`${path}/relay/1/chains/1/drawings/3`)).body).toEqual(sketches[6]);
  });

  it('recovers relay deadlines and credits the actual artist when an intervening sketch timed out', async () => {
    const smallPool = app.get(GuessPoolsService).create({ name: 'Two relay cards', codes: codes.slice(0, 2) });
    expect((await request(rooms, undefined, { name: 'Small pool', playerId: 'Ada', mode: 'relay', poolId: smallPool.poolId })).status).toBe(409);
    const { path, players } = await relayRoom(poolId, ['Bert', 'Cy', 'Dee', 'Eve']);
    const [ada, bert, cy, dee] = players.map(({ token }) => token);
    const start = (await act(path, ada, { action: 'start' })).body;
    const answer = activeRelay(start).choices[0].code;
    const cyDefault = activeRelay(await state(path, cy)).choices[0].code;
    expect((await act(path, ada, { action: 'relay-submit', round: 1, step: 1, code: answer, drawing })).status).toBe(200);

    now += 10_000;
    closeDb();
    const restarted = new DgService(app.get(CardsService), app.get(GuessPoolsService), app.get(RealtimeService));
    restarted.onModuleInit();
    restarted.onModuleDestroy();
    expect((await state(path, bert)).relay).toMatchObject({ step: 2, stepCount: 4, action: 'guess', hasIncomingDrawing: true });
    expect((await state(path, cy)).relay).toMatchObject({ step: 2, hasIncomingDrawing: false });
    expect((await act(path, cy, { action: 'relay-submit', round: 1, step: 2, code: codes[0] })).status).toBe(200);
    now += 12_000;
    expect((await state(path, cy)).relay).toMatchObject({ step: 3, action: 'draw', prompt: { code: answer } });
    expect((await state(path, dee)).relay).toMatchObject({ step: 3, action: 'draw', prompt: { code: codes[0] } });
    now += 10_000;
    expect((await state(path, dee)).relay).toMatchObject({ step: 4, action: 'guess', hasIncomingDrawing: true });
    expect((await request<DgDrawing>(`${path}/relay/1/incoming/4`, dee)).body).toEqual(drawing);
    expect((await act(path, dee, { action: 'relay-submit', round: 1, step: 4, code: answer })).status).toBe(200);
    now += 12_000;
    const revealed = await state(path);
    expect(revealed.relay).toEqual({ kind: 'reveal', round: 1, revealedCount: 1 });
    expect(revealed.players.map(({ score }) => score)).toEqual([1, 0, 0, 1, 0]);
    const { body: chain } = await request<DgRelayChainView>(`${path}/relay/1/chains/1`);
    expect(chain.steps.map(({ playerId }) => playerId)).toEqual(['Ada', 'Bert', 'Cy', 'Dee']);
    expect(chain.steps[2]).toMatchObject({ action: 'draw', hasDrawing: false });
    expect(chain.steps[3]).toMatchObject({ action: 'guess', correct: true, receivedFromStep: 1 });

    now += 24 * 60 * 60 * 1000;
    const final = await state(path);
    expect(final.phase).toBe('finished');
    expect(final.relay).toEqual({ kind: 'reveal', round: 1, revealedCount: 5 });
    expect(final.players).toEqual(revealed.players);
    expect((await request<DgRelayChainView>(`${path}/relay/1/chains/2`)).body.steps[1])
      .toMatchObject({ playerId: 'Cy', guess: { code: codes[0] }, correct: null, receivedFromStep: null });
    expect((await request<DgRelayChainView>(`${path}/relay/1/chains/3`)).body.answer.code).toBe(cyDefault);
  });
});
