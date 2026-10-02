import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import fs from 'fs';
import { ApiController } from '../src/api.controller';
import { AdminController } from '../src/admin.controller';
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

describe('HTTP authorization follows matched route metadata', () => {
  let app: INestApplication, base: string, tid: number, target: number;
  let player: Record<string, string>, tournaments: TournamentsService, cards: CardsService;
  const creator = { 'x-create-user': 'owner', 'x-create-token': 'creator-fixture' };
  beforeAll(async () => {
    useTestDb();
    tournaments = makeTournaments(); cards = new CardsService();
    tid = tournaments.create({ name: 'source', maxPlayers: 4, cardPool: TEST_POOL }, 'owner').tid;
    target = tournaments.create({ name: 'target', maxPlayers: 4, cardPool: TEST_POOL }, 'other').tid;
    const { token } = tournaments.join(tid, 'alice', 'Alice');
    player = { 'x-tournament-id': String(tid), 'x-player-id': 'alice', 'x-token': token };
    getDb().prepare('INSERT INTO create_users(username,token_hash,created_at,active) VALUES(?,?,?,1)')
      .run('owner', sha256(creator['x-create-token']), new Date().toISOString());
    const module = await Test.createTestingModule({
      controllers: [AdminController, ApiController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: TournamentsService, useValue: tournaments },
        { provide: CardsService, useValue: cards },
        { provide: PoolsService, useValue: new PoolsService(cards) },
        ...[DraftService, DecksService, MatchesService, RealtimeService, CardPickStatsService]
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
});
