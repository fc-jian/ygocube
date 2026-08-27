import { NestFactory } from '@nestjs/core';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AppModule } from './app.module';
import { config, validateStartupSecurity } from './config';
import { getDb } from './db';
import express, { Request, Response, NextFunction } from 'express';
import { compressJsonResponse } from './response-compression';

// Minimal cookie parser (no extra dependency).
export function cookieParser(req: Request, _res: Response, next: NextFunction) {
  const raw = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (raw) {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        try {
          cookies[key] = decodeURIComponent(value);
        } catch {
          // A malformed cookie must not turn every request into a 500.
          cookies[key] = value;
        }
      }
    }
  }
  (req as Request & { cookies: Record<string, string> }).cookies = cookies;
  next();
}

// Uniform error shape: { ok:false, code, ...details } (dev_docs/07 §5)
const CONFLICT_CODES = new Set([
  'WRONG_PHASE', 'NOT_YOUR_TURN', 'CARD_NOT_AVAILABLE', 'CARD_NOT_IN_ZONE', 'WRONG_ZONE',
  'LOCKED', 'ALREADY_LOCKED', 'DECK_INVALID', 'PAUSED', 'PAUSE_EXISTS', 'NO_PAUSE',
  'ALREADY_VOTED', 'NOT_PAUSED', 'FORBIDDEN', 'TOURNAMENT_FULL', 'NOT_ENOUGH_PLAYERS',
  'POOL_EXISTS', 'FROZEN', 'ALREADY_JOINED', 'CARD_NOT_IN_POOL',
  'NO_VALID_PAIRING',
  'CREATE_USER_EXISTS',
  'RESULT_ROUND_LOCKED', 'POOL_IN_USE',
  'FORMAT_LOCKED', 'ROUND_EXISTS', 'ROUND_PENDING', 'NO_ROUND', 'WRONG_DRAFT_MODE',
  'PACKCOUNT_NOT_MULTIPLE', 'ELIMINATION_DRAW',
]);

const BAD_REQUEST_CODES = new Set([
  'BAD_PLAYER_ID', 'BAD_DISPLAY_NAME', 'BAD_RESULT', 'BAD_PAYLOAD', 'BAD_POOL_IMPORT',
  'BAD_POOL_NAME', 'BAD_CREATE_USERNAME', 'BAD_EXTRA_RATIO', 'INSUFFICIENT_PACK_RATIO',
  'REVERT_CONFIRMATION_MISMATCH', 'BAD_SEAT_ASSIGNMENT', 'BAD_SWISS_ROUNDS',
  'BAD_PLAYOFF_SIZE', 'BAD_MATCH_FORMAT', 'FORMAT_PLAYER_COUNT', 'BAD_RESERVE_SECONDS', 'BAD_ACTION', 'BAD_TOURNAMENT_ID',
]);

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let details: unknown;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        code = String(b.code ?? exception.message);
        details = b.details;
      } else {
        code = String(body);
      }
    } else if (exception instanceof Error) {
      const candidate = exception.message;
      if (['PLAYER_NOT_FOUND', 'MATCH_NOT_FOUND', 'CREATE_USER_NOT_FOUND', 'POOL_NOT_FOUND', 'REVERT_EVENT_NOT_FOUND', 'TOURNAMENT_NOT_FOUND'].includes(candidate)) {
        status = 404;
        code = candidate;
        details = (exception as Error & { details?: unknown }).details;
      } else if (candidate === 'FORBIDDEN' || candidate === 'CORS_ORIGIN_DENIED') {
        status = 403;
        code = candidate;
      } else if (BAD_REQUEST_CODES.has(candidate)) {
        status = 400;
        code = candidate;
        details = (exception as Error & { details?: unknown }).details;
      } else if (candidate.startsWith('REVERT_ROOM_CLOSE_FAILED') || candidate === 'PAIRING_SEARCH_LIMIT') {
        status = 503;
        code = candidate.startsWith('REVERT_ROOM_CLOSE_FAILED') ? 'REVERT_ROOM_CLOSE_FAILED' : candidate;
      } else if (candidate === 'DRAFT_NOT_STARTED' || CONFLICT_CODES.has(candidate)) {
        status = 409;
        code = candidate;
        details = (exception as Error & { details?: unknown }).details;
      } else {
        // SQL paths, filesystem paths, and upstream response bodies frequently
        // occur in Error.message. Keep them in server logs, never in the API.
        console.error('unhandled API error', exception);
      }
    }
    res.status(status).json({ ok: false, code, ...(details !== undefined ? { details } : {}) });
  }
}

async function bootstrap() {
  validateStartupSecurity();
  getDb(); // init schema
  // eager card import (cards.cdb): search/pools need the table warm
  const { CardsService } = require('./cards/cards.service');
  new CardsService().allCodes();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'], bodyParser: false });
  app.enableShutdownHooks();
  app.use(cookieParser);
  app.use(compressJsonResponse);
  // Keep request-boundary protections independent from traffic volume. Card
  // pool pages legitimately fetch many assets in parallel, so this service does
  // not apply an application-level request rate limit. Origin, payload-size,
  // authentication and phase checks still protect the API.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const origin = req.headers.origin;
    if (origin && !config.server.allowedOrigins.includes(origin)) {
      res.status(403).json({ ok: false, code: 'CORS_ORIGIN_DENIED' });
      return;
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > 512 * 1024) {
      res.status(413).json({ ok: false, code: 'REQUEST_TOO_LARGE' });
      return;
    }
    const cardMetadataRequest = req.method === 'GET'
      && (/^\/t\/[^/]+\/cards$/.test(req.path) || /^\/pools\/[^/]+\/cards$/.test(req.path));
    if (req.path.startsWith('/pics/')) {
      // Image handlers set their own long-lived cache policy.
    } else if (cardMetadataRequest) {
      // Card metadata contains no player-private state. Keep it browser-local
      // and revalidate periodically so pick statistics converge without
      // allowing a shared proxy to mix tournament identities.
      res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=30');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('X-Accel-Buffering', 'yes');
    } else if (req.path.endsWith('/stream')) {
      // RealtimeService sets the definitive no-cache/no-buffer policy.
    } else {
      res.setHeader('Cache-Control', 'no-store');
      // Nginx is configured with buffering disabled for the API so SSE works;
      // explicitly opt normal JSON responses back into proxy buffering.
      res.setHeader('X-Accel-Buffering', 'yes');
    }
    next();
  });
  // Explicit parser limits apply to chunked requests as well as those with a
  // Content-Length header. The request-boundary middleware above runs first so
  // rejected origins never spend parser work.
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use((error: any, _req: Request, res: Response, next: NextFunction) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ ok: false, code: 'REQUEST_TOO_LARGE' });
      return;
    }
    if (error instanceof SyntaxError && (error as SyntaxError & { status?: number }).status === 400) {
      res.status(400).json({ ok: false, code: 'BAD_PAYLOAD' });
      return;
    }
    next(error);
  });
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || config.server.allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('CORS_ORIGIN_DENIED'), false);
    },
    credentials: true,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(config.server.port);
  console.log(`cube api listening on ${config.server.port}`);
}

bootstrap().catch((e) => {
  console.error('boot failed', e);
  process.exit(1);
});
