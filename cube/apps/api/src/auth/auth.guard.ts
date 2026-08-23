import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import crypto from 'crypto';
import { getDb } from '../db';
import { config } from '../config';

// Auth model (dev_docs/07 §2, §5.1):
// - player routes: three-factor tournamentId + playerId + token, unless the tournament
//   has token auth disabled by an admin (auth_required=false, for same-machine testing).
// - /admin/*: X-Admin-Token must be the super admin token (all tournaments + pools)
//   or the per-tournament admin token issued at creation (that tournament only).
// - POST /tournaments: requires X-Create-User + X-Create-Token or the super token.
export interface Identity {
  tournamentId: number;
  playerId: string;
  isAdmin: boolean;
  isSuper: boolean;
  createUsername?: string;
}

export interface AuthedRequest extends Request {
  identity?: Identity;
}

export const Public = () => SetMetadata('public', true);

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

interface PlayerRow {
  found: number;
}

interface TournamentRow {
  id: number;
  admin_token_hash: string | null;
  auth_required: number;
}

function tournamentRow(tid: number): TournamentRow | null {
  return (getDb().prepare('SELECT id, admin_token_hash, auth_required FROM tournaments WHERE id=?').get(tid) as TournamentRow | undefined) ?? null;
}

function headerValue(req: AuthedRequest, name: string): string | undefined {
  const v = req.headers[name];
  const raw = Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined;
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function headerToken(req: AuthedRequest): string | undefined {
  return headerValue(req, 'x-admin-token');
}

export function safeSecretEqual(value: string, expected: string): boolean {
  const left = crypto.createHash('sha256').update(value).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function safeHashEqual(value: string, expectedHash: string | null | undefined): boolean {
  if (!expectedHash || !/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(sha256(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}

export const CREATE_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function normalizeCreateUsername(value: unknown): string {
  if (typeof value !== 'string') throw new Error('BAD_CREATE_USERNAME');
  const username = value.trim().toLowerCase();
  if (!CREATE_USERNAME_PATTERN.test(username)) throw new Error('BAD_CREATE_USERNAME');
  return username;
}

function isSuper(token: string): boolean {
  return safeSecretEqual(token, config.admin.superToken);
}

function isTournamentAdmin(token: string, hash: string | null): boolean {
  return safeHashEqual(token, hash);
}

function isCreateUser(username: string, token: string): boolean {
  const row = getDb().prepare('SELECT token_hash FROM create_users WHERE username=? AND active=1').get(username) as { token_hash: string } | undefined;
  return !!row && safeHashEqual(token, row.token_hash);
}

function cookiesOf(req: AuthedRequest): Record<string, string> {
  return (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
}

export function extractIdentity(req: AuthedRequest): Identity | null {
  const cookies = cookiesOf(req);
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const pathTid = req.path.match(/^\/(?:admin\/)?t\/(\d+)/)?.[1];
  // header values must be ISO-8859-1; non-ASCII player ids are percent-encoded by the client
  const hget = (name: string): string | undefined => {
    const v = headers[name];
    if (Array.isArray(v)) return v[0];
    if (typeof v === 'string') {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
    return undefined;
  };
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v =
        (pathTid && k === 'yc_pid' ? cookies[`yc_pid_${pathTid}`] : undefined) ??
        (pathTid && k === 'yc_token' ? cookies[`yc_token_${pathTid}`] : undefined) ??
        cookies[k] ??
        hget(`x-${k.replace('yc_', '').replace('tid', 'tournament-id').replace('pid', 'player-id')}`) ??
        hget(k) ??
        (req.query as Record<string, string>)[k] ??
        (req.body as Record<string, string> | undefined)?.[k];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };
  // Tournament routes carry the authoritative id in the path. Scoped cookies
  // intentionally omit the legacy global yc_tid cookie so concurrent browser
  // tabs for different tournaments cannot overwrite one another.
  const tid = pathTid ?? get('yc_tid', 'tid');
  const pid = get('yc_pid', 'pid');
  const token = get('yc_token', 'token');
  if (!tid || !pid || !token) return null;
  const tournamentId = Number(tid);
  if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) return null;
  // super admin token doubles as a universal player token (dev_docs/07 §2.1)
  if (isSuper(token)) {
    return { tournamentId, playerId: pid, isAdmin: false, isSuper: true };
  }
  const row = getDb()
    .prepare('SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=? AND active=1')
    .get(tournamentId, pid) as { token_hash: string } | undefined;
  if (!row || !safeHashEqual(token, row.token_hash)) return null;
  return { tournamentId, playerId: pid, isAdmin: false, isSuper: false };
}

export function extractTournamentId(req: AuthedRequest): number | null {
  const m = req.path.match(/^\/(?:admin\/)?t\/(\d+)/);
  if (m) return Number(m[1]);
  const v =
    (req.query as Record<string, string>).tid ??
    (req.body as Record<string, string> | undefined)?.tid ??
    (req.headers['x-tournament-id'] as string | undefined);
  if (v !== undefined) {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    if (req.path.startsWith('/admin')) {
      const token = headerToken(req);
      if (!token) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['admin_token'] });
      if (isSuper(token)) {
        req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: true };
        return true;
      }
      const tid = extractTournamentId(req);
      if (tid === null) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['admin_token'] });
      const row = tournamentRow(tid);
      if (!row || !isTournamentAdmin(token, row.admin_token_hash)) {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['admin_token'] });
      }
      req.identity = { tournamentId: tid, playerId: '', isAdmin: true, isSuper: false };
      return true;
    }

    if (req.path === '/tournaments' && req.method === 'POST') {
      // The super token remains a backwards-compatible direct create credential;
      // regular create users must use the dedicated create headers.
      const createToken = headerValue(req, 'x-create-token');
      const adminToken = headerValue(req, 'x-admin-token');
      const token = createToken ?? adminToken;
      if (!token) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user', 'create_token'] });
      if (isSuper(token)) {
        req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: true, createUsername: 'super-admin' };
        return true;
      }
      // A non-super credential is accepted only in the dedicated create-token
      // header. X-Admin-Token is reserved for tournament administration and
      // must never become an accidental second create-user header.
      if (!createToken) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_token'] });
      const rawUsername = headerValue(req, 'x-create-user');
      let username: string;
      try {
        username = normalizeCreateUsername(rawUsername);
      } catch {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user'] });
      }
      if (!isCreateUser(username, token)) {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user', 'create_token'] });
      }
      req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: false, createUsername: username };
      return true;
    }

    const tid = extractTournamentId(req);
    if (tid !== null) {
      const row = tournamentRow(tid);
      if (row && row.auth_required === 0) {
        const cookies = cookiesOf(req);
        const rawPid =
          headerValue(req, 'x-player-id') ??
          cookies[`yc_pid_${tid}`] ??
          cookies.yc_pid ??
          (req.query as Record<string, string>).pid ??
          (req.body as Record<string, string> | undefined)?.pid;
        let pid = rawPid;
        if (typeof pid === 'string') {
          try {
            pid = decodeURIComponent(pid);
          } catch {
            // keep as-is when not percent-encoded
          }
        }
        if (!pid) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['pid'] });
        const player = getDb()
          .prepare('SELECT 1 AS found FROM tournament_players WHERE tournament_id=? AND player_id=? AND active=1')
          .get(tid, pid) as PlayerRow | undefined;
        if (!player) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['pid'] });
        req.identity = { tournamentId: tid, playerId: pid, isAdmin: false, isSuper: false };
        return true;
      }
    }

    const identity = extractIdentity(req);
    if (!identity) {
      const body = req.body as Record<string, unknown> | undefined;
      const cookies = cookiesOf(req);
      const pathTid = req.path.match(/^\/(?:admin\/)?t\/(\d+)/)?.[1];
      const fields: string[] = [];
      if (!pathTid && !cookies.yc_tid && !req.query.tid && !body?.tid) fields.push('tid');
      if (!(pathTid && cookies[`yc_pid_${pathTid}`]) && !cookies.yc_pid && !req.query.pid && !body?.pid) fields.push('pid');
      if (!(pathTid && cookies[`yc_token_${pathTid}`]) && !cookies.yc_token && !req.query.token && !body?.token) fields.push('token');
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields });
    }
    req.identity = identity;
    return true;
  }
}
