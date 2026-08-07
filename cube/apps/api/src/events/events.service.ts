import { getDb } from '../db';
import { config, defaults } from '../config';

// Append-only event log + in-memory state with snapshot/replay (dev_docs/05 §7).
// Every mutation is: logEvent(...) then apply(state, action, payload) — the same
// apply() is used for live mutation and for replay, so replay is exact by construction.

export interface PlayerState {
  playerId: string;
  displayName: string;
  seat: number;
  eliminated: boolean;
}

export interface PackState {
  index: number;
  size: number;
  dropCard: number | null;
  // 每堆起始玩家偏移（仅 serial 模式）：packSize 是人数倍数时用蛇形偏移；否则每堆随机。
  // 可选：旧事件/快照无此字段；passing 模式不使用。
  startOffset?: number;
  order: number[];
}

export interface PickState {
  playerId: string;
  packIndex: number;
  round: number;
  card: number;
  auto: boolean;
  at: string;
}

export interface DeckState {
  main: number[];
  extra: number[];
  side: number[];
  lockedAt: string | null;
  status: 'building' | 'locked';
}

export interface MatchState {
  id: number;
  round: number;
  playerA: string;
  playerB: string;
  tableNo: number;
  roomName: string | null;
  playerAPass: string | null;
  playerBPass: string | null;
  resultA: number | null;
  resultB: number | null;
  source: string | null;
  faultedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PauseState {
  remainingMs: number;
  votes: Record<string, boolean>;
  proposer: string | null;
  pausedAt: string | null;
  // passing 模式暂停时冻结的各玩家剩余选牌时间（恢复时按此重设 deadline）
  pausedDeadlines?: Record<string, number>;
}

export interface TournamentState {
  id: number;
  name: string;
  configJson: string;
  status: string;
  round: number;
  frozen: boolean;
  players: PlayerState[];
  packs: PackState[];
  droppedCards: number[];
  picks: PickState[];
  pickCursor: { packIndex: number; round: number; playerId: string; deadlineAt: string | null } | null;
  // passing 模式（packs_created 事件带 queues 即启用）：每玩家 FIFO 牌堆队列 + 各自选牌 deadline
  packQueues: Record<string, number[]>;
  pickDeadlines: Record<string, string | null>;
  // passing：已发堆数（按轮发堆，一轮全空才发下一轮）；旧事件无 dealt 字段时回退 packs.length
  packsDealt: number;
  // passing：每玩家保留时间余额（ms，不刷新；单选超时先扣 reserve，耗尽才自动选）
  pickReserves: Record<string, number>;
  pause: PauseState | null;
  decks: Record<string, DeckState>;
  matches: MatchState[];
  phaseDeadline: string | null;
  pendingPhase: string | null;
}

const stateCache = new Map<number, TournamentState>();

// Test hook: drop in-memory state so a fresh DB is replayed on next load.
export function resetStateCache(): void {
  stateCache.clear();
}

// SSE fan-out hook, wired in AppModule (RealtimeService.emit); avoids circular deps.
type EventHook = (tid: number, action: string, payload: any) => void;
let eventHook: EventHook | null = null;
export function setEventHook(hook: EventHook): void {
  eventHook = hook;
}

function emptyState(id: number, name: string, configJson: string): TournamentState {
  return {
    id, name, configJson, status: 'registration', round: 0, frozen: false,
    players: [], packs: [], droppedCards: [], picks: [], pickCursor: null, pause: null, decks: {}, matches: [],
    packQueues: {}, pickDeadlines: {}, packsDealt: 0, pickReserves: {},
    phaseDeadline: null, pendingPhase: null,
  };
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export function apply(state: TournamentState, action: string, payload: any): void {
  switch (action) {
    case 'phase': {
      state.status = payload.status;
      state.round = payload.round ?? state.round;
      if (payload.deadlineAt !== undefined) state.phaseDeadline = payload.deadlineAt;
      break;
    }
    case 'pending': {
      state.pendingPhase = payload;
      break;
    }
    case 'config': {
      state.configJson = JSON.stringify(payload);
      break;
    }
    case 'player_join': {
      const p: PlayerState = payload;
      state.players.push(p);
      state.decks[p.playerId] = { main: [], extra: [], side: [], lockedAt: null, status: 'building' };
      break;
    }
    case 'seat_assign': {
      const map: Record<string, number> = payload;
      for (const pl of state.players) if (map[pl.playerId] !== undefined) pl.seat = map[pl.playerId];
      break;
    }
    case 'player_remove': {
      const playerId: string = payload;
      state.players = state.players.filter((p) => p.playerId !== playerId);
      state.picks = state.picks.filter((p) => p.playerId !== playerId);
      delete state.decks[playerId];
      delete state.packQueues[playerId];
      delete state.pickDeadlines[playerId];
      delete state.pickReserves[playerId];
      break;
    }
    case 'packs_created': {
      state.packs = (payload.packs as PackState[]).map(clone);
      if (Array.isArray(payload.droppedCards)) state.droppedCards = payload.droppedCards;
      // passing 模式：初始队列与各玩家 deadline 随事件下发（无 queues 字段 = 旧串行模式）
      if (payload.queues) {
        state.packQueues = clone(payload.queues);
        // 旧 passing 事件无 dealt 字段（全部堆一次入队）：回退为 packs.length，回放行为不变
        state.packsDealt = payload.dealt ?? state.packs.length;
      }
      if (payload.deadlines) state.pickDeadlines = clone(payload.deadlines);
      if (payload.reserves) state.pickReserves = clone(payload.reserves);
      break;
    }
    case 'deal': {
      // passing 模式：一轮全部选空后发下一轮（payload 为发堆后的全量快照）
      if (payload.queues) state.packQueues = clone(payload.queues);
      if (payload.deadlines) state.pickDeadlines = clone(payload.deadlines);
      if (payload.reserves) state.pickReserves = clone(payload.reserves);
      if (payload.dealt !== undefined) state.packsDealt = payload.dealt;
      break;
    }
    case 'pick': {
      const p: PickState = payload;
      state.picks.push(p);
      // passing 模式：pick 事件携带选后队列/deadline/reserve 快照，回放与实时一致
      if (payload.queues) state.packQueues = clone(payload.queues);
      if (payload.deadlines) state.pickDeadlines = clone(payload.deadlines);
      if (payload.reserves) state.pickReserves = clone(payload.reserves);
      break;
    }
    case 'deadlines': {
      // passing 模式：全量重设各玩家 deadline（暂停/恢复/冻结/解冻）。
      // payload 两种形态：{deadlines, reserves?}（新）或直接是 deadline map（旧）
      if (payload && payload.deadlines) {
        state.pickDeadlines = clone(payload.deadlines);
        if (payload.reserves) state.pickReserves = clone(payload.reserves);
      } else {
        state.pickDeadlines = payload ? clone(payload) : {};
      }
      break;
    }
    case 'cursor': {
      state.pickCursor = payload ? clone(payload) : null;
      break;
    }
    case 'pause': {
      state.pause = payload ? clone(payload) : null;
      break;
    }
    case 'deck': {
      state.decks[payload.playerId] = clone(payload.deck);
      break;
    }
    case 'match': {
      const m: MatchState = payload;
      const i = state.matches.findIndex((x) => x.id === m.id);
      if (i >= 0) state.matches[i] = m;
      else state.matches.push(m);
      break;
    }
    case 'frozen': {
      state.frozen = payload;
      break;
    }
    default:
      throw new Error(`unknown event action: ${action}`);
  }
}

export function logEvent(tid: number, entity: string, action: string, payload: any, actor: string): number {
  const row = getDb()
    .prepare('INSERT INTO events (tournament_id, entity, action, payload_json, created_at, actor) VALUES (?,?,?,?,?,?)')
    .run(tid, entity, action, JSON.stringify(payload), new Date().toISOString(), actor);
  const seq = Number(row.lastInsertRowid);
  const state = stateCache.get(tid);
  if (state) apply(state, action, payload);
  if (eventHook) eventHook(tid, action, payload);
  maybeSnapshot(tid, seq);
  return seq;
}

export function loadState(tid: number): TournamentState {
  const cached = stateCache.get(tid);
  if (cached) return cached;
  const row = tournamentRow(tid);
  const state = emptyState(row.id, row.name, row.config_json);
  state.status = row.status;
  state.round = row.round;
  state.frozen = (row as TournamentRow & { frozen?: number }).frozen === 1;
  // replay from snapshot if present, else from scratch
  const snap = getDb()
    .prepare('SELECT seq, event_seq, state_json FROM tournament_snapshots WHERE tournament_id=? AND event_seq IS NOT NULL ORDER BY event_seq DESC LIMIT 1')
    .get(tid) as SnapRow | undefined;
  let startSeq = 0;
  if (snap) {
    const snapState = JSON.parse(snap.state_json) as TournamentState;
    Object.assign(state, snapState);
    startSeq = snap.event_seq as number;
  }
  const rows = getDb()
    .prepare('SELECT seq, tournament_id, entity, action, payload_json, created_at, actor FROM events WHERE tournament_id=? AND seq>? ORDER BY seq')
    .all(tid, startSeq) as EventRow[];
  for (const e of rows) apply(state, e.action, JSON.parse(e.payload_json));
  stateCache.set(tid, state);
  return state;
}

export function persistMeta(tid: number): void {
  const s = stateCache.get(tid);
  if (!s) return;
  getDb().prepare('UPDATE tournaments SET status=?, round=?, updated_at=? WHERE id=?').run(s.status, s.round, new Date().toISOString(), tid);
}

interface CountRow {
  c: number;
}

interface TournamentRow {
  id: number;
  name: string;
  config_json: string;
  status: string;
  round: number;
  frozen?: number;
}

interface EventRow {
  seq: number;
  tournament_id: number;
  entity: string;
  action: string;
  payload_json: string;
  created_at: string;
  actor: string;
}

interface SnapRow {
  seq: number;
  event_seq: number | null;
  state_json: string;
}

function tournamentRow(tid: number): TournamentRow {
  const row = getDb().prepare('SELECT * FROM tournaments WHERE id=?').get(tid) as TournamentRow | undefined;
  if (!row) throw new Error('tournament not found');
  return row;
}

function eventCount(tid: number): number {
  return (getDb().prepare('SELECT count(*) AS c FROM events WHERE tournament_id=?').get(tid) as CountRow).c;
}

function maybeSnapshot(tid: number, globalSeq: number): void {
  const count = eventCount(tid);
  if (count % 100 === 0) {
    const s = stateCache.get(tid);
    if (s) {
      getDb()
        .prepare('INSERT INTO tournament_snapshots (tournament_id, seq, event_seq, state_json, created_at) VALUES (?,?,?,?,?)')
        .run(tid, count, globalSeq, JSON.stringify(s), new Date().toISOString());
    }
  }
}

export function snapshotNow(tid: number): void {
  const s = stateCache.get(tid);
  if (!s) return;
  const count = eventCount(tid);
  const last = getDb().prepare('SELECT MAX(seq) m FROM events WHERE tournament_id=?').get(tid) as { m: number | null };
  getDb()
    .prepare('INSERT INTO tournament_snapshots (tournament_id, seq, event_seq, state_json, created_at) VALUES (?,?,?,?,?)')
    .run(tid, count, last.m ?? count, JSON.stringify(s), new Date().toISOString());
}

// Admin time travel: rebuild state as of seq, freeze the tournament (dev_docs/05 §7).
export function revertTo(tid: number, seq: number): TournamentState {
  const row = tournamentRow(tid);
  const state = emptyState(row.id, row.name, row.config_json);
  const snap = getDb()
    .prepare('SELECT seq, event_seq, state_json FROM tournament_snapshots WHERE tournament_id=? AND event_seq IS NOT NULL AND event_seq<=? ORDER BY event_seq DESC LIMIT 1')
    .get(tid, seq) as SnapRow | undefined;
  let startSeq = 0;
  if (snap) {
    Object.assign(state, JSON.parse(snap.state_json) as TournamentState);
    startSeq = snap.event_seq as number;
  }
  const rows = getDb()
    .prepare('SELECT seq, tournament_id, entity, action, payload_json, created_at, actor FROM events WHERE tournament_id=? AND seq>? AND seq<=? ORDER BY seq')
    .all(tid, startSeq, seq) as EventRow[];
  for (const e of rows) apply(state, e.action, JSON.parse(e.payload_json));
  state.frozen = true;
  stateCache.set(tid, state);
  persistMeta(tid);
  getDb().prepare('UPDATE tournaments SET frozen=1 WHERE id=?').run(tid);
  return state;
}

// 删除 tournament 的进程内状态（配合管理台删除）
export function dropState(tid: number): void {
  stateCache.delete(tid);
}

export function unfreeze(tid: number): void {
  const s = stateCache.get(tid);
  if (s) {
    s.frozen = false;
    logEvent(tid, 'tournament', 'frozen', false, 'admin');
  }
  getDb().prepare('UPDATE tournaments SET frozen=0 WHERE id=?').run(tid);
}

export function freeze(tid: number, actor: string): void {
  const s = stateCache.get(tid);
  if (s) {
    s.frozen = true;
    logEvent(tid, 'tournament', 'frozen', true, actor);
  }
  getDb().prepare('UPDATE tournaments SET frozen=1 WHERE id=?').run(tid);
}

export function getConfig(state: TournamentState) {
  return { ...defaults, ...JSON.parse(state.configJson) };
}

export function pickedCards(state: TournamentState, playerId: string): number[] {
  return state.picks.filter((p) => p.playerId === playerId).map((p) => p.card);
}
