import { BadRequestException, Injectable } from '@nestjs/common';
import { getDb } from '../db';
import { config, defaults } from '../config';
import { logEvent, loadState, persistMeta, getConfig, TournamentState } from '../events/events.service';
import crypto from 'crypto';
import { sha256 } from '../auth/auth.guard';
import { PoolsService } from '../pools/pools.service';

export type DropMode = 'use_all' | 'drop_leftover' | 'drop_leftover_exact';

// 玩家 token 词表：3 个单词用 '-' 连接，方便口述与记忆（如 "ember-frost-nova"）
const TOKEN_WORDS = [
  'ember', 'frost', 'gale', 'haze', 'iron', 'jade', 'kite', 'lark', 'mist', 'nova',
  'onyx', 'pearl', 'quartz', 'raven', 'slate', 'tide', 'umbra', 'vale', 'wisp', 'yew',
  'amber', 'briar', 'cedar', 'dusk', 'elm', 'fern', 'grove', 'holly', 'iris', 'juniper',
  'acorn', 'bloom', 'cinder', 'dove', 'echo', 'flint', 'glade', 'heron', 'ivy', 'lynx',
  'maple', 'oak', 'pine', 'reed', 'snow', 'thorn', 'willow', 'zephyr', 'basil', 'clover',
  'drift', 'ember', 'falcon', 'gnome', 'harbor', 'indigo', 'jasmine', 'kestrel', 'lotus',
  'meadow', 'nettle', 'orchid', 'poppy', 'quill', 'robin', 'saffron', 'thistle', 'violet',
  'wren', 'yarrow', 'boulder', 'coral', 'denim', 'falcon', 'garnet', 'hazel', 'iris',
  'juniper', 'knot', 'lagoon', 'moss', 'nutmeg', 'opal', 'pumice', 'quince', 'raven',
  'sable', 'tangerine', 'umber', 'verbena', 'walnut', 'xenon', 'yonder', 'zinnia',
];

export function randomToken(): string {
  const pick = () => TOKEN_WORDS[Math.floor(Math.random() * TOKEN_WORDS.length)];
  return `${pick()}-${pick()}-${pick()}`;
}

export interface CreateTournamentInput {
  name: string;
  maxPlayers: number;
  mode?: 'single' | 'match';
  packSize?: number; // 每堆卡牌数（任意正整数）；旧参数 packSizeMultiple=每堆为 人数×倍数 的兼容字段
  packSizeMultiple?: number;
  pickSeconds?: number;
  deckbuildingSeconds?: number;
  mainMin?: number;
  mainMax?: number;
  extraMax?: number;
  sideMax?: number;
  maxCopies?: number;
  timeLimit?: number; // per-turn seconds, forwarded to the duel host (srvpro TIME token; 999 ≈ unlimited)
  // 剩余卡处理（dev_docs/05 §3）—— legacy：仅未显式设置 packCount 时生效（旧比赛回放兼容）：
  //  use_all            = 所有卡进牌堆，最后一堆可不满
  //  drop_leftover      = 只丢弃无法整除的余数（默认，不要求牌堆数是玩家数倍数）
  //  drop_leftover_exact= 丢弃余数且要求牌堆数是玩家数倍数
  dropMode?: DropMode;
  // 旧参数兼容：dropLeftover=true → drop_leftover_exact，false → use_all
  dropLeftover?: boolean;
  // 牌堆构成策略：stratify（默认，主/额外按比例均匀每堆）| random | main_then_extra
  packStrategy?: 'stratify' | 'random' | 'main_then_extra';
  // 牌堆总数（轮数）：≤ floor(池卡数/packSize) = 固定堆数，剩余卡全部随机丢弃；
  // > 该上限 = 推断为"用全部卡池"（堆数 = ceil(池卡数/packSize)，末堆可不满，不丢弃）；缺省按 dropMode 自动
  packCount?: number;
  // 丢弃的卡牌是否公开（默认公开；false 时只移除不展示）
  dropPublic?: boolean;
  // 选牌模式：passing（默认，每玩家牌堆队列传递式）| serial（旧全局串行，兼容用）
  draftMode?: 'passing' | 'serial';
  // 牌堆数须为人数整数倍（默认开；显式 packCount 非倍数在 startDraft 拒绝 PACKCOUNT_NOT_MULTIPLE）
  evenPackCount?: boolean;
  // passing 模式每玩家保留时间（秒，默认 300）：单选超时先扣 reserve，耗尽才自动选
  reserveSeconds?: number;
  cardPool?: string;
}

