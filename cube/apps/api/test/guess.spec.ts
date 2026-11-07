import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type {
  GuessActionRequest, GuessCardPage, GuessMove, GuessPoolSummary, GuessRoomSummary, GuessRoomView, GuessSession,
} from '@ygocube/shared';
import fs from 'node:fs';
import { AuthGuard, sha256 } from '../src/auth/auth.guard';
import { CardsService, TYPE_TOKEN } from '../src/cards/cards.service';
import { config } from '../src/config';
import { closeDb, getDb } from '../src/db';
import { GuessController } from '../src/guess/guess.controller';
import { GuessPoolsService } from '../src/guess/guess-pools.service';
import { GuessService } from '../src/guess/guess.service';
import { DEFAULT_GUESS_POOL_CODES } from '../src/guess/default-pool-codes';
import { useTestDb } from './helpers';

describe('Guess the Card HTTP game', () => {
  const superToken = 'guess-super-token-fixture';
  let app: INestApplication;
  let base: string;
  let codes: number[];
  let tokenCode: number;
  let outsideCode: number;

  beforeAll(async () => {
    useTestDb();
    config.admin.superToken = superToken;
    const cards = new CardsService();
    const catalog = cards.poolCodes();
    codes = catalog.slice(0, 30);
    [outsideCode, tokenCode] = catalog.slice(30, 32);
    getDb().prepare('UPDATE cards SET type = type | ? WHERE code = ?').run(TYPE_TOKEN, tokenCode);
    const module = await Test.createTestingModule({
      controllers: [GuessController],
      providers: [GuessService, GuessPoolsService, { provide: CardsService, useValue: cards }, { provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/games/guess`;
  });

  afterAll(async () => {
    if (app) await app.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm', '.pre-auth-migration.bak']) {
      fs.rmSync(config.server.dbPath + suffix, { force: true });
    }
  });

  async function request<T = { code: string }>(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.text();
    return { status: response.status, body: (json ? JSON.parse(json) : null) as T };
  }

  async function createPool(name: string, poolCodes: number[]) {
    const result = await request<GuessPoolSummary>('/pools', undefined, { name, codes: poolCodes }, { 'X-Admin-Token': superToken });
    expect(result.status).toBe(201);
    return result.body;
  }

  async function create(playerId: string, poolId: number) {
    const result = await request<GuessSession>('/rooms', undefined, { name: 'Fixture table', playerId, poolId });
    expect(result.status).toBe(201);
    return result.body;
  }

  function action<T = GuessRoomView>(path: string, token: string, command: GuessActionRequest) {
    return request<T>(`${path}/action`, token, command);
  }

  async function stats(poolId: number, code: number) {
    const response = await request<GuessCardPage>(`/pools/${poolId}/cards?q=${code}`);
    expect(response.status).toBe(200);
    return response.body.cards.find((card) => card.code === code)?.stats;
  }

  it('requires the Cube super token for pool creation while preserving public browsing', async () => {
    const body = { name: 'Protected pool', codes: codes.slice(0, 2) };
    getDb().prepare('INSERT INTO create_users(username,token_hash,created_at,active) VALUES(?,?,?,1)')
      .run('guesscreator', sha256('creator-fixture'), new Date().toISOString());
    expect((await request('/pools')).status).toBe(200);
    expect((await request('/pools/0/cards')).status).toBe(200);
    for (const headers of [{}, { 'X-Admin-Token': 'wrong' },
      { 'X-Create-User': 'guesscreator', 'X-Create-Token': 'creator-fixture' }, { 'X-Token': superToken }]) {
      expect((await request('/Pools/', undefined, body, headers as Record<string, string>)).status).toBe(401);
    }
    expect((await request('/pools', superToken, body)).status).toBe(401);
    expect((await createPool(body.name, body.codes)).isDefault).toBe(false);
  });

  it('keeps deals private, records completed rounds and lets the host settle the game', async () => {
    const pool = await createPool('Fixture pool', codes);
    const separatePool = await createPool('Separate pool', codes);
    const alice = await create('Alice', pool.poolId);
    const path = `/rooms/${alice.room.roomId}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(`${path}/cards`)).status).toBe(401);
    expect((await action(path, alice.token, { action: 'start', version: alice.room.version })).status).toBe(409);
    expect((await request(`${path}/join`, undefined, { playerId: 'ALICE' })).body.code).toBe('GUESS_PLAYER_EXISTS');

    const bob = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Bob' })).body;
    const cora = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Cora' })).body;
    const sessions = new Map([['Alice', alice.token], ['Bob', bob.token], ['Cora', cora.token]]);
    const list = (await request<GuessRoomSummary[]>('/rooms')).body;
    expect(list.find((room) => room.roomId === alice.room.roomId)).toEqual({
      roomId: alice.room.roomId, name: 'Fixture table', playerCount: 3, maxPlayers: 8, poolId: pool.poolId, poolName: pool.name,
    });
    expect((await action(path, bob.token, { action: 'start', version: cora.room.version })).status).toBe(403);
    const start = await action(path, alice.token, { action: 'start', version: cora.room.version });
    expect(start.status).toBe(200);
    expect((await request(`${path}/join`, undefined, { playerId: 'Dana' })).body.code).toBe('GUESS_WRONG_PHASE');
    expect((await request<GuessRoomSummary[]>('/rooms')).body.some((room) => room.roomId === alice.room.roomId)).toBe(false);
    const order = start.body.players.map((player) => player.playerId);

    async function readAnswers() {
      const views = await Promise.all([...sessions].map(async ([playerId, token]) => {
        const { status, body } = await request<GuessRoomView>(path, token);
        expect(status).toBe(200);
        expect(body.viewerId).toBe(playerId);
        expect(body.players.find((player) => player.playerId === playerId)?.card).toBeNull();
        expect(body.players.filter((player) => player.card)).toHaveLength(2);
        expect(body).not.toHaveProperty('poolCodes');
        expect(body.players[0]).not.toHaveProperty('tokenHash');
        return body;
      }));
      const answers = new Map<string, number>();
      for (const view of views) for (const player of view.players) {
        if (player.card) answers.set(player.playerId, player.card.code);
      }
      expect(new Set(answers.values()).size).toBe(3);
      return answers;
    }
    const answers = await readAnswers();
    const page = (await request<GuessCardPage>(`${path}/cards?q=测试用效果文本`, alice.token)).body;
    expect(page.cards.map((card) => card.code)).toEqual(codes.slice(0, 24));
    expect(page.cards.every((card) => !card.stats)).toBe(true);
    expect(page.hasMore).toBe(true);
    expect((await request<GuessCardPage>(`${path}/cards?page=1`, bob.token)).body.cards.map((card) => card.code)).toEqual(codes.slice(24));
    expect((await request<GuessCardPage>(`${path}/cards?q=${outsideCode}`, bob.token)).body.cards).toEqual([]);
    expect((await request<GuessCardPage>(`/cards?q=${outsideCode}`)).body.cards.map((card) => card.code)).toEqual([outsideCode]);
    expect((await request<GuessCardPage>(`/cards?q=${tokenCode}`)).body.cards).toEqual([]);

    const first = start.body.currentPlayerId!;
    const second = order[(order.indexOf(first) + 1) % order.length];
    const third = order[(order.indexOf(first) + 2) % order.length];
    const firstToken = sessions.get(first)!;
    const secondToken = sessions.get(second)!;
    const thirdToken = sessions.get(third)!;
    const version = start.body.version;
    expect((await action(path, alice.token, { action: 'finish', version })).status).toBe(409);
    expect((await action(path, sessions.get(second)!, { action: 'guess', version, code: answers.get(second)! })).status).toBe(409);
    expect((await action(path, firstToken, { action: 'guess', version, code: outsideCode })).status).toBe(400);
    expect((await action(path, firstToken, { action: 'surrender', version })).status).toBe(409);
    const miss: GuessActionRequest = { action: 'guess', version, code: answers.get(second)! };
    const duplicate = await Promise.all([action(path, firstToken, miss), action(path, firstToken, miss)]);
    expect(duplicate.map((response) => response.status).sort()).toEqual([200, 409]);
    let state = duplicate.find((response) => response.status === 200)!.body;
    expect(state.currentPlayerId).toBe(second);
    expect(state.lastMove?.outcome).toBe('incorrect');
    expect(state.players.find((player) => player.playerId === first)?.card).toBeNull();

    state = (await action(path, secondToken, { action: 'guess', version: state.version, code: answers.get(second)! })).body;
    expect(state.lastMove).toEqual({ playerId: second, outcome: 'correct', points: 3 });
    expect(state.players.find((player) => player.playerId === second)?.card?.code).toBe(answers.get(second));
    expect(await stats(pool.poolId, answers.get(second)!)).toEqual({ appearances: 0, averageGuessTurns: null });
    expect(state.currentPlayerId).toBe(third);
    state = (await action(path, thirdToken, { action: 'guess', version: state.version, code: answers.get(second)! })).body;
    expect(state.currentPlayerId).toBe(first);
    state = (await action(path, firstToken, { action: 'guess', version: state.version, code: answers.get(first)! })).body;
    expect(state.lastMove).toEqual({ playerId: first, outcome: 'correct', points: 2 });
    expect(state.currentPlayerId).toBe(third);
    state = (await action(path, thirdToken, { action: 'surrender', version: state.version })).body;
    expect(state.phase).toBe('between_rounds');
    expect(state.lastMove).toEqual({ playerId: third, outcome: 'surrendered', points: 0 });
    expect(state.players.find((player) => player.playerId === third)?.card?.code).toBe(answers.get(third));
    for (const [id, turns] of [[first, 2], [second, 1], [third, null]] as const) {
      expect(await stats(pool.poolId, answers.get(id)!)).toEqual({ appearances: 1, averageGuessTurns: turns });
    }
    expect(await stats(separatePool.poolId, answers.get(first)!)).toEqual({ appearances: 0, averageGuessTurns: null });
    expect((await action(path, bob.token, { action: 'finish', version: state.version })).status).toBe(403);

    closeDb();
    expect((await request<GuessPoolSummary[]>('/pools')).body).toContainEqual(pool);
    const resumed = (await request<GuessRoomView>(path, thirdToken)).body;
    expect(resumed).toEqual(state);
    state = (await action(path, alice.token, { action: 'next', version: resumed.version })).body;
    expect(state.round).toBe(2);
    const nextAnswers = await readAnswers();
    for (const points of [3, 2, 1]) {
      const id = state.currentPlayerId!;
      state = (await action(path, sessions.get(id)!, { action: 'guess', version: state.version, code: nextAnswers.get(id)! })).body;
      expect(state.lastMove?.points).toBe(points);
    }
    expect(state.phase).toBe('between_rounds');
    expect(state.players.reduce((sum, player) => sum + player.score, 0)).toBe(11);
    expect(state.players.every((player) => player.card)).toBe(true);
    state = (await action(path, alice.token, { action: 'finish', version: state.version })).body;
    expect(state.phase).toBe('finished');
    expect((await action(path, alice.token, { action: 'next', version: state.version })).status).toBe(409);
    const events = getDb().prepare('SELECT version, event_json FROM guess_room_events WHERE room_id = ? ORDER BY version')
      .all(alice.room.roomId) as { version: number; event_json: string }[];
    expect(events.map((event) => event.version)).toEqual(Array.from({ length: state.version }, (_, index) => index + 1));
    expect(events.every((event) => !event.event_json.includes('token'))).toBe(true);
  });

  it('validates room setup, caps simultaneous joins, and hands off a waiting room', async () => {
    const headers = { 'X-Admin-Token': superToken };
    for (const poolCodes of [[codes[0], tokenCode], [codes[0], codes[0]], [codes[0], -1], [codes[0], 999999999]]) {
      expect((await request('/pools', undefined, { name: 'Invalid', codes: poolCodes }, headers)).status).toBe(400);
    }
    const small = await createPool('Small pool', codes.slice(0, 2));
    expect((await request('/pools', undefined, { name: 'SMALL POOL', codes: codes.slice(0, 2) }, headers)).body.code).toBe('GUESS_POOL_EXISTS');
    expect((await request('/rooms', undefined, { name: 'Unknown pool', playerId: 'Host', poolId: 999999 })).status).toBe(404);
    const host = await create('Host', 0);
    const path = `/rooms/${host.room.roomId}`;
    const visitors = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      request<GuessSession>(`${path}/join`, undefined, { playerId: `Guest ${index + 1}` })));
    const joined = visitors.filter((result) => result.status === 201).map((result) => result.body);
    expect(joined).toHaveLength(7);
    expect(visitors.filter((result) => result.status === 409)).toHaveLength(1);
    const full = (await request<GuessRoomView>(path, host.token)).body;
    expect(full.playerCount).toBe(8);
    expect((await request<GuessRoomSummary[]>('/rooms')).body.some((room) => room.roomId === host.room.roomId)).toBe(false);
    expect((await action(path, host.token, { action: 'leave', version: full.version })).status).toBe(200);
    expect((await request(path, host.token)).status).toBe(401);
    const successor = joined.find((session) => session.room.viewerId === full.players[1].playerId)!;
    const waiting = (await request<GuessRoomView>(path, successor.token)).body;
    expect(waiting.hostId).toBe(successor.room.viewerId);
    const otherRoom = await create('Other', small.poolId);
    expect(otherRoom.room.maxPlayers).toBe(2);
    expect((await request(path, otherRoom.token)).status).toBe(401);
  });

  it('backfills completed legacy rounds and preserves the attempts of a live round', async () => {
    const roomId = '0ABCD123';
    const [aCode, bCode] = codes;
    const aToken = 'a'.repeat(64);
    const bToken = 'b'.repeat(64);
    const seats = [{ playerId: 'A', code: aCode, points: null }, { playerId: 'B', code: bCode, points: null }];
    const deal = { number: 1, seats, currentPlayerId: 'A', lastMove: null };
    const miss: GuessMove = { playerId: 'A', outcome: 'incorrect', points: null };
    const events = [
      { action: 'create' }, { action: 'join' }, { action: 'start', round: deal },
      { action: 'guess', playerId: 'A', code: bCode, move: miss },
      { action: 'guess', playerId: 'B', code: bCode, move: { playerId: 'B', outcome: 'correct', points: 2 } },
      { action: 'guess', playerId: 'A', code: bCode, move: miss },
      { action: 'guess', playerId: 'A', code: aCode, move: { playerId: 'A', outcome: 'correct', points: 1 } },
      { action: 'next', round: { ...deal, number: 2 } },
      { action: 'guess', playerId: 'A', code: bCode, move: miss },
    ];
    const legacy = {
      roomId, name: 'Legacy room', poolCodes: [aCode, bCode], poolCount: 2, roundCount: 2,
      phase: 'playing', version: events.length,
      players: [{ playerId: 'A', score: 1, tokenHash: sha256(aToken) }, { playerId: 'B', score: 2, tokenHash: sha256(bToken) }],
      round: { ...deal, number: 2, currentPlayerId: 'B', lastMove: miss },
    };
    const now = new Date().toISOString();
    const db = getDb();
    db.transaction(() => {
      db.prepare('INSERT INTO guess_rooms VALUES (?, ?, ?, ?)').run(roomId, legacy.phase, JSON.stringify(legacy), now);
      const insert = db.prepare('INSERT INTO guess_room_events VALUES (?, ?, ?, ?)');
      events.forEach((event, index) => insert.run(roomId, index + 1, JSON.stringify(event), now));
    })();

    app.get(GuessService).onModuleInit();
    app.get(GuessService).onModuleInit();
    const path = `/rooms/${roomId}`;
    const migrated = (await request<GuessRoomView>(path, bToken)).body;
    expect(migrated.poolName).toBe(`Legacy room [${roomId}]`);
    expect(await stats(migrated.poolId, aCode)).toEqual({ appearances: 1, averageGuessTurns: 3 });
    expect(migrated.players.find((player) => player.playerId === 'B')?.card).toBeNull();
    const bCorrect = (await action(path, bToken, { action: 'guess', version: migrated.version, code: bCode })).body;
    const aCorrect = (await action(path, aToken, { action: 'guess', version: bCorrect.version, code: aCode })).body;
    expect(aCorrect.phase).toBe('between_rounds');
    expect(await stats(migrated.poolId, aCode)).toEqual({ appearances: 2, averageGuessTurns: 2.5 });
    expect(await stats(migrated.poolId, bCode)).toEqual({ appearances: 2, averageGuessTurns: 1 });
  });

  it('seeds the curated pool once its whole catalog is available', async () => {
    const service = app.get(GuessPoolsService);
    const catalog = jest.spyOn(app.get(CardsService), 'poolCodes');
    const snapshot = [...DEFAULT_GUESS_POOL_CODES];
    expect(snapshot).toEqual([...new Set(snapshot)].sort((a, b) => a - b));
    expect(snapshot.every((code) => code > 0 && code < 100_000_000)).toBe(true);
    try {
      catalog.mockReturnValue(snapshot.slice(1));
      service.onModuleInit();
      expect(service.list().some((pool) => pool.isDefault)).toBe(false);
      catalog.mockReturnValue(snapshot);
      service.onModuleInit();
      service.onModuleInit();
      const defaults = (await request<GuessPoolSummary[]>('/pools')).body.filter((pool) => pool.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].cardCount).toBe(snapshot.length);
      expect(service.get(defaults[0].poolId).codes).toEqual(snapshot);
    } finally {
      catalog.mockRestore();
    }
  });
});
