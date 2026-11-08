import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Access, Public } from '../auth/auth.guard';
import { GuessPoolsService } from './guess-pools.service';
import { GuessService } from './guess.service';

function badPayload(): never {
  throw new BadRequestException({ code: 'BAD_PAYLOAD' });
}

function payload(body: unknown, keys: string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) badPayload();
  if (Object.keys(body).some((key) => !keys.includes(key))) badPayload();
  return body as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') badPayload();
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > limit || /[\p{Cc}\p{Cf}]/u.test(normalized)) badPayload();
  return normalized;
}

function playerId(value: unknown): string {
  const id = text(value, 24);
  if (!/^[\p{L}\p{N}_. -]+$/u.test(id)) badPayload();
  return id;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) badPayload();
  return value;
}

function poolCodes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20_000) badPayload();
  const codes = value.map((code) => integer(code, 1, Number.MAX_SAFE_INTEGER));
  if (new Set(codes).size !== codes.length) badPayload();
  return codes;
}

function decimalId(value: string, min = 0): number {
  if (!/^\d+$/.test(value)) badPayload();
  return integer(Number(value), min, Number.MAX_SAFE_INTEGER);
}

function searchParams(q: unknown, page: unknown): [string, number] {
  if (typeof q !== 'string' || q.length > 100 || typeof page !== 'string' || !/^\d{1,5}$/.test(page)) badPayload();
  return [q.trim(), Number(page)];
}

@Controller('games/guess')
export class GuessController {
  constructor(private readonly guess: GuessService, private readonly pools: GuessPoolsService) {}

  @Public()
  @Get('rooms')
  list() {
    return this.guess.list();
  }

  @Public()
  @Get('cards')
  search(@Query('q') q: unknown = '', @Query('page') page: unknown = '0') {
    return this.pools.search(...searchParams(q, page));
  }

  @Public()
  @Get('card-details')
  cardDetails(@Query('codes') codes: unknown) {
    if (typeof codes !== 'string' || codes.length > 6800) badPayload();
    const parts = codes.split(',');
    if (parts.length > 400) badPayload();
    return this.pools.cardDetails(parts.map((part) => decimalId(part, 1)));
  }

  @Public()
  @Get('pools')
  listPools() {
    return this.pools.list();
  }

  @Access('super-admin')
  @Post('pools')
  createPool(@Body() body: unknown) {
    const input = payload(body, ['name', 'codes']);
    return this.pools.create({ name: text(input.name, 48), codes: poolCodes(input.codes) });
  }

  @Public()
  @Get('pools/:poolId')
  pool(@Param('poolId') id: string) {
    return this.pools.describe(decimalId(id));
  }

  @Public()
  @Get('pools/:poolId/cards')
  poolCards(@Param('poolId') id: string, @Query('q') q: unknown = '', @Query('page') page: unknown = '0') {
    return this.pools.browse(decimalId(id), ...searchParams(q, page));
  }

  @Public()
  @Post('rooms')
  create(@Body() body: unknown) {
    const input = payload(body, ['name', 'playerId', 'poolId']);
    return this.guess.create({
      name: text(input.name, 48),
      playerId: playerId(input.playerId),
      poolId: integer(input.poolId, 0, Number.MAX_SAFE_INTEGER),
    });
  }

  @Public()
  @Post('rooms/:roomId/join')
  join(@Param('roomId') roomId: string, @Body() body: unknown) {
    return this.guess.join(roomId, playerId(payload(body, ['playerId']).playerId));
  }

  @Public()
  @Get('rooms/:roomId')
  state(@Param('roomId') roomId: string, @Headers('authorization') authorization?: string) {
    return this.guess.state(roomId, authorization);
  }

  @Public()
  @Get('rooms/:roomId/spectate')
  spectate(@Param('roomId') roomId: string) {
    return this.guess.spectate(roomId);
  }

  @Public()
  @Get('rooms/:roomId/cards')
  roomCards(
    @Param('roomId') roomId: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('q') q: unknown = '',
    @Query('page') page: unknown = '0',
  ) {
    return this.guess.search(roomId, authorization, ...searchParams(q, page));
  }

  @Public()
  @Post('rooms/:roomId/action')
  @HttpCode(200)
  act(
    @Param('roomId') roomId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const input = payload(body, ['action', 'version', 'code']);
    const { action } = input;
    const version = integer(input.version, 1, Number.MAX_SAFE_INTEGER);
    if (action === 'select' || action === 'guess') {
      return this.guess.act(roomId, authorization, { action, version, code: integer(input.code, 1, Number.MAX_SAFE_INTEGER) });
    }
    if (input.code !== undefined) badPayload();
    if (action !== 'start' && action !== 'next' && action !== 'finish' && action !== 'leave'
      && action !== 'surrender' && action !== 'skip' && action !== 'host-skip') {
      badPayload();
    }
    return this.guess.act(roomId, authorization, { action, version });
  }
}
