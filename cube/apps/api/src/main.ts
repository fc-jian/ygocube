import { NestFactory } from '@nestjs/core';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AppModule } from './app.module';
import { config, validateStartupSecurity } from './config';
import { getDb } from './db';
import { Request, Response, NextFunction } from 'express';

// Minimal cookie parser (no extra dependency).
function cookieParser(req: Request, _res: Response, next: NextFunction) {
  const raw = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (raw) {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
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
]);

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
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
      code = exception.message;
      details = (exception as Error & { details?: unknown }).details;
      if (code === 'PLAYER_NOT_FOUND') status = 404;
      else if (code === 'MATCH_NOT_FOUND') status = 404;
      else if (code === 'CREATE_USER_NOT_FOUND') status = 404;
      else if (code === 'POOL_NOT_FOUND') status = 404;
      else if (code === 'BAD_PLAYER_ID' || code === 'BAD_DISPLAY_NAME' || code === 'BAD_RESULT' || code === 'BAD_PAYLOAD' || code === 'BAD_POOL_IMPORT' || code === 'BAD_POOL_NAME' || code === 'BAD_CREATE_USERNAME' || code === 'BAD_EXTRA_RATIO' || code === 'INSUFFICIENT_PACK_RATIO' || code === 'REVERT_CONFIRMATION_MISMATCH') status = 400;
      else if (code === 'REVERT_EVENT_NOT_FOUND') status = 404;
      else if (code.startsWith('REVERT_ROOM_CLOSE_FAILED')) status = 503;
      else if (code === 'DRAFT_NOT_STARTED') status = 409;
      else if (CONFLICT_CODES.has(code)) status = 409;
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
