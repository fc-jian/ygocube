import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type {
  DgActionRequest, DgDrawing, DgDrawingPatch, DgLiveDrawing, DgRelayChainView, DgRoomView,
  DgSession, GuessCardPage, GuessPoolSummary,
} from '@ygocube/shared';
import { randomUUID } from 'node:crypto';
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

  async function relayRoom(relayPool: number) {
    const { body: host, status } = await request<DgSession>(rooms, undefined, {
      name: 'Relay room', playerId: 'Ada', poolId: relayPool, mode: 'relay', drawSeconds: 10, guessSeconds: 12,
    });
    expect(status).toBe(201);
    const path = `${rooms}/${host.room.roomId}`;
    const players = [host];
    for (const playerId of ['Bert', 'Cy']) {
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
    expect(host.room.settings).toEqual({ drawSeconds: 120, guessSeconds: 120, hintsEnabled: true });
    getDb().prepare("UPDATE dg_rooms SET state_json = json_remove(state_json, '$.mode') WHERE room_id = ?").run(host.room.roomId);
    expect((await state(path)).mode).toBe('classic');
    expect((await act(path, host.token, { action: 'start' })).status).toBe(409);
    const { body: first } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'First' });
    const { body: second } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Second' });
    expect((await act(path, first.token, { action: 'start' })).status).toBe(403);
    const { body: active } = await act(path, host.token, { action: 'start' });
    const code = active.turn!.answer!.code;
    expect(codes).toContain(code);
    expect(active.deadlineAt).toBe(now + 120_000);
    expect((await state(path, first.token)).turn).toMatchObject({ answer: null, hint: null, hasDrawing: false });
    expect((await state(path)).turn?.answer).toBeNull();
    expect((await request(`${path}/drawing/1`)).status).toBe(404);
    expect((await request(`${path}/cards`)).status).toBe(401);
    const filtered = await request<GuessCardPage>(`${path}/cards?category=2`, first.token);
    expect(filtered.body.cards.map((card) => card.code)).toEqual([codes[1]]);
    expect((await act(path, first.token, { action: 'submit', turn: 1, drawing })).status).toBe(403);
    const malformed = { strokes: [{ color: 'red', width: 10, points: [[0, 1]] }] };
    expect((await request(`${path}/action`, host.token, { action: 'submit', turn: 1, drawing: malformed })).status).toBe(400);
    expect((await act(path, host.token, { action: 'submit', turn: 1, drawing })).body.phase).toBe('guessing');
    expect((await request<DgDrawing>(`${path}/drawing/1`)).body).toEqual(drawing);
    expect((await act(path, host.token, { action: 'guess', turn: 1, code })).status).toBe(403);
    expect((await act(path, first.token, { action: 'guess', turn: 1, code: 10003 })).status).toBe(400);

    now += 59_999;
    expect((await state(path, first.token)).turn?.hint).toBeNull();
    now++;
    expect((await state(path, first.token)).turn?.hint?.candidateCount).toBeLessThan(codes.length);
    const wrong = codes.find((candidate) => candidate !== code)!;
    expect((await act(path, first.token, { action: 'guess', turn: 1, code: wrong })).body.viewerLastGuess?.correct).toBe(false);
    expect((await state(path, second.token)).viewerLastGuess).toBeNull();
    expect(await act(path, first.token, { action: 'guess', turn: 1, code })).toEqual({
      status: 429, body: { code: 'DG_GUESS_RATE_LIMIT' },
    });
    now += 1000;
    const attempts = await Promise.all([first, second].map(({ token }) => act(path, token, { action: 'guess', turn: 1, code })));
    expect(attempts.map(({ status }) => status)).toEqual([200, 200]);
    const result = await state(path);
    expect(result.phase).toBe('reveal');
    expect(result.turn?.answer?.code).toBe(code);
    expect(result.turn?.drawerPoints).toBe(2);
    expect(result.turn?.solves.map(({ points }) => points)).toEqual([2, 1]);
    expect(result.turn?.solves.map(({ playerId }) => playerId).sort()).toEqual(['First', 'Second']);

    now += 10_000;
    const next = await state(path, first.token);
    expect(next.phase).toBe('drawing');
    expect(next.turn).toMatchObject({ number: 2, drawerId: 'First' });
    expect(next.turn?.answer?.code).not.toBe(code);
    expect((await request(`${path}/drawing/1`)).status).toBe(404);
  });

  it('recovers drawing deadlines from SQLite, applies custom timers, and keeps hints off', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, {
      name: 'Timed room', playerId: 'Artist', poolId, drawSeconds: 10, guessSeconds: 12, hintsEnabled: false,
    });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guest' });
    expect((await act(path, host.token, { action: 'start' })).body.deadlineAt).toBe(now + 10_000);

    now += 10_000;
    closeDb();
    const restarted = new DgService(app.get(CardsService), app.get(GuessPoolsService), app.get(RealtimeService));
    restarted.onModuleInit();
    restarted.onModuleDestroy();
    expect((await state(path)).phase).toBe('reveal');
    expect((await state(path)).turn).toMatchObject({ hasDrawing: false, drawerPoints: 0, solves: [] });

    now += 10_000;
    const next = await state(path, guest.token);
    expect(next.turn).toMatchObject({ number: 2, drawerId: 'Guest' });
    const code = next.turn!.answer!.code;
    expect((await request(`${path}/drawing/2/live`, guest.token, firstPatch())).status).toBe(200);
    closeDb();
    expect((await request<DgLiveDrawing>(`${path}/drawing/2/live`)).body.strokes).toEqual(drawing.strokes);
    now += 10_000;
    expect(await state(path)).toMatchObject({ phase: 'guessing', deadlineAt: now + 12_000, turn: { hasDrawing: true } });
    expect((await request<DgDrawing>(`${path}/drawing/2`)).body).toEqual(drawing);
    now += 6000;
    expect((await state(path, host.token)).turn?.hint).toBeNull();
    now += 6000;
    expect((await act(path, host.token, { action: 'guess', turn: 2, code })).status).toBe(409);
    const final = await state(path);
    expect(final.phase).toBe('finished');
    expect(final.players.map(({ score }) => score)).toEqual([0, 0]);
  });

  it('streams versioned edits before submission and freezes the drawing when everyone guesses it', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, { name: 'Live canvas', playerId: 'Artist', poolId });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: guest } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Guesser' });
    const { body: started } = await act(path, host.token, { action: 'start' });
    const code = started.turn!.answer!.code;
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
      expect((await request(livePath, guest.token, first)).status).toBe(403);
      expect((await request(livePath, host.token, first)).body).toEqual({ revision: first.revision });
      expect(await event('drawing')).toEqual(first);
      const version = (await state(path)).version;
      expect((await request(livePath, host.token, first)).body).toEqual({ revision: first.revision });
      expect((await state(path)).version).toBe(version);
      expect((await request(livePath, host.token, firstPatch())).status).toBe(409);

      const extend: DgDrawingPatch = {
        baseRevision: first.revision, revision: randomUUID(), strokeIndex: 0, pointIndex: 2,
        strokes: [{ ...drawing.strokes[0], points: [[300, 300]] }],
      };
      expect((await request(livePath, host.token, extend)).status).toBe(429);
      now += 100;
      expect((await request(livePath, host.token, extend)).status).toBe(200);
      expect(await event('drawing')).toEqual(extend);
      expect((await request<DgLiveDrawing>(livePath)).body.strokes[0].points).toEqual([[1, 5], [150, 200], [300, 300]]);

      const clear = { baseRevision: extend.revision, revision: randomUUID(), strokeIndex: 0, pointIndex: 0, strokes: [] };
      now += 100;
      expect((await request(livePath, host.token, clear)).status).toBe(200);
      expect(await event('drawing')).toEqual(clear);
      expect((await request<DgLiveDrawing>(livePath)).body).toEqual({ revision: clear.revision, strokes: [] });
      const finalPatch = { ...firstPatch(), baseRevision: clear.revision };
      now += 100;
      expect((await request(livePath, host.token, finalPatch)).status).toBe(200);
      expect(await event('drawing')).toEqual(finalPatch);
      expect((await state(path)).turn?.answer).toBeNull();
      expect((await act(path, host.token, { action: 'guess', turn: 1, code })).status).toBe(403);
      const guessed = await act(path, guest.token, { action: 'guess', turn: 1, code });
      expect(guessed.body).toMatchObject({ phase: 'reveal', turn: { hasDrawing: true, drawerPoints: 1 } });
      expect(await event('closed')).toBeNull();
      expect((await request<DgDrawing>(`${path}/drawing/1`)).body).toEqual(drawing);
      expect((await request(livePath)).status).toBe(404);
      expect((await request(livePath, host.token, finalPatch)).status).toBe(409);
    } finally {
      await reader.cancel();
    }
  });

  it('keeps the solve order and cooldown when the artist submits the picture', async () => {
    const { body: host } = await request<DgSession>(rooms, undefined, { name: 'Live guesses', playerId: 'Artist', poolId });
    const path = `${rooms}/${host.room.roomId}`;
    const { body: first } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'First' });
    const { body: second } = await request<DgSession>(`${path}/join`, undefined, { playerId: 'Second' });
    const code = (await act(path, host.token, { action: 'start' })).body.turn!.answer!.code;
    expect((await act(path, first.token, { action: 'guess', turn: 1, code })).body).toMatchObject({
      phase: 'drawing', turn: { answer: null, solves: [{ playerId: 'First', points: 2 }] },
    });
    const wrong = codes.find((candidate) => candidate !== code)!;
    expect((await act(path, second.token, { action: 'guess', turn: 1, code: wrong })).body.viewerLastGuess?.correct).toBe(false);
    expect((await act(path, host.token, { action: 'submit', turn: 1, drawing })).body.phase).toBe('guessing');
    expect((await act(path, second.token, { action: 'guess', turn: 1, code })).status).toBe(429);
    expect((await act(path, first.token, { action: 'guess', turn: 1, code })).status).toBe(409);
    now += 1000;
    expect((await act(path, second.token, { action: 'guess', turn: 1, code })).body).toMatchObject({
      phase: 'reveal', turn: { solves: [{ playerId: 'First', points: 2 }, { playerId: 'Second', points: 1 }], drawerPoints: 2 },
    });
  });

  it('rotates a private drawing for every chain across shared barriers and scores in reveal order', async () => {
    const dealCodes = Array.from({ length: 9 }, (_, index) => 10000 + index);
    const pool = app.get(GuessPoolsService).create({ name: 'Relay pool', codes: dealCodes });
    const { path, players } = await relayRoom(pool.poolId);
    const [ada, bert, cy] = players.map(({ token }) => token);
    const room = (await act(path, ada, { action: 'start' })).body;
    expect(room.mode).toBe('relay');
    expect(room.deadlineAt).toBe(now + 10_000);
    expect(room.settings.hintsEnabled).toBe(false);
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
    expect(next.relay).toMatchObject({ step: 2, choices: [], hasIncomingDrawing: true, submittedCount: 0 });
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
    expect(newRound.relay).toMatchObject({ kind: 'active', round: 2, step: 1, submittedCount: 0 });
    expect(newRound.players).toEqual(all.players);
    expect((await submit(ada, 1, answerA, 0)).status).toBe(409);
  });

  it('recovers relay deadlines and credits the actual artist when an intervening sketch timed out', async () => {
    const smallPool = app.get(GuessPoolsService).create({ name: 'Two relay cards', codes: codes.slice(0, 2) });
    expect((await request(rooms, undefined, { name: 'Small pool', playerId: 'Ada', mode: 'relay', poolId: smallPool.poolId })).status).toBe(409);
    const { path, players } = await relayRoom(poolId);
    const [ada, bert, cy] = players.map(({ token }) => token);
    const start = (await act(path, ada, { action: 'start' })).body;
    const answer = activeRelay(start).choices[0].code;
    const cyDefault = activeRelay(await state(path, cy)).choices[0].code;
    expect((await act(path, ada, { action: 'relay-submit', round: 1, step: 1, code: answer, drawing })).status).toBe(200);

    now += 10_000;
    closeDb();
    const restarted = new DgService(app.get(CardsService), app.get(GuessPoolsService), app.get(RealtimeService));
    restarted.onModuleInit();
    restarted.onModuleDestroy();
    expect((await state(path, bert)).relay).toMatchObject({ step: 2, hasIncomingDrawing: true });
    expect((await state(path, cy)).relay).toMatchObject({ step: 2, hasIncomingDrawing: false });
    now += 12_000;
    expect((await state(path, cy)).relay).toMatchObject({ step: 3, hasIncomingDrawing: true });
    expect((await request<DgDrawing>(`${path}/relay/1/incoming/3`, cy)).body).toEqual(drawing);
    expect((await act(path, cy, { action: 'relay-submit', round: 1, step: 3, code: answer, drawing })).status).toBe(200);
    now += 12_000;
    const revealed = await state(path);
    expect(revealed.relay).toEqual({ kind: 'reveal', round: 1, revealedCount: 1 });
    expect(revealed.players.map(({ score }) => score)).toEqual([1, 0, 1]);
    const { body: chain } = await request<DgRelayChainView>(`${path}/relay/1/chains/1`);
    expect(chain.steps[1]).toMatchObject({ playerId: 'Bert', guess: null, correct: null, hasDrawing: false });
    expect(chain.steps[2]).toMatchObject({ playerId: 'Cy', correct: true, receivedFromStep: 1 });

    now += 24 * 60 * 60 * 1000;
    const final = await state(path);
    expect(final.phase).toBe('finished');
    expect(final.relay).toEqual({ kind: 'reveal', round: 1, revealedCount: 3 });
    expect(final.players).toEqual(revealed.players);
    expect((await request<DgRelayChainView>(`${path}/relay/1/chains/3`)).body.answer.code).toBe(cyDefault);
  });
});
