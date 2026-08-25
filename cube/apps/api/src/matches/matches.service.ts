import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getDb } from '../db';
import {
  afterEventCommit,
  loadState,
  logEvent,
  getConfig,
  persistMeta,
  MatchState,
  withEventTransaction,
} from '../events/events.service';
import { config } from '../config';
import axios from 'axios';
import crypto from 'crypto';
import { cubeDeckFileBase } from '../decks/deck-filename';

export interface SrvproApi {
  createRoom(req: any): Promise<any>;
  roomStatus(roomName: string): Promise<any>;
  closeRoom(roomName: string): Promise<any>;
}

// Real srvpro client (dev_docs/07 §3). Injectable for tests.
export class RealSrvproClient implements SrvproApi {
  constructor(private base: string, private apiKey: string) {}
  private headers() {
    return { 'X-Cube-Api-Key': this.apiKey, 'Content-Type': 'application/json' };
  }
  async createRoom(req: any): Promise<any> {
    const r = await axios.post(`${this.base}/cube/create_room`, req, { headers: this.headers(), timeout: 15000 });
    return r.data;
  }
  async roomStatus(roomName: string): Promise<any> {
    const r = await axios.get(`${this.base}/cube/room_status`, { params: { room_name: roomName }, headers: this.headers(), timeout: 5000 });
    return r.data;
  }
  async closeRoom(roomName: string): Promise<any> {
    const r = await axios.post(`${this.base}/cube/close_room`, { room_name: roomName }, { headers: this.headers(), timeout: 5000 });
    return r.data;
  }
}

interface PointsRow {
  playerId: string;
  points: number;
  gameDiff: number; // 净胜局（轮空记 0）
  omw: number; // opponent match win %
  oppPoints: number; // 历史对手总积分
  played: number;
}

@Injectable()
export class MatchesService implements OnModuleInit, OnModuleDestroy {
  private poller: NodeJS.Timeout | null = null;
  private roomRetryCooldown = new Map<number, number>(); // tid -> last attempt ts
  private operationGeneration = new Map<number, number>();
  constructor(private srvpro: SrvproApi = new RealSrvproClient(config.srvpro.url, config.srvpro.apiKey)) {}

  onModuleInit(): void {
    if (!this.poller) {
      this.poller = setInterval(() => this.pollAll(), 10000);
      this.poller.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.roomRetryCooldown.clear();
    this.operationGeneration.clear();
  }

  // ---------- pairing (dev_docs/05 §5) ----------

  validateStart(tid: number): void {
    const state = loadState(tid);
    const active = this.activePlayers(state);
    if (active.some((player) => !/^[\x20-\x7E]{1,19}$/.test(player.playerId) || player.playerId.includes('$'))) {
      // Historical registrations created before the protocol-length guard must
      // fail visibly instead of spawning a room that no client can authenticate.
      throw new Error('BAD_PLAYER_ID');
    }
    const count = active.length;
    // A deckbuilding preflight may DSQ/withdraw everyone except one player. That
    // player still needs a recorded bye (and the tournament can then finish), so
    // only an empty field is invalid at this point.
    if (count < 1) throw new Error('FORMAT_PLAYER_COUNT');
    if (count === 1) return;
    if (this.format(state) === 'swiss') {
      const rounds = this.configuredSwissRounds(state);
      const playoff = Number(getConfig(state).playoffSize ?? 0);
      const maxRounds = count % 2 === 0 ? count - 1 : count;
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > maxRounds) throw new Error('BAD_SWISS_ROUNDS');
      if (playoff > count) throw new Error('FORMAT_PLAYER_COUNT');
    }
  }

  swissRounds(n: number): number {
    if (n <= 5) return n - 1; // round robin
    if (n <= 16) return 4;
    return Math.ceil(Math.log2(n)) + 1; // 17+: 标准瑞士轮（dev_docs/05 §5）
  }

  private activePlayers(state: ReturnType<typeof loadState>) {
    return state.players.filter((p) => !p.eliminated && !p.withdrawn);
  }

  private format(state: ReturnType<typeof loadState>): 'round_robin' | 'swiss' | 'double_elimination' {
    const cfg = getConfig(state);
    if (cfg.matchFormat === 'round_robin' || cfg.matchFormat === 'swiss' || cfg.matchFormat === 'double_elimination') return cfg.matchFormat;
    return this.activePlayers(state).length <= 5 ? 'round_robin' : 'swiss';
  }

  private configuredSwissRounds(state: ReturnType<typeof loadState>): number {
    const cfg = getConfig(state);
    return Number.isInteger(cfg.swissRoundCount) ? Number(cfg.swissRoundCount) : this.swissRounds(this.activePlayers(state).length);
  }

