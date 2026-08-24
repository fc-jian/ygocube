import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { AuthGuard, AuthedRequest, Identity, normalizeCreateUsername, sha256 } from './auth/auth.guard';
import { TournamentsService } from './tournaments/tournaments.service';
import { DraftService } from './draft/draft.service';
import { DecksService } from './decks/decks.service';
import { MatchesService } from './matches/matches.service';
import { PoolsService } from './pools/pools.service';
import { CardsService } from './cards/cards.service';
import { RealtimeService } from './realtime/realtime.service';
import {
  loadState,
  hardRevertTo,
  previewRevert,
  unfreeze,
  freeze,
  dropState,
  getConfig,
  withEventTransaction,
} from './events/events.service';
import { randomToken, validateMatchFormat } from './tournaments/tournaments.service';
import { CardPickStatsService } from './cards/card-pick-stats.service';
import { getDb } from './db';

// Admin endpoints authenticate via X-Admin-Token (handled inside AuthGuard):
// super token for everything, per-tournament token for that tournament only.
@Controller('admin')
export class AdminController {
  constructor(
    private tournaments: TournamentsService,
    private draft: DraftService,
    private decks: DecksService,
    private matches: MatchesService,
    private pools: PoolsService,
    private cards: CardsService,
    private realtime: RealtimeService,
    private cardStats?: CardPickStatsService,
  ) {}

  private adminActor(req: AuthedRequest): string {
    const identity = req.identity as Identity;
    return identity.isSuper ? 'super-admin' : 'tournament-admin';
  }

  private superOnly(req: AuthedRequest): void {
    const id = req.identity as Identity;
    if (!id.isSuper) throw new Error('FORBIDDEN');
  }

  // ---------- create permission users ----------

  @Get('create-users')
  listCreateUsers(@Req() req: AuthedRequest) {
    this.superOnly(req);
    return getDb()
      .prepare('SELECT id, username, created_at AS createdAt, active FROM create_users ORDER BY username')
      .all() as { id: number; username: string; createdAt: string; active: number }[];
  }

  @Post('create-users')
  createUser(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    this.superOnly(req);
    const username = normalizeCreateUsername(body.username);
    const exists = getDb().prepare('SELECT id FROM create_users WHERE username=?').get(username);
    if (exists) throw new Error('CREATE_USER_EXISTS');
    const token = randomToken();
    const createdAt = new Date().toISOString();
    getDb().prepare('INSERT INTO create_users (username, token_hash, created_at, active) VALUES (?,?,?,1)')
      .run(username, sha256(token), createdAt);
    return { username, create_token: token, createdAt };
  }

  @Delete('create-users/:username')
  removeCreateUser(@Req() req: AuthedRequest, @Param('username') rawUsername: string) {
    this.superOnly(req);
    const username = normalizeCreateUsername(rawUsername);
    const result = getDb().prepare('DELETE FROM create_users WHERE username=?').run(username);
    if (result.changes === 0) throw new Error('CREATE_USER_NOT_FOUND');
    return { ok: true, username };
  }

  // ---------- tournaments ----------

  @Get('tournaments')
  listTournaments(@Req() req: AuthedRequest) {
    this.superOnly(req);
    return getDb()
      .prepare(
        'SELECT t.id, t.name, t.status, t.round, t.created_by, t.frozen, (SELECT count(*) FROM tournament_players tp WHERE tp.tournament_id = t.id AND tp.active=1) AS player_count, t.created_at FROM tournaments t ORDER BY t.id DESC',
      )
      .all() as { id: number; name: string; status: string; round: number; created_by: string; frozen: number; player_count: number; created_at: string }[];
  }

  @Delete('t/:tid')
  async deleteTournament(@Req() req: AuthedRequest) {
    this.superOnly(req);
    const tid = Number(req.params.tid);
    const state = loadState(tid);
    // Stop every in-process writer before awaiting external room shutdown.
    // Otherwise a draft timeout/poller can append a new event halfway through
    // deletion and leave an orphaned cache or srvpro room.
    this.matches.invalidateTournament(tid);
    this.draft.haltAllTimers(tid);
    if (!state.frozen) freeze(tid, this.adminActor(req));
    // 尽力关闭 srvpro 房间
    for (const m of state.matches) {
      if (m.roomName && m.resultA === null) {
        try {
          await this.matches.closeSrvproRoom(m.roomName);
        } catch {
          // 房间关闭失败不阻塞删除
        }
      }
    }
    const db = getDb();
    db.transaction(() => {
      for (const table of ['events', 'tournament_snapshots', 'tournament_players', 'picks', 'packs', 'decks', 'matches', 'admin_actions']) {
        db.prepare(`DELETE FROM ${table} WHERE tournament_id=?`).run(tid);
      }
      db.prepare('DELETE FROM tournaments WHERE id=?').run(tid);
    })();
    dropState(tid);
    return { ok: true };
  }

