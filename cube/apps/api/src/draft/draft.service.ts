import { Injectable, OnModuleInit } from '@nestjs/common';
import { loadState, logEvent, getConfig, persistMeta, TournamentState, PickState } from '../events/events.service';
import { CardsService } from '../cards/cards.service';
import { TournamentsService } from '../tournaments/tournaments.service';
import { PoolsService } from '../pools/pools.service';
import { MatchesService } from '../matches/matches.service';
import { DecksService } from '../decks/decks.service';

// Draft engine: pack generation, pick timers with server-side auto-pick,
// pause voting, deckbuilding deadline (dev_docs/05 §3).
// 两种模式：
//  - passing（默认）：每玩家 FIFO 牌堆队列，队首堆选 1 张后顺时针传递，各自独立计时；
//  - serial（旧兼容）：全局单光标蛇形轮转。运行时按状态形状分派
//    （packs_created 事件带 queues 即 passing），旧比赛回放/进行中行为不变。
@Injectable()
export class DraftService implements OnModuleInit {
  private timers = new Map<number, NodeJS.Timeout>();
  private passTimers = new Map<string, NodeJS.Timeout>(); // passing 模式：key = `${tid}:${playerId}`
  private deckbuildingTimers = new Map<number, NodeJS.Timeout>();
  private pauseTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private cards: CardsService,
    private tournaments: TournamentsService,
    private pools: PoolsService,
    private matches: MatchesService,
  ) {}

  // passing 模式判定：packs_created 事件携带 queues 即启用（与配置无关，回放安全）
  private isPassing(state: TournamentState): boolean {
    return Object.keys(state.packQueues ?? {}).length > 0;
  }

  onModuleInit(): void {
    // re-arm timers after restart (all state server-side; deadlines persisted)
    const db = require('../db').getDb();
    const rows = db.prepare('SELECT id FROM tournaments WHERE status=?').all('drafting') as { id: number }[];
    for (const r of rows) {
      try {
        const state = loadState(r.id);
        if (state.frozen) continue;
        if (state.pause?.pausedAt) {
          const elapsed = Math.max(0, Date.now() - new Date(state.pause.pausedAt).getTime());
          const pauseLeft = Math.max(0, state.pause.remainingMs - elapsed);
          if (pauseLeft <= 0) this.pauseExpired(r.id);
          else this.armPauseTimer(r.id, pauseLeft);
          continue;
        }
        if (this.isPassing(state)) {
          for (const p of state.players) this.armPassTimer(r.id, p.playerId);
        } else if (state.pickCursor?.deadlineAt) {
          this.armTimer(state);
        }
      } catch (e) {
        console.error('re-arm failed for tournament', r.id, e);
      }
    }
    const deckRows = db.prepare('SELECT id FROM tournaments WHERE status=?').all('deckbuilding') as { id: number }[];
    for (const r of deckRows) {
      try {
        if (loadState(r.id).frozen) continue;
        this.armDeckbuildingTimer(r.id);
      } catch (e) {
        console.error('re-arm deckbuilding failed for tournament', r.id, e);
      }
    }
  }

  startDraft(tid: number, actor: string): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'registration') throw new Error('WRONG_PHASE');
    const cfg = getConfig(state);
    const rawCfg = JSON.parse(state.configJson) as Record<string, unknown>;
    const n = state.players.length;
    if (n < 2) throw new Error('NOT_ENOUGH_PLAYERS');
    // seats: join order unless admin assigned
    const seats = state.players.map((p) => (p.seat >= 0 ? p.seat : -1));
    let next = 0;
    const order: string[] = [];
    for (let i = 0; i < n; i++) {
      if (seats[i] < 0) {
        while (order.includes(state.players[next].playerId)) next++;
        order.push(state.players[next].playerId);
      }
    }
    const seatMap: Record<string, number> = {};
    // 注意：order 只含未分配座位的玩家；管理员预分配 seat>=0 的玩家不在其中，
    // 不得用 indexOf（会得到 -1 覆盖其座位）——只为 order 内的玩家写 seatMap
    state.players.forEach((p) => {
      const idx = order.indexOf(p.playerId);
      if (idx >= 0) seatMap[p.playerId] = idx;
    });
    // packs: shuffled pool (card pool or full card table), pack size = n * multiple, drop last (public)
    const poolCodes = this.pools.resolve(cfg.cardPool as string | undefined).slice();
    for (let i = poolCodes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [poolCodes[i], poolCodes[j]] = [poolCodes[j], poolCodes[i]];
    }
    // 剩余卡处理（dev_docs/05 §3，DropMode）：
    //  use_all            = 所有卡进牌堆，最后一堆可以不满（不做整除要求）
    //  drop_leftover      = 只丢弃无法整除的余数，不要求牌堆数是玩家数倍数
    //  drop_leftover_exact= 丢弃余数且要求牌堆数是玩家数倍数（旧 dropLeftover=true 行为）
    //  packCount 显式设置时优先：≤ 整除上限 floor(池卡数/packSize) = 固定牌堆总数，剩余卡全部随机丢弃；
    //  > 上限 = 不丢弃——用全部卡池，堆数 = ceil(池卡数/packSize)（末堆可不满）
    //  dropPublic=false 时丢弃卡牌不公开（只从卡池移除，不进入公开列表）
    const packSize = (rawCfg.packSize as number | undefined) ?? n * ((rawCfg.packSizeMultiple as number | undefined) ?? 3);
    const dropMode =
      cfg.dropMode === 'use_all' || cfg.dropMode === 'drop_leftover' || cfg.dropMode === 'drop_leftover_exact'
        ? cfg.dropMode
        : cfg.dropLeftover === false
          ? 'use_all'
          : 'drop_leftover_exact'; // 旧配置兼容
    const dropPublic = (rawCfg.dropPublic as boolean | undefined) === true; // 默认不公开丢弃列表
    const explicitPacks = (rawCfg.packCount as number | undefined) ?? 0;
    // evenPackCount（默认开）：牌堆数须为人数整数倍——显式 packCount 非倍数直接拒绝；
    // 自动/钳制结果向下取整到最大倍数（余数按 dropPublic 规则处理）；不足一整轮时兜底不取整
    const evenPackCount = (rawCfg.evenPackCount as boolean | undefined) !== false;
    let packCount: number;
    if (explicitPacks >= 1) {
      const want = Math.floor(explicitPacks);
      if (evenPackCount && want % n !== 0) throw new Error('PACKCOUNT_NOT_MULTIPLE');
      // 超过整除上限：推断为"用全部卡池"（末堆可不满），不丢弃；之后 evenPackCount 取整块仍可能产生弃置
      const maxFull = Math.floor(poolCodes.length / packSize);
      packCount = want <= maxFull ? want : Math.max(1, Math.ceil(poolCodes.length / packSize));
    } else if (dropMode === 'use_all') {
      packCount = Math.max(1, Math.ceil(poolCodes.length / packSize));
    } else {
      const rawCount = Math.floor(poolCodes.length / packSize);
      packCount = Math.max(1, dropMode === 'drop_leftover_exact' ? rawCount - (rawCount % n) : rawCount);
    }
    if (evenPackCount && packCount % n !== 0) {
      const m = packCount - (packCount % n);
      if (m >= n) packCount = m;
    }
    // Before arranging packs, choose the drafted subset with proportional
    // stratification. Therefore any initial random discard preserves the
    // pool's main/extra ratio (within unavoidable integer rounding), regardless
    // of the later pack display strategy.
    const shuffle = <T>(items: T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    const allMain: number[] = [];
    const allExtra: number[] = [];
    for (const code of poolCodes) {
      const info = this.cards.get(code);
      ((info && info.type & 0x4802040) ? allExtra : allMain).push(code);
    }
    const draftedCount = Math.min(poolCodes.length, packSize * packCount);
    const idealExtra = Math.round(draftedCount * (allExtra.length / Math.max(1, poolCodes.length)));
    const draftedExtraCount = Math.max(
      Math.max(0, draftedCount - allMain.length),
      Math.min(allExtra.length, idealExtra),
    );
    const draftedMainCount = draftedCount - draftedExtraCount;
    const draftedMain = allMain.slice(0, draftedMainCount);
    const draftedExtra = allExtra.slice(0, draftedExtraCount);
    const discardedPoolCodes = [...allMain.slice(draftedMainCount), ...allExtra.slice(draftedExtraCount)];

    // 牌堆构成策略（packStrategy）：
    //  stratify（默认）   = 主卡/额外卡按整体比例均匀分布到每一堆（各池先洗牌再按比例取）
    //  random             = 全卡池随机洗牌后顺序切堆
    //  main_then_extra    = 先排完全部主卡（跨堆），再接额外卡
    const strategy = cfg.packStrategy === 'random' || cfg.packStrategy === 'main_then_extra' ? cfg.packStrategy : 'stratify';
    let codes: number[];
    if (strategy === 'random') {
      codes = shuffle([...draftedMain, ...draftedExtra]);
    } else if (strategy === 'main_then_extra') {
      codes = [...draftedMain, ...draftedExtra];
    } else {
      // stratify: dynamically apportion every pack from the remaining drafted
      // main/extra cards, with bounds that always fill the requested pack.
      let mi = 0;
      let ei = 0;
      const per: number[][] = [];
      for (let k = 0; k < packCount; k++) {
        const size = Math.min(packSize, draftedCount - k * packSize);
        const remMain = draftedMain.length - mi;
        const remExtra = draftedExtra.length - ei;
        const minExtra = Math.max(0, size - remMain);
        const maxExtra = Math.min(size, remExtra);
        const proportionalExtra = Math.round(size * (remExtra / Math.max(1, remMain + remExtra)));
        const extraCount = Math.max(minExtra, Math.min(maxExtra, proportionalExtra));
        const mainCount = size - extraCount;
        per.push(shuffle([
          ...draftedMain.slice(mi, mi + mainCount),
          ...draftedExtra.slice(ei, ei + extraCount),
        ]));
        mi += mainCount;
        ei += extraCount;
      }
      codes = per.flat();
    }
    const droppedCards: number[] = dropPublic ? shuffle(discardedPoolCodes) : [];
    const draftMode = (rawCfg.draftMode as string | undefined) === 'serial' ? 'serial' : 'passing';
    const packs = [];
    for (let k = 0; k < packCount; k++) {
      const orderList = codes.slice(k * packSize, Math.min((k + 1) * packSize, codes.length));
      // serial：每堆起始偏移（packSize 为人数倍数时蛇形偏移；否则每堆随机起始玩家）；passing 不使用
      const startOffset =
        draftMode === 'serial' ? (packSize % n === 0 ? (n - (k % n)) % n : Math.floor(Math.random() * n)) : undefined;
      packs.push({ index: k, size: orderList.length, dropCard: null, startOffset, order: orderList });
    }
    // leftover pool cards are already randomly sampled and shuffled above.
    logEvent(tid, 'tournament', 'phase', { status: 'drafting', round: 0 }, actor);
    logEvent(tid, 'player', 'seat_assign', seatMap, actor);
    if (draftMode === 'serial') {
      logEvent(tid, 'pack', 'packs_created', { packs, droppedCards }, actor);
      // snake cursor: pack 0 starts with seat 0; each pack alternates direction
      this.advance(tid, actor, true);
    } else {
      // passing 按轮发堆：开局只发第 0 轮（堆 k → 座位 k）；一轮全空后由 dealRound 发下一轮
      const seatsArr = state.players.slice().sort((a, b) => a.seat - b.seat);
      const queues: Record<string, number[]> = {};
      const reserves: Record<string, number> = {};
      for (const p of seatsArr) {
        queues[p.playerId] = [];
        reserves[p.playerId] = cfg.reserveSeconds * 1000;
      }
      const dealt = Math.min(n, packCount);
      for (let k = 0; k < dealt; k++) queues[seatsArr[k].playerId].push(k);
      // deadline = 基础选牌时间 + 保留时间（超时先扣 reserve，耗尽才自动选）
      const deadlineAt = new Date(Date.now() + (cfg.pickSeconds + cfg.reserveSeconds) * 1000).toISOString();
      const deadlines: Record<string, string | null> = {};
      for (const p of seatsArr) deadlines[p.playerId] = queues[p.playerId].length ? deadlineAt : null;
      logEvent(tid, 'pack', 'packs_created', { packs, droppedCards, queues, deadlines, reserves, dealt }, actor);
      for (const p of seatsArr) this.armPassTimer(tid, p.playerId);
    }
    persistMeta(tid);
  }

  // picker at (packIndex, round): ALWAYS clockwise, each pack starts one seat further
  // on (dev_docs/05 §3): orders are 1-2-3, 3-1-2, 2-3-1, 1-2-3, ... so the last picker
  // of a pack picks first in the next pack (consecutive double pick), and with a pack
  // count that is a multiple of n every player occupies every position equally.
  // （仅 serial 模式使用）
  private pickerAt(state: TournamentState, packIndex: number, round: number): string {
    const n = state.players.length;
    const seats = state.players.slice().sort((a, b) => a.seat - b.seat);
    // 非倍数堆的每堆随机起始已在 packs 创建时定下；旧数据无 startOffset 时回退蛇形偏移
    const pack = state.packs.find((p) => p.index === packIndex);
    const startOffset = pack?.startOffset ?? (n - (packIndex % n)) % n;
    const pos = (round + startOffset) % n;
    return seats[pos].playerId;
  }

  private remainingInPack(state: TournamentState, packIndex: number): number[] {
    const pack = state.packs.find((p) => p.index === packIndex);
    if (!pack) return [];
    const taken = new Map<number, number>();
    for (const p of state.picks.filter((p) => p.packIndex === packIndex)) taken.set(p.card, (taken.get(p.card) ?? 0) + 1);
    return pack.order.filter((c) => {
      const n = taken.get(c) ?? 0;
      if (n <= 0) return true;
      taken.set(c, n - 1);
      return false;
    });
  }

  private isLastPickOfPack(state: TournamentState, packIndex: number): boolean {
    const pack = state.packs.find((p) => p.index === packIndex);
    return pack ? state.picks.filter((p) => p.packIndex === packIndex).length >= pack.order.length : true;
  }

  // ---------- serial 模式（旧兼容） ----------

  private advance(tid: number, actor: string, initial: boolean): void {
    const state = loadState(tid);
    const cur = state.pickCursor;
    let packIndex = 0;
    let round = 0;
    let playerId = this.pickerAt(state, 0, 0);
    if (!initial && cur) {
      if (this.isLastPickOfPack(state, cur.packIndex)) {
        // 手动进入构筑的请求：等当前牌堆选完后切换，进度（下一堆开头的光标）保留
        if (state.pendingPhase === 'deckbuilding') {
          logEvent(tid, 'draft', 'pending', null, actor);
          if (cur.packIndex + 1 < state.packs.length) {
            const next = cur.packIndex + 1;
            const first = this.pickerAt(state, next, 0);
            logEvent(tid, 'draft', 'cursor', { packIndex: next, round: 0, playerId: first, deadlineAt: null }, actor);
          } else {
            logEvent(tid, 'draft', 'cursor', null, actor);
          }
          this.tournaments.enterDeckbuilding(tid, actor);
          this.armDeckbuildingTimer(tid);
          return;
        }
        packIndex = cur.packIndex + 1;
        round = 0;
        playerId = this.pickerAt(state, packIndex, round);
      } else {
        packIndex = cur.packIndex;
        round = cur.round + 1;
        playerId = this.pickerAt(state, packIndex, round);
      }
    }
    if (packIndex >= state.packs.length) {
      // drafting complete
      logEvent(tid, 'draft', 'cursor', null, actor);
      this.tournaments.enterDeckbuilding(tid, actor);
      this.armDeckbuildingTimer(tid);
      return;
    }
    const cfg = getConfig(state);
    const deadlineAt = new Date(Date.now() + cfg.pickSeconds * 1000).toISOString();
    logEvent(tid, 'draft', 'cursor', { packIndex, round, playerId, deadlineAt }, actor);
    this.armTimer(loadState(tid));
    persistMeta(tid);
  }

  // 恢复（解冻）时：构筑倒计时按持久化 deadline 重新武装
  resumeDeckbuildingTimer(tid: number): void {
    this.armDeckbuildingTimer(tid);
  }

  // ---------- deckbuilding deadline (dev_docs/05 §4) ----------

  private armDeckbuildingTimer(tid: number): void {
    const old = this.deckbuildingTimers.get(tid);
    if (old) clearTimeout(old);
    const state = loadState(tid);
    if (state.status !== 'deckbuilding' || !state.phaseDeadline) return;
    const ms = new Date(state.phaseDeadline).getTime() - Date.now();
    if (ms <= 0) {
      this.deckbuildingTimeout(tid);
      return;
    }
    const t = setTimeout(() => this.deckbuildingTimeout(tid), ms);
    t.unref();
    this.deckbuildingTimers.set(tid, t);
  }

  // 时限到：未锁定的卡组随机补/删至合法，然后进入对战
  private deckbuildingTimeout(tid: number): void {
    let state: TournamentState;
    try {
      state = loadState(tid);
    } catch {
      return; // 比赛已被删除
    }
    if (state.status !== 'deckbuilding') return;
    if (state.frozen) {
      // 暂停期间构筑倒计时冻结：挂起，恢复后重新计时
      const t = setTimeout(() => this.deckbuildingTimeout(tid), 5000);
      t.unref();
      this.deckbuildingTimers.set(tid, t);
      return;
    }
    const decks = new DecksService(this.cards);
    for (const p of state.players.filter((player) => !player.eliminated && !player.withdrawn)) decks.repairForMatches(tid, p.playerId);
    // A previous admin transition may already have persisted round 1 before
    // returning the tournament to deckbuilding. In that recovery path the
    // existing matches are authoritative even if later deck repairs leave no
    // eligible player for a fresh-format validation.
    const hasRoundOne = loadState(tid).matches.some((match) => match.round === 1);
    if (!hasRoundOne) this.matches.validateStart(tid);
    this.tournaments.setPhase(tid, 'matches', 1, 'system');
    try {
      this.matches.startRound(tid, 1, 'system');
    } catch (e) {
      // round 1 已安排过（如管理员先进过对战又回退到构筑）：startRound 抛 ROUND_EXISTS。
      // 阶段已切到 matches 且对阵已存在，视为正常完成；定时器回调抛异常会导致 Node 进程崩溃。
      console.warn('deckbuilding timeout: round 1 already scheduled, skipping startRound', tid, (e as Error).message);
    }
  }

  private armTimer(state: TournamentState): void {
    this.clearTimer(state.id);
    if (!state.pickCursor?.deadlineAt) return;
    const ms = new Date(state.pickCursor.deadlineAt).getTime() - Date.now();
    if (ms <= 0) {
      this.autoPick(state.id);
      return;
    }
    const t = setTimeout(() => this.autoPick(state.id), ms);
    t.unref();
    this.timers.set(state.id, t);
  }

  private clearTimer(tid: number): void {
    const t = this.timers.get(tid);
    if (t) clearTimeout(t);
    this.timers.delete(tid);
  }

  // 管理员冻结（暂停）期间：选牌定时器挂起，解冻后重新计时（dev_docs/05 §3）
  haltPickTimer(tid: number): void {
    this.clearTimer(tid);
    this.clearPassTimers(tid);
  }

  // 管理员冻结：先把当前剩余时间写入事件日志，再挂起定时器。
  // 这样短暂停不会继续消耗时间，进程重启后也能精确恢复。
  freezeTimers(tid: number): void {
    const state = loadState(tid);
    const now = Date.now();
    const frozen: { passing?: Record<string, number>; serial?: number; deckbuilding?: number } = {};
    if (state.status === 'drafting') {
      if (this.isPassing(state)) {
        frozen.passing = {};
        for (const p of state.players) {
          const paused = state.pause?.pausedAt ? state.pause.pausedDeadlines?.[p.playerId] : undefined;
          const dl = state.pickDeadlines[p.playerId];
          if ((paused !== undefined || dl) && (state.packQueues[p.playerId]?.length ?? 0) > 0) {
            frozen.passing[p.playerId] = paused ?? Math.max(0, new Date(dl!).getTime() - now);
          }
        }
      } else if (state.pickCursor?.deadlineAt) {
        frozen.serial = state.pause?.pausedAt
          ? state.pause.pausedPickRemainingMs ?? 0
          : Math.max(0, new Date(state.pickCursor.deadlineAt).getTime() - now);
      }
    } else if (state.status === 'deckbuilding' && state.phaseDeadline) {
      frozen.deckbuilding = Math.max(0, new Date(state.phaseDeadline).getTime() - now);
    }
    logEvent(tid, 'tournament', 'timer_freeze', frozen, 'system');
    this.haltPickTimer(tid);
    const deckbuilding = this.deckbuildingTimers.get(tid);
    if (deckbuilding) clearTimeout(deckbuilding);
    this.deckbuildingTimers.delete(tid);
    persistMeta(tid);
  }

  // 管理员解冻：严格恢复冻结瞬间的剩余时间；旧冻结事件无快照时走兼容逻辑。
  resumeFrozenTimers(tid: number): void {
    let state = loadState(tid);
    const frozen = state.frozenTimers;
    const now = Date.now();
    if (!frozen) {
      this.resumePickTimer(tid);
      this.resumeDeckbuildingTimer(tid);
      return;
    }
    if (state.status === 'drafting' && frozen.passing) {
      const deadlines: Record<string, string | null> = { ...state.pickDeadlines };
      for (const p of state.players) {
        const ms = frozen.passing[p.playerId];
        deadlines[p.playerId] = ms !== undefined && (state.packQueues[p.playerId]?.length ?? 0) > 0
          ? new Date(now + ms).toISOString()
          : null;
      }
      logEvent(tid, 'draft', 'deadlines', { deadlines, reserves: state.pickReserves }, 'system');
    } else if (state.status === 'drafting' && frozen.serial !== undefined && state.pickCursor) {
      logEvent(tid, 'draft', 'cursor', { ...state.pickCursor, deadlineAt: new Date(now + frozen.serial).toISOString() }, 'system');
    } else if (state.status === 'deckbuilding' && frozen.deckbuilding !== undefined) {
      logEvent(tid, 'tournament', 'phase', {
        status: state.status,
        round: state.round,
        deadlineAt: new Date(now + frozen.deckbuilding).toISOString(),
      }, 'system');
    }
    logEvent(tid, 'tournament', 'timer_freeze', null, 'system');
    persistMeta(tid);
    state = loadState(tid);
    if (state.status === 'drafting') this.resumePickTimer(tid);
    if (state.status === 'deckbuilding') this.armDeckbuildingTimer(tid);
  }

  haltAllTimers(tid: number): void {
    this.haltPickTimer(tid);
    const deckbuilding = this.deckbuildingTimers.get(tid);
    if (deckbuilding) clearTimeout(deckbuilding);
    this.deckbuildingTimers.delete(tid);
    const pause = this.pauseTimers.get(tid);
    if (pause) clearTimeout(pause);
    this.pauseTimers.delete(tid);
  }

  resumePickTimer(tid: number): void {
    const s = loadState(tid);
    if (s.status !== 'drafting' || s.pause?.pausedAt) return;
    if (this.isPassing(s)) {
      // 冻结期间 deadline 可能已过期：过期/缺失的一律恢复为完整选牌时长 + 剩余 reserve（与 serial 语义一致）
      const cfg = getConfig(s);
      const now = Date.now();
      const deadlines: Record<string, string | null> = { ...s.pickDeadlines };
      const reserves: Record<string, number> = { ...s.pickReserves };
      let changed = false;
      for (const p of s.players) {
        const hasPack = (s.packQueues[p.playerId]?.length ?? 0) > 0;
        const dl = deadlines[p.playerId];
        if (hasPack && (!dl || new Date(dl).getTime() <= now)) {
          deadlines[p.playerId] = new Date(now + cfg.pickSeconds * 1000 + (reserves[p.playerId] ?? cfg.reserveSeconds * 1000)).toISOString();
          changed = true;
        }
      }
      if (changed) {
        logEvent(tid, 'draft', 'deadlines', { deadlines, reserves }, 'system');
        persistMeta(tid);
      }
      for (const p of s.players) this.armPassTimer(tid, p.playerId);
      return;
    }
    if (!s.pickCursor?.deadlineAt) return;
    // 冻结期间 deadline 已过期：把剩余时限恢复为完整选牌时长（与暂停恢复语义一致）
    if (new Date(s.pickCursor.deadlineAt).getTime() <= Date.now()) {
      const cfg = getConfig(s);
      logEvent(tid, 'draft', 'cursor', {
        ...s.pickCursor,
        deadlineAt: new Date(Date.now() + cfg.pickSeconds * 1000).toISOString(),
      }, 'system');
      persistMeta(tid);
    }
    this.armTimer(loadState(tid));
  }

  // timeout -> server picks randomly (dev_docs/05 §3)
  private autoPick(tid: number): void {
    try {
      this.doAutoPick(tid);
    } catch (e) {
      // 定时器回调异常不可冒泡（会杀进程）：记录并继续
      console.error('autoPick failed', tid, (e as Error).message);
    }
  }

  private doAutoPick(tid: number): void {
    let state: TournamentState;
    try {
      state = loadState(tid);
    } catch {
      return; // 比赛已被删除
    }
    if (state.frozen) {
      // 暂停中：不推进选牌，5 秒后再检查（解冻后 resumePickTimer 会重新计时）
      const t = setTimeout(() => this.autoPick(tid), 5000);
      t.unref();
      this.timers.set(tid, t);
      return;
    }
    if (!state.pickCursor || state.pause?.pausedAt) return;
    const remaining = this.remainingInPack(state, state.pickCursor.packIndex);
    if (!remaining.length) {
      this.advance(tid, 'system', false);
      return;
    }
    const card = remaining[Math.floor(Math.random() * remaining.length)];
    this.doPick(tid, state.pickCursor.playerId, card, true, 'system');
  }

  pick(tid: number, playerId: string, card: number, targetZone?: 'main' | 'extra' | 'side'): void {
    const state = loadState(tid);
    if (state.status !== 'drafting') throw new Error('WRONG_PHASE');
    if (state.pause?.pausedAt) throw new Error('PAUSED');
    // 拖拽目标区类型校验在落 pick 事件之前做（避免事件已记录但卡组/光标未推进的不一致）
    if (targetZone) {
      const isExtra = this.cards.isExtraDeck(card);
      if (targetZone === 'main' && isExtra) throw new Error('WRONG_ZONE');
      if (targetZone === 'extra' && !isExtra) throw new Error('WRONG_ZONE');
    }
    if (this.isPassing(state)) {
      const queue = state.packQueues[playerId] ?? [];
      if (!queue.length) throw new Error('NOT_YOUR_TURN'); // passing：当前没有可选择的牌堆
      const remaining = this.remainingInPack(state, queue[0]);
      if (!remaining.includes(card)) throw new Error('CARD_NOT_AVAILABLE');
      this.doPassPick(tid, playerId, card, false, playerId, targetZone);
      return;
    }
    if (!state.pickCursor || state.pickCursor.playerId !== playerId) throw new Error('NOT_YOUR_TURN');
    const remaining = this.remainingInPack(state, state.pickCursor.packIndex);
    if (!remaining.includes(card)) throw new Error('CARD_NOT_AVAILABLE');
    this.doPick(tid, playerId, card, false, playerId, targetZone);
  }

  // 选中的卡立即进入左侧对应区域：拖拽目标区优先，否则按卡类型进 main/extra（dev_docs/06 §2）
  private applyPickToDeck(tid: number, playerId: string, card: number, actor: string, targetZone?: 'main' | 'extra' | 'side'): void {
    const state = loadState(tid);
    const deck = state.decks[playerId] ?? { main: [], extra: [], side: [], lockedAt: null, status: 'building' as const };
    const isExtra = this.cards.isExtraDeck(card);
    if (targetZone === 'main' && isExtra) throw new Error('WRONG_ZONE');
    if (targetZone === 'extra' && !isExtra) throw new Error('WRONG_ZONE');
    if (targetZone === 'main' || targetZone === 'side') deck[targetZone].push(card);
    else if (targetZone === 'extra') deck.extra.push(card);
    else if (isExtra) deck.extra.push(card);
    else deck.main.push(card);
    logEvent(tid, 'deck', 'deck', { playerId, deck }, actor);
  }

  private doPick(tid: number, playerId: string, card: number, auto: boolean, actor: string, targetZone?: 'main' | 'extra' | 'side'): void {
    const state = loadState(tid);
    const pick: PickState = {
      playerId,
      packIndex: state.pickCursor!.packIndex,
      round: state.pickCursor!.round,
      card,
      auto,
      at: new Date().toISOString(),
    };
    logEvent(tid, 'pick', 'pick', pick, actor);
    this.applyPickToDeck(tid, playerId, card, actor, targetZone);
    const pausePending = !!state.pause && !state.pause.pausedAt;
    this.advance(tid, actor, false);
    // pause activates after the current picker finishes their pick
    if (pausePending) {
      const s = loadState(tid);
      if (s.pause && !s.pause.pausedAt && s.status === 'drafting') {
        this.pauseNow(tid);
      }
    }
  }

  // ---------- passing 模式 ----------

  private armPassTimer(tid: number, playerId: string): void {
    const key = `${tid}:${playerId}`;
    const old = this.passTimers.get(key);
    if (old) clearTimeout(old);
    this.passTimers.delete(key);
    let state: TournamentState;
    try {
      state = loadState(tid);
    } catch {
      return; // 比赛已被删除
    }
    if (state.status !== 'drafting') return;
    const deadline = state.pickDeadlines?.[playerId];
    if (!deadline) return;
    const ms = new Date(deadline).getTime() - Date.now();
    if (ms <= 0) {
      this.passAutoPick(tid, playerId);
      return;
    }
    const t = setTimeout(() => this.passAutoPick(tid, playerId), ms);
    t.unref();
    this.passTimers.set(key, t);
  }

  private clearPassTimers(tid: number): void {
    const prefix = `${tid}:`;
    for (const [key, t] of [...this.passTimers]) {
      if (key.startsWith(prefix)) {
        clearTimeout(t);
        this.passTimers.delete(key);
      }
    }
  }

  private passAutoPick(tid: number, playerId: string): void {
    try {
      this.doPassAutoPick(tid, playerId);
    } catch (e) {
      // 定时器回调异常不可冒泡（会杀进程）：记录并继续
      console.error('passAutoPick failed', tid, playerId, (e as Error).message);
    }
  }

  private doPassAutoPick(tid: number, playerId: string): void {
    let state: TournamentState;
    try {
      state = loadState(tid);
    } catch {
      return; // 比赛已被删除
    }
    if (state.status !== 'drafting' || !this.isPassing(state)) return;
    if (state.frozen) {
      // 暂停中：不推进选牌，5 秒后再检查（解冻后 resumePickTimer 会重新计时）
      const t = setTimeout(() => this.passAutoPick(tid, playerId), 5000);
      t.unref();
      this.passTimers.set(`${tid}:${playerId}`, t);
      return;
    }
    if (state.pause?.pausedAt) return;
    const queue = state.packQueues[playerId] ?? [];
    if (!queue.length) return;
    const remaining = this.remainingInPack(state, queue[0]);
    if (!remaining.length) return; // 队首堆已空属异常状态（正常流程空堆即消亡），不推进
    const card = remaining[Math.floor(Math.random() * remaining.length)];
    this.doPassPick(tid, playerId, card, true, 'system');
  }

  private doPassPick(tid: number, playerId: string, card: number, auto: boolean, actor: string, targetZone?: 'main' | 'extra' | 'side'): void {
    const state = loadState(tid);
    const cfg = getConfig(state);
    const queue = state.packQueues[playerId] ?? [];
    if (!queue.length) return; // 竞态兜底（理论上入口已校验）
    const packIndex = queue[0];
    const pack = state.packs.find((p) => p.index === packIndex);
    if (!pack) return;
    const round = state.picks.filter((p) => p.packIndex === packIndex).length;
    const pick: PickState = { playerId, packIndex, round, card, auto, at: new Date().toISOString() };
    // 队列/deadline/reserve 变更随 pick 事件落日志，回放与实时一致
    const queues: Record<string, number[]> = {};
    for (const [pid, q] of Object.entries(state.packQueues)) queues[pid] = q.slice();
    queues[playerId] = queue.slice(1);
    const deadlines: Record<string, string | null> = { ...state.pickDeadlines };
    const reserves: Record<string, number> = { ...state.pickReserves };
    const now = Date.now();
    // 保留时间结算：本次选牌超出基础时间的部分从 reserve 扣除（不刷新）。
    // deadline = 选牌开始 + pickSeconds + 当时 reserve → base 时刻 = deadline - reserve
    const prevDeadline = state.pickDeadlines[playerId] ? new Date(state.pickDeadlines[playerId]!).getTime() : null;
    const prevReserve = reserves[playerId] ?? cfg.reserveSeconds * 1000;
    if (prevDeadline !== null) {
      const consumed = Math.max(0, now - (prevDeadline - prevReserve));
      reserves[playerId] = Math.max(0, prevReserve - consumed);
    }
    const deadlineFor = (pid: string) => new Date(now + cfg.pickSeconds * 1000 + (reserves[pid] ?? 0)).toISOString();
    let receiver: string | null = null;
    if (this.remainingInPack(state, packIndex).length > 1) {
      // 堆未空：传给顺时针下一座位玩家的队尾
      const seatsArr = state.players.slice().sort((a, b) => a.seat - b.seat);
      const idx = seatsArr.findIndex((p) => p.playerId === playerId);
      receiver = seatsArr[(idx + 1) % seatsArr.length].playerId;
      if (!queues[receiver]) queues[receiver] = [];
      if (queues[receiver].length === 0) deadlines[receiver] = deadlineFor(receiver); // 空队列接到堆：开始计时
      queues[receiver].push(packIndex);
    }
    // 空堆直接消亡（不移交）
    deadlines[playerId] = queues[playerId].length ? deadlineFor(playerId) : null;
    logEvent(tid, 'pick', 'pick', { ...pick, queues, deadlines, reserves }, actor);
    this.applyPickToDeck(tid, playerId, card, actor, targetZone);
    this.armPassTimer(tid, playerId);
    if (receiver) this.armPassTimer(tid, receiver);
    // 一轮全部选空：pendingPhase 优先（管理台提前进构筑，不发下一轮）；
    // 否则还有未发堆 → 发下一轮；全部发完 → 进入构筑
    const s = loadState(tid);
    if (s.status === 'drafting' && s.players.every((p) => !(s.packQueues[p.playerId]?.length))) {
      if (s.pendingPhase === 'deckbuilding') {
        logEvent(tid, 'draft', 'pending', null, actor);
        this.tournaments.enterDeckbuilding(tid, actor);
        this.armDeckbuildingTimer(tid);
      } else if (s.packsDealt < s.packs.length) {
        this.dealRound(tid, actor);
      } else {
        this.tournaments.enterDeckbuilding(tid, actor);
        this.armDeckbuildingTimer(tid);
      }
    }
    persistMeta(tid);
  }

  // passing：一轮全部选空后发下一轮。整轮按座位顺序入队；残轮（evenPackCount 关闭时才出现）
  // 随机分给 r 名互斥玩家。调用前提：所有玩家队列均为空。
  private dealRound(tid: number, actor: string): void {
    const state = loadState(tid);
    const cfg = getConfig(state);
    const n = state.players.length;
    const remaining = state.packs.length - state.packsDealt;
    if (remaining <= 0) return;
    const count = Math.min(n, remaining);
    let seatsArr = state.players.slice().sort((a, b) => a.seat - b.seat);
    // reseatEachRound（默认开）：每轮结束后随机重排玩家座位，再发下一轮（seat_assign 事件落日志，回放一致）
    if (cfg.reseatEachRound && remaining > 0) {
      const shuffled = seatsArr.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const seatMap: Record<string, number> = {};
      shuffled.forEach((p, idx) => {
        seatMap[p.playerId] = idx;
      });
      logEvent(tid, 'player', 'seat_assign', seatMap, actor);
      seatsArr = loadState(tid).players.slice().sort((a, b) => a.seat - b.seat);
    }
    const recipients = seatsArr.slice();
    if (count < n) {
      // 残轮：随机互斥分配
      for (let i = recipients.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [recipients[i], recipients[j]] = [recipients[j], recipients[i]];
      }
    }
    const queues: Record<string, number[]> = {};
    for (const [pid, q] of Object.entries(state.packQueues)) queues[pid] = q.slice();
    const deadlines: Record<string, string | null> = { ...state.pickDeadlines };
    const reserves: Record<string, number> = { ...state.pickReserves };
    const now = Date.now();
    for (let k = 0; k < count; k++) {
      const pid = recipients[k].playerId;
      if (!queues[pid]) queues[pid] = [];
      queues[pid].push(state.packsDealt + k);
      deadlines[pid] = new Date(now + cfg.pickSeconds * 1000 + (reserves[pid] ?? cfg.reserveSeconds * 1000)).toISOString();
    }
    const dealt = state.packsDealt + count;
    logEvent(tid, 'draft', 'deal', { queues, deadlines, reserves, dealt }, actor);
    for (let k = 0; k < count; k++) this.armPassTimer(tid, recipients[k].playerId);
    persistMeta(tid);
  }

  // ---------- pause voting (dev_docs/05 §3) ----------

  proposePause(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (state.status !== 'drafting') throw new Error('WRONG_PHASE');
    if (state.pause) throw new Error('PAUSE_EXISTS');
    const cfg = getConfig(state);
    logEvent(tid, 'pause', 'pause', {
      remainingMs: cfg.pauseSeconds * 1000,
      votes: { [playerId]: true },
      proposer: playerId,
      pausedAt: null,
    }, playerId);
    this.checkPauseVotes(tid);
  }

  votePause(tid: number, playerId: string, yes: boolean): void {
    const state = loadState(tid);
    if (!state.pause) throw new Error('NO_PAUSE');
    if (state.pause.votes[playerId] !== undefined) throw new Error('ALREADY_VOTED');
    const votes = { ...state.pause.votes, [playerId]: yes };
    logEvent(tid, 'pause', 'pause', { ...state.pause, votes }, playerId);
    this.checkPauseVotes(tid);
  }

  private checkPauseVotes(tid: number): void {
    const state = loadState(tid);
    if (!state.pause || state.pause.pausedAt) return;
    const n = state.players.length;
    const yes = Object.values(state.pause.votes).filter(Boolean).length;
    if (yes > n / 2) {
      if (this.isPassing(state)) {
        // passing：无"当前选牌者"，多数通过即冻结所有人的剩余选牌时间
        this.pauseNow(tid);
        return;
      }
      // majority reached: pause once current picker finishes their pick
      logEvent(tid, 'pause', 'pause', { ...state.pause, votes: state.pause.votes }, 'system');
    }
  }

  private pauseNow(tid: number): void {
    const state = loadState(tid);
    if (!state.pause) return;
    if (this.isPassing(state)) {
      this.clearPassTimers(tid);
      // 冻结各玩家剩余选牌时间，恢复时按此重设 deadline
      const now = Date.now();
      const pausedDeadlines: Record<string, number> = {};
      for (const [pid, dl] of Object.entries(state.pickDeadlines)) {
        if (dl) pausedDeadlines[pid] = Math.max(0, new Date(dl).getTime() - now);
      }
      logEvent(tid, 'pause', 'pause', { ...state.pause, pausedDeadlines, pausedAt: new Date().toISOString() }, 'system');
      persistMeta(tid);
      // 暂停时长上限（默认 5 分钟）：到期自动恢复（dev_docs/05 §3）
      this.armPauseTimer(tid, state.pause.remainingMs);
      return;
    }
    this.clearTimer(tid);
    // serial：分别保存允许暂停的时长和当前选牌剩余时间，禁止两个计时器互相污染。
    const pausedPickRemainingMs = state.pickCursor?.deadlineAt
      ? Math.max(0, new Date(state.pickCursor.deadlineAt).getTime() - Date.now())
      : 0;
    logEvent(tid, 'pause', 'pause', { ...state.pause, pausedPickRemainingMs, pausedAt: new Date().toISOString() }, 'system');
    persistMeta(tid);
    // 暂停时长上限（默认 5 分钟）：到期自动恢复（dev_docs/05 §3）
    this.armPauseTimer(tid, state.pause.remainingMs);
  }

  private armPauseTimer(tid: number, ms: number): void {
    const old = this.pauseTimers.get(tid);
    if (old) clearTimeout(old);
    if (ms <= 0) return;
    const t = setTimeout(() => this.pauseExpired(tid), ms);
    t.unref();
    this.pauseTimers.set(tid, t);
  }

  private pauseExpired(tid: number): void {
    const state = loadState(tid);
    this.pauseTimers.delete(tid);
    if (!state.pause?.pausedAt) return;
    const proposer = state.pause.proposer;
    if (!proposer) return;
    try {
      this.resume(tid, proposer);
    } catch {
      // 已恢复或状态变化：忽略
    }
  }

  resume(tid: number, playerId: string): void {
    const state = loadState(tid);
    if (!state.pause?.pausedAt) throw new Error('NOT_PAUSED');
    if (playerId !== state.pause.proposer) throw new Error('FORBIDDEN');
    const old = this.pauseTimers.get(tid);
    if (old) clearTimeout(old);
    this.pauseTimers.delete(tid);
    if (this.isPassing(state)) {
      // 恢复：严格恢复暂停瞬间冻结的剩余时间，reserve 余额不变。
      const cfg = getConfig(state);
      const reserves: Record<string, number> = { ...state.pickReserves };
      const now = Date.now();
      const deadlines: Record<string, string | null> = {};
      for (const p of state.players) {
        const hasPack = (state.packQueues[p.playerId]?.length ?? 0) > 0;
        const remaining = state.pause.pausedDeadlines?.[p.playerId]
          ?? (cfg.pickSeconds * 1000 + (reserves[p.playerId] ?? cfg.reserveSeconds * 1000));
        deadlines[p.playerId] = hasPack
          ? new Date(now + Math.max(0, remaining ?? 0)).toISOString()
          : null;
      }
      logEvent(tid, 'pause', 'pause', null, playerId);
      logEvent(tid, 'draft', 'deadlines', { deadlines, reserves }, playerId);
      for (const p of state.players) this.armPassTimer(tid, p.playerId);
      persistMeta(tid);
      return;
    }
    const s = loadState(tid);
    // serial：严格恢复暂停瞬间冻结的当前选牌剩余时间。
    const cfg = getConfig(s);
    const pickLeft = Math.max(0, s.pause?.pausedPickRemainingMs ?? cfg.pickSeconds * 1000);
    logEvent(tid, 'pause', 'pause', null, playerId);
    if (s.pickCursor) {
      const deadlineAt = new Date(Date.now() + pickLeft).toISOString();
      logEvent(tid, 'draft', 'cursor', { ...s.pickCursor, deadlineAt }, playerId);
      this.armTimer(loadState(tid));
    }
    persistMeta(tid);
  }

  resumeByAdmin(tid: number, actor: string): void {
    const state = loadState(tid);
    if (!state.pause?.pausedAt) throw new Error('NOT_PAUSED');
    if (!state.pause.proposer) throw new Error('NOT_PAUSED');
    this.resume(tid, state.pause.proposer);
  }
}