  private roundRobinSchedule(ids: string[]): [string, string | null][][] {
    if (ids.length % 2 === 0) {
      const rounds: [string, string | null][][] = [];
      const arr = [...ids];
      for (let r = 0; r < ids.length - 1; r++) {
        const pairs: [string, string | null][] = [];
        for (let i = 0; i < ids.length / 2; i++) pairs.push([arr[2 * i], arr[2 * i + 1]]);
        rounds.push(pairs);
        const first = arr.splice(1, 1)[0];
        arr.push(first);
      }
      return rounds;
    }
    const ring: (string | null)[] = [...ids];
    ring.push(null);
    const rounds: [string, string | null][][] = [];
    for (let r = 0; r < ring.length - 1; r++) {
      const pairs: [string, string | null][] = [];
      for (let i = 0; i < ring.length / 2; i++) {
        const a = ring[i];
        const b = ring[ring.length - 1 - i];
        if (a !== null) pairs.push([a, b]);
        else if (b !== null) pairs.push([b, null]);
      }
      rounds.push(pairs);
      ring.splice(1, 0, ring.pop()!);
    }
    return rounds;
  }

  private shuffled<T>(values: T[]): T[] {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private points(state: ReturnType<typeof loadState>, round: number): PointsRow[] {
    const rows: PointsRow[] = state.players
      .filter((p) => !p.eliminated && !p.withdrawn)
      .map((p) => {
        let points = 0;
        let gameDiff = 0;
        let omw = 0;
        let oppPoints = 0;
        let opps = 0;
        for (const m of state.matches.filter((m) => m.round < round)) {
          const isA = m.playerA === p.playerId;
          if (!isA && m.playerB !== p.playerId) continue;
          if (m.resultA === null || m.resultB === null) continue;
          const my = isA ? m.resultA : m.resultB;
          const opp = isA ? m.resultB : m.resultA;
          const oppId = isA ? m.playerB : m.playerA;
          if (my > opp) points += 3;
          else if (my === opp) points += 1;
          if (oppId !== '(bye)') gameDiff += my - opp; // 轮空净胜局记 0（dev_docs/05 §5）
          if (oppId !== '(bye)') {
            const oppMatches = state.matches.filter((x) => (x.playerA === oppId || x.playerB === oppId) && x.resultA !== null && x.round < round);
            const oppWins = oppMatches.filter((x) => {
              const a = x.playerA === oppId ? x.resultA : x.resultB;
              const b = x.playerA === oppId ? x.resultB : x.resultA;
              return a! > b!;
            }).length;
            omw += oppMatches.length ? oppWins / oppMatches.length : 0;
            oppPoints += oppMatches.length >= 2 ? oppWins * 3 : 0;
            opps++;
          }
        }
        return {
          playerId: p.playerId,
          points,
          gameDiff,
          omw: opps ? omw / opps : 0,
          oppPoints,
          played: state.matches.filter((m) => m.round < round && (m.playerA === p.playerId || m.playerB === p.playerId) && m.resultA !== null).length,
        };
      });
    rows.sort((a, b) => b.points - a.points || b.gameDiff - a.gameDiff || b.omw - a.omw || b.oppPoints - a.oppPoints);
    return rows;
  }

  private generateRound(state: ReturnType<typeof loadState>, round: number): MatchState[] {
    const n = this.activePlayers(state).length;
    const ids = this.points(state, round).map((r) => r.playerId);
    const playedPairs = new Set<string>();
    for (const m of state.matches) {
      playedPairs.add([m.playerA, m.playerB].sort().join('|'));
    }
    const pairs: [string, string][] = [];
    if (this.format(state) === 'round_robin') {
      const planned = state.competition?.roundRobinSchedule?.[round - 1] ?? [];
      for (const [a, b] of planned) {
        if (b && ids.includes(a) && ids.includes(b)) pairs.push([a, b]);
      }
    } else {
      // Swiss pairing is a whole-round constraint problem, not a per-table
      // greedy choice. The old greedy implementation could consume all valid
      // opponents for the last two players and then pair that repeated matchup
      // as a fallback even though another complete solution existed.
      const memo = new Set<string>();
      let visited = 0;
      const deadline = Date.now() + 100;
      const solve = (remaining: string[]): [string, string][] | null => {
        if (++visited > 100_000 || Date.now() > deadline) throw new Error('PAIRING_SEARCH_LIMIT');
        if (remaining.length === 0) return [];
        const signature = remaining.join('\0');
        if (memo.has(signature)) return null;
        const a = remaining[0];
        // ids is already standings order. Trying nearby candidates first keeps
        // score groups as close as possible while backtracking when necessary.
        for (let i = 1; i < remaining.length; i++) {
          const b = remaining[i];
          if (playedPairs.has([a, b].sort().join('|'))) continue;
          const rest = [...remaining.slice(1, i), ...remaining.slice(i + 1)];
          const tail = solve(rest);
          if (tail) return [[a, b], ...tail];
        }
        memo.add(signature);
        return null;
      };

      let swissPairs: [string, string][] | null = null;
      if (n % 2 === 0) {
        swissPairs = solve(ids);
      } else {
        const previousByes = new Set(state.matches.filter((m) => m.playerB === '(bye)').map((m) => m.playerA));
        // Prefer the lowest-ranked player who has not already received a bye.
        const byeCandidates = ids
          .map((id, index) => ({ id, index, hadBye: previousByes.has(id) }))
          .sort((a, b) => Number(a.hadBye) - Number(b.hadBye) || b.index - a.index);
        for (const candidate of byeCandidates) {
          memo.clear();
          const result = solve(ids.filter((id) => id !== candidate.id));
          if (result) {
            swissPairs = result;
            // Keep the bye player unmatched; the common bye creation below
            // detects the one id absent from swissPairs.
            break;
          }
        }
      }
      if (!swissPairs) throw new Error('NO_VALID_PAIRING');
      pairs.push(...swissPairs);
    }
    // byes: eliminated-adjacent; a lone player gets a bye (3 points)
    const matched = new Set(pairs.flat());
    const bye = ids.find((id) => !matched.has(id));
    const matches: MatchState[] = pairs.map(([a, b], i) => ({
      id: 0,
      round,
      playerA: a,
      playerB: b,
      tableNo: i + 1,
      roomName: null,
      playerAPass: null,
      playerBPass: null,
      resultA: null,
      resultB: null,
      source: null,
      faultedAt: null,
      startedAt: null,
      finishedAt: null,
      stage: this.format(state) === 'round_robin' ? 'round_robin' : 'swiss',
      bracketRound: round,
    }));
    // Swiss records byes for odd fields. Round-robin keeps the historical
    // schedule shape (only real tables) except for a singleton field left after
    // DSQ/withdrawal, where a bye is the only meaningful result to record.
    if (bye && n % 2 === 1 && (this.format(state) === 'swiss' || n === 1)) {
      matches.push({ id: 0, round, playerA: bye, playerB: '(bye)', tableNo: matches.length + 1, roomName: null, playerAPass: null, playerBPass: null, resultA: 2, resultB: 0, source: 'bye', faultedAt: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stage: this.format(state) === 'round_robin' ? 'round_robin' : 'swiss', bracketRound: round });
    }
    return matches;
  }

  private doubleEliminationLosses(state: ReturnType<typeof loadState>, seeds: string[]): Record<string, number> {
    const losses = Object.fromEntries(seeds.map((id) => [id, 0])) as Record<string, number>;
    for (const match of state.matches.filter((candidate) => this.isEliminationMatch(candidate)
      && candidate.resultA !== null && candidate.resultB !== null)) {
      if (match.resultA === match.resultB) continue;
      const loser = match.resultA! < match.resultB! ? match.playerA : match.playerB;
      if (Object.prototype.hasOwnProperty.call(losses, loser)) losses[loser] += 1;
    }
    return losses;
  }

  private generateDoubleEliminationRound(state: ReturnType<typeof loadState>, round: number): MatchState[] {
    const seeds = (state.competition?.seeds ?? this.activePlayers(state).map((p) => p.playerId))
      .filter((id) => this.activePlayers(state).some((p) => p.playerId === id));
    const losses = this.doubleEliminationLosses(state, seeds);
    const alive = seeds.filter((id) => (losses[id] ?? 0) < 2);
    if (alive.length < 2) return [];
    const make = (
      a: string,
      b: string,
      stage: 'winners' | 'losers' | 'grand_final' | 'grand_final_reset',
      index: number,
    ): MatchState => ({
      id: 0, round, playerA: a, playerB: b, tableNo: index + 1,
      roomName: null, playerAPass: null, playerBPass: null, resultA: null, resultB: null,
      source: null, faultedAt: null, startedAt: null, finishedAt: null,
      stage, bracketRound: round, bracketMatchId: `${stage}-${round}-${index + 1}`,
    });
    if (alive.length === 2) {
      // If the one-loss finalist beats the undefeated finalist, both now have
      // one loss and a reset match is required. The old implementation ended
      // the tournament after the first grand final regardless of its winner.
      const completedGrandFinal = state.matches.some((match) => match.stage === 'grand_final' && match.resultA !== null && match.resultB !== null);
      return [make(alive[0], alive[1], completedGrandFinal ? 'grand_final_reset' : 'grand_final', 0)];
    }
    const matches: MatchState[] = [];
    for (const lossCount of [0, 1]) {
      const group = alive.filter((id) => (losses[id] ?? 0) === lossCount);
      for (let i = 0; i + 1 < group.length; i += 2) {
        matches.push(make(group[i], group[i + 1], lossCount === 0 ? 'winners' : 'losers', matches.length));
      }
    }
    return matches;
  }

  startRound(tid: number, round: number, actor: string): void {
    const shouldCreateRooms = withEventTransaction(tid, () => this.startRoundCommand(tid, round, actor));
    if (shouldCreateRooms) afterEventCommit(tid, () => void this.createRoomsForRound(tid, round));
  }

  private startRoundCommand(tid: number, round: number, actor: string): boolean {
    const state = loadState(tid);
    if (!Number.isSafeInteger(round) || round < 1 || round > 10_000) throw new Error('BAD_PAYLOAD');
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'matches') throw new Error('WRONG_PHASE');
    if (state.matches.length === 0) this.validateStart(tid);
    if (state.matches.some((m) => m.round === round)) throw new Error('ROUND_EXISTS');
    if (!state.competition) {
      const format = this.format(state);
      const seeds = this.activePlayers(state).map((p) => p.playerId);
      logEvent(tid, 'tournament', 'competition', {
        format,
        seeds: format === 'double_elimination' ? this.shuffled(seeds) : seeds,
        roundRobinSchedule: format === 'round_robin' ? this.roundRobinSchedule(seeds) : undefined,
        losses: format === 'double_elimination' ? Object.fromEntries(seeds.map((id) => [id, 0])) : undefined,
      }, actor);
    }
    const current = loadState(tid);
    const matches = this.format(current) === 'double_elimination'
      ? this.generateDoubleEliminationRound(current, round)
      : this.generateRound(current, round);
    if (matches.length === 0) {
      logEvent(tid, 'tournament', 'phase', { status: 'finished', round: Math.max(0, round - 1) }, actor);
      persistMeta(tid);
      return false;
    }
    // persist with ids
    const now = new Date().toISOString();
    const insert = getDb().prepare(
      'INSERT INTO matches (tournament_id, round, player_a, player_b, table_no, room_name, player_a_pass, player_b_pass, result_a, result_b, source, started_at, finished_at, stage, bracket_round, bracket_match_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const m of matches) {
      // Keep the match start timestamp in the event state as well as the SQL
      // projection. Room retries/re-entry must reuse this value for the cube
      // deck filename instead of creating a new timestamped file each time.
      const persisted = { ...m, startedAt: m.startedAt ?? now };
      const row = insert.run(tid, persisted.round, persisted.playerA, persisted.playerB, persisted.tableNo, null, persisted.playerAPass, persisted.playerBPass, persisted.resultA, persisted.resultB, persisted.source, persisted.startedAt, persisted.finishedAt, persisted.stage ?? null, persisted.bracketRound ?? null, persisted.bracketMatchId ?? null);
      logEvent(tid, 'match', 'match', { ...persisted, id: Number(row.lastInsertRowid) }, actor);
    }
    if (state.round !== round) {
      logEvent(tid, 'tournament', 'phase', { status: 'matches', round }, actor);
    }
    persistMeta(tid);
    return true;
  }