  @Post('t/:tid/pause')
  pauseTournament(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    withEventTransaction(tid, () => {
      this.draft.freezeTimers(tid);
      freeze(tid, this.adminActor(req));
    });
    return { ok: true };
  }

  @Post('t/:tid/start_draft')
  startDraft(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    this.draft.startDraft(tid, this.adminActor(req));
    const s = loadState(tid);
    this.realtime.emitPhase(tid, s.status, s.round);
    return { ok: true };
  }

  @Post('t/:tid/phase')
  phase(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const tid = Number(req.params.tid);
    const status = String(body.status);
    if (status === 'matches') {
      const invalid = this.decks.validationReport(tid);
      if (invalid.length > 0 && body.confirm_invalid_decks !== true) {
        return { ok: false, requires_confirmation: true, invalid_decks: invalid };
      }
      const repairs = withEventTransaction(tid, () => {
        const result = loadState(tid).players
          .filter((player) => !player.eliminated && !player.withdrawn)
          .map((player) => ({ playerId: player.playerId, ...this.decks.repairForMatches(tid, player.playerId) }));
        const eligible = loadState(tid).players.filter((player) => !player.eliminated && !player.withdrawn).length;
        if (eligible < 1) throw new Error('FORMAT_PLAYER_COUNT');
        if (eligible >= 2) validateMatchFormat(getConfig(loadState(tid)), eligible);
        this.tournaments.setPhase(tid, status, body.round !== undefined ? Number(body.round) : 1, this.adminActor(req));
        const round = body.round !== undefined ? Number(body.round) : loadState(tid).round || 1;
        this.matches.startRound(tid, round, this.adminActor(req));
        return result;
      });
      const s = loadState(tid);
      this.realtime.emitPhase(tid, s.status, s.round);
      return { ok: true, repairs };
    }
    withEventTransaction(tid, () => {
      this.tournaments.setPhase(tid, status, body.round !== undefined ? Number(body.round) : undefined, this.adminActor(req));
      // 阶段切换后重新武装对应定时器（setPhase 只写状态；定时器由这里/推进链路负责）
      if (status === 'drafting') this.draft.resumePickTimer(tid);
      else if (status === 'deckbuilding') this.draft.resumeDeckbuildingTimer(tid);
    });
    const s = loadState(tid);
    this.realtime.emitPhase(tid, s.status, s.round);
    return { ok: true };
  }

