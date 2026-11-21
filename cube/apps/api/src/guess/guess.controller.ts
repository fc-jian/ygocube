import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GUESS_POOL_VOTE_SORTS, type GuessPoolVoteSort } from '@ygocube/shared';
import { Access, Public } from '../auth/auth.guard';
import { parseCardSearchParams } from '../cards/search-params';
import { badPayload, integer, payload, playerId, text } from '../games/room-input';
import { GuessPoolsService } from './guess-pools.service';
import { GuessPoolVotesService } from './guess-pool-votes.service';
import { voterIp } from './voter-ip';
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
  constructor(
    private readonly guess: GuessService,
    private readonly pools: GuessPoolsService,
    private readonly votes: GuessPoolVotesService,
  ) {}

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
  @Get('pools/:poolId/export.csv')
  exportPool(@Param('poolId') id: string, @Res() response: Response) {
    const poolId = decimalId(id);
    const csv = this.pools.exportCsv(poolId);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="guess-pool-${poolId}.csv"`);
    response.setHeader('Cache-Control', 'no-store');
    response.send(csv);
  }

  @Public()
  @Get('pools/:poolId/cards')
  poolCards(@Param('poolId') id: string, @Query() params: Record<string, unknown>, @Req() request: Request) {
    const voteSort = params.voteSort;
    if (voteSort !== undefined && !GUESS_POOL_VOTE_SORTS.includes(voteSort as GuessPoolVoteSort)) badPayload();
    return this.votes.browse(decimalId(id), parseCardSearchParams(params), voterIp(request), voteSort as GuessPoolVoteSort | undefined);
  }

  @Public()
  @Post('pools/:poolId/cards/:code/vote')
  @HttpCode(200)
  voteCard(@Param('poolId') id: string, @Param('code') code: string, @Body() body: unknown, @Req() request: Request) {
    const { vote } = payload(body, ['vote']);
    if (vote !== null && vote !== 'like' && vote !== 'dislike') badPayload();
    return this.votes.vote(decimalId(id), decimalId(code, 1), vote, voterIp(request));
  }

  @Public()
  @Get('pools/:poolId/proposals')
  proposals(@Param('poolId') id: string, @Req() request: Request) {
    return this.votes.proposals(decimalId(id), voterIp(request));
  }

  @Public()
  @Get('pools/:poolId/proposals/ranking')
  proposalRanking(@Param('poolId') id: string, @Query() params: Record<string, unknown>, @Req() request: Request) {
    return this.votes.ranking(decimalId(id), parseCardSearchParams(params), voterIp(request));
  }

  @Public()
  @Get('pools/:poolId/proposals/cards')
  proposalCards(@Param('poolId') id: string, @Query() params: Record<string, unknown>, @Req() request: Request) {
    return this.votes.searchProposals(decimalId(id), parseCardSearchParams(params), voterIp(request));
  }

  @Public()
  @Post('pools/:poolId/proposals')
  @HttpCode(200)
  proposeCard(@Param('poolId') id: string, @Body() body: unknown, @Req() request: Request) {
    const input = payload(body, ['code', 'codes']);
    if (Object.hasOwn(input, 'code') === Object.hasOwn(input, 'codes')) badPayload();
    if (Object.hasOwn(input, 'code')) {
      return this.votes.propose(decimalId(id), integer(input.code, 1, Number.MAX_SAFE_INTEGER), voterIp(request));
    }
    if (!Array.isArray(input.codes) || input.codes.length < 1 || input.codes.length > 10) badPayload();
    const codes = input.codes.map((code) => integer(code, 1, Number.MAX_SAFE_INTEGER));
    return this.votes.proposeMany(decimalId(id), codes, voterIp(request));
  }

  @Public()
  @Post('rooms')
  create(@Body() body: unknown) {
    const input = payload(body, ['name', 'playerId', 'poolId', 'expertMode', 'disableOpeningHints']);
    for (const key of ['expertMode', 'disableOpeningHints']) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') badPayload();
    }
    return this.guess.create({
      name: text(input.name, 48),
      playerId: playerId(input.playerId),
      poolId: integer(input.poolId, 0, Number.MAX_SAFE_INTEGER),
      expertMode: input.expertMode === true,
      disableOpeningHints: input.disableOpeningHints === true,
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
    const input = payload(body, ['action', 'version', 'code', 'playerId', 'locked']);
    const { action } = input;
    const version = integer(input.version, 1, Number.MAX_SAFE_INTEGER);
    if (action === 'set-admission') {
      if (typeof input.locked !== 'boolean' || input.playerId !== undefined || input.code !== undefined) return badPayload();
      return this.guess.act(roomId, authorization, { action, version, locked: input.locked });
    }
    if (input.locked !== undefined) badPayload();
    if (action === 'remove' || action === 'transfer-host') {
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
