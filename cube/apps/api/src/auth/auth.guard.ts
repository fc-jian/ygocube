import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
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
// - POST /tournaments: requires X-Create-Token (config admin.create_token) or super token.
export interface Identity {
  tournamentId: number;
  playerId: string;
  isAdmin: boolean;
  isSuper: boolean;
}

export interface AuthedRequest extends Request {
  identity?: Identity;
}

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

function headerToken(req: AuthedRequest): string | undefined {
  const v = req.headers['x-admin-token'] ?? req.headers['x-create-token'];
  const raw = Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined;
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isSuper(token: string): boolean {
  return token === config.admin.superToken;
}

function isTournamentAdmin(token: string, hash: string | null): boolean {
  return hash !== null && hash !== '' && sha256(token) === hash;
}

function cookiesOf(req: AuthedRequest): Record<string, string> {
  return (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
}

export function extractIdentity(req: AuthedRequest): Identity | null {
  const cookies = cookiesOf(req);
  const headers = req.headers as Record<string, string | string[] | undefined>;
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
        cookies[k] ??
        hget(`x-${k.replace('yc_', '').replace('tid', 'tournament-id').replace('pid', 'player-id')}`) ??
        hget(k) ??
        (req.query as Record<string, string>)[k] ??
        (req.body as Record<string, string> | undefined)?.[k];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };
  const tid = get('yc_tid', 'tid');
  const pid = get('yc_pid', 'pid');
  const token = get('yc_token', 'token');
  if (!tid || !pid || !token) return null;
  const tournamentId = Number(tid);
  if (!Number.isInteger(tournamentId)) return null;
  // super admin token doubles as a universal player token (dev_docs/07 §2.1)
  if (token === config.admin.superToken) {
    return { tournamentId, playerId: pid, isAdmin: false, isSuper: true };
  }
  const row = getDb()
    .prepare('SELECT 1 AS found FROM tournament_players WHERE tournament_id=? AND player_id=? AND token_hash=? AND active=1')
    .get(tournamentId, pid, sha256(token)) as PlayerRow | undefined;
  if (!row) return null;
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
      const token = headerToken(req);
      if (!token || (!isSuper(token) && token !== config.admin.createToken)) {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields: ['create_token'] });
      }
      req.identity = { tournamentId: 0, playerId: '', isAdmin: true, isSuper: isSuper(token) };
      return true;
    }

    const tid = extractTournamentId(req);
    if (tid !== null) {
      const row = tournamentRow(tid);
      if (row && row.auth_required === 0) {
        const rawPid =
          (req.headers['x-player-id'] as string) ??
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
        req.identity = { tournamentId: tid, playerId: pid, isAdmin: false, isSuper: false };
        return true;
      }
    }

    const identity = extractIdentity(req);
    if (!identity) {
      const body = req.body as Record<string, unknown> | undefined;
      const cookies = cookiesOf(req);
      const fields: string[] = [];
      if (!cookies.yc_tid && !req.query.tid && !body?.tid) fields.push('tid');
      if (!cookies.yc_pid && !req.query.pid && !body?.pid) fields.push('pid');
      if (!cookies.yc_token && !req.query.token && !body?.token) fields.push('token');
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', fields });
    }
    req.identity = identity;
    return true;
  }
}
