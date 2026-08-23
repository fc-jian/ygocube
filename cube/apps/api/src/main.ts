import { NestFactory } from '@nestjs/core';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AppModule } from './app.module';
import { config, validateStartupSecurity } from './config';
import { getDb } from './db';
import { Request, Response, NextFunction } from 'express';

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
  'BAD_PLAYOFF_SIZE', 'BAD_MATCH_FORMAT', 'FORMAT_PLAYER_COUNT', 'BAD_RESERVE_SECONDS', 'BAD_ACTION',
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
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.use(cookieParser);
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
