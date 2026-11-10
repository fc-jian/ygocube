import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Access, Public } from '../auth/auth.guard';
import { parseCardSearchParams } from '../cards/search-params';
import { badPayload, integer, payload, playerId, text } from '../games/room-input';
import { GuessPoolsService } from './guess-pools.service';
import { GuessService } from './guess.service';

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
  search(@Query() params: Record<string, unknown>) {
    return this.pools.search(parseCardSearchParams(params));
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
  poolCards(@Param('poolId') id: string, @Query() params: Record<string, unknown>) {
    return this.pools.browse(decimalId(id), parseCardSearchParams(params));
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
    @Query() params: Record<string, unknown>,
  ) {
    return this.guess.search(roomId, authorization, parseCardSearchParams(params));
  }

  @Public()
  @Post('rooms/:roomId/action')
  @HttpCode(200)
  act(
    @Param('roomId') roomId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const input = payload(body, ['action', 'version', 'code', 'playerId']);
    const { action } = input;
    const version = integer(input.version, 1, Number.MAX_SAFE_INTEGER);
    if (action === 'remove') {
      if (input.code !== undefined) badPayload();
      return this.guess.act(roomId, authorization, { action, version, playerId: playerId(input.playerId) });
    }
    if (input.playerId !== undefined) badPayload();
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
