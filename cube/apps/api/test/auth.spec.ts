import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { config } from '../src/config';
import { AuthGuard } from '../src/auth/auth.guard';
import { Reflector } from '@nestjs/core';
import { getDb } from '../src/db';

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
    expect(guard.canActivate(makeCtx('/tournaments', { 'x-create-token': config.admin.createToken }, {}, {}, 'POST'))).toBe(true);
    expect(guard.canActivate(makeCtx('/tournaments', { 'x-admin-token': config.admin.superToken }, {}, {}, 'POST'))).toBe(true);
  });

  it('per-tournament admin token manages only its own tournament', () => {
    const tournaments = makeTournaments();
    const t1 = tournaments.create({ name: 'a', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    const t2 = tournaments.create({ name: 'b', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    const guard = new AuthGuard(new Reflector());
    expect(guard.canActivate(makeCtx(`/admin/t/${t1.tid}/state`, { 'x-admin-token': t1.admin_token }))).toBe(true);
    expectUnauthorized(() => guard.canActivate(makeCtx(`/admin/t/${t2.tid}/state`, { 'x-admin-token': t1.admin_token })));
    expect(guard.canActivate(makeCtx(`/admin/t/${t2.tid}/state`, { 'x-admin-token': config.admin.superToken }))).toBe(true);
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
    tournaments.setAuthRequired(t.tid, true, 'test');
    expectUnauthorized(() => guard.canActivate(makeCtx(`/t/${t.tid}/state`, { 'x-player-id': 'alice' })));
  });

  it('creation returns a unique admin token, stored hashed', () => {
    const tournaments = makeTournaments();
    const t1 = tournaments.create({ name: 'd', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    const t2 = tournaments.create({ name: 'e', maxPlayers: 3, cardPool: TEST_POOL }, 'test');
    expect(t1.admin_token).toBeTruthy();
    expect(t1.admin_token).not.toBe(t2.admin_token);
    const row = getDb().prepare('SELECT admin_token_hash FROM tournaments WHERE id=?').get(t1.tid) as { admin_token_hash: string };
    const { sha256 } = require('../src/auth/auth.guard');
    expect(row.admin_token_hash).toBe(sha256(t1.admin_token));
  });
});
