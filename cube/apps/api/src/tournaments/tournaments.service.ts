import { BadRequestException, Injectable } from '@nestjs/common';
import { getDb } from '../db';
import { config, defaults } from '../config';
import { logEvent, loadState, persistMeta, getConfig, TournamentState, withEventTransaction } from '../events/events.service';
import crypto from 'crypto';
import { sha256 } from '../auth/auth.guard';
import { normalizePoolName, PoolsService } from '../pools/pools.service';
import {
  CreateTournamentInput,
  validateTournamentInput,
  validateTournamentName,
} from './tournament-config';

export type { CreateTournamentInput, DropMode } from './tournament-config';


/** Normalize the optional per-pack extra-deck ratio used by pack generation. */
export function normalizeExtraRatioPercent(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('BAD_EXTRA_RATIO');
  }
  return value;
}

export function randomToken(): string {
  // 192 bits; legacy word tokens remain valid because only their hashes are stored.
  return crypto.randomBytes(24).toString('base64url');
}

export function recommendedMatchFormat(n: number): { matchFormat: 'round_robin' | 'swiss'; swissRoundCount?: number; playoffSize?: number } {
  // Two players cannot have three Swiss rounds without repeating the only
  // opponent, so recommend the complete round-robin schedule for that edge.
  if (n <= 2) return { matchFormat: 'round_robin' };
  if (n <= 8) return { matchFormat: 'swiss', swissRoundCount: 3, playoffSize: 0 };
  if (n <= 16) return { matchFormat: 'swiss', swissRoundCount: 4, playoffSize: 4 };
  return { matchFormat: 'swiss', swissRoundCount: Math.ceil(Math.log2(n)) + 1, playoffSize: 8 };
}

export function validateMatchFormat(input: Record<string, unknown>, playerCount?: number): void {
  const format = input.matchFormat;
  if (!['round_robin', 'swiss', 'double_elimination'].includes(String(format))) throw new Error('BAD_MATCH_FORMAT');
  if (format !== 'swiss') return;
  const rounds = Number(input.swissRoundCount);
  const playoff = Number(input.playoffSize ?? 0);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('BAD_SWISS_ROUNDS');
  if (!Number.isInteger(playoff) || playoff < 0 || (playoff !== 0 && (playoff < 2 || (playoff & (playoff - 1)) !== 0))) throw new Error('BAD_PLAYOFF_SIZE');
  if (playerCount !== undefined) {
    const maxRounds = playerCount % 2 === 0 ? playerCount - 1 : playerCount;
    if (rounds > maxRounds) throw new Error('BAD_SWISS_ROUNDS');
    if (playoff > playerCount) throw new Error('FORMAT_PLAYER_COUNT');
  }
}

@Injectable()
export class TournamentsService {
  constructor(private pools: PoolsService) {}

  // cardPool must name an existing pool; 'full' is rejected on write paths
  // (PoolsService.resolve still understands legacy 'full' configs).
  private assertCardPool(cardPool: unknown): string {
    if (typeof cardPool !== 'string' || !cardPool.trim()) throw new BadRequestException({ code: 'BAD_PAYLOAD' });
    const name = normalizePoolName(cardPool);
    if (name === 'full' || !this.pools.codesByName(name)) throw new Error('POOL_NOT_FOUND');
    return name;
  }

  private poolsCodes(cfg: Record<string, unknown>): number {
    const ref = cfg.cardPool as string | undefined;
    if (ref && ref !== 'full') {
      const codes = this.pools.codesByName(ref);
      if (codes) return codes.length;
    }
    // full pool count from cards table
    const { CardsService } = require('../cards/cards.service');
    return new CardsService().poolCodes().length;
  }

