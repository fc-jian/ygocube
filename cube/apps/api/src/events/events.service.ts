import { getDb } from '../db';
import { config, defaults } from '../config';
import crypto from 'crypto';

// Append-only event log + in-memory state with snapshot/replay (dev_docs/05 §7).
// Every mutation is: logEvent(...) then apply(state, action, payload) — the same
// apply() is used for live mutation and for replay, so replay is exact by construction.

export interface PlayerState {
  playerId: string;
  displayName: string;
  seat: number;
  eliminated: boolean;
  withdrawn?: boolean;
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
  stage?: 'round_robin' | 'swiss' | 'playoff' | 'winners' | 'losers' | 'grand_final';
  bracketRound?: number;
  bracketMatchId?: string;
}

export interface CompetitionState {
  format: 'round_robin' | 'swiss' | 'double_elimination';
  seeds: string[];
  roundRobinSchedule?: [string, string | null][][];
  losses?: Record<string, number>;
  playoffStarted?: boolean;
}

export interface PauseState {
  remainingMs: number;
  votes: Record<string, boolean>;
  proposer: string | null;
  pausedAt: string | null;
  // passing 模式暂停时冻结的各玩家剩余选牌时间（恢复时按此重设 deadline）
  pausedDeadlines?: Record<string, number>;
  // serial 模式暂停时冻结的当前选牌剩余时间
  pausedPickRemainingMs?: number;
}

