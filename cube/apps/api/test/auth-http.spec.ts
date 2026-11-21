import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import fs from 'fs';
import { ApiController } from '../src/api.controller';
import { AdminController } from '../src/admin.controller';
import { DuelController } from '../src/duel/duel.controller';
import { DuelService } from '../src/duel/duel.service';
import { AuthGuard, sha256 } from '../src/auth/auth.guard';
import { CardsService } from '../src/cards/cards.service';
import { CardPickStatsService } from '../src/cards/card-pick-stats.service';
import { PoolsService } from '../src/pools/pools.service';
import { TournamentsService } from '../src/tournaments/tournaments.service';
import { DraftService } from '../src/draft/draft.service';
import { DecksService } from '../src/decks/decks.service';
import { MatchesService } from '../src/matches/matches.service';
import { RealtimeService } from '../src/realtime/realtime.service';
import { getDb, closeDb } from '../src/db';
import { config } from '../src/config';
import { makeTournaments, TEST_POOL, useTestDb } from './helpers';
import { getConfig, hardRevertTo, loadState, logEvent, resetStateCache } from '../src/events/events.service';

describe('HTTP authorization follows matched route metadata', () => {
  let app: INestApplication, base: string, tid: number, target: number;
  let player: Record<string, string>, tournaments: TournamentsService, cards: CardsService;
  const creator = { 'x-create-user': 'owner', 'x-create-token': 'creator-fixture' };
  const deleteReplay = jest.fn(() => ({ ok: true }));
  beforeAll(async () => {
    useTestDb();
    tournaments = makeTournaments(); cards = new CardsService();
    tid = tournaments.create({ name: 'source', maxPlayers: 4, cardPool: TEST_POOL }, 'owner').tid;
    target = tournaments.create({ name: 'target', maxPlayers: 4, cardPool: TEST_POOL }, 'other').tid;
    const { token } = tournaments.join(tid, 'alice', 'Alice');
    player = { 'x-tournament-id': String(tid), 'x-player-id': 'alice', 'x-token': token };
    getDb().prepare('INSERT INTO create_users(username,token_hash,created_at,active) VALUES(?,?,?,1)')
      .run('owner', sha256(creator['x-create-token']), new Date().toISOString());
    const pools = new PoolsService(cards);
    const draft = new DraftService(cards, tournaments, pools, new MatchesService());
    const module = await Test.createTestingModule({
      controllers: [AdminController, ApiController, DuelController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: TournamentsService, useValue: tournaments },
        { provide: CardsService, useValue: cards },
        { provide: PoolsService, useValue: pools },
        { provide: DuelService, useValue: { deleteReplay } },
        { provide: DraftService, useValue: { review: draft.review.bind(draft) } },
        { provide: DecksService, useValue: new DecksService(cards) },
        ...[MatchesService, RealtimeService, CardPickStatsService]
          .map(provide => ({ provide, useValue: {} })),
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.server.dbPath + suffix, { force: true });
  });
  async function post(path: string, headers: Record<string, string>, body: unknown) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await response.arrayBuffer();
    return response.status;
  }
  it('returns only the authenticated participant’s hands and deck checks through the player routes', async () => {
    const game = tournaments.create({ name: 'personal review', maxPlayers: 2, cardPool: TEST_POOL }, 'owner').tid;
    const headers = (pid: string, token: string) => ({ 'x-tournament-id': String(game), 'x-player-id': pid, 'x-token': token });
    const alice = tournaments.join(game, 'A', 'A').token;
    const bob = tournaments.join(game, 'B', 'B').token;
    const url = `${base}/t/${game}/draft-review`;
    logEvent(game, 'pack', 'packs_created', { packs: [{ index: 0, size: 2, order: [10001, 10002], dropCard: null }] }, 'test');
    for (const [pid, code] of [['B', 10001], ['A', 10002]] as const) {
      logEvent(game, 'pick', 'pick', { playerId: pid, card: code, packIndex: 0, auto: false }, 'test');
    }
    logEvent(game, 'phase', 'phase', { status: 'deckbuilding' }, 'test');
    const building = await fetch(`${base}/t/${game}/state`, { headers: headers('A', alice) });
    expect(await building.json()).toMatchObject({ deckIssues: [expect.objectContaining({ reason: 'too-few', zone: 'main' })] });
    logEvent(game, 'phase', 'phase', { status: 'finished' }, 'test');
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: headers('B', alice) })).status).toBe(401);
    const first = await fetch(url + '?pid=B', { headers: headers('A', alice) });
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(await first.json()).toEqual({ hands: [{ packIndex: 0, cards: [10002], selected: [10002], auto: false }],
      names: { '10002': expect.any(String) } });
    const second = await fetch(url, { headers: headers('B', bob) });
    expect(await second.json()).toMatchObject({ hands: [{ cards: [10001, 10002], selected: [10001] }] });
  });

  it('serves a compact admin poll and scopes history to the authorized tournament and selection', async () => {
    const id = tournaments.create({ name: 'admin history', maxPlayers: 4, cardPool: TEST_POOL }, 'owner').tid;
    for (const pid of ['A +', 'B']) tournaments.join(id, pid, pid);
    const packs = [[10001, 10002], [10003, 10004]].map((order, index) => ({ index, size: 2, order, dropCard: null }));
    logEvent(id, 'pack', 'packs_created', { packs }, 'test');
    for (const [packIndex, playerId] of [[0, 'A +'], [1, 'B']] as const) {
      logEvent(id, 'pick', 'pick', { packIndex, playerId, card: packs[packIndex].order[0], round: 1, auto: false, at: '2026-01-01' }, playerId);
    }
    logEvent(id, 'match', 'match', { id: 1, tableNo: 1, round: 1, playerA: 'A +', playerB: 'B', playerAPass: 'private-a', playerBPass: 'private-b' }, 'test');
    const root = `${base}/admin/t/${id}`;
    const state = async (body: object) => (await fetch(root + '/state', {
      method: 'POST', headers: { ...creator, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    const full = await state({});
    expect(full.packs).toEqual(packs);
    expect(full.picks).toHaveLength(2);
    expect(full).toHaveProperty('decks');
    const summary = await state({ view: 'summary' });
    expect(summary).toMatchObject({ packSummary: [{ index: 0, size: 2 }, { index: 1, size: 2 }],
      pickSummary: [{ playerId: 'A +', count: 1, lockedAt: null }, { playerId: 'B', count: 1, lockedAt: null }], lastEventSeq: expect.any(Number) });
    for (const key of ['picks', 'packs', 'decks', 'packQueues', 'droppedCards']) expect(summary).not.toHaveProperty(key);
    expect(JSON.stringify(summary)).not.toContain('private-');
    const history = root + '/draft-history';
    const get = (url: string, headers = creator as Record<string, string>) => fetch(url, { headers });
    expect(await (await get(history + '?pack=0')).json()).toMatchObject({ pack: packs[0], picks: [{ playerId: 'A +', card: 10001 }] });
    const personal = await (await get(history + '?player=A%20%2B')).json();
    expect(personal.picks).toHaveLength(1);
    expect(personal).not.toHaveProperty('pack');
    for (const query of ['', '?pack=-1', '?pack=0&player=B', '?pack=0&pack=1', '?player=']) {
      expect((await get(history + query)).status).toBe(400);
    }
    expect((await get(history + '?pack=2')).status).toBe(404);
    expect((await get(history + '?player=unknown')).status).toBe(404);
    expect((await get(history + '?pack=0', {})).status).toBe(401);
    expect((await get(`${base}/admin/t/${target}/draft-history?pack=0`)).status).toBe(403);
  });

  it('preserves literal percent escapes in player headers and administrator routes', async () => {
    const id = tournaments.create({ name: 'encoded player', maxPlayers: 3, cardPool: TEST_POOL }, 'owner').tid;
    for (const pid of ['A B', 'A%20B']) tournaments.join(id, pid, pid);
    tournaments.setAuthRequired(id, false, 'owner');
    const pid = 'A%20B';
    const headers = { 'x-player-id': encodeURIComponent(pid) };
    expect(await post(`/t/${id}/player/ready`, headers, { ready: true })).toBe(201);
    expect(loadState(id).players.find(p => p.playerId === pid)?.ready).toBe(true);
    expect(loadState(id).players.find(p => p.playerId === 'A B')?.ready).toBeFalsy();
    for (const action of ['withdraw', 'restore']) {
      expect(await post(`/admin/t/${id}/players/${encodeURIComponent(pid)}/${action}`, creator, {})).toBe(201);
      expect(loadState(id).players.find(p => p.playerId === pid)?.withdrawn === true).toBe(action === 'withdraw');
      expect(loadState(id).players.find(p => p.playerId === 'A B')?.withdrawn).toBeFalsy();
    }
  });

  it.each(['admin', 'Admin', 'ADMIN'])('rejects player administration using %s and a conflicting tournament header', async prefix => {
    for (const suffix of ['', '/']) {
      expect(await post(`/${prefix}/t/${target}/security${suffix}`, player, { require_token: false })).toBe(401);
      expect(await post(`/${prefix}/t/${target}/security${suffix}`, { ...creator, 'x-tournament-id': String(tid) }, { require_token: false })).toBe(403);
    }
    expect((getDb().prepare('SELECT auth_required FROM tournaments WHERE id=?').get(target) as any).auth_required).toBe(1);
  });
  it('allows a creator only on their matched tournament and revokes rotated credentials', async () => {
    expect(await post(`/Admin/T/${tid}/security/`, creator, { require_token: true })).toBe(201);
    getDb().prepare('UPDATE create_users SET token_hash=? WHERE username=?').run(sha256('rotated'), 'owner');
    expect(await post(`/Admin/t/${tid}/security`, creator, { require_token: false })).toBe(401);
    getDb().prepare('UPDATE create_users SET token_hash=? WHERE username=?').run(sha256(creator['x-create-token']), 'owner');
  });
  it.each(['/tournaments', '/tournaments/', '/Tournaments/'])('requires creator credentials for %s even when player auth is disabled', async path => {
    tournaments.setAuthRequired(tid, false, 'test');
    const body = { name: 'creation', maxPlayers: 4, cardPool: TEST_POOL };
    expect(await post(path, { ...player, 'x-token': '' }, body)).toBe(401);
    expect(await post(path, player, body)).toBe(401);
    expect(await post(path, creator, body)).toBe(201);
  });
  it.each(['pools', 'Pools', 'POOLS'])('requires a real player token for %s candidate writes', async prefix => {
    const pools = new PoolsService(cards);
    const name = `http-candidate-${prefix.toLowerCase()}-${prefix.length}-${prefix}`.toLowerCase();
    if (!pools.getByName(name)) pools.create(name, [cards.allCodes()[0]]);
    for (const suffix of ['', '/']) {
      const path = `/${prefix}/${name}/candidate/cards${suffix}`, body = { codes: [cards.allCodes()[1]] };
      expect(await post(path, { ...player, 'x-token': '' }, body)).toBe(401);
      expect(await post(path, { ...player, 'x-token': config.admin.superToken }, body)).toBe(401);
      expect(await post(path, player, body)).toBe(201);
    }
  });

  it.each([true, false])('enforces the replay deletion role matrix with player token auth %s', async required => {
    tournaments.setAuthRequired(tid, required, 'test');
    const cases: { label: string; headers: Record<string, string>; tournamentId: number; status: number }[] = [
      { label: 'anonymous', headers: {}, tournamentId: tid, status: 401 },
      { label: 'player', headers: player, tournamentId: tid, status: 401 },
      { label: 'player without token', headers: { 'x-player-id': 'alice' }, tournamentId: tid, status: 401 },
      { label: 'super token in player identity', headers: { ...player, 'x-token': config.admin.superToken }, tournamentId: tid, status: 401 },
      { label: 'invalid admin', headers: { 'x-admin-token': 'invalid' }, tournamentId: tid, status: 401 },
      { label: 'invalid creator', headers: { ...creator, 'x-create-token': 'invalid' }, tournamentId: tid, status: 401 },
      { label: 'owner', headers: creator, tournamentId: tid, status: 201 },
      { label: 'other tournament creator', headers: { ...creator, 'x-tournament-id': String(tid) }, tournamentId: target, status: 403 },
      { label: 'super admin', headers: { 'x-admin-token': config.admin.superToken }, tournamentId: target, status: 201 },
    ];
    for (const prefix of ['admin', 'Admin', 'ADMIN']) {
      for (const suffix of ['', '/']) {
        for (const scenario of cases) {
          deleteReplay.mockClear();
          const status = await post(`/${prefix}/t/${scenario.tournamentId}/matches/42/replay/delete${suffix}`, scenario.headers, {});
          expect({ role: scenario.label, status }).toEqual({ role: scenario.label, status: scenario.status });
          if (scenario.status === 201) expect(deleteReplay).toHaveBeenCalledWith(scenario.tournamentId, 42);
          else expect(deleteReplay).not.toHaveBeenCalled();
        }
      }
    }
  });

  it.each([undefined, true, false])('restores effective player authorization after reverting to authRequired=%s', async required => {
    const revertTid = tournaments.create({ name: 'revert-auth', maxPlayers: 2, cardPool: TEST_POOL }, 'owner').tid;
    const { token } = tournaments.join(revertTid, 'alice', 'Alice');
    if (required !== undefined) tournaments.setAuthRequired(revertTid, required, 'test');
    const seq = (getDb().prepare('SELECT MAX(seq) AS seq FROM events WHERE tournament_id=?').get(revertTid) as { seq: number }).seq;
    const expectedRequired = required !== false;
    tournaments.setAuthRequired(revertTid, !expectedRequired, 'test');
    hardRevertTo(revertTid, seq, 'test');
    resetStateCache();
    expect(getConfig(loadState(revertTid)).authRequired !== false).toBe(expectedRequired);
    expect(tournaments.get(revertTid).authRequired).toBe(expectedRequired);
    for (const credential of [undefined, 'invalid', token]) {
      const response = await fetch(`${base}/t/${revertTid}/state`, {
        headers: { 'x-player-id': 'alice', ...(credential === undefined ? {} : { 'x-token': credential }) },
      });
      expect(response.status).toBe(expectedRequired && credential !== token ? 401 : 200);
      await response.arrayBuffer();
    }
  });
});