  private async createRoomsForRound(tid: number, round: number): Promise<void> {
    const state = loadState(tid);
    if (state.frozen) return;
    const generation = this.operationGeneration.get(tid) ?? 0;
    const cfg = getConfig(state);
    for (const m of state.matches.filter((x) => x.round === round && x.roomName === null && x.playerB !== '(bye)')) {
      try {
        if ((this.operationGeneration.get(tid) ?? 0) !== generation) return;
        const beforeCreate = loadState(tid);
        const liveMatch = beforeCreate.matches.find((candidate) => candidate.id === m.id);
        if (beforeCreate.frozen || beforeCreate.status !== 'matches' || !liveMatch || liveMatch.resultA !== null || liveMatch.roomName !== null) {
          continue;
        }
        // Room identity must be stable across an accepted request whose local
        // response/update was lost. Together with request_id this makes srvpro
        // creation idempotent instead of leaking duplicate duel processes.
        const roomKey = BigInt(`0x${crypto.createHash('sha256')
          .update(`${tid}:${m.id}:${m.startedAt ?? ''}`)
          .digest('hex')
          .slice(0, 18)}`).toString(36).padStart(14, '0');
        // CTOS_JoinGame has uint16_t pass[20]: 19 visible ASCII characters.
        // Keep the opaque room identity within that protocol limit and resolve
        // webhook ownership from the persisted match row, not from user input.
        const roomName = `CUBE-${roomKey}`;
        const syncedAt = this.deckSyncAt(state, m);
        const deckA = state.decks[m.playerA];
        const deckB = state.decks[m.playerB];
        const res = await this.srvpro.createRoom({
          room_name: roomName,
          request_id: `t:${tid}:m:${m.id}:${roomKey}`,
          hostinfo: {
            mode: cfg.mode === 'match' ? 1 : 0,
            rule: 5,
            lflist: -1,
            duel_rule: 5,
            start_lp: 8000,
            start_hand: 5,
            draw_count: 1,
            time_limit: Number(cfg.timeLimit ?? 180),
          },
          deck_size: { main_min: cfg.mainMin, main_max: cfg.mainMax, extra_max: cfg.extraMax, side_max: cfg.sideMax },
          players: [
            { player_id: m.playerA, name_vpass: m.playerA },
            { player_id: m.playerB, name_vpass: m.playerB },
          ],
          cube_decks: {
            [m.playerA]: { main: [...deckA.main, ...deckA.extra], side: deckA.side, filename: cubeDeckFileBase(tid, m.playerA, syncedAt) },
            [m.playerB]: { main: [...deckB.main, ...deckB.extra], side: deckB.side, filename: cubeDeckFileBase(tid, m.playerB, syncedAt) },
          },
        });
        if (res.ok) {
          const current = loadState(tid);
          const currentMatch = current.matches.find((x) => x.id === m.id);
          if ((this.operationGeneration.get(tid) ?? 0) !== generation || current.frozen || current.status !== 'matches'
            || !currentMatch || currentMatch.resultA !== null) {
            try { await this.srvpro.closeRoom(roomName); } catch { /* already gone */ }
          } else if (currentMatch.roomName === null) {
            this.patchMatch(tid, m.id, { roomName, source: 'srvpro' });
          } else if (currentMatch.roomName !== roomName) {
            // A competing attempt won with a different room identity. The
            // deterministic request normally makes this impossible, but only
            // that genuinely orphaned room should be closed. If both calls
            // resolved the same idempotent srvpro request, closing here would
            // tear down the valid room already recorded by the first caller.
            try { await this.srvpro.closeRoom(roomName); } catch { /* already gone */ }
          }
        } else {
          console.error('srvpro create_room failed', roomName, res);
        }
      } catch (e) {
        console.error('srvpro create_room error', m.id, (e as Error).message);
      }
    }
  }