export interface FrozenTimerState {
  passing?: Record<string, number>;
  serial?: number;
  deckbuilding?: number;
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
  // 管理员冻结时持久化各阶段计时器的剩余时间；解冻后原样恢复。
  frozenTimers?: FrozenTimerState | null;
  competition?: CompetitionState | null;
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
    phaseDeadline: null, pendingPhase: null, frozenTimers: null, competition: null,
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
    case 'round_complete': {
      // 对局轮次全部有结果，等待管理员确认推进（无状态变化，仅通知）
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
    case 'player_dsq': {
      const playerId: string = payload.playerId ?? payload;
      const player = state.players.find((p) => p.playerId === playerId);
      if (player) player.eliminated = true;
      break;
    }
    case 'player_withdraw': {
      const player = state.players.find((p) => p.playerId === (payload.playerId ?? payload));
      if (player) player.withdrawn = true;
      break;
    }
    case 'player_restore': {
      const player = state.players.find((p) => p.playerId === (payload.playerId ?? payload));
      if (player) player.withdrawn = false;
      break;
    }
    case 'competition': {
      state.competition = clone(payload);
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
    case 'timer_freeze': {
      state.frozenTimers = payload ? clone(payload) : null;
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

function stateAt(tid: number, seq: number): TournamentState {
  const row = tournamentRow(tid);
  const target = getDb().prepare('SELECT seq FROM events WHERE tournament_id=? AND seq=?').get(tid, seq);
  if (!target) throw new Error('REVERT_EVENT_NOT_FOUND');
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
  return state;
}

export interface RevertPreview {
  seq: number;
  tournamentName: string;
  targetStatus: string;
  targetRound: number;
  deleteEvents: number;
  deletePicks: number;
  deleteMatches: number;
  closeRooms: string[];
}

export function previewRevert(tid: number, seq: number): RevertPreview {
  if (!Number.isInteger(seq) || seq <= 0) throw new Error('BAD_PAYLOAD');
  const state = stateAt(tid, seq);
  const row = tournamentRow(tid);
  const future = getDb().prepare('SELECT count(*) AS c FROM events WHERE tournament_id=? AND seq>?').get(tid, seq) as CountRow;
  const current = loadState(tid);
  const closeRooms = [...new Set(current.matches
    .filter((m) => m.roomName && m.resultA === null && m.playerB !== '(bye)')
    .map((m) => m.roomName!))];
  return {
    seq,
    tournamentName: row.name,
    targetStatus: state.status,
    targetRound: state.round,
    deleteEvents: future.c,
    deletePicks: Math.max(0, current.picks.length - state.picks.length),
    deleteMatches: Math.max(0, current.matches.length - state.matches.length),
    closeRooms,
  };
}

export interface HardRevertResult {
  state: TournamentState;
  deletedEvents: number;
  replacementTokens: Record<string, string>;
}

// Destructive admin time travel: discard the future event branch and rebuild every
// queryable projection from the target state.  The tournament remains frozen until
// an explicit unfreeze, so no timer/webhook can mutate the newly restored branch.
export function hardRevertTo(tid: number, seq: number, actor: string): HardRevertResult {
  const preview = previewRevert(tid, seq);
  const state = stateAt(tid, seq);
  state.frozen = true;
  // Rooms are external resources and cannot be resurrected. Completed matches keep
  // their historical room label; unresolved matches are recreated after unfreeze.
  for (const match of state.matches) {
    if (match.resultA === null) {
      match.roomName = null;
      match.playerAPass = null;
      match.playerBPass = null;
      match.source = 'revert';
      match.faultedAt = null;
      match.startedAt = null;
      match.finishedAt = null;
    }
  }

  const db = getDb();
  const replacementTokens: Record<string, string> = {};
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM events WHERE tournament_id=? AND seq>?').run(tid, seq);
    db.prepare('DELETE FROM tournament_snapshots WHERE tournament_id=?').run(tid);
    db.prepare('UPDATE tournaments SET config_json=?, status=?, round=?, frozen=1, updated_at=? WHERE id=?')
      .run(state.configJson, state.status, state.round, now, tid);

    db.prepare('UPDATE tournament_players SET active=0 WHERE tournament_id=?').run(tid);
    const findPlayer = db.prepare('SELECT id FROM tournament_players WHERE tournament_id=? AND player_id=?');
    const updatePlayer = db.prepare('UPDATE tournament_players SET display_name=?, seat=?, eliminated=?, withdrawn=?, active=1 WHERE tournament_id=? AND player_id=?');
    const insertPlayer = db.prepare('INSERT INTO tournament_players (tournament_id, player_id, display_name, token_hash, seat, joined_at, eliminated, withdrawn, active) VALUES (?,?,?,?,?,?,?,?,1)');
    for (const player of state.players) {
      if (findPlayer.get(tid, player.playerId)) {
        updatePlayer.run(player.displayName, player.seat, player.eliminated ? 1 : 0, player.withdrawn ? 1 : 0, tid, player.playerId);
      } else {
        const token = crypto.randomBytes(24).toString('base64url');
        replacementTokens[player.playerId] = token;
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        insertPlayer.run(tid, player.playerId, player.displayName, hash, player.seat, now, player.eliminated ? 1 : 0, player.withdrawn ? 1 : 0);
      }
    }

    db.prepare('DELETE FROM packs WHERE tournament_id=?').run(tid);
    const insertPack = db.prepare('INSERT INTO packs (tournament_id, "index", size, drop_card_code, order_json) VALUES (?,?,?,?,?)');
    for (const pack of state.packs) insertPack.run(tid, pack.index, pack.size, pack.dropCard, JSON.stringify(pack.order));

    db.prepare('DELETE FROM picks WHERE tournament_id=?').run(tid);
    const insertPick = db.prepare('INSERT INTO picks (tournament_id, player_id, pack_index, pick_round, card_code, auto_picked, picked_at) VALUES (?,?,?,?,?,?,?)');
    for (const pick of state.picks) insertPick.run(tid, pick.playerId, pick.packIndex, pick.round, pick.card, pick.auto ? 1 : 0, pick.at);

    db.prepare('DELETE FROM decks WHERE tournament_id=?').run(tid);
    const insertDeck = db.prepare('INSERT INTO decks (tournament_id, player_id, main_json, extra_json, side_json, locked_at, status) VALUES (?,?,?,?,?,?,?)');
    for (const [playerId, deck] of Object.entries(state.decks)) {
      insertDeck.run(tid, playerId, JSON.stringify(deck.main), JSON.stringify(deck.extra), JSON.stringify(deck.side), deck.lockedAt, deck.status);
    }

    db.prepare('DELETE FROM matches WHERE tournament_id=?').run(tid);
    const insertMatch = db.prepare('INSERT INTO matches (id, tournament_id, round, player_a, player_b, table_no, room_name, player_a_pass, player_b_pass, result_a, result_b, source, faulted_at, started_at, finished_at, stage, bracket_round, bracket_match_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const match of state.matches) {
      insertMatch.run(match.id, tid, match.round, match.playerA, match.playerB, match.tableNo, match.roomName, match.playerAPass, match.playerBPass, match.resultA, match.resultB, match.source, match.faultedAt, match.startedAt, match.finishedAt, match.stage ?? null, match.bracketRound ?? null, match.bracketMatchId ?? null);
    }

    const count = eventCount(tid);
    db.prepare('INSERT INTO tournament_snapshots (tournament_id, seq, event_seq, state_json, created_at) VALUES (?,?,?,?,?)')
      .run(tid, count, seq, JSON.stringify(state), now);
    db.prepare('INSERT INTO admin_actions (tournament_id, actor, action, detail_json, created_at) VALUES (?,?,?,?,?)')
      .run(tid, actor, 'hard_revert', JSON.stringify({ seq, deletedEvents: preview.deleteEvents }), now);
  })();
  stateCache.set(tid, state);
  return { state, deletedEvents: preview.deleteEvents, replacementTokens };
}

// Kept for callers/tests compiled against the old helper. New controller code uses
// hardRevertTo directly so the actor is never a credential.
export function revertTo(tid: number, seq: number): TournamentState {
  return hardRevertTo(tid, seq, 'admin').state;
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