@Injectable()
export class TournamentsService {
  constructor(private pools: PoolsService) {}

  // cardPool must name an existing pool; 'full' is rejected on write paths
  // (PoolsService.resolve still understands legacy 'full' configs).
  private assertCardPool(cardPool: unknown): string {
    if (typeof cardPool !== 'string' || !cardPool.trim()) throw new BadRequestException({ code: 'BAD_PAYLOAD' });
    const name = cardPool.trim();
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

  create(input: CreateTournamentInput, actor: string): { tid: number; url: string; admin_token: string } {
    const cfg = {
      maxPlayers: input.maxPlayers,
      mode: input.mode ?? 'match',
      packSize: input.packSize ?? (input.packSizeMultiple === undefined ? defaults.packSize : undefined),
      packSizeMultiple: input.packSizeMultiple ?? defaults.packSizeMultiple,
      pickSeconds: input.pickSeconds ?? defaults.pickSeconds,
      pauseSeconds: defaults.pauseSeconds,
      deckbuildingSeconds: input.deckbuildingSeconds ?? defaults.deckbuildingSeconds,
      dropLeftover: input.dropLeftover !== false,
      dropMode:
        input.dropMode ??
        (input.dropLeftover === undefined
          ? 'drop_leftover'
          : input.dropLeftover
            ? 'drop_leftover_exact'
            : 'use_all'),
      packStrategy: input.packStrategy ?? 'stratify',
      packCount: input.packCount,
      dropPublic: input.dropPublic !== false,
      // 仅 serial 需要落配置（缺省 passing 由 defaults 提供；startDraft 只认 rawCfg.draftMode==='serial'）
      draftMode: input.draftMode === 'serial' ? 'serial' : undefined,
      evenPackCount: input.evenPackCount !== false,
      reserveSeconds: input.reserveSeconds ?? defaults.reserveSeconds,
      mainMin: input.mainMin ?? defaults.mainMin,
      mainMax: input.mainMax ?? defaults.mainMax,
      extraMax: input.extraMax ?? defaults.extraMax,
      sideMax: input.sideMax ?? defaults.sideMax,
      maxCopies: input.maxCopies ?? defaults.maxCopies,
      timeLimit: input.timeLimit ?? defaults.timeLimit,
      cardPool: this.assertCardPool(input.cardPool),
    };
    // per-tournament admin token (dev_docs/07 §5.1): manages this tournament only
    const adminToken = crypto.randomBytes(24).toString('hex');
    const now = new Date().toISOString();
    const row = getDb()
      .prepare(
        'INSERT INTO tournaments (name, config_json, status, round, created_at, updated_at, admin_token_hash) VALUES (?,?,?,?,?,?,?)',
      )
      .run(input.name, JSON.stringify(cfg), 'registration', 0, now, now, sha256(adminToken));
    const tid = Number(row.lastInsertRowid);
    logEvent(tid, 'tournament', 'phase', { status: 'registration', round: 0 }, actor);
    return { tid, url: `/t/${tid}`, admin_token: adminToken };
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
      players: state.players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, seat: p.seat })),
      playerCount: state.players.length,
      frozen: state.frozen,
      authRequired: row ? row.auth_required !== 0 : true,
    };
  }

  join(tid: number, playerId: string, displayName: string): { token: string } {
    // 进房昵称即玩家 ID：YGOPro 协议仅支持 ASCII 文本，非 ASCII 无法进入游戏（前端已拦截，这里兜底）
    if (!/^[\x20-\x7E]+$/.test(playerId)) throw new Error('BAD_PLAYER_ID');
    const state = loadState(tid);
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    if (state.players.length >= getConfig(state).maxPlayers) throw new Error('TOURNAMENT_FULL');
    if (state.players.some((p) => p.playerId === playerId)) throw new Error('ALREADY_JOINED');
    const token = randomToken();
    // OR REPLACE：管理台回溯到报名前之后重新报名同名玩家时，DB 行可能残留（revert 只回滚事件状态）
    getDb()
      .prepare('INSERT OR REPLACE INTO tournament_players (tournament_id, player_id, display_name, token_hash, seat, joined_at) VALUES (?,?,?,?,?,?)')
      .run(tid, playerId, displayName, sha256(token), null, new Date().toISOString());
    logEvent(tid, 'player', 'player_join', { playerId, displayName, seat: -1, eliminated: false }, playerId);
    return { token };
  }

  setSeats(tid: number, order: string[], actor: string): void {
    const state = loadState(tid);
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    const map: Record<string, number> = {};
    order.forEach((pid, i) => (map[pid] = i));
    logEvent(tid, 'player', 'seat_assign', map, actor);
    persistMeta(tid);
  }

  // 管理台删除玩家：报名/选牌/构筑阶段可删（同时清理其选牌与卡组），对战开始后禁止
  removePlayer(tid: number, playerId: string, actor: string): void {
    const state = loadState(tid);
    if (state.status === 'matches' || state.status === 'finished') throw new Error('WRONG_PHASE');
    if (!state.players.some((p) => p.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    getDb().prepare('DELETE FROM tournament_players WHERE tournament_id=? AND player_id=?').run(tid, playerId);
    logEvent(tid, 'player', 'player_remove', playerId, actor);
    persistMeta(tid);
  }

  // 管理台重置玩家 token（token 只存哈希无法回显，重置后返回新明文）
  resetPlayerToken(tid: number, playerId: string): { token: string } {
    const state = loadState(tid);
    if (!state.players.some((p) => p.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    const token = randomToken();
    getDb().prepare('UPDATE tournament_players SET token_hash=? WHERE tournament_id=? AND player_id=?').run(sha256(token), tid, playerId);
    return { token };
  }

  // 阶段迁移规则（dev_docs/05 §3.2）：
  // - registration 不能直接进入 deckbuilding（必须开始选牌）；
  // - drafting -> deckbuilding（手动）：serial 若当前牌堆未选完 / passing 若本轮队列未空，置 pendingPhase，
  //   等当前牌堆/本轮选完后进入（进度保留）；
  // - deckbuilding -> drafting（回退）：允许，选牌从保留的光标处继续。
  setPhase(tid: number, status: string, round: number | undefined, actor: string): void {
    const state = loadState(tid);
    state.frozen = false;
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
    const state = loadState(tid);
    const cfg = getConfig(state);
    const deadlineAt = new Date(Date.now() + (cfg.deckbuildingSeconds as number) * 1000).toISOString();
    logEvent(tid, 'tournament', 'phase', { status: 'deckbuilding', round: 0, deadlineAt }, actor);
    persistMeta(tid);
  }

  // 开始选牌前可调整任何参数（含卡池），dev_docs/05 §2
  updateConfig(tid: number, patch: Record<string, unknown>, actor: string): Record<string, unknown> {
    const state = loadState(tid);
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    if (patch.cardPool !== undefined) patch = { ...patch, cardPool: this.assertCardPool(patch.cardPool) };
    const cfg = { ...getConfig(state), ...patch };
    if (typeof cfg.maxPlayers === 'number' && cfg.maxPlayers < state.players.length) {
      throw new Error('TOURNAMENT_FULL');
    }
    logEvent(tid, 'tournament', 'config', cfg, actor);
    persistMeta(tid);
    return cfg;
  }

  // per-tournament token-auth toggle (dev_docs/07 §5.3): off allows same-machine testing
  setAuthRequired(tid: number, required: boolean, actor: string): void {
    const state = loadState(tid);
    const cfg = { ...getConfig(state), authRequired: required };
    logEvent(tid, 'tournament', 'config', cfg, actor);
    getDb().prepare('UPDATE tournaments SET auth_required=? WHERE id=?').run(required ? 1 : 0, tid);
    persistMeta(tid);
  }

  list(): { id: number; name: string; status: string }[] {
    return getDb()
      .prepare('SELECT id, name, status FROM tournaments ORDER BY id DESC LIMIT 50')
      .all() as { id: number; name: string; status: string }[];
  }

  stateForPlayer(tid: number, playerId: string) {
    const state = loadState(tid);
    // 未加入比赛的玩家 URL 应失效（前端据此跳回报名页）
    if (!state.players.some((pl) => pl.playerId === playerId)) throw new Error('PLAYER_NOT_FOUND');
    const cfg = getConfig(state);
    const picks = state.picks.filter((p) => p.playerId === playerId);
    const remainingOf = (packIndex: number): number[] => {
      const pk = state.packs.find((p) => p.index === packIndex);
      if (!pk) return [];
      const taken = new Set(state.picks.filter((p) => p.packIndex === packIndex).map((p) => p.card));
      return pk.order.filter((c) => !taken.has(c));
    };
    const passing = Object.keys(state.packQueues ?? {}).length > 0;
    let pack: Record<string, unknown> | null = null;
    let queueLengths: { playerId: string; length: number }[] | undefined;
    if (passing) {
      // passing：所有人可见各玩家队列长度（仅数量）；本人队首堆内容仅本人可见
      queueLengths = state.players.map((p) => ({ playerId: p.playerId, length: state.packQueues[p.playerId]?.length ?? 0 }));
      if (state.status === 'drafting') {
        const queue = state.packQueues[playerId] ?? [];
        const head = queue.length ? state.packs.find((p) => p.index === queue[0]) : null;
        if (head) {
          const remaining = remainingOf(head.index);
          pack = {
            index: head.index,
            cardsLeft: remaining.length,
            packsRemaining: queue.length,
            queueLength: queue.length,
            currentPicker: playerId,
            deadlineAt: state.pickDeadlines[playerId] ?? null,
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
      pack = cur
        ? {
            index: cur.index,
            cardsLeft: remaining.length,
            packsRemaining: state.packs.length - cur.index,
            currentPicker: state.pickCursor!.playerId,
            deadlineAt: state.pickCursor!.deadlineAt,
            isMyTurn: isCurrentPicker,
            cards: isCurrentPicker ? remaining : undefined,
            droppedCard: cur.dropCard,
          }
        : null;
    }
    return {
      id: state.id,
      name: state.name,
      status: state.status,
      round: state.round,
      frozen: state.frozen,
      config: cfg,
      players: state.players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, seat: p.seat })),
      pickedCards: picks.map((p) => p.card),
      poolInfo: { name: String(cfg.cardPool ?? 'full'), count: this.poolsCodes(cfg) },
      pack,
      queueLengths,
      pause: state.pause,
      droppedCards: state.droppedCards,
      phaseDeadline: state.phaseDeadline,
      pendingPhase: state.pendingPhase,
      deck: state.decks[playerId],
      matches: state.matches
        .filter((m) => m.round === state.round && (m.playerA === playerId || m.playerB === playerId))
        .map((m) => ({ ...m, opponent: m.playerA === playerId ? m.playerB : m.playerA })),
    };
  }

  // 管理台事件时间线：完整事件列表（全局 seq + 可读摘要），供回溯选择
  events(tid: number): { seq: number; entity: string; action: string; summary: string; createdAt: string }[] {
    const rows = getDb()
      .prepare('SELECT seq, entity, action, payload_json, created_at FROM events WHERE tournament_id=? ORDER BY seq')
      .all(tid) as { seq: number; entity: string; action: string; payload_json: string; created_at: string }[];
    return rows.map((e) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(e.payload_json); } catch { /* ignore */ }
      const p = payload as Record<string, any>;
      let summary = e.action;
      if (e.entity === 'player' && e.action === 'player_join') summary = `报名 ${p.playerId}`;
      else if (e.entity === 'player' && e.action === 'player_remove') summary = `删除玩家 ${p}`;
      else if (e.entity === 'player' && e.action === 'seat_assign') summary = '座位分配';
      else if (e.entity === 'pack' && e.action === 'packs_created') summary = `牌堆生成（${(p.packs ?? []).length} 堆${p.droppedCards?.length ? `，弃置 ${p.droppedCards.length} 张` : ''}${p.queues ? '，传递式' : ''}）`;
      else if (e.entity === 'draft' && e.action === 'deadlines') summary = '选牌计时重设';
      else if (e.entity === 'draft' && e.action === 'cursor') summary = p ? `牌堆 ${p.packIndex} → ${p.playerId}` : '选牌结束';
      else if (e.entity === 'draft' && e.action === 'pick') summary = `选牌 ${p.playerId} #${p.card}${p.auto ? '（超时自动）' : ''}`;
      else if (e.entity === 'draft' && e.action === 'pause') summary = p?.pausedAt ? '暂停' : '恢复';
      else if (e.entity === 'tournament' && e.action === 'phase') summary = `阶段 → ${p.status} r${p.round ?? ''}`;
      else if (e.entity === 'tournament' && e.action === 'config') summary = '参数修改';
      else if (e.entity === 'tournament' && e.action === 'frozen') summary = !p ? '解冻' : '冻结';
      else if (e.entity === 'deck' && e.action === 'deck') summary = `卡组 ${p.playerId}`;
      else if (e.entity === 'match' && e.action === 'match') summary = `对局 r${p.round}t${p.tableNo}${p.resultA !== null ? ` ${p.resultA}:${p.resultB}` : '（安排）'}`;
      return { seq: e.seq, entity: e.entity, action: e.action, summary, createdAt: e.created_at };
    });
  }

  adminState(tid: number) {
    const state = loadState(tid);
    const cfg = getConfig(state);
    const row = getDb().prepare('SELECT auth_required FROM tournaments WHERE id=?').get(tid) as { auth_required: number } | undefined;
    return {
      id: state.id,
      name: state.name,
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
