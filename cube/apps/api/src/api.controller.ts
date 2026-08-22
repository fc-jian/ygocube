import { Body, Controller, Get, Param, Post, Query, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import type { CardVisibilityStatus } from '@ygocube/shared';
import { Response } from 'express';
import { AuthGuard, AuthedRequest, Identity } from './auth/auth.guard';
import { TournamentsService } from './tournaments/tournaments.service';
import { DraftService } from './draft/draft.service';
import { DecksService } from './decks/decks.service';
import { MatchesService } from './matches/matches.service';
import { CardsService } from './cards/cards.service';
import { PoolsService } from './pools/pools.service';
import { RealtimeService } from './realtime/realtime.service';
import { config } from './config';
import { loadState } from './events/events.service';
import { CreateTournamentInput } from './tournaments/tournaments.service';
import { cubeDeckFileBase } from './decks/deck-filename';
import { cardsSeenByPlayer } from './cards/card-visibility';

export const Public = () => SetMetadata('public', true);

@Controller()
@UseGuards(AuthGuard)
export class ApiController {
  constructor(
    private tournaments: TournamentsService,
    private draft: DraftService,
    private decks: DecksService,
    private matches: MatchesService,
    private cards: CardsService,
    private pools: PoolsService,
    private realtime: RealtimeService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }

  @Public()
  @Get('tournaments')
  list() {
    return this.tournaments.list();
  }

  // pool names + counts for the create-tournament dropdown (no card codes exposed)
  @Public()
  @Get('pools')
  listPools() {
    return this.pools.list();
  }

  // low-res avif thumbnails stored server-side (config.yaml pics.avif_dir, default
  // assets/pics_avif); registered BEFORE pics/:code so the .avif suffix is not swallowed
  @Public()
  @Get('pics/:code.avif')
  picAvif(@Param('code') code: string, @Res() res: Response) {
    const n = Number(code);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(404).end();
      return;
    }
    const file = this.cards.resolveAvifPath(n);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'image/avif');
    res.sendFile(file);
  }

  // card images: proxied from a server-local ygopro root (config.yaml pics.ygopro_root);
  // never stored by the cube backend (dev_docs/06 §5)
  @Public()
  @Get('pics/:code')
  pic(@Param('code') code: string, @Res() res: Response) {
    const bare = code.replace(/\.(jpg|jpeg|png)$/i, '');
    const n = Number(bare);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(404).end();
      return;
    }
    const file = this.cards.resolvePicPath(n);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  }

  // requires X-Create-Token (or super admin token); returns a per-tournament admin token
  @Post('tournaments')
  create(@Body() body: CreateTournamentInput) {
    return this.tournaments.create(body, 'admin');
  }

  @Public()
  @Get('t/:tid')
  info(@Req() req: AuthedRequest) {
    return this.tournaments.get(Number(req.params.tid));
  }

  @Public()
  @Post('t/:tid/join')
  join(@Req() req: AuthedRequest, @Body() body: Record<string, string>) {
    const playerId = String(body.player_id ?? body.pid);
    return this.tournaments.join(Number(req.params.tid), playerId, String(body.display_name ?? playerId));
  }

  @Post('t/:tid/player/name')
  updatePlayerName(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const id = req.identity as Identity;
    const displayName = typeof body.display_name === 'string' ? body.display_name : '';
    return this.tournaments.updateDisplayName(id.tournamentId, id.playerId, displayName, id.playerId);
  }

  @Post('t/:tid/player/ready')
  setPlayerReady(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const id = req.identity as Identity;
    return this.tournaments.setPlayerReady(id.tournamentId, id.playerId, body.ready === true, id.playerId);
  }

  @Get('t/:tid/state')
  state(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    return this.tournaments.stateForPlayer(id.tournamentId, id.playerId);
  }

  @Get('t/:tid/cards')
  cardsSearch(@Query('q') q: string, @Query('codes') codes: string) {
    if (codes) {
      return [...new Set(codes
        .split(',')
        .map(Number)
        .filter(Number.isInteger)
      )]
        .map((c) => this.cards.get(c))
        .filter((c) => c !== null);
    }
    return this.cards.search(q ?? '');
  }

  // drop 前卡池（报名/未开始选牌时展示给玩家；选牌开始后也可查看）
  @Get('t/:tid/pool')
  poolInfo(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    const state = loadState(id.tournamentId);
    const cfg = JSON.parse(state.configJson) as Record<string, unknown>;
    const codes = this.pools.resolve(cfg.cardPool as string | undefined);
    return { name: String(cfg.cardPool ?? 'full'), count: codes.length, codes };
  }

  // 选牌搜索状态标注（dev_docs/06 §5.6）：每个玩家视角不同
  @Get('t/:tid/cards/status')
  cardsStatus(@Req() req: AuthedRequest, @Query('codes') codes: string) {
    const id = req.identity as Identity;
    const state = loadState(id.tournamentId);
    const cfg = JSON.parse(state.configJson) as Record<string, unknown>;
    const pool = new Set(this.pools.resolve(cfg.cardPool as string | undefined));
    // Private initial drops are normally represented by an empty list. Keep
    // the config check as a defence for legacy snapshots or edited settings.
    const dropped = cfg.dropPublic === true ? new Set(state.droppedCards) : new Set<number>();
    const myPicks = new Set(state.picks.filter((p) => p.playerId === id.playerId).map((p) => p.card));
    const seen = cardsSeenByPlayer(state, id.playerId);
    const codesList = [...new Set(String(codes ?? '').split(',').map(Number).filter(Number.isInteger))];
    return codesList.map((c) => {
      const status: CardVisibilityStatus = !pool.has(c)
        ? 'not_in_pool'
        : dropped.has(c)
          ? 'dropped'
          : myPicks.has(c)
            ? 'picked'
            : seen.has(c)
              ? 'seen'
              : 'unknown';
      return { code: c, status };
    });
  }

  @Post('t/:tid/pick')
  pick(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    const zone = body.target_zone as 'main' | 'extra' | 'side' | undefined;
    this.draft.pick(id.tournamentId, id.playerId, Number(body.card_code), zone);
    const s = loadState(id.tournamentId);
    this.realtime.emitPack(id.tournamentId, {
      packIndex: s.pickCursor?.packIndex ?? null,
      currentPicker: s.pickCursor?.playerId ?? null,
      deadlineAt: s.pickCursor?.deadlineAt ?? null,
      status: s.status,
    });
    return { ok: true };
  }

  @Post('t/:tid/pick/alternative')
  pickAlternative(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    this.draft.setPickAlternative(id.tournamentId, id.playerId, Number(body.card_code), id.playerId);
    const s = loadState(id.tournamentId);
    this.realtime.emitPack(id.tournamentId, {
      packIndex: s.pickCursor?.packIndex ?? null,
      currentPicker: s.pickCursor?.playerId ?? null,
      deadlineAt: s.pickCursor?.deadlineAt ?? null,
      status: s.status,
    });
    return { ok: true, card: Number(body.card_code) };
  }

  @Post('t/:tid/pause')
  pause(@Req() req: AuthedRequest, @Body() body: Record<string, string>) {
    const id = req.identity as Identity;
    const action = String(body.action ?? 'propose');
    if (action === 'propose') this.draft.proposePause(id.tournamentId, id.playerId);
    else if (action === 'vote_yes') this.draft.votePause(id.tournamentId, id.playerId, true);
    else if (action === 'vote_no') this.draft.votePause(id.tournamentId, id.playerId, false);
    else if (action === 'resume') this.draft.resume(id.tournamentId, id.playerId);
    else throw new Error('BAD_ACTION');
    this.realtime.emitPause(id.tournamentId, loadState(id.tournamentId).pause);
    return { ok: true };
  }

  @Post('t/:tid/deck/move')
  deckMove(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    this.decks.move(
      id.tournamentId,
      id.playerId,
      Number(body.card_code),
      String(body.from) as 'main' | 'extra' | 'side' | 'pool',
      String(body.to) as 'main' | 'extra' | 'side' | 'pool',
      body.index !== undefined ? Number(body.index) : undefined,
      body.from_index !== undefined ? Number(body.from_index) : undefined,
    );
    this.realtime.emitDeck(id.tournamentId, { playerId: id.playerId });
    return { ok: true };
  }

  @Post('t/:tid/deck/sort')
  deckSort(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    this.decks.sort(id.tournamentId, id.playerId);
    this.realtime.emitDeck(id.tournamentId, { playerId: id.playerId });
    return { ok: true };
  }

  @Post('t/:tid/deck/shuffle')
  deckShuffle(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    this.decks.shuffleMain(id.tournamentId, id.playerId);
    this.realtime.emitDeck(id.tournamentId, { playerId: id.playerId });
    return { ok: true };
  }

  @Post('t/:tid/deck/lock')
  lock(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    this.decks.lock(id.tournamentId, id.playerId);
    this.realtime.emitDeck(id.tournamentId, { playerId: id.playerId });
    return { ok: true };
  }

  @Post('t/:tid/deck/unlock')
  unlock(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    this.assertNotFrozen(id.tournamentId);
    this.decks.unlock(id.tournamentId, id.playerId);
    return { ok: true };
  }

  @Get('t/:tid/deck.ydk')
  ydk(@Req() req: AuthedRequest, @Res() res: Response) {
    const id = req.identity as Identity;
    const ydk = this.decks.ydk(id.tournamentId, id.playerId);
    res.setHeader('Content-Type', 'application/octet-stream');
    // The shared helper emits an ASCII-only filesystem-safe name usable by browsers and YGOPro.
    res.setHeader('Content-Disposition', `attachment; filename="${cubeDeckFileBase(id.tournamentId, id.playerId)}.ydk"`);
    res.send(ydk);
  }

  private assertNotFrozen(tid: number): void {
    if (loadState(tid).frozen) throw new Error('FROZEN');
  }

  @Get('t/:tid/matches')
  matchesInfo(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    return this.matches.roomInfo(id.tournamentId, id.playerId);
  }

  // 实时积分榜（对局双方可见，不含卡牌信息）
  @Get('t/:tid/ranking')
  ranking(@Req() req: AuthedRequest) {
    const id = req.identity as Identity;
    return this.matches.ranking(id.tournamentId);
  }

  // 对局客户端连接信息（供玩家页展示：服务器地址/端口来自 config.yaml）
  @Public()
  @Get('meta')
  meta() {
    return { srvpro: { host: config.srvpro.host, gamePort: config.srvpro.gamePort } };
  }

  @Public()
  @Post('cube/result')
  result(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    // 结果上报鉴权：srvpro 必须携带与 config.yaml srvpro.api_key 一致的 X-Cube-Api-Key（防伪造比分）
    const key = Array.isArray(req.headers['x-cube-api-key']) ? req.headers['x-cube-api-key'][0] : req.headers['x-cube-api-key'];
    if (key !== config.srvpro.apiKey) throw new Error('FORBIDDEN');
    const r = this.matches.onWebhook(body);
    if (r.ack && typeof body.room_name === 'string') {
      const m = body.room_name.match(/^CUBE-(\d+)-(\d+)-(\d+)(?:-[A-Za-z0-9]+)?$/);
      if (m) {
        const players = body.players as Record<string, unknown>[] | undefined;
        this.realtime.emitMatch(Number(m[1]), { round: Number(m[2]), tableNo: Number(m[3]), resultA: players?.[0]?.score, resultB: players?.[1]?.score });
      }
    }
    return r;
  }

  @Get('t/:tid/stream')
  stream(@Req() req: AuthedRequest, @Res() res: Response) {
    const id = req.identity as Identity;
    this.realtime.subscribe(id.tournamentId, res);
  }
}