  @Put('t/:tid/config')
  updateTournamentConfig(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const tid = Number(req.params.tid);
    if (loadState(tid).frozen) throw new Error('FROZEN');
    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'maxPlayers', 'mode', 'packSize', 'packSizeMultiple', 'cardPool', 'mainMin', 'mainMax', 'extraMax', 'sideMax', 'maxCopies', 'timeLimit', 'pickSeconds', 'pauseSeconds', 'deckbuildingSeconds', 'dropMode', 'packStrategy', 'extraRatioPercent', 'packCount', 'dropPublic', 'draftMode', 'evenPackCount', 'reserveSeconds', 'reseatEachRound']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('BAD_PAYLOAD');
    const cfg = withEventTransaction(tid, () => {
      if (patch.name !== undefined) {
        this.tournaments.updateName(tid, patch.name, this.adminActor(req));
        delete patch.name;
      }
      if (Object.keys(patch).length === 0) return getConfig(loadState(tid));
      return this.tournaments.updateConfig(tid, patch, this.adminActor(req));
    });
    return { ok: true, config: cfg };
  }

  @Put('t/:tid/match-format')
  updateMatchFormat(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const tid = Number(req.params.tid);
    const patch = {
      matchFormat: body.matchFormat,
      swissRoundCount: body.swissRoundCount,
      playoffSize: body.playoffSize ?? 0,
    };
    return { ok: true, config: this.tournaments.updateMatchFormat(tid, patch, this.adminActor(req)) };
  }

  @Post('t/:tid/players/:pid/withdraw')
  withdrawPlayer(@Req() req: AuthedRequest, @Param('pid') pid: string) {
    this.tournaments.withdrawPlayer(Number(req.params.tid), decodeURIComponent(pid), this.adminActor(req));
    return { ok: true };
  }

  @Post('t/:tid/players/:pid/restore')
  restorePlayer(@Req() req: AuthedRequest, @Param('pid') pid: string) {
    this.tournaments.restorePlayer(Number(req.params.tid), decodeURIComponent(pid), this.adminActor(req));
    return { ok: true };
  }

  @Post('t/:tid/security')
  security(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const tid = Number(req.params.tid);
    if (typeof body.require_token !== 'boolean') throw new Error('BAD_PAYLOAD');
    this.tournaments.setAuthRequired(tid, body.require_token, this.adminActor(req));
    return { ok: true };
  }

  @Post('t/:tid/admin-token')
  resetAdminToken(@Req() req: AuthedRequest) {
    const result = this.tournaments.resetAdminToken(Number(req.params.tid));
    return { ...result, caller_was_super: (req.identity as Identity).isSuper === true };
  }

  @Get('settings/default-pool')
  defaultPool(@Req() req: AuthedRequest) {
    this.superOnly(req);
    return { pool: this.pools.defaultPool() };
  }

  @Put('settings/default-pool')
  setDefaultPool(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    this.superOnly(req);
    const id = Number(body.pool_id);
    if (!Number.isInteger(id)) throw new Error('BAD_PAYLOAD');
    return { pool: this.pools.setDefaultPool(id) };
  }

  @Post('t/:tid/pause/resume')
  resume(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    this.draft.resumeByAdmin(tid, this.adminActor(req));
    this.realtime.emitPause(tid, loadState(tid).pause);
    return { ok: true };
  }

  @Post('t/:tid/deck/fix')
  fix(@Req() req: AuthedRequest, @Body() body: Record<string, string>) {
    const tid = Number(req.params.tid);
    this.decks.autoFix(tid, String(body.player_id));
    return { ok: true };
  }

  @Post('t/:tid/matches/start')
  startRound(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const tid = Number(req.params.tid);
    const round = body.round !== undefined ? Number(body.round) : 1;
    if (loadState(tid).matches.length === 0) this.matches.validateStart(tid);
    this.matches.startRound(tid, round, this.adminActor(req));
    return { ok: true };
  }

  @Post('t/:tid/matches/advance')
  advanceRound(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    this.matches.advanceRound(tid, this.adminActor(req));
    return { ok: true };
  }

  @Post('t/:tid/revert')
  async revert(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const tid = Number(req.params.tid);
    const seq = Number(body.seq);
    if (!Number.isInteger(seq)) throw new Error('BAD_PAYLOAD');
    const preview = previewRevert(tid, seq);
    if (String(body.confirm_name ?? '') !== preview.tournamentName) throw new Error('REVERT_CONFIRMATION_MISMATCH');
    this.matches.invalidateTournament(tid);
    this.draft.haltAllTimers(tid);
    freeze(tid, this.adminActor(req));
    // If external room shutdown fails, keep the tournament frozen and preserve the
    // event branch. The operator can retry without risking a late result mutation.
    await this.matches.closeRoomsForRevert(preview.closeRooms);
    const result = hardRevertTo(tid, seq, this.adminActor(req));
    const state = result.state;
    this.realtime.emitNotice(tid, `admin reverted to event ${seq}; tournament frozen`);
    this.realtime.emitPhase(tid, state.status, state.round);
    return { ok: true, state: state.status, deleted_events: result.deletedEvents, replacement_tokens: result.replacementTokens };
  }

  @Get('t/:tid/revert/preview')
  revertPreview(@Req() req: AuthedRequest, @Query('seq') rawSeq: string) {
    const tid = Number(req.params.tid);
    const seq = Number(rawSeq);
    if (!Number.isInteger(seq)) throw new Error('BAD_PAYLOAD');
    return previewRevert(tid, seq);
  }

  @Post('t/:tid/unfreeze')
  unfreeze(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    withEventTransaction(tid, () => {
      unfreeze(tid, this.adminActor(req));
      this.draft.resumeFrozenTimers(tid);
      this.matches.resumeAfterRevert(tid);
    });
    return { ok: true };
  }

  @Post('t/:tid/players')
  addPlayer(@Req() req: AuthedRequest, @Body() body: Record<string, string>) {
    const tid = Number(req.params.tid);
    const playerId = String(body.player_id ?? '').trim();
    const displayName = String(body.display_name ?? '').trim();
    if (!playerId) throw new Error('BAD_PAYLOAD');
    return this.tournaments.join(tid, playerId, displayName || playerId);
  }

  @Delete('t/:tid/players/:pid')
  removePlayer(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    this.tournaments.removePlayer(tid, String(req.params.pid), this.adminActor(req));
    return { ok: true };
  }

  @Post('t/:tid/players/:pid/token')
  resetPlayerToken(@Req() req: AuthedRequest) {
    const tid = Number(req.params.tid);
    return this.tournaments.resetPlayerToken(tid, String(req.params.pid));
  }

  @Post('t/:tid/players/:pid/reserve')
  addPlayerReserve(@Req() req: AuthedRequest, @Param('pid') pid: string, @Body() body: Record<string, unknown>) {
    const seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) throw new Error('BAD_RESERVE_SECONDS');
    const playerId = decodeURIComponent(pid);
    const result = this.draft.addReserveSeconds(Number(req.params.tid), playerId, seconds, this.adminActor(req));
    return { ok: true, player_id: playerId, added_seconds: seconds, ...result };
  }

  @Post('t/:tid/match/result')
  setMatchResult(@Req() req: AuthedRequest, @Body() body: Record<string, number>) {
    const tid = Number(req.params.tid);
    const round = Number(body.round);
    const tableNo = Number(body.tableNo);
    const resultA = Number(body.resultA);
    const resultB = Number(body.resultB);
    if (!Number.isInteger(round) || !Number.isInteger(tableNo) || !Number.isInteger(resultA) || !Number.isInteger(resultB)) {
      throw new Error('BAD_PAYLOAD');
    }
    this.matches.setMatchResult(tid, round, tableNo, resultA, resultB);
    return { ok: true };
  }

  @Get('t/:tid/events')
  events(@Req() req: AuthedRequest) {
    return this.tournaments.events(Number(req.params.tid));
  }

  @Post('t/:tid/state')
  state(@Req() req: AuthedRequest) {
    return this.tournaments.adminState(Number(req.params.tid));
  }

  // ---------- card pools (scoped read, super-admin mutations, dev_docs/07 §5.2) ----------

  // Tournament administrators may choose from every existing pool while
  // editing their tournament, but must not receive pool mutation privileges.
  @Get('t/:tid/pools')
  listTournamentPools(@Req() req: AuthedRequest, @Param('tid') rawTid: string) {
    const identity = req.identity as Identity;
    const tid = Number(rawTid);
    if (!Number.isSafeInteger(tid) || tid <= 0) throw new Error('BAD_TOURNAMENT_ID');
    if (!identity.isSuper && identity.tournamentId !== tid) throw new Error('FORBIDDEN');
    return { pools: this.pools.list(), canEdit: identity.isSuper === true };
  }

  @Get('pools')
  listPools(@Req() req: AuthedRequest) {
    this.superOnly(req);
    return this.pools.list();
  }

  @Post('pools')
  createPool(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    this.superOnly(req);
    const name = String(body.name ?? '');
    if (typeof body.importText === 'string') {
      const { pool, filtered, missingCodes, entryWarnings } = this.pools.createFromText(name, body.importText);
      return { ...pool, filtered, missingCodes, entryWarnings };
    }
    if (!Array.isArray(body.codes) || body.codes.some((code) => typeof code !== 'number' || !Number.isSafeInteger(code))) {
      throw new Error('BAD_PAYLOAD');
    }
    const codes = body.codes as number[];
    const { pool, filtered, missingCodes, entryWarnings } = this.pools.create(name, codes);
    return { ...pool, filtered, missingCodes, entryWarnings };
  }

  @Post('pools/random')
  createRandomPool(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    this.superOnly(req);
    const name = String(body.name ?? '');
    const size = body.size === undefined ? 1000 : body.size as number;
    const { pool, filtered, missingCodes, entryWarnings } = this.pools.createRandom(name, size);
    return { ...pool, filtered, missingCodes, entryWarnings };
  }

  @Get('pools/:id')
  poolDetail(@Req() req: AuthedRequest, @Param('id') id: string) {
    this.superOnly(req);
    const pool = this.pools.get(Number(id));
    if (!pool) throw new Error('POOL_NOT_FOUND');
    return pool;
  }

  @Put('pools/:id')
  updatePool(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    this.superOnly(req);
    if (!Array.isArray(body.codes) || body.codes.some((code) => typeof code !== 'number' || !Number.isSafeInteger(code))) {
      throw new Error('BAD_PAYLOAD');
    }
    const codes = body.codes as number[];
    const { pool, filtered, missingCodes, entryWarnings } = this.pools.update(Number(id), codes);
    return { ...pool, filtered, missingCodes, entryWarnings };
  }

  // 卡池编辑页使用的全卡查询/搜索（super admin）
  @Get('cards')
  adminCards(@Req() req: AuthedRequest, @Query('q') q: string, @Query('codes') codes: string, @Query('pool_id') poolId: string) {
    this.superOnly(req);
    const pool = poolId && Number.isInteger(Number(poolId)) ? this.pools.get(Number(poolId)) : null;
    const stats = pool && this.cardStats ? this.cardStats.forPool(pool) : new Map();
    const attach = (card: any) => ({ ...card, ...(stats.has(card.code) ? { pickStats: [stats.get(card.code)] } : { pickStats: [] }) });
    if (codes) {
      return this.cards.getMany(codes.split(',').map(Number)).map(attach);
    }
    return this.cards.search(q ?? '').map(attach);
  }

  @Delete('pools/:id')
  removePool(@Req() req: AuthedRequest) {
    this.superOnly(req);
    this.pools.remove(Number(req.params.id));
    return { ok: true };
  }
}
