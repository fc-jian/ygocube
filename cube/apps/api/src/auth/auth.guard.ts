import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import crypto from 'crypto';
import { getDb } from '../db';
import { config } from '../config';

// Auth model (dev_docs/07 §2, §5.1):
// - player routes: three-factor tournamentId + playerId + token, unless the tournament
//   has token auth disabled by an admin (auth_required=false, for same-machine testing).
// - /admin/*: X-Admin-Token is reserved for the super admin. Scoped tournament
//   administration uses the creator's X-Create-User + X-Create-Token pair.
// - POST /tournaments: requires X-Create-User + X-Create-Token or the super token.
export interface Identity {
  tournamentId: number;
  playerId: string;
  isAdmin: boolean;
  isSuper: boolean;
  /** A creator identity is scoped to the tournamentId it owns. */
  isCreator?: boolean;
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
  created_by: string | null;
  auth_required: number;
}

function tournamentRow(tid: number): TournamentRow | null {
  return (getDb().prepare('SELECT id, created_by, auth_required FROM tournaments WHERE id=?').get(tid) as TournamentRow | undefined) ?? null;
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
// Express accepts an optional trailing slash by default. Keep both spellings
// under the strict candidate-write policy so `/.../cards/` cannot fall into
// the tournament's no-token testing bypass.
const CANDIDATE_WRITE_PATH = /^\/pools\/[^/]+\/candidate\/cards\/?$/;

export function normalizeCreateUsername(value: unknown): string {
  if (typeof value !== 'string') throw new Error('BAD_CREATE_USERNAME');
  const username = value.trim().toLowerCase();
  if (!CREATE_USERNAME_PATTERN.test(username)) throw new Error('BAD_CREATE_USERNAME');
  return username;
}

function isSuper(token: string): boolean {
  return safeSecretEqual(token, config.admin.superToken);
}

function isCreateUser(username: string, token: string): boolean {
  const row = getDb().prepare('SELECT token_hash FROM create_users WHERE username=? AND active=1').get(username) as { token_hash: string } | undefined;
  return !!row && safeHashEqual(token, row.token_hash);
}

function cookiesOf(req: AuthedRequest): Record<string, string> {
  return (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
}

function queryScalar(req: AuthedRequest, key: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function extractIdentity(req: AuthedRequest): Identity | null {
  const cookies = cookiesOf(req);
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const pathTid = req.path.match(/^\/(?:admin\/)?t\/(\d+)(?:\/|$)/)?.[1];
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
        // Authentication material must never be accepted from a request body:
        // body fields are attacker-controlled application data and are easy to
        // confuse with an actor supplied by a client. Query parameters remain
        // supported only for legacy non-secret ids; tokens come from headers or
        // cookies below.
        (k === 'yc_token' || k === 'token' ? undefined : queryScalar(req, k));
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };
  // Tournament routes carry the authoritative id in the path. Scoped cookies
  // intentionally omit the legacy global yc_tid cookie so concurrent browser
  // tabs for different tournaments cannot overwrite one another.
  const tid = pathTid ?? get('yc_tid', 'tid');
  const pid = get('yc_pid', 'pid');
  const token =
    (pathTid ? cookies[`yc_token_${pathTid}`] : undefined) ??
    cookies.yc_token ??
    hget('x-token') ??
    hget('token');
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
  const m = req.path.match(/^\/(?:admin\/)?t\/(\d+)(?:\/|$)/);
  if (m) {
    const parsed = Number(m[1]);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  const v =
    queryScalar(req, 'tid') ??
    (typeof req.headers['x-tournament-id'] === 'string' ? req.headers['x-tournament-id'] : undefined);
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
    // Candidate additions are deliberately a player-only capability.  The
    // super token is a universal player token for legacy tournament pages, but
    // it must not bypass the requirement for an active player's real token on
    // this public, append-only endpoint.
    const candidateWrite = req.method === 'POST' && CANDIDATE_WRITE_PATH.test(req.path);
    if (candidateWrite) {
      // The candidate endpoint is intentionally stricter than legacy player
      // routes: its caller must send all three identity factors as headers.
      // Do not accept the fallback query/cookie forms here, which could put a
      // credential in a URL or accidentally reuse another tournament tab's
      // cookie.
      const missing: string[] = [];
      if (!headerValue(req, 'x-tournament-id')) missing.push('tournament_id');
      if (!headerValue(req, 'x-player-id')) missing.push('player_id');
      if (!headerValue(req, 'x-token')) missing.push('token');
      if (missing.length > 0) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: missing });
    }

    if (req.path.startsWith('/admin')) {
      const adminToken = headerToken(req);
      if (adminToken) {
        if (isSuper(adminToken)) {
          req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: true };
          return true;
        }
        // Per-tournament admin tokens were revoked. Do not fall back to them
        // or expose whether a token belongs to a particular tournament.
        throw new UnauthorizedException({ code: 'ADMIN_TOKEN_REMOVED' });
      }

      const createToken = headerValue(req, 'x-create-token');
      const rawUsername = headerValue(req, 'x-create-user');
      if (!createToken || !rawUsername) {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user', 'create_token'] });
      }
      let username: string;
      try {
        username = normalizeCreateUsername(rawUsername);
      } catch {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user'] });
      }
      if (!isCreateUser(username, createToken)) {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user', 'create_token'] });
      }
      const tid = extractTournamentId(req);
      // A creator may use the scoped list endpoint, but all other creator
      // operations must carry a tournament id and match created_by exactly.
      if (tid === null) {
        if (req.path === '/admin/mine/tournaments') {
          req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: false, isCreator: true, createUsername: username };
          return true;
        }
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['tid'] });
      }
      const row = tournamentRow(tid);
      // Rows migrated from databases that predate creator ownership have no
      // trustworthy actor. They remain super-admin-only even if a future
      // create user happens to use the historical placeholder name.
      if (!row || !row.created_by || row.created_by.trim().toLowerCase() === 'unknown' || row.created_by.trim().toLowerCase() !== username) {
        throw new ForbiddenException({ code: 'FORBIDDEN' });
      }
      req.identity = { tournamentId: tid, playerId: '', isAdmin: true, isSuper: false, isCreator: true, createUsername: username };
      return true;
    }

    if (req.path === '/tournaments' && req.method === 'POST') {
      // The super token remains a direct create credential. A non-super
      // X-Admin-Token is never accepted as a create credential.
      const createToken = headerValue(req, 'x-create-token');
      const adminToken = headerValue(req, 'x-admin-token');
      if (adminToken && !isSuper(adminToken)) throw new UnauthorizedException({ code: 'ADMIN_TOKEN_REMOVED' });
      const token = createToken ?? adminToken;
      if (!token) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_user', 'create_token'] });
      if (isSuper(token)) {
        req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: true };
        return true;
      }
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
      req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: false, isCreator: true, createUsername: username };
      return true;
    }

    const tid = extractTournamentId(req);
    if (tid !== null) {
      const row = tournamentRow(tid);
      // Candidate-pool writes are public to read but still require a real
      // player token.  Do not let the tournament's optional no-token testing
      // mode turn the append-only endpoint into an unauthenticated writer.
      if (row && row.auth_required === 0 && !candidateWrite) {
        const cookies = cookiesOf(req);
        const rawPid =
          headerValue(req, 'x-player-id') ??
          cookies[`yc_pid_${tid}`] ??
          cookies.yc_pid ??
          queryScalar(req, 'pid');
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
      const cookies = cookiesOf(req);
      const pathTid = req.path.match(/^\/(?:admin\/)?t\/(\d+)(?:\/|$)/)?.[1];
      const fields: string[] = [];
      if (!pathTid && !cookies.yc_tid && !queryScalar(req, 'tid') && !req.headers['x-tournament-id']) fields.push('tid');
      if (!(pathTid && cookies[`yc_pid_${pathTid}`]) && !cookies.yc_pid && !queryScalar(req, 'pid') && !req.headers['x-player-id']) fields.push('pid');
      if (!(pathTid && cookies[`yc_token_${pathTid}`]) && !cookies.yc_token && !req.headers['x-token']) fields.push('token');
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields });
    }
    if (candidateWrite && identity.isSuper) {
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['player_token'] });
    }
    req.identity = identity;
    return true;
  }
}