  /**
   * Choose the immutable timestamp for a match's server-synchronized decks.
   * New matches carry startedAt in the event log; lockedAt keeps old/reverted
   * match records deterministic. The final fallback is only for legacy data
   * where neither timestamp was recorded.
   */
  private deckSyncAt(state: ReturnType<typeof loadState>, match: MatchState): Date {
    const candidates = [
      match.startedAt,
      state.decks[match.playerA]?.lockedAt,
      state.decks[match.playerB]?.lockedAt,
    ];
    for (const raw of candidates) {
      if (!raw) continue;
      const value = new Date(raw);
      if (Number.isFinite(value.getTime())) return value;
    }
    return new Date();
  }

  private patchMatch(tid: number, id: number, patch: Partial<MatchState>, actor = 'system'): void {
    withEventTransaction(tid, () => this.patchMatchCommand(tid, id, patch, actor));
  }

  private patchMatchCommand(tid: number, id: number, patch: Partial<MatchState>, actor = 'system'): void {
    const state = loadState(tid);
    if (state.frozen) return;
    const m = state.matches.find((x) => x.id === id);
    if (!m) return;
    const db = getDb();
    const value = <K extends keyof MatchState>(key: K): MatchState[K] =>
      Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] as MatchState[K] : m[key];
    db.prepare('UPDATE matches SET room_name=?, player_a_pass=?, player_b_pass=?, result_a=?, result_b=?, source=?, faulted_at=?, started_at=?, finished_at=? WHERE id=?').run(
      value('roomName'),
      value('playerAPass'),
      value('playerBPass'),
      value('resultA'),
      value('resultB'),
      value('source'),
      value('faultedAt'),
      value('startedAt'),
      value('finishedAt'),
      id,
    );
    logEvent(tid, 'match', 'match', { ...m, ...patch }, actor);
    persistMeta(tid);
  }

  // srvpro 断线标记 -9 → 断线方一律 0:2 判负；双方均断线 → 0:0。
  // Missing, fractional, or out-of-range values are transport faults and must
  // never become standings points (the old -5 fallback corrupted rankings).
  private static normalizeResult(a: unknown, b: unknown): [number, number] | null {
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    const ra = Number(a);
    const rb = Number(b);
    if (![-9, 0, 1, 2].includes(ra) || ![-9, 0, 1, 2].includes(rb)) return null;
    if (ra === -9 || rb === -9) {
      return [ra === -9 ? 0 : 2, rb === -9 ? 0 : 2];
    }
    return [ra, rb];
  }

  private isEliminationMatch(match: MatchState): boolean {
    return ['playoff', 'winners', 'losers', 'grand_final', 'grand_final_reset'].includes(String(match.stage));
  }

  // srvpro webhook receiver (dev_docs/07 §3.4)
  onWebhook(body: any): { ack: boolean } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ack: false };
    const roomName = body?.room_name;
    if (typeof roomName !== 'string' || roomName.length > 255) return { ack: false };
    const rows = getDb().prepare(
      'SELECT tournament_id FROM matches WHERE room_name=? LIMIT 2',
    ).all(roomName) as { tournament_id: number }[];
    if (rows.length !== 1) return { ack: false };
    const tid = Number(rows[0].tournament_id);
    const state = loadState(tid);
    if (state.frozen) return { ack: false };
    const match = state.matches.find((x) => x.roomName === roomName);
    if (!match) return { ack: false };
    if (match.resultA !== null) return { ack: true }; // idempotent
    // srvpro currently sends exactly two players. Keep the endpoint bounded so
    // a forged internal request cannot allocate an unbounded lookup map.
    if (!Array.isArray(body.players) || body.players.length > 8) return { ack: false };
    const byId: Record<string, any> = Object.create(null) as Record<string, any>;
    for (const player of body.players) {
      if (
        player &&
        typeof player === 'object' &&
        !Array.isArray(player) &&
        typeof player.player_id === 'string' &&
        player.player_id.length <= 64
      ) {
        byId[player.player_id] = player;
      }
    }
    const a = byId[match.playerA];
    const b = byId[match.playerB];
    if (!a || !b) return { ack: false };
    const normalized = MatchesService.normalizeResult(a.score, b.score);
    if (!normalized) {
      this.patchMatch(tid, match.id, { source: 'invalid_result', faultedAt: new Date().toISOString() });
      return { ack: true };
    }
    const [resultA, resultB] = normalized;
    if (this.isEliminationMatch(match) && resultA === resultB) {
      this.patchMatch(tid, match.id, { source: 'invalid_draw', faultedAt: new Date().toISOString() });
      return { ack: true };
    }
    const reportedEnd = typeof body.end === 'string' && Number.isFinite(new Date(body.end).getTime())
      ? new Date(body.end).toISOString()
      : new Date().toISOString();
    withEventTransaction(tid, () => {
      this.patchMatch(tid, match.id, { resultA, resultB, source: 'webhook', faultedAt: null, finishedAt: reportedEnd });
      this.maybeAdvance(tid, match.round);
    });
    return { ack: true };
  }

  private maybeAdvance(tid: number, round: number): void {
    const state = loadState(tid);
    if (state.frozen) return;
    const roundMatches = state.matches.filter((m) => m.round === round);
    if (roundMatches.length === 0) return;
    const done = roundMatches.every((m) => m.resultA !== null && m.resultB !== null);
    if (!done) return;
    if (roundMatches.some((match) => match.stage === 'grand_final' || match.stage === 'grand_final_reset')) {
      const seeds = state.competition?.seeds ?? this.activePlayers(state).map((player) => player.playerId);
      const losses = this.doubleEliminationLosses(state, seeds);
      const alive = seeds.filter((playerId) => (losses[playerId] ?? 0) < 2);
      if (alive.length <= 1) {
        logEvent(tid, 'tournament', 'phase', { status: 'finished', round }, 'system');
        persistMeta(tid);
      } else {
        // The losers-bracket finalist handed the previously undefeated player
        // their first loss. An administrator confirms before creating the reset.
        logEvent(tid, 'tournament', 'round_complete', { round }, 'system');
        persistMeta(tid);
      }
      return;
    }
    if (roundMatches.length === 1 && roundMatches[0].stage === 'playoff') {
      logEvent(tid, 'tournament', 'phase', { status: 'finished', round }, 'system');
      persistMeta(tid);
      return;
    }
    // 其余轮次不自动推进：发 round_complete 事件，由管理员确认后 advanceRound 开始下一轮
    logEvent(tid, 'tournament', 'round_complete', { round }, 'system');
    persistMeta(tid);
  }

  // 管理员确认当前轮全部有结果后，开始下一轮（swiss→swiss / swiss 完→季后赛种子 / 季后赛→胜者配对 / 全部打完→结束）
  advanceRound(tid: number, actor: string): void {
    const nextRound = withEventTransaction(tid, () => this.advanceRoundCommand(tid, actor));
    if (nextRound !== null) afterEventCommit(tid, () => void this.createRoomsForRound(tid, nextRound));
  }

  private advanceRoundCommand(tid: number, actor: string): number | null {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status !== 'matches') throw new Error('WRONG_PHASE');
    const cur = state.round;
    const roundMatches = state.matches.filter((m) => m.round === cur);
    if (roundMatches.length === 0) throw new Error('NO_ROUND');
    if (!roundMatches.every((m) => m.resultA !== null && m.resultB !== null)) throw new Error('ROUND_PENDING');
    const n = this.activePlayers(state).length;
    const format = this.format(state);
    if (format === 'double_elimination') {
      return this.startRoundCommand(tid, cur + 1, actor) ? cur + 1 : null;
    }
    if (format === 'round_robin') {
      const total = state.competition?.roundRobinSchedule?.length ?? Math.max(1, n - 1);
      if (cur < total) return this.startRoundCommand(tid, cur + 1, actor) ? cur + 1 : null;
      logEvent(tid, 'tournament', 'phase', { status: 'finished', round: cur }, actor);
      persistMeta(tid);
      return null;
    }
    const swissRounds = this.configuredSwissRounds(state);
    if (cur < swissRounds) {
      return this.startRoundCommand(tid, cur + 1, actor) ? cur + 1 : null;
    } else if (cur === swissRounds) {
      const playoffSize = Number(getConfig(state).playoffSize ?? (n >= 9 ? (n >= 17 ? 8 : 4) : 0));
      if (playoffSize > 0) {
        // 季后赛按排名取种子，并按标准高低种子固定 bracket。
        const top = this.points(state, cur + 1)
          .slice(0, playoffSize)
          .map((r) => r.playerId);
        this.pairPlayoffRoundCommand(tid, cur + 1, this.bracketSeedOrder(top), 1);
        return cur + 1;
      } else {
        logEvent(tid, 'tournament', 'phase', { status: 'finished', round: cur }, actor);
        persistMeta(tid);
      }
    } else {
      // 季后赛轮：胜者配对晋级
      const winners = roundMatches.map((m) => (m.resultA! > m.resultB! ? m.playerA : m.playerB));
      if (winners.length <= 1) {
        logEvent(tid, 'tournament', 'phase', { status: 'finished', round: cur }, actor);
        persistMeta(tid);
      } else {
        this.pairPlayoffRoundCommand(tid, cur + 1, winners, cur - swissRounds + 1);
        return cur + 1;
      }
    }
    return null;
  }

  private bracketSeedOrder(ids: string[]): string[] {
    if (ids.length <= 2) return ids;
    let positions = [1, 2];
    while (positions.length < ids.length) {
      const size = positions.length * 2 + 1;
      positions = positions.flatMap((seed) => [seed, size - seed]);
    }
    return positions.map((seed) => ids[seed - 1]).filter(Boolean);
  }

  private pairPlayoffRoundCommand(tid: number, round: number, ids: string[], bracketRound: number): void {
    const state = loadState(tid);
    if (state.matches.some((m) => m.round === round)) throw new Error('ROUND_EXISTS');
    const matches: MatchState[] = [];
    for (let i = 0; i < ids.length; i += 2) {
      if (i + 1 >= ids.length) break;
      matches.push({ id: 0, round, playerA: ids[i], playerB: ids[i + 1], tableNo: i / 2 + 1, roomName: null, playerAPass: null, playerBPass: null, resultA: null, resultB: null, source: null, faultedAt: null, startedAt: null, finishedAt: null, stage: 'playoff', bracketRound, bracketMatchId: `playoff-${bracketRound}-${i / 2 + 1}` });
    }
    const now = new Date().toISOString();
    const insert = getDb().prepare(
      'INSERT INTO matches (tournament_id, round, player_a, player_b, table_no, room_name, player_a_pass, player_b_pass, result_a, result_b, source, started_at, finished_at, stage, bracket_round, bracket_match_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const m of matches) {
      const persisted = { ...m, startedAt: m.startedAt ?? now };
      const row = insert.run(tid, persisted.round, persisted.playerA, persisted.playerB, persisted.tableNo, null, null, null, persisted.resultA, persisted.resultB, persisted.source, persisted.startedAt, null, persisted.stage, persisted.bracketRound, persisted.bracketMatchId);
      logEvent(tid, 'match', 'match', { ...persisted, id: Number(row.lastInsertRowid) }, 'system');
    }
    if (state.round !== round) {
      logEvent(tid, 'tournament', 'phase', { status: 'matches', round }, 'system');
    }
    persistMeta(tid);
  }

  // polling fallback (dev_docs/05 §6)：结果采集 + 建房失败重试
  private async pollAll(): Promise<void> {
    try {
      await this.doPollAll();
    } catch (e) {
      // 轮询回调异常不可冒泡（setInterval 回调抛异常会杀进程）
      console.error('pollAll failed', (e as Error).message);
    }
  }

  private async doPollAll(): Promise<void> {
    const db = getDb();
    const rows = db
      .prepare('SELECT DISTINCT tournament_id FROM matches WHERE room_name IS NOT NULL AND result_a IS NULL')
      .all() as { tournament_id: number }[];
    for (const r of rows) {
      let state: ReturnType<typeof loadState>;
      try {
        state = loadState(r.tournament_id);
      } catch {
        continue; // 比赛已被删除
      }
      if (state.frozen) continue;
      for (const m of state.matches.filter((x) => x.roomName && x.resultA === null && !x.faultedAt && x.playerB !== '(bye)')) {
        try {
          const st = await this.srvpro.roomStatus(m.roomName!);
          if (st.ok && st.finished) {
            const scores = st.scores ?? {};
            const a = scores[state.players.find((p) => p.playerId === m.playerA)?.playerId ?? ''];
            const b = scores[state.players.find((p) => p.playerId === m.playerB)?.playerId ?? ''];
            const normalized = MatchesService.normalizeResult(a, b);
            if (!normalized) {
              this.patchMatch(r.tournament_id, m.id, { source: 'invalid_result', faultedAt: new Date().toISOString() });
              continue;
            }
            const [resultA, resultB] = normalized;
            if (this.isEliminationMatch(m) && resultA === resultB) {
              this.patchMatch(r.tournament_id, m.id, { source: 'invalid_draw', faultedAt: new Date().toISOString() });
              continue;
            }
            withEventTransaction(r.tournament_id, () => {
              this.patchMatch(r.tournament_id, m.id, { resultA, resultB, source: 'poll', finishedAt: new Date().toISOString() });
              this.maybeAdvance(r.tournament_id, m.round);
            });
          }
        } catch (e) {
          // 房间已消失（404）但无结果 = 建房后故障退出：标记故障停止轮询，由管理员手动补录结果
          if ((e as { response?: { status?: number } }).response?.status === 404) {
            this.patchMatch(r.tournament_id, m.id, { faultedAt: new Date().toISOString() });
          }
          // 其余错误（srvpro 整体不可用等）：下次 tick 重试
        }
      }
    }
    // 建房失败自愈：matches 阶段中 roomName 仍为 null 的未决对局，每 30s 重试建房（G2）
    const active = db.prepare('SELECT id FROM tournaments WHERE status=?').all('matches') as { id: number }[];
    for (const r of active) {
      const last = this.roomRetryCooldown.get(r.id) ?? 0;
      if (Date.now() - last < 30000) continue;
      try {
        const st = loadState(r.id);
        if (st.frozen) continue;
        const missing = st.matches.some((m) => m.round === st.round && m.roomName === null && m.resultA === null && m.playerB !== '(bye)');
        if (missing) {
          this.roomRetryCooldown.set(r.id, Date.now());
          await this.createRoomsForRound(r.id, st.round);
        }
      } catch {
        // 比赛已删除等：忽略
      }
    }
  }

  async closeSrvproRoom(roomName: string): Promise<void> {
    try {
      await this.srvpro.closeRoom(roomName);
    } catch (e) {
      console.error('close srvpro room failed', roomName, (e as Error).message);
    }
  }

  invalidateTournament(tid: number): void {
    this.operationGeneration.set(tid, (this.operationGeneration.get(tid) ?? 0) + 1);
    this.roomRetryCooldown.delete(tid);
  }

  async closeRoomsForRevert(roomNames: string[]): Promise<void> {
    const failures: string[] = [];
    for (const roomName of [...new Set(roomNames)]) {
      try {
        await this.srvpro.closeRoom(roomName);
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status !== 404) failures.push(roomName);
      }
    }
    if (failures.length) throw new Error(`REVERT_ROOM_CLOSE_FAILED:${failures.join(',')}`);
  }

  resumeAfterRevert(tid: number): void {
    const state = loadState(tid);
    if (!state.frozen && state.status === 'matches') {
      afterEventCommit(tid, () => void this.createRoomsForRound(tid, state.round));
    }
  }

  // 管理台手动设置/修改对战结果（含故障房间补录）；触发轮次推进与实时积分更新
  setMatchResult(tid: number, round: number, tableNo: number, resultA: number, resultB: number, actor = 'admin'): void {
    const state = loadState(tid);
    if (state.frozen) throw new Error('FROZEN');
    if (state.status === 'finished' || state.matches.some((match) => match.round > round)) {
      // Editing history after a dependent round exists leaves the bracket and
      // standings inconsistent. Administrators must use the audited revert flow.
      throw new Error('RESULT_ROUND_LOCKED');
    }
    const m = state.matches.find((x) => x.round === round && x.tableNo === tableNo);
    if (!m) throw new Error('MATCH_NOT_FOUND');
    if (![0, 1, 2].includes(resultA) || ![0, 1, 2].includes(resultB)) throw new Error('BAD_RESULT');
    if (this.isEliminationMatch(m) && resultA === resultB) throw new Error('ELIMINATION_DRAW');
    const room = m.roomName;
    withEventTransaction(tid, () => {
      this.patchMatch(tid, m.id, { resultA, resultB, source: 'admin', faultedAt: null, finishedAt: new Date().toISOString() }, actor);
      this.maybeAdvance(tid, round);
    });
    if (room) void this.closeSrvproRoom(room);
  }

  // 实时积分榜（dev_docs/07 §2.4）：胜 3 分、平 1 分、负 0 分，OMW% 破同分
  ranking(tid: number) {
    const state = loadState(tid);
    const names = new Map(state.players.map((p) => [p.playerId, p.displayName]));
    const rows = state.players
      .filter((p) => !p.eliminated)
      .map((p) => {
        const mine = state.matches.filter(
          (m) => (m.playerA === p.playerId || m.playerB === p.playerId) && m.resultA !== null && m.resultB !== null,
        );
        let wins = 0;
        let draws = 0;
        let losses = 0;
        let omw = 0;
        let gameDiff = 0;
        let oppPoints = 0;
        let opponentCount = 0;
        for (const m of mine) {
          const isA = m.playerA === p.playerId;
          const my = isA ? m.resultA! : m.resultB!;
          const opp = isA ? m.resultB! : m.resultA!;
          if (my > opp) wins++;
          else if (my === opp) draws++;
          else losses++;
          const oppId = isA ? m.playerB : m.playerA;
          if (oppId !== '(bye)') {
            gameDiff += my - opp; // 轮空净胜局记 0
            const oppRows = state.matches.filter(
              (x) => (x.playerA === oppId || x.playerB === oppId) && x.resultA !== null && x.resultB !== null,
            );
            const oppWins = oppRows.filter((x) => {
              const a = x.playerA === oppId ? x.resultA! : x.resultB!;
              const b = x.playerA === oppId ? x.resultB! : x.resultA!;
              return a > b;
            }).length;
            omw += oppRows.length ? oppWins / oppRows.length : 0;
            oppPoints += oppWins * 3;
            opponentCount++;
          }
        }
        return {
          playerId: p.playerId,
          displayName: names.get(p.playerId) ?? p.playerId,
          played: mine.length,
          wins,
          draws,
          losses,
          points: wins * 3 + draws,
          gameDiff,
          omw: opponentCount ? Number((omw / opponentCount).toFixed(3)) : 0,
          oppPoints,
        };
      });
    rows.sort((a, b) => b.points - a.points || b.gameDiff - a.gameDiff || b.omw - a.omw || b.oppPoints - a.oppPoints);
    return rows.map((r, i) => ({ rank: i + 1, ...r }));
  }

  roomInfo(tid: number, playerId: string) {
    const state = loadState(tid);
    // 返回该玩家全部轮次的历史对局（不只当前轮），按轮次/桌号排序
    return state.matches
      .filter((m) => m.playerA === playerId || m.playerB === playerId)
      .sort((a, b) => a.round - b.round || a.tableNo - b.tableNo)
      .map((m) => ({
        id: m.id,
        round: m.round,
        tableNo: m.tableNo,
        playerA: m.playerA,
        opponent: m.playerA === playerId ? m.playerB : m.playerA,
        roomName: m.roomName,
        resultA: m.resultA,
        resultB: m.resultB,
        startedAt: m.startedAt,
        finishedAt: m.finishedAt,
        stage: m.stage,
        bracketRound: m.bracketRound,
        bracketMatchId: m.bracketMatchId,
      }));
  }
}
