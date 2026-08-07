import { Injectable, OnModuleInit } from '@nestjs/common';
import { loadState, logEvent, getConfig, persistMeta, TournamentState, PickState } from '../events/events.service';
import { CardsService } from '../cards/cards.service';
import { TournamentsService } from '../tournaments/tournaments.service';
import { PoolsService } from '../pools/pools.service';
import { MatchesService } from '../matches/matches.service';
import { DecksService } from '../decks/decks.service';

// Draft engine: pack generation, snake rotation, pick timer with server-side
// auto-pick, pause voting, deckbuilding deadline (dev_docs/05 §3).
@Injectable()
export class DraftService implements OnModuleInit {
  private timers = new Map<number, NodeJS.Timeout>();
  private deckbuildingTimers = new Map<number, NodeJS.Timeout>();
  private pauseTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private cards: CardsService,
    private tournaments: TournamentsService,
    private pools: PoolsService,
    private matches: MatchesService,
  ) {}

  onModuleInit(): void {
    // re-arm timers after restart (all state server-side; deadlines persisted)
    const db = require('../db').getDb();
    const rows = db.prepare('SELECT id FROM tournaments WHERE status=?').all('drafting') as { id: number }[];
    for (const r of rows) {
      try {
        const state = loadState(r.id);
        if (state.pickCursor?.deadlineAt && !state.pause?.pausedAt) {
          this.armTimer(state);
        }
      } catch (e) {
        console.error('re-arm failed for tournament', r.id, e);
      }
    }
    const deckRows = db.prepare('SELECT id FROM tournaments WHERE status=?').all('deckbuilding') as { id: number }[];
    for (const r of deckRows) {
      try {
        this.armDeckbuildingTimer(r.id);
      } catch (e) {
        console.error('re-arm deckbuilding failed for tournament', r.id, e);
      }
    }
  }

  startDraft(tid: number, actor: string): void {
    const state = loadState(tid);
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
    state.players.forEach((p) => (seatMap[p.playerId] = order.indexOf(p.playerId)));
    // packs: shuffled pool (card pool or full card table), pack size = n * multiple, drop last (public)
    const poolCodes = this.pools.resolve(cfg.cardPool as string | undefined).slice();
    for (let i = poolCodes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [poolCodes[i], poolCodes[j]] = [poolCodes[j], poolCodes[i]];
    }
    // 牌堆构成策略（packStrategy）：
    //  stratify（默认）   = 主卡/额外卡按整体比例均匀分布到每一堆（各池先洗牌再按比例取）
    //  random             = 全卡池随机洗牌后顺序切堆
    //  main_then_extra    = 先排完全部主卡（跨堆），再接额外卡
    const strategy = cfg.packStrategy === 'random' || cfg.packStrategy === 'main_then_extra' ? cfg.packStrategy : 'stratify';
    let codes: number[];
    if (strategy === 'random') {
      codes = poolCodes;
    } else {
      const main: number[] = [];
      const extra: number[] = [];
      for (const c of poolCodes) {
        const info = this.cards.get(c);
        ((info && info.type & 0x4802040) ? extra : main).push(c);
      }
      if (strategy === 'main_then_extra') {
        codes = [...main, ...extra];
      } else {
        // stratify: 逐堆按剩余 main:extra 比例动态取卡（两池已各自洗牌），堆外剩余追加为弃置
        const packSize = (rawCfg.packSize as number | undefined) ?? n * ((rawCfg.packSizeMultiple as number | undefined) ?? 3);
        const dropMode0 =
          cfg.dropMode === 'use_all' || cfg.dropMode === 'drop_leftover' || cfg.dropMode === 'drop_leftover_exact'
            ? cfg.dropMode
            : cfg.dropLeftover === false
              ? 'use_all'
              : 'drop_leftover_exact';
        const packCount0 = dropMode0 === 'use_all'
          ? Math.max(1, Math.ceil(poolCodes.length / packSize))
          : Math.max(1, Math.floor(poolCodes.length / packSize) - (dropMode0 === 'drop_leftover_exact' ? Math.floor(poolCodes.length / packSize) % n : 0));
        let mi = 0;
        let ei = 0;
        const per: number[][] = [];
        for (let k = 0; k < packCount0; k++) {
          const size = dropMode0 === 'use_all' ? Math.min(packSize, poolCodes.length - k * packSize) : packSize;
          const remMain = main.length - mi;
          const remExtra = extra.length - ei;
          const m = Math.min(remMain, Math.round(size * (remMain / Math.max(1, remMain + remExtra))));
          const e = Math.min(remExtra, size - m);
          per.push([...main.slice(mi, mi + m), ...extra.slice(ei, ei + e)]);
          mi += m;
          ei += e;
        }
        codes = [...per.flat(), ...main.slice(mi), ...extra.slice(ei)];
      }
    }
    const packSize = (rawCfg.packSize as number | undefined) ?? n * ((rawCfg.packSizeMultiple as number | undefined) ?? 3);
    // 剩余卡处理（dev_docs/05 §3，DropMode）：
    //  use_all            = 所有卡进牌堆，最后一堆可以不满（不做整除要求）
    //  drop_leftover      = 只丢弃无法整除的余数，不要求牌堆数是玩家数倍数
    //  drop_leftover_exact= 丢弃余数且要求牌堆数是玩家数倍数（旧 dropLeftover=true 行为）
    const dropMode =
      cfg.dropMode === 'use_all' || cfg.dropMode === 'drop_leftover' || cfg.dropMode === 'drop_leftover_exact'
        ? cfg.dropMode
        : cfg.dropLeftover === false
          ? 'use_all'
          : 'drop_leftover_exact'; // 旧配置兼容
    let packCount: number;
    let droppedCards: number[] = [];
    if (dropMode === 'use_all') {
      packCount = Math.max(1, Math.ceil(codes.length / packSize));
    } else {
      const rawCount = Math.floor(codes.length / packSize);
      packCount = Math.max(1, dropMode === 'drop_leftover_exact' ? rawCount - (rawCount % n) : rawCount);
      droppedCards = codes.slice(packSize * packCount);
    }
    const packs = [];
    for (let k = 0; k < packCount; k++) {
      const orderList = codes.slice(k * packSize, Math.min((k + 1) * packSize, codes.length));
      packs.push({ index: k, size: orderList.length, dropCard: null, order: orderList });
    }
    // leftover pool cards (drop 模式): randomly dropped, list made public before the draft starts
    for (let i = droppedCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [droppedCards[i], droppedCards[j]] = [droppedCards[j], droppedCards[i]];
    }
    logEvent(tid, 'tournament', 'phase', { status: 'drafting', round: 0 }, actor);
    logEvent(tid, 'player', 'seat_assign', seatMap, actor);
    logEvent(tid, 'pack', 'packs_created', { packs, droppedCards }, actor);
    // snake cursor: pack 0 starts with seat 0; each pack alternates direction
    this.advance(tid, actor, true);
    persistMeta(tid);
  }

  // picker at (packIndex, round): ALWAYS clockwise, each pack starts one seat further
  // on (dev_docs/05 §3): orders are 1-2-3, 3-1-2, 2-3-1, 1-2-3, ... so the last picker
  // of a pack picks first in the next pack (consecutive double pick), and with a pack
  // count that is a multiple of n every player occupies every position equally.
  private pickerAt(state: TournamentState, packIndex: number, round: number): string {
    const n = state.players.length;
    const seats = state.players.slice().sort((a, b) => a.seat - b.seat);
    const pos = (round + (n - (packIndex % n)) % n) % n;
    return seats[pos].playerId;
  }

  private remainingInPack(state: TournamentState, packIndex: number): number[] {
    const pack = state.packs.find((p) => p.index === packIndex);
    if (!pack) return [];
    const taken = new Set(state.picks.filter((p) => p.packIndex === packIndex).map((p) => p.card));
    return pack.order.filter((c) => !taken.has(c));
  }

  private isLastPickOfPack(state: TournamentState, packIndex: number): boolean {
    const pack = state.packs.find((p) => p.index === packIndex);
    return pack ? state.picks.filter((p) => p.packIndex === packIndex).length >= pack.order.length : true;
  }

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

  // 恢复（解冻）时：构筑倒计时重新开始
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
    for (const p of state.players) {
      if (!state.decks[p.playerId]?.lockedAt) {
        decks.autoFix(tid, p.playerId);
      }
    }
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
  }

  resumePickTimer(tid: number): void {
    const s = loadState(tid);
    if (s.status !== 'drafting' || !s.pickCursor?.deadlineAt) return;
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
    if (!state.pickCursor || state.pickCursor.playerId !== playerId) throw new Error('NOT_YOUR_TURN');
    if (state.pause?.pausedAt) throw new Error('PAUSED');
    const remaining = this.remainingInPack(state, state.pickCursor.packIndex);
    if (!remaining.includes(card)) throw new Error('CARD_NOT_AVAILABLE');
    this.doPick(tid, playerId, card, false, playerId, targetZone);
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
    // picked cards join the left zones immediately; 拖拽目标区优先（类型不符拒绝），
    // 否则按卡类型进 main/extra（dev_docs/06 §2）
    const deck = state.decks[playerId] ?? { main: [], extra: [], side: [], lockedAt: null, status: 'building' as const };
    const isExtra = this.cards.isExtraDeck(card);
    if (targetZone === 'main' && isExtra) throw new Error('WRONG_ZONE');
    if (targetZone === 'extra' && !isExtra) throw new Error('WRONG_ZONE');
    if (targetZone === 'main' || targetZone === 'side') {
      if (!deck[targetZone].includes(card)) deck[targetZone].push(card);
    } else if (targetZone === 'extra') {
      if (!deck.extra.includes(card)) deck.extra.push(card);
    } else if (isExtra) {
      if (!deck.extra.includes(card)) deck.extra.push(card);
    } else if (!deck.main.includes(card)) {
      deck.main.push(card);
    }
    logEvent(tid, 'deck', 'deck', { playerId, deck }, actor);
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
      // majority reached: pause once current picker finishes their pick
      logEvent(tid, 'pause', 'pause', { ...state.pause, votes: state.pause.votes }, 'system');
    }
  }

  private pauseNow(tid: number): void {
    const state = loadState(tid);
    if (!state.pause) return;
    this.clearTimer(tid);
    // freeze remaining pick time into pause
    let remainingMs = state.pause.remainingMs;
    if (state.pickCursor?.deadlineAt) {
      const left = new Date(state.pickCursor.deadlineAt).getTime() - Date.now();
      if (left > 0) remainingMs = Math.max(0, remainingMs - (state.pause.remainingMs > 0 ? state.pause.remainingMs - left : left));
    }
    logEvent(tid, 'pause', 'pause', { ...state.pause, remainingMs, pausedAt: new Date().toISOString() }, 'system');
    persistMeta(tid);
    // 暂停时长上限（默认 5 分钟）：到期自动恢复（dev_docs/05 §3）
    this.armPauseTimer(tid, remainingMs);
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
    const s = loadState(tid);
    // restore deadline: now + remaining pick time (paused budget consumed)
    const cfg = getConfig(s);
    const pickLeft = s.pickCursor?.deadlineAt
      ? Math.max(0, new Date(s.pickCursor.deadlineAt).getTime() - Date.now() + (s.pause?.remainingMs ?? 0) - cfg.pickSeconds * 1000)
      : cfg.pickSeconds * 1000;
    const old = this.pauseTimers.get(tid);
    if (old) clearTimeout(old);
    this.pauseTimers.delete(tid);
    logEvent(tid, 'pause', 'pause', null, playerId);
    if (s.pickCursor) {
      const deadlineAt = new Date(Date.now() + Math.max(0, pickLeft || cfg.pickSeconds * 1000)).toISOString();
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
