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
import { GuessPoolVotesService } from '../src/guess/guess-pool-votes.service';
import { GuessService, settleOpenGuessRoomsForMaintenance } from '../src/guess/guess.service';
import { buildOpeningHintOptions } from '../src/guess/opening-hints';
import {
  original as DEFAULT_GUESS_POOL_CODES, shortlist as SHORTLIST_GUESS_POOL_CODES, recent as RECENCY_GUESS_POOL_CODES,
  firstEdition as EXTREME_GUESS_POOL_CODES, revision as REVIEWED_EXTREME_GUESS_POOL_CODES,
  expansion as EXPANDED_EXTREME_GUESS_POOL_CODES,
} from './pool-fixture';
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
  const artworkBase = 10280;
  const artworkVariant = 10281;
  const secondArtwork = 10282;
  const ruleAlias = 10305;

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
    const setNamesAndAlias = getDb().prepare('UPDATE cards SET name = ?, alias = ? WHERE code = ?');
    setNamesAndAlias.run('测试异画 原版', 0, artworkBase);
    setNamesAndAlias.run('测试异画 版本甲', artworkBase, artworkVariant);
    setNamesAndAlias.run('测试异画 版本乙', artworkBase, secondArtwork);
    setNamesAndAlias.run('测试异画 规则同名', artworkBase, ruleAlias);
    const module = await Test.createTestingModule({
      controllers: [GuessController],
      providers: [GuessService, GuessPoolsService, GuessPoolVotesService, { provide: CardsService, useValue: cards }, { provide: APP_GUARD, useClass: AuthGuard }],
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
    for (const name of ['Fixture original', 'Fixture short', 'Fixture previous name', 'Fixture recent', 'Fixture browse']) {
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
      expect(hints).toContainEqual({ method: 'field-size', group: 'distinct-field-large', candidateCount: 1 });
    }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'persists independent expert=%s and disabled-hints=%s options and enforces room search',
    async (expertMode, disableOpeningHints) => {
      const pool = await createPool(`Options ${expertMode} ${disableOpeningHints}`, uniformCodes);
      const host = await request<GuessSession>('/rooms', undefined, {
        name: 'Options room', playerId: 'Options host', poolId: pool.poolId, expertMode, disableOpeningHints,
      });
      expect(host.status).toBe(201);
      const path = `/rooms/${host.body.room.roomId}`;
      const guest = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Options guest' })).body;
      const started = (await action(path, host.body.token, { action: 'start', version: guest.room.version })).body;
      const restored = (await request<GuessRoomView>(path, host.body.token)).body;
      const publicView = (await request<GuessSpectatorView>(`${path}/spectate`)).body;
      for (const view of [host.body.room, guest.room, started, restored, publicView]) {
        expect(view).toMatchObject({ expertMode, disableOpeningHints });
      }
      const saved = getDb().prepare('SELECT state_json FROM guess_rooms WHERE room_id = ?').pluck()
        .get(started.roomId) as string;
      expect(JSON.parse(saved)).toMatchObject({ expertMode, disableOpeningHints });
      if (disableOpeningHints) {
        for (const view of [started, restored, publicView]) expect(view.players.every((seat) => seat.openingHint === null)).toBe(true);
        expect(restored.viewerOpeningHint).toBeNull();
        expect(restored.viewerCardKind).toBeNull();
        expect(JSON.parse(saved).round.hintPools).toEqual({});
      } else {
        expect(restored.viewerOpeningHint).not.toBeNull();
        expect(publicView.players.every((seat) => seat.openingHint !== null)).toBe(true);
      }

      const search = (query: string) => request<GuessCardPage>(`${path}/cards?${query}`, host.body.token);
      expect((await search('q=测试卡牌')).body.totalCount).toBeGreaterThan(0);
      const outsideName = app.get(CardsService).get(outsideCode)!.name;
      const outside = await search(`q=${encodeURIComponent(`"${outsideName}"`)}`);
      expect(outside.body.cards.some((card) => card.code === outsideCode)).toBe(expertMode);
      if (expertMode) {
        expect((await search('')).body.totalCount).toBe(0);
        expect((await search('q=测试用效果文本')).body.totalCount).toBe(0);
        expect((await search(`q=${uniformCodes[0]}`)).body.totalCount).toBe(0);
        for (const query of ['q=测试卡牌&category=1', 'q=测试卡牌&subtype=monster', 'q=测试卡牌&sort=attack']) {
          expect((await request(`${path}/cards?${query}`, host.body.token)).body.code).toBe('GUESS_FILTERS_DISABLED');
        }
        expect((await request<GuessCardPage>(`/pools/${pool.poolId}/cards?q=测试用效果文本`)).body.totalCount).toBe(uniformCodes.length);
      } else {
        expect((await search('q=测试用效果文本')).body.totalCount).toBeGreaterThan(0);
      }
      const tokens = new Map([['Options host', host.body.token], ['Options guest', guest.token]]);
      const views = await Promise.all([...tokens.values()].map((token) => request<GuessRoomView>(path, token)));
      const answers = new Map(views.flatMap(({ body }) => body.players.filter((seat) => seat.card)
        .map(({ playerId, card }) => [playerId, card!.code])));
      let state = restored;
      while (state.currentPlayerId) {
        const token = tokens.get(state.currentPlayerId)!;
        const code = answers.get(state.currentPlayerId)!;
        const selected = (await action(path, token, { action: 'select', version: state.version, code })).body;
        state = (await action(path, token, { action: 'guess', version: selected.version, code })).body;
      }
      state = (await action(path, host.body.token, { action: 'next', version: state.version })).body;
      expect(state).toMatchObject({ phase: 'playing', round: 2, expertMode, disableOpeningHints });
      expect(state.viewerOpeningHint === null).toBe(disableOpeningHints);
    },
  );

  it.each([false, true])('allows expert guesses from the full catalog with disabled hints=%s', async (disableOpeningHints) => {
    const pool = await createPool(`Full catalog ${disableOpeningHints}`, uniformCodes);
    const host = (await request<GuessSession>('/rooms', undefined, {
      name: 'Full catalog room', playerId: 'Solo expert', poolId: pool.poolId, expertMode: true, disableOpeningHints,
    })).body;
    const path = `/rooms/${host.room.roomId}`;
    let state = (await action(path, host.token, { action: 'start', version: host.room.version })).body;
    expect(state.viewerOpeningHint === null).toBe(disableOpeningHints);
    const cards = app.get(CardsService);
    const searchName = (code: number) => request<GuessCardPage>(
      `${path}/cards?q=${encodeURIComponent(`"${cards.get(code)!.name}"`)}`, host.token,
    );
    expect((await searchName(outsideCode)).body.cards.map((card) => card.code)).toContain(outsideCode);
    expect((await searchName(tokenCode)).body.cards.map((card) => card.code)).not.toContain(tokenCode);
    for (const code of [tokenCode, 999999999]) {
      const result = await action<{ code: string }>(path, host.token, { action: 'select', version: state.version, code });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('GUESS_CARD_NOT_IN_POOL');
    }
    state = (await action(path, host.token, { action: 'select', version: state.version, code: outsideCode })).body;
    expect(state.currentGuess?.code).toBe(outsideCode);
    state = (await action(path, host.token, { action: 'guess', version: state.version, code: outsideCode })).body;
    expect(state.lastMove).toMatchObject({ playerId: 'Solo expert', card: { code: outsideCode }, outcome: 'incorrect' });
    expect(state.currentPlayerId).toBe('Solo expert');
    expect(state.viewerWrongGuessCodes).toEqual([outsideCode]);
    for (const command of ['select', 'guess'] as const) {
      const result = await action<{ code: string }>(path, host.token, { action: command, version: state.version, code: outsideCode });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('GUESS_CARD_ALREADY_GUESSED');
    }
    const answer = getDb().prepare("SELECT json_extract(state_json, '$.round.seats[0].code') FROM guess_rooms WHERE room_id = ?")
      .pluck().get(state.roomId) as number;
    expect(uniformCodes).toContain(answer);
    state = (await action(path, host.token, { action: 'guess', version: state.version, code: answer })).body;
    expect(state.phase).toBe('between_rounds');
    expect(state.players[0]).toMatchObject({ roundPoints: 1, score: 1 });
    expect(getDb().prepare('SELECT guess_turns FROM guess_round_cards WHERE room_id = ?').pluck().get(state.roomId)).toBe(2);
  });

  it('rejects non-boolean room options', async () => {
    for (const flags of [{ expertMode: 'true' }, { disableOpeningHints: 1 }, { expertMode: null }]) {
      expect((await request('/rooms', undefined, { name: 'Invalid options', playerId: 'Host', poolId: 0, ...flags })).status).toBe(400);
    }
  });

  it('allows the representative to solve an artwork-only deal and keeps the printed card in stats', async () => {
    const pool = await createPool('Two artworks', [artworkVariant, secondArtwork]);
    const host = (await request<GuessSession>('/rooms', undefined, {
      name: 'Artwork room', playerId: 'Artwork expert', poolId: pool.poolId, expertMode: true, disableOpeningHints: true,
    })).body;
    expect(host.room.maxPlayers).toBe(1);
    const path = `/rooms/${host.room.roomId}`;
    const started = (await action(path, host.token, { action: 'start', version: host.room.version })).body;
    const search = await request<GuessCardPage>(`${path}/cards?q=测试异画`, host.token);
    expect(search.body).toMatchObject({ cards: [{ code: artworkBase }, { code: ruleAlias }], totalCount: 2, totalPages: 1 });
    const wrong = (await action(path, host.token, { action: 'guess', version: started.version, code: ruleAlias })).body;
    expect(wrong.lastMove).toMatchObject({ outcome: 'incorrect', card: { code: ruleAlias } });
    const correct = (await action(path, host.token, { action: 'guess', version: wrong.version, code: artworkBase })).body;
    expect(correct.lastMove).toMatchObject({ outcome: 'correct', points: 1 });
    expect(correct.players[0].card?.code).toBe(artworkVariant);
    expect(await stats(pool.poolId, artworkVariant)).toEqual({ appearances: 1, averageGuessTurns: 2 });

    const other = (await request<GuessSession>('/rooms', undefined, {
      name: 'Artwork repetition', playerId: 'Artwork expert', poolId: (await createPool('Other cards', codes.slice(0, 2))).poolId,
      expertMode: true,
    })).body;
    const otherPath = `/rooms/${other.room.roomId}`;
    const opened = (await action(otherPath, other.token, { action: 'start', version: other.room.version })).body;
    const missed = (await action(otherPath, other.token, { action: 'guess', version: opened.version, code: secondArtwork })).body;
    expect(missed.viewerWrongGuessCodes).toEqual([artworkBase]);
    expect(await action(otherPath, other.token, { action: 'select', version: missed.version, code: artworkBase }))
      .toEqual({ status: 409, body: { code: 'GUESS_CARD_ALREADY_GUESSED' } });
  });

  it('uses the same filters for public card pools and private room candidates', async () => {
    const pool = await createPool('Filter pool', [codes[0], codes[1], codes[2]]);
    const host = await create('Filter host', pool.poolId);
    const path = `/rooms/${host.room.roomId}`;
    const guest = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Filter guest' })).body;
    const params = `subtype=${encodeURIComponent('(quick-play or counter)')}`;
    const cards = await request<GuessCardPage>(`/pools/${pool.poolId}/cards?${params}`);
    expect(cards.body).toMatchObject({ cards: [{ code: codes[1] }, { code: codes[2] }], totalCount: 2, totalPages: 1 });
    expect((await request<GuessCardPage>(`/cards?subtype=quick-play&q=${codes[1]}`)).body.cards[0]?.code).toBe(codes[1]);
    expect((await request(`/pools/${pool.poolId}/cards?subtype=quick-play+and`)).status).toBe(400);
    expect((await request(`/pools/${pool.poolId}/cards?atkMin=100&atkMax=99`)).status).toBe(400);

    const started = (await action(path, host.token, { action: 'start', version: guest.room.version })).body;
    const expected = (await request<GuessCardPage>(`${path}/cards`, host.token)).body.cards
      .filter(({ code }) => code === codes[1] || code === codes[2]);
    const narrowed = await request<GuessCardPage>(`${path}/cards?${params}`, host.token);
    expect(narrowed.body.cards).toEqual(expected);
    expect(narrowed.body.totalCount).toBe(expected.length);
    const candidates = (await request<GuessCardPage>(`${path}/cards`, host.token)).body.cards;
    const complement = encodeURIComponent('not (quick-play or counter)');
    const negated = await request<GuessCardPage>(`${path}/cards?subtype=${complement}`, host.token);
    expect(negated.body.cards).toEqual(candidates.filter(({ code }) => code === codes[0]));
    expect(negated.body.totalCount + narrowed.body.totalCount).toBe(candidates.length);
    expect((await request(`${path}/cards?${params}`)).status).toBe(401);
    const tokens = new Map([[host.room.viewerId, host.token], [guest.room.viewerId, guest.token]]);
    const views = await Promise.all([...tokens.values()].map((token) => request<GuessRoomView>(path, token)));
    const dealt = new Map(views.flatMap(({ body }) => body.players.filter((seat) => seat.card).map(({ playerId, card }) => [playerId, card!.code])));
    let state = started;
    while (state.currentPlayerId) {
      const current = state.currentPlayerId;
      state = (await action(path, tokens.get(current)!, { action: 'guess', version: state.version, code: dealt.get(current)! })).body;
    }
    await action(path, host.token, { action: 'finish', version: state.version });
  });

  it('keeps deals private, records completed rounds and lets the host settle the game', async () => {
    const pool = await createPool('Fixture pool', uniformCodes);
    const separatePool = await createPool('Separate pool', uniformCodes);
    const alice = await create('Alice', pool.poolId);
    const path = `/rooms/${alice.room.roomId}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(`${path}/cards`)).status).toBe(401);
    expect((await request(`${path}/join`, undefined, { playerId: 'ALICE' })).body.code).toBe('GUESS_PLAYER_EXISTS');

    const bob = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Bob' })).body;
    const cora = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Cora' })).body;
    const sessions = new Map([['Alice', alice.token], ['Bob', bob.token], ['Cora', cora.token]]);
    const list = (await request<GuessRoomSummary[]>('/rooms')).body;
    expect(list.find((room) => room.roomId === alice.room.roomId)).toEqual({
      roomId: alice.room.roomId, name: 'Fixture table', playerCount: 3, maxPlayers: uniformCodes.length, poolId: pool.poolId, poolName: pool.name,
      expertMode: false, disableOpeningHints: false,
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
    for (const { viewerId, viewerOpeningHint } of views) {
      const nextHint = (await read(viewerId)).viewerOpeningHint;
      expect(nextHint).toBeTruthy();
      expect(nextHint?.group).not.toBe(viewerOpeningHint?.group);
    }
  });

  it('starts and continues a solo game while keeping its card hidden until the round ends', async () => {
    const pool = await createPool('Solo pool', uniformCodes.slice(0, 2));
    const host = await create('Solo player', pool.poolId);
    const roomId = host.room.roomId;
    const path = `/rooms/${roomId}`;
    let state = (await action(path, host.token, { action: 'start', version: host.room.version })).body;
    expect(state).toMatchObject({ phase: 'playing', round: 1, playerCount: 1, currentPlayerId: 'Solo player',
      players: [{ playerId: 'Solo player', card: null }] });
    const watched = (await request<GuessSpectatorView>(`${path}/spectate`)).body;
    expect(watched.players[0].card).toBeNull();
    const answer = getDb().prepare("SELECT json_extract(state_json, '$.round.seats[0].code') FROM guess_rooms WHERE room_id = ?")
      .pluck().get(roomId) as number;
    state = (await action(path, host.token, { action: 'skip', version: state.version })).body;
    expect(state.currentPlayerId).toBe('Solo player');
    state = (await action(path, host.token, { action: 'guess', version: state.version, code: answer })).body;
    expect(state).toMatchObject({ phase: 'between_rounds', lastMove: { outcome: 'correct', points: 1 } });
    expect(await stats(pool.poolId, answer)).toEqual({ appearances: 1, averageGuessTurns: 2 });
    state = (await action(path, host.token, { action: 'next', version: state.version })).body;
    expect(state).toMatchObject({ phase: 'playing', round: 2 });
    state = (await action(path, host.token, { action: 'next', version: state.version })).body;
    expect(state).toMatchObject({ phase: 'playing', round: 3, previousSurrender: { round: 2, playerId: 'Solo player' } });
    state = (await action(path, host.token, { action: 'surrender', version: state.version })).body;
    expect(state).toMatchObject({ phase: 'between_rounds', lastMove: { outcome: 'surrendered', points: 0 } });
    expect((await action(path, host.token, { action: 'finish', version: state.version })).status).toBe(200);
  });

  it('limits simultaneous joins to the card count and plays with more than eight players', async () => {
    const headers = { 'X-Admin-Token': superToken };
    for (const poolCodes of [[codes[0], tokenCode], [codes[0], codes[0]], [codes[0], -1], [codes[0], 999999999]]) {
      expect((await request('/pools', undefined, { name: 'Invalid', codes: poolCodes }, headers)).status).toBe(400);
    }
    const small = await createPool('Small pool', codes.slice(0, 2));
    expect((await request('/pools', undefined, { name: 'SMALL POOL', codes: codes.slice(0, 2) }, headers)).body.code).toBe('GUESS_POOL_EXISTS');
    expect((await request('/rooms', undefined, { name: 'Unknown pool', playerId: 'Host', poolId: 999999 })).status).toBe(404);
    const large = await createPool('Large room pool', uniformCodes.slice(0, 10));
    const host = await create('Host', large.poolId);
    const path = `/rooms/${host.room.roomId}`;
    const visitors = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      request<GuessSession>(`${path}/join`, undefined, { playerId: `Guest ${index + 1}` })));
    const joined = visitors.filter((result) => result.status === 201).map((result) => result.body);
    expect(joined).toHaveLength(9);
    expect(visitors.filter((result) => result.status === 409)).toHaveLength(1);
    const full = (await request<GuessRoomView>(path, host.token)).body;
    expect(full).toMatchObject({ playerCount: 10, maxPlayers: 10 });
    expect((await request<GuessRoomSummary[]>('/rooms')).body.some((room) => room.roomId === host.room.roomId)).toBe(false);
    expect((await action(path, host.token, { action: 'leave', version: full.version })).status).toBe(200);
    expect((await request(path, host.token)).status).toBe(401);
    const successor = joined.find((session) => session.room.viewerId === full.players[1].playerId)!;
    const waiting = (await request<GuessRoomView>(path, successor.token)).body;
    expect(waiting.hostId).toBe(successor.room.viewerId);
    expect((await request<GuessRoomSummary[]>('/rooms')).body).toContainEqual(expect.objectContaining({
      roomId: host.room.roomId, playerCount: 9, maxPlayers: 10,
    }));
    const otherRoom = await create('Other', small.poolId);
    expect(otherRoom.room.maxPlayers).toBe(2);
    expect((await request(path, otherRoom.token)).status).toBe(401);
    let state = (await action(path, successor.token, { action: 'start', version: waiting.version })).body;
    expect(state.players).toHaveLength(9);
    expect(state.viewerOpeningHint?.candidateCount).toBe(2);
    const views = await Promise.all(joined.map(({ token }) => request<GuessRoomView>(path, token)));
    const dealt = new Map(views.flatMap(({ body }) => body.players.filter(({ card }) => card).map(({ playerId, card }) => [playerId, card!.code])));
    const tokens = new Map(joined.map(({ room, token }) => [room.viewerId, token]));
    expect(new Set(dealt.values()).size).toBe(9);
    while (state.currentPlayerId) {
      const current = state.currentPlayerId;
      state = (await action(path, tokens.get(current)!, { action: 'guess', version: state.version, code: dealt.get(current)! })).body;
    }
    expect(state.standings.map(({ score }) => score).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await action(path, successor.token, { action: 'finish', version: state.version })).status).toBe(200);
  });

  it('atomically settles the last player when the host advances and revokes credentials on removal', async () => {
    const poolCodes = uniformCodes.slice(0, 3);
    const pool = await createPool('Host advance pool', poolCodes);
    const host = await create('Advance host', pool.poolId);
    const roomId = host.room.roomId;
    const path = `/rooms/${roomId}`;
    const guest = (await request<GuessSession>(`${path}/join`, undefined, { playerId: 'Advance guest' })).body;
    const tokens = new Map([[host.room.viewerId, host.token], [guest.room.viewerId, guest.token]]);
    async function answers() {
      const views = await Promise.all([...tokens.values()].map((token) => request<GuessRoomView>(path, token)));
      return new Map(views.flatMap(({ body }) => body.players.filter(({ card }) => card).map(({ playerId, card }) => [playerId, card!])));
    }
    let state = (await action(path, host.token, { action: 'start', version: guest.room.version })).body;
    expect((await action(path, host.token, { action: 'next', version: state.version })).status).toBe(409);
    expect((await action(path, host.token, { action: 'remove', version: state.version, playerId: guest.room.viewerId })).status).toBe(409);
    const dealt = await answers();
    const first = state.currentPlayerId!;
    state = (await action(path, tokens.get(first)!, { action: 'guess', code: dealt.get(first)!.code, version: state.version })).body;
    const last = state.currentPlayerId!;
    const lastCard = dealt.get(last)!;
    const version = state.version;
    expect((await action(path, guest.token, { action: 'next', version })).status).toBe(403);

    const changePool = getDb().prepare('UPDATE guess_pools SET codes_json = ? WHERE id = ?');
    changePool.run(JSON.stringify([poolCodes[0]]), pool.poolId);
    try {
      expect((await action(path, host.token, { action: 'next', version })).status).toBe(409);
    } finally {
      changePool.run(JSON.stringify(poolCodes), pool.poolId);
    }
    expect((await request<GuessRoomView>(path, host.token)).body).toMatchObject({ round: 1, version, currentPlayerId: last });
    expect(await stats(pool.poolId, lastCard.code)).toEqual({ appearances: 0, averageGuessTurns: null });

    const next = await action(path, host.token, { action: 'next', version });
    expect(next.status).toBe(200);
    state = next.body;
    const previousSurrender = { round: 1, playerId: last, card: { code: lastCard.code, name: lastCard.name } };
    expect(state).toMatchObject({ phase: 'playing', round: 2, version: version + 2, previousSurrender });
    const watching = (await request<GuessSpectatorView>(`${path}/spectate`)).body;
    expect(watching.previousSurrender).toEqual(previousSurrender);
    expect(watching.players.every(({ card }) => card === null)).toBe(true);
    expect(await stats(pool.poolId, lastCard.code)).toEqual({ appearances: 1, averageGuessTurns: null });
    expect((await action(path, host.token, { action: 'next', version })).status).toBe(409);
    const events = getDb().prepare('SELECT event_json FROM guess_room_events WHERE room_id=? AND version>? ORDER BY version')
      .pluck().all(roomId, version).map((event) => JSON.parse(event as string));
    expect(events).toMatchObject([
      { action: 'surrender', playerId: last, forcedBy: host.room.viewerId, move: { points: 0 } },
      { action: 'next', playerId: host.room.viewerId, round: { number: 2 } },
    ]);

    const roundTwo = await answers();
    while (state.currentPlayerId) {
      const current = state.currentPlayerId;
      state = (await action(path, tokens.get(current)!, { action: 'guess', code: roundTwo.get(current)!.code, version: state.version })).body;
    }
    const guestStanding = state.standings.find(({ playerId }) => playerId === guest.room.viewerId)!;
    expect((await action(path, guest.token, { action: 'remove', version: state.version, playerId: host.room.viewerId })).status).toBe(403);
    expect((await action(path, host.token, { action: 'remove', version: state.version, playerId: host.room.viewerId })).status).toBe(400);
    const removed = await action(path, host.token, { action: 'remove', version: state.version, playerId: guest.room.viewerId });
    expect(removed.body).toMatchObject({ phase: 'between_rounds', playerCount: 1 });
    expect(removed.body.standings).toContainEqual({ ...guestStanding, departed: true });
    expect((await request(path, guest.token)).status).toBe(401);
    expect((await action(path, host.token, { action: 'finish', version: removed.body.version })).status).toBe(200);
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
    const playing = await create('Maintenance playing', 0);
    const playingPath = `/rooms/${playing.room.roomId}`;
    expect((await action(playingPath, playing.token, { action: 'start', version: playing.room.version })).status).toBe(200);
    const db = getDb();
    const open = db.prepare("SELECT room_id FROM guess_rooms WHERE phase IN ('lobby', 'playing', 'between_rounds')").pluck().all() as string[];
    const started = db.prepare("SELECT room_id FROM guess_rooms WHERE phase IN ('playing', 'between_rounds')").pluck().all() as string[];
    const history = db.prepare('SELECT * FROM guess_round_cards ORDER BY room_id, round_number, code');
    const before = history.all();
    expect(started).toContain(playing.room.roomId);
    expect(settleOpenGuessRoomsForMaintenance(false)).toBe(started.length);
    expect((await request<GuessRoomView>(`/rooms/${waiting.room.roomId}`, waiting.token)).body)
      .toMatchObject({ phase: 'lobby', version: waiting.room.version });
    expect(settleOpenGuessRoomsForMaintenance()).toBe(open.length - started.length);
    expect(settleOpenGuessRoomsForMaintenance()).toBe(0);
    expect(history.all()).toEqual(before);
    const event = db.prepare('SELECT event_json FROM guess_room_events WHERE room_id = ? ORDER BY version DESC LIMIT 1').pluck();
    for (const roomId of open) expect(JSON.parse(event.get(roomId) as string)).toEqual({ action: 'finish', reason: 'maintenance' });
    const result = (await request<GuessRoomView>(`/rooms/${waiting.room.roomId}`, waiting.token)).body;
    expect(result).toMatchObject({ phase: 'finished', finishReason: 'maintenance', version: waiting.room.version + 1 });
  });

  it('allows only pool-scoped name searches and plain pagination in the Extreme pool', async () => {
    const pool = await createPool('Name-only pool', uniformCodes);
    const db = getDb();
    db.prepare('UPDATE guess_pools SET name_key = ? WHERE id = ?').run('builtin:test-browse', pool.poolId);
    try {
      const path = `/pools/${pool.poolId}/cards`;
      const all = (await request<GuessCardPage>(path)).body;
      expect(all).toMatchObject({ totalCount: 30, totalPages: 2, hasMore: true });
      expect(all.cards.map(({ code }) => code)).toEqual(uniformCodes.slice(0, 24));
      const next = (await request<GuessCardPage>(`${path}?page=1`)).body;
      expect(next.cards.map(({ code }) => code)).toEqual(uniformCodes.slice(24));
      expect(next).toMatchObject({ totalCount: 30, totalPages: 2, hasMore: false });
      const cards = app.get(CardsService);
      const name = cards.get(uniformCodes[0])!.name;
      const query = `q=${encodeURIComponent(`"${name}"`)}`;
      expect((await request<GuessCardPage>(`${path}?${query}`)).body.cards.map(({ code }) => code)).toEqual([uniformCodes[0]]);
      for (const term of [String(uniformCodes[0]), '测试用效果文本', `"${cards.get(outsideCode)!.name}"`]) {
        expect((await request<GuessCardPage>(`${path}?q=${encodeURIComponent(term)}`)).body.totalCount).toBe(0);
      }
      for (const filter of ['category=1', 'subtype=monster', 'atkMin=0', 'sort=attack']) {
        expect(await request(`${path}?${query}&${filter}`))
          .toEqual({ status: 400, body: { code: 'GUESS_POOL_BROWSE_ONLY' } });
      }
      const host = await create('Name-only host', pool.poolId);
      const roomPath = `/rooms/${host.room.roomId}`;
      const started = (await action(roomPath, host.token, { action: 'start', version: host.room.version })).body;
      const answer = db.prepare("SELECT json_extract(state_json, '$.round.seats[0].code') FROM guess_rooms WHERE room_id = ?")
        .pluck().get(host.room.roomId) as number;
      const scored = (await action(roomPath, host.token, { action: 'guess', version: started.version, code: answer })).body;
      await action(roomPath, host.token, { action: 'finish', version: scored.version });
      const answerQuery = encodeURIComponent(`"${cards.get(answer)!.name}"`);
      const result = (await request<GuessCardPage>(`${path}?q=${answerQuery}`)).body;
      expect(result.cards.find(({ code }) => code === answer)?.stats).toEqual({ appearances: 1, averageGuessTurns: 1 });
    } finally {
      db.prepare('UPDATE guess_pools SET name_key = ? WHERE id = ?').run('name:name-only pool', pool.poolId);
    }
  });

  it('promotes the newest complete default while preserving older pool IDs and members', async () => {
    const service = app.get(GuessPoolsService);
    const catalog = jest.spyOn(app.get(CardsService), 'poolCodes');
    const original = [...DEFAULT_GUESS_POOL_CODES];
    const shortlist = [...SHORTLIST_GUESS_POOL_CODES];
    const recency = [...RECENCY_GUESS_POOL_CODES];
    const expanded = EXPANDED_EXTREME_GUESS_POOL_CODES;
    try {
      catalog.mockReturnValue(original.filter((code) => code !== shortlist[0]));
      service.onModuleInit();
      expect(service.list().some((pool) => pool.isDefault)).toBe(false);
      const savedOriginal = getDb().prepare('INSERT INTO guess_pools (name, name_key, codes_json) VALUES (?, ?, ?)')
        .run('Fixture original', 'builtin:test-original', JSON.stringify(original));
      const originalId = Number(savedOriginal.lastInsertRowid);
      expect((await request<GuessPoolSummary>(`/pools/${originalId}`)).body.isDefault).toBe(true);
      service.onModuleInit();
      expect(service.list().filter((pool) => pool.isDefault).map((pool) => pool.poolId)).toEqual([originalId]);

      catalog.mockReturnValue(original);
      service.onModuleInit();
      const [savedShortlist] = service.list();
      expect(savedShortlist).toMatchObject({ name: 'Fixture short', cardCount: shortlist.length, isDefault: true });

      catalog.mockReturnValue([...new Set([...original, ...recency, ...expanded])]);
      service.onModuleInit();
      service.onModuleInit();
      const pools = (await request<GuessPoolSummary[]>('/pools')).body;
      const [selected] = pools;
      expect(pools.filter((pool) => pool.isDefault)).toEqual([selected]);
      expect(selected).toMatchObject({ name: 'Fixture recent', cardCount: recency.length, isDefault: true });
      expect(selected.poolId).not.toBe(originalId);
      expect(selected.poolId).not.toBe(savedShortlist.poolId);
      expect((await request<GuessPoolSummary>(`/pools/${selected.poolId}`)).body).toEqual(selected);
      expect(service.get(selected.poolId).codes).toEqual(recency);
      const extreme = pools.find((pool) => pool.name === 'Fixture browse')!;
      expect(extreme).toMatchObject({ cardCount: expanded.length, isDefault: false, browseOnly: true });
      expect((await request<GuessPoolSummary>(`/pools/${extreme.poolId}`)).body).toEqual(extreme);
      const browse = `/pools/${extreme.poolId}/cards`;
      expect((await request(`${browse}?page=1`)).status).toBe(200);
      expect((await request(`${browse}?q=测试`)).status).toBe(200);
      for (const query of ['subtype=monster', 'atkMin=0', 'sort=attack']) {
        expect(await request(`${browse}?${query}`)).toEqual({ status: 400, body: { code: 'GUESS_POOL_BROWSE_ONLY' } });
      }
      expect(extreme.poolId).not.toBe(selected.poolId);
      expect(service.get(extreme.poolId).codes).toEqual(expanded);
      expect(service.get(savedShortlist.poolId)).toEqual({
        poolId: savedShortlist.poolId, name: savedShortlist.name, codes: shortlist, isDefault: false, browseOnly: false,
      });
      expect(service.get(originalId)).toEqual({ poolId: originalId, name: 'Fixture original', codes: original, isDefault: false, browseOnly: false });
    } finally {
      catalog.mockRestore();
    }
  });
});

it.each([
  { key: 'builtin:test-recent', name: 'Fixture previous name', poolId: 4, isDefault: true, browseOnly: false },
  { key: 'builtin:test-browse', name: 'Fixture browse', poolId: 5, isDefault: false, browseOnly: true },
])('retains $key, its active round and completed-round statistics across restart', ({ key, name, poolId, isDefault, browseOnly }) => {
  useTestDb();
  const snapshot = () => ({
    pool: getDb().prepare('SELECT * FROM guess_pools WHERE id = ?').get(poolId),
    rooms: getDb().prepare('SELECT * FROM guess_rooms ORDER BY room_id').all(),
    events: getDb().prepare('SELECT * FROM guess_room_events ORDER BY room_id, version').all(),
    stats: getDb().prepare('SELECT * FROM guess_round_cards ORDER BY room_id, round_number, code').all(),
  });
  let restartedGame: GuessService | undefined;

  try {
    const cards = new CardsService();
    const codes = cards.poolCodes().slice(0, 2);
    getDb().prepare('INSERT INTO guess_pools (id, name, name_key, codes_json) VALUES (?, ?, ?, ?)')
      .run(poolId, name, key, JSON.stringify(codes));
    const game = new GuessService(cards, new GuessPoolsService(cards));
    const { room, token } = game.create({ name: 'Saved room', playerId: 'Host', poolId });
    const authorization = `Bearer ${token}`;
    const opened = game.act(room.roomId, authorization, { action: 'start', version: room.version })!;
    const answer = getDb().prepare("SELECT json_extract(state_json, '$.round.seats[0].code') FROM guess_rooms WHERE room_id = ?")
      .pluck().get(room.roomId) as number;
    const scored = game.act(room.roomId, authorization, { action: 'guess', version: opened.version, code: answer })!;
    const playing = game.act(room.roomId, authorization, { action: 'next', version: scored.version })!;
    expect(playing).toMatchObject({ phase: 'playing', round: 2, poolId, poolName: name });
    const before = snapshot();
    expect(before.stats).toEqual([{ room_id: room.roomId, round_number: 1, pool_id: poolId, code: answer, guess_turns: 1 }]);
    closeDb();

    const restartedCards = new CardsService();
    const eligible = [...new Set([...restartedCards.poolCodes(), ...RECENCY_GUESS_POOL_CODES, ...EXPANDED_EXTREME_GUESS_POOL_CODES])];
    jest.spyOn(restartedCards, 'poolCodes').mockReturnValue(eligible);
    const restartedPools = new GuessPoolsService(restartedCards);
    restartedGame = new GuessService(restartedCards, restartedPools);
    restartedPools.onModuleInit();
    restartedGame.onModuleInit();
    expect(restartedPools.describe(poolId)).toEqual({ poolId, name, cardCount: codes.length, isDefault, browseOnly });
    expect(restartedPools.list()).toContainEqual({ poolId, name, cardCount: codes.length, isDefault, browseOnly });
    expect(restartedPools.list().find((pool) => pool.name === 'Fixture browse'))
      .toMatchObject({ cardCount: browseOnly ? codes.length : EXPANDED_EXTREME_GUESS_POOL_CODES.length, browseOnly: true });
    expect(restartedGame.state(room.roomId, authorization)).toEqual(playing);
    expect(snapshot()).toEqual(before);
    const nextAfterRestart = restartedGame.act(room.roomId, authorization, { action: 'next', version: playing.version })!;
    expect(nextAfterRestart).toMatchObject({ phase: 'playing', round: 3 });
    expect(nextAfterRestart.viewerOpeningHint).toBeTruthy();
    expect(nextAfterRestart.viewerOpeningHint?.group).not.toBe(playing.viewerOpeningHint?.group);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  } finally {
    restartedGame?.onModuleDestroy();
    closeDb();
    for (const suffix of ['', '-wal', '-shm', '.pre-auth-migration.bak']) {
      fs.rmSync(config.server.dbPath + suffix, { force: true });
    }
  }
});

it.each([
  { previous: EXTREME_GUESS_POOL_CODES, answer: EXTREME_GUESS_POOL_CODES[0] },
  { previous: REVIEWED_EXTREME_GUESS_POOL_CODES, answer: REVIEWED_EXTREME_GUESS_POOL_CODES[0] },
])('updates an Extreme pool in place while a hintless round still uses its original cards', ({ previous, answer }) => {
  useTestDb();
  const gameCards = new CardsService();
  const extension = EXPANDED_EXTREME_GUESS_POOL_CODES;
  const added = extension.find((code) => !previous.includes(code))!;
  const poolId = 5;
  let game: GuessService | undefined;
  try {
    gameCards.poolCodes();
    const db = getDb();
    const insertCard = db.prepare('INSERT INTO cards (code, name, type, search_text) VALUES (?, ?, 1, ?)');
    db.transaction(() => {
      for (const code of new Set([...extension, answer])) {
        insertCard.run(code, `Card ${code}`, `card ${code}`);
      }
    })();
    const catalog = jest.spyOn(gameCards, 'poolCodes').mockReturnValue([answer]);
    db.prepare('INSERT INTO guess_pools (id, name, name_key, codes_json) VALUES (?, ?, ?, ?)')
      .run(poolId, 'Fixture browse', 'builtin:test-browse', JSON.stringify(previous));
    const pools = new GuessPoolsService(gameCards);
    game = new GuessService(gameCards, pools);
    const { room, token } = game.create({ name: 'Existing Extreme', playerId: 'Host', poolId, disableOpeningHints: true });
    const authorization = `Bearer ${token}`;
    const first = game.act(room.roomId, authorization, { action: 'start', version: room.version })!;
    const scored = game.act(room.roomId, authorization, { action: 'guess', version: first.version, code: answer })!;
    const active = game.act(room.roomId, authorization, { action: 'next', version: scored.version })!;
    const stats = db.prepare('SELECT * FROM guess_round_cards ORDER BY room_id, round_number, code');
    const previousStats = stats.all();
    const history = db.prepare('SELECT * FROM guess_room_events ORDER BY room_id, version');
    const previousHistory = history.all();

    catalog.mockReturnValue([answer, ...extension.filter((code) => code !== added)]);
    pools.onModuleInit();
    expect(pools.get(poolId).codes).toEqual(previous);
    catalog.mockReturnValue([...extension, answer]);
    pools.onModuleInit();
    pools.onModuleInit();
    expect(pools.list().filter(({ name }) => name === 'Fixture browse'))
      .toEqual([{ poolId, name: 'Fixture browse', cardCount: extension.length, isDefault: false, browseOnly: true }]);
    expect(pools.get(poolId).codes).toEqual(extension);
    expect(stats.all()).toEqual(previousStats);
    expect(history.all()).toEqual(previousHistory);
    expect(game.state(room.roomId, authorization)).toEqual(active);
    const query = { query: String(answer), page: 0, filters: {}, sort: 'relevance' as const };
    expect(game.search(room.roomId, authorization, query).cards.map(({ code }) => code)).toEqual([answer]);
    const newQuery = { ...query, query: String(added) };
    expect(game.search(room.roomId, authorization, newQuery).totalCount).toBe(0);
    const resolved = game.act(room.roomId, authorization, { action: 'guess', version: active.version, code: answer })!;
    game.act(room.roomId, authorization, { action: 'next', version: resolved.version });
    expect(game.search(room.roomId, authorization, newQuery).cards.map(({ code }) => code)).toEqual([added]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    game?.onModuleDestroy();
    closeDb();
    for (const suffix of ['', '-wal', '-shm', '.pre-auth-migration.bak']) {
      fs.rmSync(config.server.dbPath + suffix, { force: true });
    }
  }
});
