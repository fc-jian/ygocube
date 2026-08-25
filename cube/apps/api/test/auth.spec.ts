import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { config } from '../src/config';
import { AuthGuard, sha256 } from '../src/auth/auth.guard';
import { Reflector } from '@nestjs/core';
import { getDb } from '../src/db';
import { AdminController } from '../src/admin.controller';
import { CardsService } from '../src/cards/cards.service';
import { PoolsService } from '../src/pools/pools.service';

function makeCtx(path: string, headers: Record<string, string>, query: Record<string, string> = {}, body: Record<string, unknown> = {}, method = 'GET') {
  const req: any = {
    path,
    headers,
    query,
    body,
    method,
    cookies: {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

function expectUnauthorized(fn: () => boolean): void {
  try {
    fn();
    fail('expected UnauthorizedException');
  } catch (e: any) {
    expect(e.response?.code ?? e.message).toBe('AUTH_REQUIRED');
  }
}

function expectCode(fn: () => boolean, code: string): void {
  try {
    fn();
    fail(`expected ${code}`);
  } catch (e: any) {
    expect(e.response?.code ?? e.message).toBe(code);
  }
}

describe('auth model', () => {
  beforeEach(() => useTestDb());

  it('player triple still required on player routes', () => {
    const tournaments = makeTournaments();
    const tid = tournaments.create({ name: 'a', maxPlayers: 3, cardPool: TEST_POOL }, 'test').tid;
    tournaments.join(tid, 'alice', 'Alice');
    const guard = new AuthGuard(new Reflector());
    expectUnauthorized(() => guard.canActivate(makeCtx(`/t/${tid}/state`, {})));
  });

  it('create tournament requires create token or super token', () => {
    const guard = new AuthGuard(new Reflector());
    expectUnauthorized(() => guard.canActivate(makeCtx('/tournaments', {}, {}, {})));
    expectUnauthorized(() => guard.canActivate(makeCtx('/tournaments', { 'x-create-token': 'wrong' }, {}, {})));
    const { sha256 } = require('../src/auth/auth.guard');
    getDb().prepare('INSERT INTO create_users (username, token_hash, created_at, active) VALUES (?,?,?,1)')
      .run('creator', sha256('create-secret'), new Date().toISOString());
    expect(guard.canActivate(makeCtx('/tournaments', { 'x-create-user': 'creator', 'x-create-token': 'create-secret' }, {}, {}, 'POST'))).toBe(true);
    expectUnauthorized(() => guard.canActivate(makeCtx('/tournaments', { 'x-create-user': 'creator', 'x-create-token': 'wrong' }, {}, {}, 'POST')));
    expect(guard.canActivate(makeCtx('/tournaments', { 'x-admin-token': config.admin.superToken }, {}, {}, 'POST'))).toBe(true);
  });

  it('super admin can create and revoke hashed create users', () => {
    const controller = new AdminController(null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any);
    const req: any = { identity: { isSuper: true } };
    const created = controller.createUser(req, { username: 'Alice.Creator' });
    expect(created.username).toBe('alice.creator');
    expect(created.create_token).toBeTruthy();
    const row = getDb().prepare('SELECT token_hash FROM create_users WHERE username=?').get(created.username) as { token_hash: string };
    expect(row.token_hash).not.toBe(created.create_token);
    const guard = new AuthGuard(new Reflector());
    expect(guard.canActivate(makeCtx('/tournaments', { 'x-create-user': 'ALICE.CREATOR', 'x-create-token': created.create_token }, {}, {}, 'POST'))).toBe(true);
    const rotated = controller.rotateCreateUserToken(req, 'ALICE.CREATOR');
    expect(rotated.create_token).toBeTruthy();
    expectUnauthorized(() => guard.canActivate(makeCtx('/tournaments', { 'x-create-user': 'alice.creator', 'x-create-token': created.create_token }, {}, {}, 'POST')));
    expect(guard.canActivate(makeCtx('/tournaments', { 'x-create-user': 'alice.creator', 'x-create-token': rotated.create_token }, {}, {}, 'POST'))).toBe(true);
    controller.removeCreateUser(req, 'ALICE.CREATOR');
    expectUnauthorized(() => guard.canActivate(makeCtx('/tournaments', { 'x-create-user': 'alice.creator', 'x-create-token': rotated.create_token }, {}, {}, 'POST')));
  });

  it('creator credentials manage only tournaments owned by that creator', () => {
    const tournaments = makeTournaments();
    getDb().prepare('INSERT INTO create_users (username, token_hash, created_at, active) VALUES (?,?,?,1)')
      .run('creator', sha256('creator-secret'), new Date().toISOString());
    getDb().prepare('INSERT INTO create_users (username, token_hash, created_at, active) VALUES (?,?,?,1)')
      .run('other', sha256('other-secret'), new Date().toISOString());
    const t1 = tournaments.create({ name: 'a', maxPlayers: 3, cardPool: TEST_POOL }, 'creator');
    const t2 = tournaments.create({ name: 'b', maxPlayers: 3, cardPool: TEST_POOL }, 'other');
    const guard = new AuthGuard(new Reflector());
    const creatorHeaders = { 'x-create-user': 'creator', 'x-create-token': 'creator-secret' };
    expect(guard.canActivate(makeCtx(`/admin/t/${t1.tid}/state`, creatorHeaders))).toBe(true);
    expect(guard.canActivate(makeCtx(`/admin/t/${t1.tid}/pools`, creatorHeaders))).toBe(true);
    expectCode(() => guard.canActivate(makeCtx(`/admin/t/${t2.tid}/state`, creatorHeaders)), 'FORBIDDEN');
    expectCode(() => guard.canActivate(makeCtx(`/admin/t/${t2.tid}/pools`, creatorHeaders)), 'FORBIDDEN');
    expect(guard.canActivate(makeCtx('/admin/mine/tournaments', creatorHeaders))).toBe(true);
    expectCode(() => guard.canActivate(makeCtx('/admin/tournaments', creatorHeaders)), 'AUTH_REQUIRED');
    expectCode(() => guard.canActivate(makeCtx(`/admin/t/${t1.tid}/state`, { 'x-admin-token': 'legacy-token' })), 'ADMIN_TOKEN_REMOVED');
    expect(guard.canActivate(makeCtx(`/admin/t/${t2.tid}/state`, { 'x-admin-token': config.admin.superToken }))).toBe(true);
    getDb().prepare('UPDATE create_users SET token_hash=? WHERE username=?').run(sha256('rotated'), 'creator');
    expectCode(() => guard.canActivate(makeCtx(`/admin/t/${t1.tid}/state`, creatorHeaders)), 'AUTH_REQUIRED');
    expect(guard.canActivate(makeCtx(`/admin/t/${t1.tid}/state`, { 'x-create-user': 'creator', 'x-create-token': 'rotated' }))).toBe(true);
  });

  it('scoped tournament admins can read all pools but cannot mutate them', () => {
    const tournaments = makeTournaments();
    const created = tournaments.create({ name: 'pool-view', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    const pools = new PoolsService(new CardsService());
    pools.create('visible-pool', new CardsService().poolCodes().slice(0, 2));
    const controller = new AdminController(null as any, null as any, null as any, null as any, pools, null as any, null as any);
    const scopedReq = { identity: { isSuper: false, tournamentId: created.tid } } as any;
    const scoped = controller.listTournamentPools(scopedReq, String(created.tid));
    expect(scoped.canEdit).toBe(false);
    expect(scoped.pools.some((pool: any) => pool.name === 'visible-pool')).toBe(true);
    expect(() => controller.createPool(scopedReq, { name: 'blocked', codes: [1] })).toThrow('FORBIDDEN');

    const superReq = { identity: { isSuper: true, tournamentId: 0 } } as any;
    expect(controller.listTournamentPools(superReq, String(created.tid)).canEdit).toBe(true);
  });

  it('auth_required=false skips token check but still needs pid', () => {
    const tournaments = makeTournaments();
    const t = tournaments.create({ name: 'c', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    tournaments.join(t.tid, 'alice', 'Alice');
    tournaments.setAuthRequired(t.tid, false, 'test');
    const guard = new AuthGuard(new Reflector());
    const ctx = makeCtx(`/t/${t.tid}/state`, { 'x-player-id': 'alice' });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(ctx.switchToHttp().getRequest().identity.playerId).toBe('alice');
    expectUnauthorized(() => guard.canActivate(makeCtx(`/t/${t.tid}/state`, {})));
    expectUnauthorized(() => guard.canActivate(makeCtx(`/t/${t.tid}/state`, { 'x-player-id': 'unknown' })));
    tournaments.setAuthRequired(t.tid, true, 'test');
    expectUnauthorized(() => guard.canActivate(makeCtx(`/t/${t.tid}/state`, { 'x-player-id': 'alice' })));
  });

  it('accepts tournament-scoped cookies without exposing the token in an SSE URL', () => {
    const tournaments = makeTournaments();
    const created = tournaments.create({ name: 'scoped-cookie', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    const player = tournaments.join(created.tid, 'alice', 'Alice');
    const ctx = makeCtx(`/t/${created.tid}/events`, {});
    const request = ctx.switchToHttp().getRequest();
    request.cookies = {
      [`yc_pid_${created.tid}`]: 'alice',
      [`yc_token_${created.tid}`]: player.token,
    };
    expect(new AuthGuard(new Reflector()).canActivate(ctx)).toBe(true);
    expect(request.identity.playerId).toBe('alice');
  });

  it('creation records creator and does not issue a tournament admin token', () => {
    const tournaments = makeTournaments();
    const t1 = tournaments.create({ name: 'd', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    const t2 = tournaments.create({ name: 'e', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    expect(t1.created_by).toBe('test');
    expect(t1).not.toHaveProperty('admin_token');
    expect(t2).not.toHaveProperty('admin_token');
    const row = getDb().prepare('SELECT admin_token_hash FROM tournaments WHERE id=?').get(t1.tid) as { admin_token_hash: string };
    expect(row.admin_token_hash).toBeNull();
  });

  it('rejects legacy tournament admin tokens even if an old database still contains a hash', () => {
    const tournaments = makeTournaments();
    const created = tournaments.create({ name: 'legacy-admin', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    getDb().prepare('UPDATE tournaments SET admin_token_hash=? WHERE id=?').run(sha256('old-admin'), created.tid);
    const guard = new AuthGuard(new Reflector());
    expectCode(() => guard.canActivate(makeCtx(`/admin/t/${created.tid}/state`, { 'x-admin-token': 'old-admin' })), 'ADMIN_TOKEN_REMOVED');
  });
});
