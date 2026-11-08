import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type {
  CardInfo, GuessActionRequest, GuessCardPage, GuessMove, GuessPoolSummary, GuessRoomSummary, GuessRoomView, GuessSession, GuessSpectatorView,
} from '@ygocube/shared';
import fs from 'node:fs';
import { AuthGuard, sha256 } from '../src/auth/auth.guard';
import { CardsService, TYPE_TOKEN } from '../src/cards/cards.service';
import { config } from '../src/config';
import { closeDb, getDb } from '../src/db';
import { GuessController } from '../src/guess/guess.controller';
import { GuessPoolsService } from '../src/guess/guess-pools.service';
import { GuessService, settleOpenGuessRoomsForMaintenance } from '../src/guess/guess.service';
import { buildOpeningHintOptions } from '../src/guess/opening-hints';
import { DEFAULT_GUESS_POOL_CODES } from '../src/guess/default-pool-codes';
import { RECENCY_GUESS_POOL_CODES } from '../src/guess/recency-pool-codes';
import { SHORTLIST_GUESS_POOL_CODES } from '../src/guess/shortlist-pool-codes';
import { useTestDb } from './helpers';

describe('Guess the Card HTTP game', () => {
  const superToken = 'guess-super-token-fixture';
  let app: INestApplication;
  let base: string;
  let codes: number[];
  let uniformCodes: number[];
  let tokenCode: number;
  let outsideCode: number;
  let fieldCodes: number[];
  const fixtureField = 0x1fa;

  beforeAll(async () => {
    useTestDb();
    config.admin.superToken = superToken;
    const cards = new CardsService();
    const catalog = cards.poolCodes();
    codes = catalog.slice(0, 30);
    uniformCodes = catalog.slice(40).filter((code) => code % 10 !== 0).slice(0, 30);
    fieldCodes = catalog.slice(120, 146);
    [outsideCode, tokenCode] = catalog.slice(30, 32);
    const setType = getDb().prepare('UPDATE cards SET type = ? WHERE code = ?');
    [0x21, 0x10002, 0x100004].forEach((type, index) => setType.run(type, codes[index]));
    getDb().prepare('UPDATE cards SET type = type | ? WHERE code = ?').run(TYPE_TOKEN, tokenCode);
    const setFields = getDb().prepare('UPDATE cards SET setcodes_json = ? WHERE code = ?');
    for (const code of [...fieldCodes, tokenCode]) setFields.run(JSON.stringify([fixtureField, 0x1000 | fixtureField]), code);
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
    for (const name of ['常见卡牌', '常见卡牌精简版', '常见卡牌近年权重版']) {
      expect((await request('/pools', undefined, { ...body, name }, { 'X-Admin-Token': superToken })).status).toBe(409);
    }
  });

  it('looks up exact public card details and uses full-catalog field membership for room hints', async () => {
    const details = await request<CardInfo[]>(`/card-details?codes=${codes[0]},${tokenCode},${codes[0]},999999999`);
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject([{ code: codes[0], desc: '测试用效果文本' }]);
    expect((await request('/card-details?codes=0')).status).toBe(400);
    expect((await request('/card-details?codes=1&codes=2')).status).toBe(400);

    const cards = app.get(CardsService);
    const fullFieldSizes = cards.poolFieldSizes();
    expect(fullFieldSizes.get(fixtureField)).toBe(26);
    const roomCodes = fieldCodes.slice(0, 2);
    const { options } = buildOpeningHintOptions(cards.getMany(roomCodes), roomCodes, fullFieldSizes);
    for (const hints of options) {
      expect(hints).toContainEqual({ method: 'field-size', group: 'catalog-field-large', candidateCount: 1 });
    }
  });

  it('keeps deals private, records completed rounds and lets the host settle the game', async () => {
    const pool = await createPool('Fixture pool', uniformCodes);
    const separatePool = await createPool('Separate pool', uniformCodes);
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
    const candidates = (playerId: string) => uniformCodes.filter((code) => code === answers.get(playerId) || ![...answers.values()].includes(code));
    const page = (await request<GuessCardPage>(`${path}/cards?q=测试用效果文本`, alice.token)).body;
    expect(page.cards.map((card) => card.code)).toEqual(candidates('Alice').slice(0, 24));
    expect(page.cards.every((card) => !card.stats)).toBe(true);
    expect(page).toMatchObject({ totalCount: 28, totalPages: 2, hasMore: true });
    const nextPage = (await request<GuessCardPage>(`${path}/cards?q=测试用效果文本&page=1`, bob.token)).body;
    expect(nextPage.cards.map((card) => card.code)).toEqual(candidates('Bob').slice(24));
    expect(nextPage).toMatchObject({ totalCount: 28, totalPages: 2, hasMore: false });
    expect((await request<GuessCardPage>(`${path}/cards?q=测试用效果文本&page=2`, bob.token)).body)
      .toEqual({ cards: [], totalCount: 28, totalPages: 2, hasMore: false });
    expect((await request<GuessCardPage>(`${path}/cards?q=${outsideCode}`, bob.token)).body)
      .toEqual({ cards: [], totalCount: 0, totalPages: 0, hasMore: false });
    const unscoped = (await request<GuessCardPage>(`/cards?q=${outsideCode}`)).body;
    expect(unscoped.cards.map((card) => card.code)).toEqual([outsideCode]);
    expect(unscoped).toMatchObject({ totalCount: 1, totalPages: 1, hasMore: false });
    expect((await request<GuessCardPage>(`/cards?q=${tokenCode}`)).body)
      .toEqual({ cards: [], totalCount: 0, totalPages: 0, hasMore: false });
    const browse = (await request<GuessCardPage>(`/pools/${pool.poolId}/cards?page=1`)).body;
    expect(browse.cards.map((card) => card.code)).toEqual(uniformCodes.slice(24));
    expect(browse).toMatchObject({ totalCount: 30, totalPages: 2, hasMore: false });
    expect(browse.cards.every((card) => card.stats?.appearances === 0)).toBe(true);

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
    const missCode = uniformCodes.find((code) => ![...answers.values()].includes(code))!;
    const miss: GuessActionRequest = { action: 'guess', version, code: missCode };
    const duplicate = await Promise.all([action(path, firstToken, miss), action(path, firstToken, miss)]);
    expect(duplicate.map((response) => response.status).sort()).toEqual([200, 409]);
    let state = duplicate.find((response) => response.status === 200)!.body;
    expect(state.currentPlayerId).toBe(second);
    expect(state.lastMove?.outcome).toBe('incorrect');
    expect(state.players.find((player) => player.playerId === first)?.card).toBeNull();

    state = (await action(path, secondToken, { action: 'guess', version: state.version, code: answers.get(second)! })).body;
    expect(state.lastMove).toMatchObject({ playerId: second, outcome: 'correct', points: 3 });
    expect(state.players.find((player) => player.playerId === second)?.card?.code).toBe(answers.get(second));
    expect(await stats(pool.poolId, answers.get(second)!)).toEqual({ appearances: 0, averageGuessTurns: null });
    expect(state.currentPlayerId).toBe(third);
    state = (await action(path, thirdToken, { action: 'guess', version: state.version, code: missCode })).body;
    expect(state.currentPlayerId).toBe(first);
    state = (await action(path, firstToken, { action: 'guess', version: state.version, code: answers.get(first)! })).body;
    expect(state.lastMove).toMatchObject({ playerId: first, outcome: 'correct', points: 2 });
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

  it('shows all opening hints, locks wrong guesses, shares selections, and rotates skipped turns', async () => {
    const poolCodes = uniformCodes.slice(0, 5);
    const pool = await createPool('Turn controls pool', poolCodes);
    const hostId = 'Host';
    const host = await create(hostId, pool.poolId);
    const path = `/rooms/${host.room.roomId}`;
    const ids = [hostId, 'Guest A', 'Guest B'];
    const sessions = new Map([[hostId, host.token]]);
    for (const playerId of ids.slice(1)) {
      const join = await request<GuessSession>(`${path}/join`, undefined, { playerId });
      expect(join.status).toBe(201);
      sessions.set(playerId, join.body.token);
    }
    async function read(id: string) {
      const result = await request<GuessRoomView>(path, sessions.get(id));
      expect(result.status).toBe(200);
      return result.body;
    }
    let state = await read(hostId);
    expect(state).toMatchObject({ viewerOpeningHint: null, viewerCardKind: null, viewerGuesses: [], currentGuess: null });
    async function turn(id: string, command: GuessActionRequest['action'], code?: number) {
      const result = await request<GuessRoomView>(`${path}/action`, sessions.get(id), { action: command, version: state.version, code });
      expect(result.status).toBe(200);
      state = result.body;
    }
    await turn(hostId, 'start');

    const views = await Promise.all(ids.map(read));
    const answers = new Map(views.flatMap(({ players }) => players.flatMap(({ playerId, card }) =>
      card ? [[playerId, { code: card.code, name: card.name }] as const] : [])));
    const cards = app.get(CardsService);
    const { options: possible } = buildOpeningHintOptions(cards.getMany(poolCodes), ids.map((id) => answers.get(id)!.code), cards.poolFieldSizes());
    for (const [index, view] of views.entries()) {
      expect(possible[index]).toContainEqual(view.viewerOpeningHint);
      expect(view.viewerOpeningHint?.candidateCount).toBe(3);
      expect(view.viewerCardKind).toBeNull();
      expect(view.players.find((player) => player.playerId === view.viewerId)?.card).toBeNull();
      for (const player of view.players) {
        const { method, group } = views.find((other) => other.viewerId === player.playerId)!.viewerOpeningHint!;
        expect(player.openingHint).toEqual({ method, group });
      }
      expect(view).not.toHaveProperty('hintPools');
      expect(view.viewerGuesses).toEqual([]);
      expect((await read(view.viewerId)).viewerOpeningHint).toEqual(view.viewerOpeningHint);
    }

    if (state.currentPlayerId === hostId) await turn(hostId, 'skip');
    const target = state.currentPlayerId!;
    const targetToken = sessions.get(target)!;
    const dealtCodes = new Set([...answers.values()].map(({ code }) => code));
    const wrongCard = (await request<GuessCardPage>(`${path}/cards`, targetToken)).body.cards.find(({ code }) => !dealtCodes.has(code))!;
    const wrong = { code: wrongCard.code, name: wrongCard.name };
    const version = state.version;
    expect((await action(path, targetToken, { action: 'host-skip', version })).status).toBe(403);
    expect((await action(path, host.token, { action: 'skip', version })).status).toBe(409);
    expect((await action(path, host.token, { action: 'select', version, code: wrong.code })).status).toBe(409);
    expect((await action(path, targetToken, { action: 'select', version, code: outsideCode })).status).toBe(400);
    expect((await action<{ code: string }>(path, targetToken, { action: 'select', version, code: answers.get(hostId)!.code })).body.code)
      .toBe('GUESS_CARD_OUTSIDE_HINT');
    await turn(target, 'select', wrong.code);
    expect(state.currentPlayerId).toBe(target);
    expect(state.viewerGuesses).toEqual([]);
    expect((await read(hostId)).currentGuess).toEqual(wrong);
    const selectedVersion = state.version;
    await turn(hostId, 'host-skip');
    expect(state.lastMove).toEqual({ playerId: target, outcome: 'skipped', points: null, skippedBy: hostId });
    expect(state.currentGuess).toBeNull();
    expect((await action(path, targetToken, { action: 'guess', version: selectedVersion, code: wrong.code })).status).toBe(409);

    const selfSkipping = state.currentPlayerId!;
    expect(selfSkipping).not.toBe(target);
    await turn(selfSkipping, 'select', answers.get(selfSkipping)!.code);
    await turn(selfSkipping, 'skip');
    expect(state.lastMove).toEqual({ playerId: selfSkipping, outcome: 'skipped', points: null });
    expect(state.currentGuess).toBeNull();
    expect(state.players.every((player) => player.roundPoints === null && player.score === 0)).toBe(true);
    const third = state.currentPlayerId!;
    expect(third).not.toBe(target);
    expect(third).not.toBe(selfSkipping);
    await turn(third, 'guess', answers.get(third)!.code);
    expect(state.currentPlayerId).toBe(target);
    await turn(target, 'guess', wrong.code);
    expect(state.lastMove).toEqual({ playerId: target, outcome: 'incorrect', points: null, card: wrong });
    expect(state.viewerGuesses).toEqual([wrong]);
    expect(state.viewerWrongGuessCodes).toEqual([wrong.code]);
    expect(state.players.find((player) => player.playerId === target)?.card).toBeNull();
    expect((await read(selfSkipping)).viewerGuesses).toEqual([]);
    await turn(selfSkipping, 'guess', answers.get(selfSkipping)!.code);
    for (const actionName of ['select', 'guess'] as const) {
      const repeat = await action<{ code: string }>(path, targetToken, { action: actionName, version: state.version, code: wrong.code });
      expect(repeat).toEqual({ status: 409, body: { code: 'GUESS_CARD_ALREADY_GUESSED' } });
    }
    const wrongSearch = (await request<GuessCardPage>(`${path}/cards?q=${wrong.code}`, targetToken)).body;
    expect(wrongSearch.cards.map(({ code }) => code)).toEqual([wrong.code]);
    await turn(target, 'skip');
    expect(state.currentPlayerId).toBe(target);
    expect(state.viewerGuesses).toEqual([wrong]);
    const answer = answers.get(target)!;
    await turn(target, 'select', answer.code);
    await turn(target, 'guess', answer.code);
    expect(state.phase).toBe('between_rounds');
    expect(state.currentGuess).toBeNull();
    expect(state.viewerGuesses).toEqual([wrong, answer]);
    expect(await stats(pool.poolId, answer.code)).toEqual({ appearances: 1, averageGuessTurns: 4 });
    closeDb();
    expect((await read(target)).viewerGuesses).toEqual([wrong, answer]);
    await turn(hostId, 'next');
    expect((await read(target)).viewerGuesses).toEqual([]);
    expect((await read(target)).viewerWrongGuessCodes).toEqual([]);
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

  it('reveals surrendered cards to spectators and allows membership changes between rounds', async () => {
    const poolCodes = uniformCodes.slice(0, 3);
    const pool = await createPool('Spectator pool', poolCodes);
    const host = await create('Organizer', pool.poolId);
    const path = `/rooms/${host.room.roomId}`;
    const join = (playerId: string) => request<GuessSession>(`${path}/join`, undefined, { playerId });
    const guest = (await join('Guest')).body;
    const tokens = new Map([[host.room.viewerId, host.token], [guest.room.viewerId, guest.token]]);
    async function watch() {
      const response = await request<GuessSpectatorView>(`${path}/spectate`);
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('viewerId');
      expect(response.body).not.toHaveProperty('viewerCardKind');
      expect(response.body).not.toHaveProperty('viewerOpeningHint');
      expect(response.body).not.toHaveProperty('viewerGuesses');
      expect(JSON.stringify(response.body)).not.toContain('tokenHash');
      return response.body;
    }
    let state = (await action(path, host.token, { action: 'start', version: guest.room.version })).body;
    const first = state.currentPlayerId!;
    const second = state.players.find(({ playerId }) => playerId !== first)!.playerId;
    const firstView = (await request<GuessRoomView>(path, tokens.get(first))).body;
    const secondCard = firstView.players.find(({ playerId }) => playerId === second)!.card!;
    const secondView = (await request<GuessRoomView>(path, tokens.get(second))).body;
    const firstCard = secondView.players.find(({ playerId }) => playerId === first)!.card!;
    const wrongCode = poolCodes.find((code) => code !== firstCard.code && code !== secondCard.code)!;
    const wrongCard = app.get(CardsService).get(wrongCode)!;
    const watching = await watch();
    expect(watching.players.every(({ card }) => card === null)).toBe(true);
    expect(watching.players.map(({ openingHint }) => openingHint)).toEqual(state.players.map(({ openingHint }) => openingHint));
    expect((await request(path)).status).toBe(401);
    expect((await request(`${path}/cards`)).status).toBe(401);
    expect((await join('Early')).status).toBe(409);
    expect((await action(path, host.token, { action: 'leave', version: state.version })).status).toBe(409);

    state = (await action(path, tokens.get(first)!, { action: 'select', version: state.version, code: wrongCode })).body;
    const selecting = await watch();
    const publicCard = { code: secondCard.code, name: secondCard.name };
    const publicWrong = { code: wrongCode, name: wrongCard.name };
    expect(selecting.currentGuess).toEqual(publicWrong);
    expect(selecting.guesses).toEqual([]);
    expect(selecting.players.every(({ card }) => card === null)).toBe(true);
    state = (await action(path, tokens.get(first)!, { action: 'guess', version: state.version, code: wrongCode })).body;
    const wrong = { playerId: first, card: publicWrong, outcome: 'incorrect' };
    expect((await watch()).guesses).toEqual([wrong]);
    expect((await watch()).players.every(({ card }) => card === null)).toBe(true);
    state = (await action(path, tokens.get(second)!, { action: 'guess', version: state.version, code: secondCard.code })).body;
    const solved = await watch();
    expect(solved.guesses).toEqual([wrong, { playerId: second, card: publicCard, outcome: 'correct' }]);
    expect(solved.players.find(({ playerId }) => playerId === second)?.card?.code).toBe(secondCard.code);
    expect(solved.players.find(({ playerId }) => playerId === first)?.card).toBeNull();
    state = (await action(path, tokens.get(first)!, { action: 'surrender', version: state.version })).body;
    expect(state.phase).toBe('between_rounds');
    expect(state.players.every(({ card }) => card !== null)).toBe(true);
    expect((await watch()).players.find(({ playerId }) => playerId === first)?.card?.code).toBe(firstCard.code);

    expect((await action(path, host.token, { action: 'leave', version: state.version })).status).toBe(200);
    expect((await request(path, host.token)).status).toBe(401);
    const between = await watch();
    expect(between).toMatchObject({ hostId: 'Guest', playerCount: 1 });
    expect(between.standings.find(({ playerId }) => playerId === 'Organizer')).toMatchObject({
      departed: true, score: first === 'Organizer' ? 0 : 2,
    });
    expect((await action(path, guest.token, { action: 'next', version: between.version })).status).toBe(409);
    expect((await join('organizer')).status).toBe(409);
    const newcomer = await join('New player');
    expect(newcomer.status).toBe(201);
    expect(newcomer.body.room.viewerOpeningHint).toBeNull();
    expect(newcomer.body.room.standings.find(({ playerId }) => playerId === 'New player')).toMatchObject({ score: 0, departed: false });
    const next = await action(path, guest.token, { action: 'next', version: newcomer.body.room.version });
    expect(next.status).toBe(200);
    expect(next.body.viewerOpeningHint?.candidateCount).toBe(2);
    expect((await request<GuessRoomView>(path, newcomer.body.token)).body.viewerOpeningHint?.candidateCount).toBe(2);
    const nextWatch = await watch();
    expect(nextWatch.round).toBe(2);
    expect(nextWatch.players.map(({ playerId }) => playerId).sort()).toEqual(['Guest', 'New player']);
    expect(nextWatch.players.every(({ card }) => card === null)).toBe(true);
    expect(nextWatch.guesses).toEqual([]);
  });

  it('settles a stale partial round without crediting uncompleted card statistics or letting reads reset the clock', async () => {
    const pool = await createPool('Inactivity pool', codes.slice(0, 2));
    const host = await create('Host', pool.poolId);
    const path = `/rooms/${host.room.roomId}`;
    const guest = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Guest' })).body;
    let state = (await action(path, host.token, { action: 'start', version: guest.room.version })).body;
    const tokens = new Map([[host.room.viewerId, host.token], [guest.room.viewerId, guest.token]]);
    const first = state.currentPlayerId!;
    const remaining = state.players.find(({ playerId }) => playerId !== first)!.playerId;
    const other = (await request<GuessRoomView>(path, tokens.get(remaining))).body;
    const answer = other.players.find(({ playerId }) => playerId === first)!.card!;
    state = (await action(path, tokens.get(first)!, { action: 'guess', version: state.version, code: answer.code })).body;
    const db = getDb();
    const update = db.prepare('UPDATE guess_rooms SET updated_at = ? WHERE room_id = ?');
    const room = db.prepare('SELECT phase, updated_at FROM guess_rooms WHERE room_id = ?');
    const day = 24 * 60 * 60 * 1000;
    const recent = new Date(Date.now() - day + 10 * 60 * 1000).toISOString();
    update.run(recent, host.room.roomId);
    await request(path, host.token);
    await request(`${path}/cards`, host.token);
    await request(`${path}/spectate`);
    expect(room.get(host.room.roomId)).toEqual({ phase: 'playing', updated_at: recent });
    const remainingCode = codes.slice(0, 2).find((code) => code !== answer.code)!;
    const selected = await action(path, tokens.get(remaining)!, { action: 'select', version: state.version, code: remainingCode });
    expect(selected.status).toBe(200);
    expect((room.get(host.room.roomId) as { updated_at: string }).updated_at > recent).toBe(true);
    update.run(new Date(Date.now() - day).toISOString(), host.room.roomId);
    expect((await action(path, tokens.get(remaining)!, { action: 'skip', version: selected.body.version })).status).toBe(409);
    const finished = (await request<GuessRoomView>(path, tokens.get(remaining))).body;
    expect(finished).toMatchObject({ phase: 'finished', finishReason: 'inactivity', currentPlayerId: null, currentGuess: null });
    expect(finished.version).toBe(selected.body.version + 1);
    expect(finished.players.every(({ card }) => card !== null)).toBe(true);
    expect(finished.standings.map(({ score }) => score).sort()).toEqual([0, 2]);
    const publicResult = (await request<GuessSpectatorView>(`${path}/spectate`)).body;
    expect(publicResult.players.find(({ playerId }) => playerId === remaining)?.card).toBeNull();
    for (const code of codes.slice(0, 2)) {
      expect(await stats(pool.poolId, code)).toEqual({ appearances: 0, averageGuessTurns: null });
    }
    const event = db.prepare('SELECT event_json FROM guess_room_events WHERE room_id = ? AND version = ?')
      .get(host.room.roomId, finished.version) as { event_json: string };
    expect(JSON.parse(event.event_json)).toEqual({ action: 'finish', reason: 'inactivity' });
  });

  it('catches up on restart and settles idle rooms in the background without an HTTP request', async () => {
    const old = await create('Expired lobby', 0);
    const pending = await create('Waiting lobby', 0);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const db = getDb();
    const update = db.prepare('UPDATE guess_rooms SET updated_at = ? WHERE room_id = ?');
    update.run(new Date(now - day).toISOString(), old.room.roomId);
    update.run(new Date(now - day + 60_000).toISOString(), pending.room.roomId);
    const phase = db.prepare('SELECT phase FROM guess_rooms WHERE room_id = ?').pluck();
    const service = new GuessService(app.get(CardsService), app.get(GuessPoolsService));
    jest.useFakeTimers({ now });
    try {
      service.onModuleInit();
      expect(phase.get(old.room.roomId)).toBe('finished');
      expect(phase.get(pending.room.roomId)).toBe('lobby');
      jest.advanceTimersByTime(59_999);
      expect(phase.get(pending.room.roomId)).toBe('lobby');
      jest.advanceTimersByTime(1);
      expect(phase.get(pending.room.roomId)).toBe('finished');
      jest.advanceTimersByTime(60_000);
      const count = db.prepare('SELECT COUNT(*) FROM guess_room_events WHERE room_id = ?').pluck();
      expect(count.get(pending.room.roomId)).toBe(2);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
    expect((await request(`/rooms/${pending.room.roomId}/join`, undefined, { playerId: 'Late' })).status).toBe(409);
    expect((await request<GuessRoomSummary[]>('/rooms')).body.some((room) => room.roomId === pending.room.roomId)).toBe(false);
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
    expect(migrated.viewerOpeningHint).toBeNull();
    expect(migrated.viewerCardKind).toBe('spell');
    expect(migrated.viewerGuesses).toEqual([]);
    expect((await request<GuessRoomView>(path, aToken)).body.viewerGuesses.map(({ code }) => code)).toEqual([bCode]);
    const bCorrect = (await action(path, bToken, { action: 'guess', version: migrated.version, code: bCode })).body;
    const aCorrect = (await action(path, aToken, { action: 'guess', version: bCorrect.version, code: aCode })).body;
    expect(aCorrect.phase).toBe('between_rounds');
    expect(await stats(migrated.poolId, aCode)).toEqual({ appearances: 2, averageGuessTurns: 2.5 });
    expect(await stats(migrated.poolId, bCode)).toEqual({ appearances: 2, averageGuessTurns: 1 });
  });

  it('finalizes all open rooms for maintenance with one event each and keeps completed rounds', async () => {
    const waiting = await create('Maintenance lobby', 0);
    const db = getDb();
    const open = db.prepare("SELECT room_id FROM guess_rooms WHERE phase IN ('lobby', 'playing', 'between_rounds')").pluck().all() as string[];
    const history = db.prepare('SELECT * FROM guess_round_cards ORDER BY room_id, round_number, code');
    const before = history.all();
    expect(open).toContain(waiting.room.roomId);
    expect(settleOpenGuessRoomsForMaintenance()).toBe(open.length);
    expect(settleOpenGuessRoomsForMaintenance()).toBe(0);
    expect(history.all()).toEqual(before);
    const event = db.prepare('SELECT event_json FROM guess_room_events WHERE room_id = ? ORDER BY version DESC LIMIT 1').pluck();
    for (const roomId of open) expect(JSON.parse(event.get(roomId) as string)).toEqual({ action: 'finish', reason: 'maintenance' });
    const result = (await request<GuessRoomView>(`/rooms/${waiting.room.roomId}`, waiting.token)).body;
    expect(result).toMatchObject({ phase: 'finished', finishReason: 'maintenance', version: waiting.room.version + 1 });
  });

  it('promotes the newest complete default while preserving older pool IDs and members', async () => {
    const service = app.get(GuessPoolsService);
    const catalog = jest.spyOn(app.get(CardsService), 'poolCodes');
    const original = [...DEFAULT_GUESS_POOL_CODES];
    const shortlist = [...SHORTLIST_GUESS_POOL_CODES];
    const recency = [...RECENCY_GUESS_POOL_CODES];
    const originalCodes = new Set(original);
    expect(shortlist).toHaveLength(2145);
    expect(shortlist).toEqual([...new Set(shortlist)].sort((a, b) => a - b));
    expect(shortlist.every((code) => code > 0 && code < 100_000_000 && originalCodes.has(code))).toBe(true);
    expect(recency).toHaveLength(2125);
    expect(recency).toEqual([...new Set(recency)].sort((a, b) => a - b));
    expect(recency.every((code) => code > 0 && code < 100_000_000)).toBe(true);
    expect(recency).toContain(6351147);
    expect(recency).not.toContain(22123627);
    expect(recency.some((code) => !originalCodes.has(code))).toBe(true);
    try {
      catalog.mockReturnValue(original.filter((code) => code !== shortlist[0]));
      service.onModuleInit();
      expect(service.list().some((pool) => pool.isDefault)).toBe(false);
      const savedOriginal = getDb().prepare('INSERT INTO guess_pools (name, name_key, codes_json) VALUES (?, ?, ?)')
        .run('常见卡牌', 'builtin:familiar-v1', JSON.stringify(original));
      const originalId = Number(savedOriginal.lastInsertRowid);
      expect((await request<GuessPoolSummary>(`/pools/${originalId}`)).body.isDefault).toBe(true);
      service.onModuleInit();
      expect(service.list().filter((pool) => pool.isDefault).map((pool) => pool.poolId)).toEqual([originalId]);

      catalog.mockReturnValue(original);
      service.onModuleInit();
      const [savedShortlist] = service.list();
      expect(savedShortlist).toMatchObject({ name: '常见卡牌精简版', cardCount: shortlist.length, isDefault: true });

      catalog.mockReturnValue([...new Set([...original, ...recency])]);
      service.onModuleInit();
      service.onModuleInit();
      const pools = (await request<GuessPoolSummary[]>('/pools')).body;
      const [selected] = pools;
      expect(pools.filter((pool) => pool.isDefault)).toEqual([selected]);
      expect(selected).toMatchObject({ name: '常见卡牌近年权重版', cardCount: recency.length, isDefault: true });
      expect(selected.poolId).not.toBe(originalId);
      expect(selected.poolId).not.toBe(savedShortlist.poolId);
      expect((await request<GuessPoolSummary>(`/pools/${selected.poolId}`)).body).toEqual(selected);
      expect(service.get(selected.poolId).codes).toEqual(recency);
      expect(service.get(savedShortlist.poolId)).toEqual({
        poolId: savedShortlist.poolId, name: savedShortlist.name, codes: shortlist, isDefault: false,
      });
      expect(service.get(originalId)).toEqual({ poolId: originalId, name: '常见卡牌', codes: original, isDefault: false });
    } finally {
      catalog.mockRestore();
    }
  });
});