  create(input: CreateTournamentInput, actor: string): { tid: number; url: string; created_by: string } {
    input = validateTournamentInput(input);
    const cardPool = this.assertCardPool(input.cardPool);
    const pool = this.pools.getByName(cardPool);
    if (!pool) throw new Error('POOL_NOT_FOUND');
    const extraRatioPercent = normalizeExtraRatioPercent(input.extraRatioPercent);
    // New tournaments default to four complete pack rounds. If the selected
    // pool is smaller, reduce the count to the available full packs (and keep
    // the player-count multiple whenever a full round is possible).
    const effectivePackSize = input.packSize
      ?? (input.packSizeMultiple === undefined ? defaults.packSize : input.maxPlayers * (input.packSizeMultiple ?? defaults.packSizeMultiple));
    const poolCount = this.pools.codesByName(cardPool)?.length ?? 0;
    const targetPackCount = Math.max(1, input.maxPlayers * 4);
    const availablePackCount = Math.max(1, Math.floor(poolCount / Math.max(1, effectivePackSize)));
    let defaultPackCount = Math.min(targetPackCount, availablePackCount);
    if (input.evenPackCount !== false && defaultPackCount >= input.maxPlayers) {
      defaultPackCount -= defaultPackCount % input.maxPlayers;
    }
    defaultPackCount = Math.max(1, defaultPackCount);
    const recommended = recommendedMatchFormat(input.maxPlayers);
    const match = {
      matchFormat: input.matchFormat ?? recommended.matchFormat,
      swissRoundCount: input.swissRoundCount ?? recommended.swissRoundCount,
      playoffSize: input.playoffSize ?? recommended.playoffSize,
    };
    validateMatchFormat(match, input.maxPlayers);
    const cfg = {
      maxPlayers: input.maxPlayers,
      mode: input.mode ?? 'match',
      packSize: input.packSize ?? (input.packSizeMultiple === undefined ? defaults.packSize : undefined),
      packSizeMultiple: input.packSizeMultiple ?? defaults.packSizeMultiple,
      pickSeconds: input.pickSeconds ?? defaults.pickSeconds,
      deckbuildingSeconds: input.deckbuildingSeconds === undefined ? defaults.deckbuildingSeconds : input.deckbuildingSeconds,
      dropLeftover: input.dropLeftover !== false,
      dropMode:
        input.dropMode ??
        (input.dropLeftover === undefined
          ? 'drop_leftover'
          : input.dropLeftover
            ? 'drop_leftover_exact'
            : 'use_all'),
      packStrategy: input.packStrategy ?? 'stratify',
      extraRatioPercent,
      // Keep an automatically generated short partial round implicit. This
      // lets DraftService apply legacy dropMode/use_all semantics without
      // treating the unavoidable sub-round as an invalid explicit count.
      packCount: input.packCount
        ?? (input.dropMode === undefined && input.dropLeftover === undefined && availablePackCount >= input.maxPlayers
          ? defaultPackCount
          : undefined),
      dropPublic: input.dropPublic === true, // 默认不公开丢弃列表
      // 仅 serial 需要落配置（缺省 passing 由 defaults 提供；startDraft 只认 rawCfg.draftMode==='serial'）
      draftMode: input.draftMode === 'serial' ? 'serial' : undefined,
      evenPackCount: input.evenPackCount !== false,
      reseatEachRound: input.reseatEachRound !== false,
      reserveSeconds: input.reserveSeconds ?? defaults.reserveSeconds,
      mainMin: input.mainMin ?? defaults.mainMin,
      mainMax: input.mainMax ?? defaults.mainMax,
      extraMax: input.extraMax ?? defaults.extraMax,
      sideMax: input.sideMax ?? defaults.sideMax,
      maxCopies: input.maxCopies ?? defaults.maxCopies,
      timeLimit: input.timeLimit ?? defaults.timeLimit,
      cardPool,
      cardPoolId: pool.id,
      ...match,
    };
    // Validate again after defaults/recommendations are materialized so a
    // partial caller override (for example only mainMin) cannot form an
    // invalid combination with a defaulted companion field.
    validateTournamentInput({ ...cfg, name: input.name, cardPool }, false, true);
    const now = new Date().toISOString();
    const db = getDb();
    const tid = db.transaction(() => {
      const row = db
        .prepare(
          'INSERT INTO tournaments (name, config_json, created_by, card_pool_id, status, round, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(input.name, JSON.stringify(cfg), actor, pool.id, 'registration', 0, now, now);
      const createdTid = Number(row.lastInsertRowid);
      logEvent(createdTid, 'tournament', 'phase', { status: 'registration', round: 0 }, actor);
      return createdTid;
    })();
    return { tid, url: `/t/${tid}`, created_by: actor };
  }

  get(tid: number) {
    const state = loadState(tid);
    const row = getDb().prepare('SELECT auth_required FROM tournaments WHERE id=?').get(tid) as { auth_required: number } | undefined;
    return {
      id: state.id,
      name: state.name,
      config: getConfig(state),
      status: state.status,
      round: state.round,
      players: state.players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, seat: p.seat, eliminated: p.eliminated, withdrawn: p.withdrawn === true, ready: p.ready === true })),
      playerCount: state.players.length,
      frozen: state.frozen,
      createdBy: state.createdBy,
      authRequired: row ? row.auth_required !== 0 : true,
    };
  }

  join(tid: number, playerId: string, displayName: string): { token: string } {
    return withEventTransaction(tid, () => this.joinCommand(tid, playerId, displayName));
  }

  private joinCommand(tid: number, playerId: string, displayName: string): { token: string } {
    // 进房昵称即玩家 ID：YGOPro 协议仅支持 ASCII 文本，非 ASCII 无法进入游戏（前端已拦截，这里兜底）
    // CTOS_PlayerInfo is uint16_t name[20]: reserve one code unit for NUL.
    // Player ids are also used verbatim as the YGOPro name_vpass value.
    if (!/^[\x20-\x7E]{1,19}$/.test(playerId) || playerId.includes('$')) throw new Error('BAD_PLAYER_ID');
    displayName = displayName.trim();
    if (!displayName || [...displayName].length > 64 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
      throw new Error('BAD_DISPLAY_NAME');
    }
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    if (state.players.some((p) => p.playerId === playerId)) throw new Error('ALREADY_JOINED');
    if (state.players.length >= getConfig(state).maxPlayers) throw new Error('TOURNAMENT_FULL');
    const token = randomToken();
    // Historical rows are retained inactive so a hard revert can preserve credentials.
    getDb()
      .prepare(`INSERT INTO tournament_players (tournament_id, player_id, display_name, token_hash, seat, joined_at, active)
                VALUES (?,?,?,?,?,?,1)
                ON CONFLICT(tournament_id, player_id) DO UPDATE SET
                  display_name=excluded.display_name, token_hash=excluded.token_hash, seat=NULL,
                  joined_at=excluded.joined_at, eliminated=0, active=1`)
      .run(tid, playerId, displayName, sha256(token), null, new Date().toISOString());
    logEvent(tid, 'player', 'player_join', { playerId, displayName, seat: -1, eliminated: false, withdrawn: false, ready: false }, playerId);
    return { token };
  }

  setPlayerReady(tid: number, playerId: string, ready: boolean, actor: string): { playerId: string; ready: boolean } {
    return withEventTransaction(tid, () => this.setPlayerReadyCommand(tid, playerId, ready, actor));
  }

  private setPlayerReadyCommand(tid: number, playerId: string, ready: boolean, actor: string): { playerId: string; ready: boolean } {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    if (!state.players.some((p) => p.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    logEvent(tid, 'player', 'player_ready', { playerId, ready: ready === true }, actor);
    persistMeta(tid);
    return { playerId, ready: ready === true };
  }

  updateDisplayName(tid: number, playerId: string, displayName: string, actor: string): { playerId: string; displayName: string } {
    return withEventTransaction(tid, () => this.updateDisplayNameCommand(tid, playerId, displayName, actor));
  }

  private updateDisplayNameCommand(tid: number, playerId: string, displayName: string, actor: string): { playerId: string; displayName: string } {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    // Names are deliberately mutable only until the first draft action. Once
    // seats/pack history are public, changing them would make reports and
    // replays ambiguous.
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    const player = state.players.find((p) => p.playerId === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    const next = displayName.trim();
    if (!next || [...next].length > 64 || /[\u0000-\u001f\u007f]/u.test(next)) throw new Error('BAD_DISPLAY_NAME');
    if (next === player.displayName) return { playerId, displayName: next };
    getDb()
      .prepare('UPDATE tournament_players SET display_name=? WHERE tournament_id=? AND player_id=? AND active=1')
      .run(next, tid, playerId);
    logEvent(tid, 'player', 'player_rename', { playerId, displayName: next }, actor);
    persistMeta(tid);
    return { playerId, displayName: next };
  }

  setSeats(tid: number, order: string[], actor: string): void {
    withEventTransaction(tid, () => this.setSeatsCommand(tid, order, actor));
  }

  private setSeatsCommand(tid: number, order: string[], actor: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    const expected = new Set(state.players.map((player) => player.playerId));
    if (order.length !== expected.size || new Set(order).size !== order.length || order.some((playerId) => !expected.has(playerId))) {
      throw new Error('BAD_PAYLOAD');
    }
    const map: Record<string, number> = {};
    order.forEach((pid, i) => (map[pid] = i));
    logEvent(tid, 'player', 'seat_assign', map, actor);
    persistMeta(tid);
  }

  // 管理台删除玩家：报名/选牌/构筑阶段可删（同时清理其选牌与卡组），对战开始后禁止
  removePlayer(tid: number, playerId: string, actor: string): void {
    withEventTransaction(tid, () => this.removePlayerCommand(tid, playerId, actor));
  }

  private removePlayerCommand(tid: number, playerId: string, actor: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status === 'matches' || state.status === 'finished') throw new Error('WRONG_PHASE');
    if (!state.players.some((p) => p.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    getDb().prepare('UPDATE tournament_players SET active=0 WHERE tournament_id=? AND player_id=?').run(tid, playerId);
    logEvent(tid, 'player', 'player_remove', playerId, actor);
    persistMeta(tid);
  }

  // 管理台重置玩家 token（token 只存哈希无法回显，重置后返回新明文）
  resetPlayerToken(tid: number, playerId: string): { token: string } {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (!state.players.some((p) => p.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    const token = randomToken();
    getDb().prepare('UPDATE tournament_players SET token_hash=? WHERE tournament_id=? AND player_id=?').run(sha256(token), tid, playerId);
    return { token };
  }

  updateMatchFormat(tid: number, patch: Record<string, unknown>, actor: string): Record<string, unknown> {
    return withEventTransaction(tid, () => this.updateMatchFormatCommand(tid, patch, actor));
  }

  private updateMatchFormatCommand(tid: number, patch: Record<string, unknown>, actor: string): Record<string, unknown> {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.matches.length > 0) throw new Error('FORMAT_LOCKED');
    patch = validateTournamentInput(patch, true) as unknown as Record<string, unknown>;
    const cfg = { ...getConfig(state), ...patch };
    validateMatchFormat(cfg, Number(cfg.maxPlayers));
    logEvent(tid, 'tournament', 'config', cfg, actor);
    persistMeta(tid);
    return cfg;
  }

  withdrawPlayer(tid: number, playerId: string, actor: string): void {
    withEventTransaction(tid, () => this.withdrawPlayerCommand(tid, playerId, actor));
  }

  private withdrawPlayerCommand(tid: number, playerId: string, actor: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    const player = state.players.find((p) => p.playerId === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    if (player.withdrawn) return;
    getDb().prepare('UPDATE tournament_players SET withdrawn=1 WHERE tournament_id=? AND player_id=?').run(tid, playerId);
    logEvent(tid, 'player', 'player_withdraw', { playerId }, actor);
    persistMeta(tid);
  }

  restorePlayer(tid: number, playerId: string, actor: string): void {
    withEventTransaction(tid, () => this.restorePlayerCommand(tid, playerId, actor));
  }

  private restorePlayerCommand(tid: number, playerId: string, actor: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.matches.length > 0) throw new Error('FORMAT_LOCKED');
    const player = state.players.find((p) => p.playerId === playerId);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    getDb().prepare('UPDATE tournament_players SET withdrawn=0 WHERE tournament_id=? AND player_id=?').run(tid, playerId);
    logEvent(tid, 'player', 'player_restore', { playerId }, actor);
    persistMeta(tid);
  }

  // 阶段迁移规则（dev_docs/05 §3.2）：
  // - registration 不能直接进入 deckbuilding（必须开始选牌）；
  // - drafting -> deckbuilding（手动）：serial 若当前牌堆未选完 / passing 若本轮队列未空，置 pendingPhase，
  //   等当前牌堆/本轮选完后进入（进度保留）；
  // - deckbuilding -> drafting（回退）：允许，选牌从保留的光标处继续。
  setPhase(tid: number, status: string, round: number | undefined, actor: string): void {
    withEventTransaction(tid, () => this.setPhaseCommand(tid, status, round, actor));
  }

  private setPhaseCommand(tid: number, status: string, round: number | undefined, actor: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (!['registration', 'drafting', 'deckbuilding', 'matches', 'finished'].includes(status)) throw new Error('BAD_PAYLOAD');
    if (round !== undefined && (!Number.isSafeInteger(round) || round < 0 || round > 10_000)) throw new Error('BAD_PAYLOAD');
    if (status === 'deckbuilding') {
      if (state.status === 'registration') throw new Error('DRAFT_NOT_STARTED');
      if (state.status === 'drafting') {
        if (state.pickCursor) {
          logEvent(tid, 'draft', 'pending', 'deckbuilding', actor);
          persistMeta(tid);
          return; // 等待当前牌堆选完（advance 内完成切换）
        }
        // passing 模式：任一玩家队列非空 = 本轮未选完，同样置 pendingPhase 等本轮结束（doPassPick 内完成切换）
        const passing = Object.keys(state.packQueues ?? {}).length > 0;
        if (passing && state.players.some((p) => (state.packQueues[p.playerId]?.length ?? 0) > 0)) {
          logEvent(tid, 'draft', 'pending', 'deckbuilding', actor);
          persistMeta(tid);
          return;
        }
        this.enterDeckbuilding(tid, actor);
        return;
      }
    }
    if (status === 'drafting' && state.status === 'deckbuilding') {
      // 回退：清掉构筑时限，恢复选牌（serial 光标保留在最后牌堆开头；passing 队列/ deadline 原样保留，
      // 定时器由 admin 阶段端点的 resumePickTimer 重新武装，过期 deadline 会恢复为完整时长）
      const s = loadState(tid);
      const deadlineAt = null;
      logEvent(tid, 'tournament', 'phase', { status: 'drafting', round: s.round, deadlineAt }, actor);
      const passing = Object.keys(s.packQueues ?? {}).length > 0;
      if (!passing && !s.pickCursor && s.packs.length) {
        // 极端情况：选牌全部完成后回退 —— 从第一堆重新开始（没有未选完的堆）
        const first = s.packs[0];
        const playerId = s.players.slice().sort((a, b) => a.seat - b.seat)[0].playerId;
        logEvent(tid, 'draft', 'cursor', { packIndex: 0, round: 0, playerId, deadlineAt: new Date(Date.now() + getConfig(s).pickSeconds * 1000).toISOString() }, actor);
      }
      persistMeta(tid);
      return;
    }
    logEvent(tid, 'tournament', 'phase', { status, round: round ?? state.round }, actor);
    persistMeta(tid);
  }

  enterDeckbuilding(tid: number, actor: string): void {
    withEventTransaction(tid, () => this.enterDeckbuildingCommand(tid, actor));
  }

  private enterDeckbuildingCommand(tid: number, actor: string): void {
    const state = loadState(tid);
    const cfg = getConfig(state);
    const seconds = cfg.deckbuildingSeconds;
    const deadlineAt = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? new Date(Date.now() + seconds * 1000).toISOString()
      : null;
    // Legacy/imported drafts may contain picks that never received a matching
    // deck event. Material picked copies that are still unused enter their
    // natural zone before construction starts (main for normal cards, extra
    // for extra-deck monsters). Licensed virtual copies from maxCopies are not
    // invented here.
    for (const player of state.players) {
      const deck = state.decks[player.playerId] ?? { main: [], extra: [], side: [], lockedAt: null, status: 'building' as const };
      const next = { ...deck, main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
      const used = new Map<number, number>();
      for (const code of [...next.main, ...next.extra, ...next.side]) used.set(code, (used.get(code) ?? 0) + 1);
      let changed = false;
      for (const pick of state.picks.filter((entry) => entry.playerId === player.playerId)) {
        const count = used.get(pick.card) ?? 0;
        if (count > 0) {
          used.set(pick.card, count - 1);
          continue;
        }
        (this.pools.isExtraDeck(pick.card) ? next.extra : next.main).push(pick.card);
        changed = true;
      }
      if (changed) logEvent(tid, 'deck', 'deck', { playerId: player.playerId, deck: next }, actor);
    }
    logEvent(tid, 'tournament', 'phase', { status: 'deckbuilding', round: 0, deadlineAt }, actor);
    persistMeta(tid);
  }

  // 开始选牌前可调整任何参数（含卡池），dev_docs/05 §2
  updateConfig(tid: number, patch: Record<string, unknown>, actor: string): Record<string, unknown> {
    return withEventTransaction(tid, () => this.updateConfigCommand(tid, patch, actor));
  }

  private updateConfigCommand(tid: number, patch: Record<string, unknown>, actor: string): Record<string, unknown> {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    patch = validateTournamentInput(patch, true) as unknown as Record<string, unknown>;
    if (patch.cardPool !== undefined) {
      const cardPool = this.assertCardPool(patch.cardPool);
      const pool = this.pools.getByName(cardPool);
      if (!pool) throw new Error('POOL_NOT_FOUND');
      patch = { ...patch, cardPool, cardPoolId: pool.id };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'extraRatioPercent')) {
      patch = { ...patch, extraRatioPercent: normalizeExtraRatioPercent(patch.extraRatioPercent) };
    }
    const cfg = { ...getConfig(state), ...patch };
    validateTournamentInput({ ...cfg, name: state.name, cardPool: cfg.cardPool }, false, true);
    if (typeof cfg.maxPlayers === 'number' && cfg.maxPlayers < state.players.length) {
      throw new Error('TOURNAMENT_FULL');
    }
    logEvent(tid, 'tournament', 'config', cfg, actor);
    // Keep the immutable pool identity column in lockstep with the config
    // whenever an administrator changes the pool during registration. This is
    // what pick-stat aggregation uses after a pool is deleted/recreated under
    // the same name.
    if (patch.cardPool !== undefined) {
      const cardPoolId = typeof cfg.cardPoolId === 'number' && Number.isInteger(cfg.cardPoolId) ? cfg.cardPoolId : null;
      getDb().prepare('UPDATE tournaments SET card_pool_id=?, updated_at=? WHERE id=?').run(cardPoolId, new Date().toISOString(), tid);
    }
    persistMeta(tid);
    return cfg;
  }

  updateName(tid: number, value: unknown, actor = 'admin'): string {
    return withEventTransaction(tid, () => this.updateNameCommand(tid, value, actor));
  }

  private updateNameCommand(tid: number, value: unknown, actor: string): string {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    const name = validateTournamentName(value);
    getDb().prepare('UPDATE tournaments SET name=?, updated_at=? WHERE id=?').run(name, new Date().toISOString(), tid);
    logEvent(tid, 'tournament', 'tournament_name', name, actor);
    persistMeta(tid);
    return name;
  }

  // per-tournament token-auth toggle (dev_docs/07 §5.3): off allows same-machine testing
  setAuthRequired(tid: number, required: boolean, actor: string): void {
    withEventTransaction(tid, () => this.setAuthRequiredCommand(tid, required, actor));
  }

  private setAuthRequiredCommand(tid: number, required: boolean, actor: string): void {
    if (loadState(tid).frozen) throw new Error('FROZEN');
    const state = loadState(tid);
    const cfg = { ...getConfig(state), authRequired: required };
    logEvent(tid, 'tournament', 'config', cfg, actor);
    getDb().prepare('UPDATE tournaments SET auth_required=? WHERE id=?').run(required ? 1 : 0, tid);
    persistMeta(tid);
  }

  list(): { id: number; name: string; status: string; createdBy: string }[] {
    return getDb()
      .prepare('SELECT id, name, status, created_by AS createdBy FROM tournaments ORDER BY id DESC LIMIT 50')
      .all() as { id: number; name: string; status: string; createdBy: string }[];
  }

  stateForPlayer(tid: number, playerId: string) {
    const state = loadState(tid);
    // 未加入比赛的玩家 URL 应失效（前端据此跳回报名页）
    if (!state.players.some((pl) => pl.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    const cfg = getConfig(state);
    const picks = state.picks.filter((p) => p.playerId === playerId);
    const orderedPlayers = state.players.slice().sort((a, b) => a.seat - b.seat);
    const remainingOf = (packIndex: number): number[] => {
      const pk = state.packs.find((p) => p.index === packIndex);
      if (!pk) return [];
      const taken = new Map<number, number>();
      for (const p of state.picks.filter((p) => p.packIndex === packIndex)) taken.set(p.card, (taken.get(p.card) ?? 0) + 1);
      return pk.order.filter((c) => {
        const n = taken.get(c) ?? 0;
        if (n <= 0) return true;
        taken.set(c, n - 1);
        return false;
      });
    };
    const passing = Object.keys(state.packQueues ?? {}).length > 0;
    let pack: Record<string, unknown> | null = null;
    let queueLengths: { playerId: string; length: number }[] | undefined;
    if (passing) {
      // passing：所有人可见各玩家队列长度（仅数量）；本人队首堆内容仅本人可见
      queueLengths = orderedPlayers.map((p) => ({ playerId: p.playerId, length: state.packQueues[p.playerId]?.length ?? 0 }));
      if (state.status === 'drafting') {
        const queue = state.packQueues[playerId] ?? [];
        const head = queue.length ? state.packs.find((p) => p.index === queue[0]) : null;
        if (head) {
          const remaining = remainingOf(head.index);
          const pausedRemainingMs = state.pause?.pausedAt
            ? state.pause.pausedDeadlines?.[playerId] ?? state.frozenTimers?.passing?.[playerId]
            : state.frozen
              ? state.frozenTimers?.passing?.[playerId]
              : undefined;
          pack = {
            index: head.index,
            cardsLeft: remaining.length,
            packsRemaining: queue.length,
            queueLength: queue.length,
            currentPicker: playerId,
            deadlineAt: pausedRemainingMs === undefined ? (state.pickDeadlines[playerId] ?? null) : null,
            pausedRemainingMs,
            isMyTurn: true, // passing：队列非空即可选
            // 本人剩余保留时间（ms）：deadlineAt - reserveMs = 基础时间用尽时刻
            reserveMs: state.pickReserves[playerId] ?? cfg.reserveSeconds * 1000,
            cards: remaining,
            droppedCard: head.dropCard,
          };
        }
      }
    } else {
      const isCurrentPicker = state.pickCursor?.playerId === playerId;
      const cur = state.pickCursor ? state.packs.find((p) => p.index === state.pickCursor!.packIndex) : null;
      // info hiding: the current picker sees only the REMAINING cards of the pack —
      // already-picked cards' codes are never sent (dev_docs/05 §3)
      const remaining = cur ? remainingOf(cur.index) : [];
      const pausedRemainingMs = state.pause?.pausedAt
        ? state.pause.pausedPickRemainingMs ?? state.frozenTimers?.serial
        : state.frozen
          ? state.frozenTimers?.serial
          : undefined;
      pack = cur
        ? {
            index: cur.index,
            cardsLeft: remaining.length,
            packsRemaining: state.packs.length - cur.index,
            currentPicker: state.pickCursor!.playerId,
            deadlineAt: pausedRemainingMs === undefined ? state.pickCursor!.deadlineAt : null,
            pausedRemainingMs,
            isMyTurn: isCurrentPicker,
            cards: isCurrentPicker ? remaining : undefined,
            droppedCard: cur.dropCard,
          }
        : null;
    }
    // 完整 passing 轮中，每轮 n 个同尺寸牌堆，每名玩家必得该尺寸张数；
    // 因而可精确显示本人到结束还能获得多少张，与异步选牌进度无关。
    const n = orderedPlayers.length;
    const fullFairRounds = passing && n > 0 && state.packs.length % n === 0 && state.packs.every((pack, index, packs) => {
      const roundStart = Math.floor(index / n) * n;
      return pack.size === packs[roundStart].size;
    });
    const fairRoundCount = state.pendingPhase === 'deckbuilding'
      ? Math.ceil(state.packsDealt / Math.max(1, n))
      : state.packs.length / Math.max(1, n);
    const targetCards = fullFairRounds
      ? Array.from({ length: fairRoundCount }, (_, round) => state.packs[round * n].size).reduce((a, b) => a + b, 0)
      : Math.ceil(state.packs.reduce((sum, p) => sum + p.size, 0) / Math.max(1, n));
    return {
      id: state.id,
      name: state.name,
      status: state.status,
      round: state.round,
      frozen: state.frozen,
      config: cfg,
      players: orderedPlayers.map((p) => ({ playerId: p.playerId, displayName: p.displayName, seat: p.seat, eliminated: p.eliminated, withdrawn: p.withdrawn === true, ready: p.ready === true })),
      pickedCards: picks.map((p) => p.card),
      cardsRemainingToDraft: Math.max(0, targetCards - picks.length),
      cardsRemainingExact: fullFairRounds,
      disqualified: state.players.find((p) => p.playerId === playerId)?.eliminated === true,
      poolInfo: { name: String(cfg.cardPool ?? 'full'), count: this.poolsCodes(cfg) },
      pack,
      draftReserveMs: passing ? (state.pickReserves[playerId] ?? cfg.reserveSeconds * 1000) : undefined,
      // 仅返回本人的最后点击候选牌；其余玩家的候选牌保持私有。
      pickAlternative: state.pickAlternatives?.[playerId]?.card ?? null,
      queueLengths,
      pause: state.pause,
      // Never disclose private initial drops through the player-facing state;
      // adminState remains the authoritative full view.
      droppedCards: cfg.dropPublic === true ? state.droppedCards : [],
      phaseDeadline: state.frozen && state.frozenTimers?.deckbuilding !== undefined ? null : state.phaseDeadline,
      phaseDeadlineRemainingMs: state.frozen ? state.frozenTimers?.deckbuilding : undefined,
      pendingPhase: state.pendingPhase,
      deck: state.decks[playerId],
      matches: state.matches
        .filter((m) => m.round === state.round && (m.playerA === playerId || m.playerB === playerId))
        .map((m) => ({ ...m, opponent: m.playerA === playerId ? m.playerB : m.playerA })),
    };
  }

  // 管理台事件时间线：按 seq 分页（全局 seq + 可读摘要），供回溯选择。
  // detail 用于前端 hover；保留关键字段（尤其是选中的 exact card code），
  // 但不把 packs/decks 的超大完整 payload 直接塞进列表响应。
  events(tid: number, options: { limit?: number; before?: number } = {}): { seq: number; entity: string; action: string; summary: string; detail: string; createdAt: string; actor: string }[] {
    const limit = options.limit === undefined ? 1_000 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('BAD_PAYLOAD');
    const before = options.before === undefined ? Number.MAX_SAFE_INTEGER : options.before;
    if (!Number.isSafeInteger(before) || before < 1) throw new Error('BAD_PAYLOAD');
    const rows = getDb()
      .prepare('SELECT seq, entity, action, payload_json, created_at, actor FROM events WHERE tournament_id=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(tid, before, limit) as { seq: number; entity: string; action: string; payload_json: string; created_at: string; actor: string }[];
    // Preserve the historical ascending display order while limiting the
    // query to the newest page. Clients can request older pages with before.
    rows.reverse();
    return rows.map((e) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(e.payload_json); } catch { /* ignore */ }
      const p = payload as Record<string, any>;
      let summary = e.action;
      if (e.entity === 'player' && e.action === 'player_join') summary = `报名 ${p.playerId}`;
      else if (e.entity === 'player' && e.action === 'player_rename') summary = `昵称修改 ${p.playerId} → ${p.displayName}`;
      else if (e.entity === 'player' && e.action === 'player_remove') summary = `删除玩家 ${p}`;
      else if (e.entity === 'player' && e.action === 'seat_assign') summary = '座位分配';
      else if (e.entity === 'player' && e.action === 'player_dsq') summary = `DSQ ${p.playerId}（${p.reason ?? '卡组不合规'}）`;
      else if (e.entity === 'pack' && e.action === 'packs_created') summary = `牌堆生成（${(p.packs ?? []).length} 堆${p.droppedCards?.length ? `，弃置 ${p.droppedCards.length} 张` : ''}${p.queues ? '，传递式' : ''}）`;
      else if (e.entity === 'draft' && e.action === 'deadlines') summary = '选牌计时重设';
      else if (e.entity === 'draft' && e.action === 'cursor') summary = p ? `牌堆 ${p.packIndex} → ${p.playerId}` : '选牌结束';
      else if (e.entity === 'pick' && e.action === 'pick') summary = `选牌 ${p.playerId} #${p.card}${p.auto ? '（超时自动）' : ''}`;
      else if (e.entity === 'draft' && e.action === 'alternative') summary = `候选牌 ${p.playerId} #${p.card}`;
      else if (e.entity === 'draft' && e.action === 'reserve') summary = `保留时间 +${p.addedSeconds ?? Math.round(Number(p.deltaMs ?? 0) / 1000)} 秒（${p.playerId}）`;
      else if (e.entity === 'pause' && e.action === 'pause') summary = p?.pausedAt ? '暂停' : '恢复';
      else if (e.entity === 'tournament' && e.action === 'phase') summary = p.status === 'registration' && (p.round ?? 0) === 0 ? `创建比赛（${e.actor}）` : `阶段 → ${p.status} r${p.round ?? ''}`;
      else if (e.entity === 'tournament' && e.action === 'config') summary = '参数修改';
      else if (e.entity === 'tournament' && e.action === 'frozen') summary = !p ? '解冻' : '冻结';
      else if (e.entity === 'deck' && e.action === 'deck') summary = `卡组 ${p.playerId}`;
      else if (e.entity === 'match' && e.action === 'match') summary = `对局 r${p.round}t${p.tableNo}${p.resultA !== null ? ` ${p.resultA}:${p.resultB}` : '（安排）'}`;
      let detail: string;
      if (e.entity === 'pick' && e.action === 'pick') {
        detail = [
          `玩家：${p.playerId}`,
          `选择卡牌：${p.card}`,
          `牌堆：${p.packIndex} · 该堆第 ${Number(p.round ?? 0) + 1} 张`,
          p.auto ? '来源：超时自动选择' : '来源：玩家选择',
        ].join('\n');
      } else if (e.entity === 'draft' && e.action === 'reserve') {
        detail = [
          `玩家：${p.playerId}`,
          `增加：${p.addedSeconds ?? Math.round(Number(p.deltaMs ?? 0) / 1000)} 秒`,
          `当前保留：${p.reserves?.[p.playerId] !== undefined ? `${Math.ceil(Number(p.reserves[p.playerId]) / 1000)} 秒` : '未知'}`,
          `当前 deadline：${p.deadlines?.[p.playerId] ?? '无'}`,
        ].join('\n');
      } else if (e.entity === 'draft' && e.action === 'alternative') {
        detail = `玩家：${p.playerId}\n候选牌：${p.card}\n牌堆：${p.packIndex}`;
      } else if (e.entity === 'deck' && e.action === 'deck') {
        detail = `玩家：${p.playerId}\n主卡组：${p.deck?.main?.length ?? 0} 张\n额外卡组：${p.deck?.extra?.length ?? 0} 张\n副卡组：${p.deck?.side?.length ?? 0} 张`;
      } else if (e.entity === 'draft' && e.action === 'cursor') {
        detail = p
          ? `牌堆：${p.packIndex}\n轮次：${p.round}\n当前玩家：${p.playerId}\ndeadline：${p.deadlineAt ?? '无'}`
          : '选牌已结束';
      } else if (e.entity === 'player' && e.action === 'player_rename') {
        detail = `玩家：${p.playerId}\n新显示名称：${p.displayName}`;
      } else if (e.entity === 'pause' && e.action === 'pause') {
        detail = p?.pausedAt ? `管理员暂停：${p.actor ?? e.actor ?? '未知'}\n暂停时间：${p.pausedAt}` : '管理员已恢复比赛';
      } else {
        try {
          const raw = JSON.stringify(payload, null, 2);
          detail = raw.length > 1600 ? `${raw.slice(0, 1597)}...` : raw;
        } catch {
          detail = String(payload);
        }
      }
      if (e.entity === 'tournament' && e.action === 'phase' && p.status === 'registration' && (p.round ?? 0) === 0) {
        detail = `创建者：${e.actor}\n比赛进入报名阶段`;
      }
      return { seq: e.seq, entity: e.entity, action: e.action, summary, detail, createdAt: e.created_at, actor: e.actor };
    });
  }

  adminState(tid: number) {
    const state = loadState(tid);
    const cfg = getConfig(state);
    const row = getDb().prepare('SELECT auth_required FROM tournaments WHERE id=?').get(tid) as { auth_required: number } | undefined;
    return {
      id: state.id,
      name: state.name,
      createdBy: state.createdBy,
      status: state.status,
      round: state.round,
      frozen: state.frozen,
      authRequired: row ? row.auth_required !== 0 : true,
      config: cfg,
      players: state.players,
      packs: state.packs.map((p) => ({ index: p.index, size: p.size, dropCard: p.dropCard, order: p.order })),
      droppedCards: state.droppedCards,
      phaseDeadline: state.phaseDeadline,
      pendingPhase: state.pendingPhase,
      picks: state.picks,
      pickCursor: state.pickCursor,
      packQueues: state.packQueues,
      pickDeadlines: state.pickDeadlines,
      packsDealt: state.packsDealt,
      pickReserves: state.pickReserves,
      pickAlternatives: state.pickAlternatives,
      pause: state.pause,
      decks: state.decks,
      matches: state.matches,
      pickSummary: state.players.map((p) => ({
        playerId: p.playerId,
        seat: p.seat,
        count: state.picks.filter((x) => x.playerId === p.playerId).length,
      })),
    };
  }
}
