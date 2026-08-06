import { Injectable, OnModuleInit } from '@nestjs/common';
import { getDb } from '../db';
import { loadState, logEvent, getConfig, persistMeta, MatchState } from '../events/events.service';
import { config } from '../config';
import axios from 'axios';
import crypto from 'crypto';

// 房间号随机词（在规律编号后附加，避免玩家进错房间）
const ROOM_WORDS = [
  'ember', 'frost', 'gale', 'haze', 'iron', 'jade', 'kite', 'lark', 'mist', 'nova',
  'onyx', 'pearl', 'quartz', 'raven', 'slate', 'tide', 'umbra', 'vale', 'wisp', 'yew',
  'amber', 'briar', 'cedar', 'dusk', 'elm', 'fern', 'grove', 'holly', 'iris', 'juniper',
];

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
export class MatchesService implements OnModuleInit {
  private poller: NodeJS.Timeout | null = null;
  private roomRetryCooldown = new Map<number, number>(); // tid -> last attempt ts
  constructor(private srvpro: SrvproApi = new RealSrvproClient(config.srvpro.url, config.srvpro.apiKey)) {}

  onModuleInit(): void {
    if (!this.poller) {
      this.poller = setInterval(() => this.pollAll(), 10000);
    }
  }

  // ---------- pairing (dev_docs/05 §5) ----------

  swissRounds(n: number): number {
    if (n <= 5) return n - 1; // round robin
    if (n <= 16) return 4;
    return Math.ceil(Math.log2(n)) + 1; // 17+: 标准瑞士轮（dev_docs/05 §5）
  }

  private points(state: ReturnType<typeof loadState>, round: number): PointsRow[] {
    const rows: PointsRow[] = state.players
      .filter((p) => !p.eliminated)
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
    const n = state.players.filter((p) => !p.eliminated).length;
    const ids = this.points(state, round).map((r) => r.playerId);
    const playedPairs = new Set<string>();
    for (const m of state.matches) {
      playedPairs.add([m.playerA, m.playerB].sort().join('|'));
    }
    const pairs: [string, string][] = [];
    if (n <= 5) {
      // round robin (circle method): each call generates exactly ONE round,
      // every player appears in at most one match per round (dev_docs/05 §5).
      // 4 players: R1 1v2,3v4; R2 1v3,2v4; R3 1v4,2v3
      const arr = [ids[0], ...ids.slice(1)];
      for (let r = 1; r < round; r++) {
        // others rotate left one seat per round
        const first = arr.splice(1, 1)[0];
        arr.push(first);
      }
      for (let i = 0; i < Math.floor(n / 2); i++) {
        const a = arr[2 * i];
        const b = arr[2 * i + 1];
        if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b]);
      }
    } else {
      // swiss: pair adjacent, skip repeats; leftover players pair among themselves
      // (a forced rematch is acceptable when unavoidable in swiss)
      const used = new Set<string>();
      for (let i = 0; i < ids.length - 1; i++) {
        if (used.has(ids[i])) continue;
        for (let j = i + 1; j < ids.length; j++) {
          if (used.has(ids[j])) continue;
          const key = [ids[i], ids[j]].sort().join('|');
          if (playedPairs.has(key)) continue;
          pairs.push([ids[i], ids[j]]);
          used.add(ids[i]);
          used.add(ids[j]);
          break;
        }
      }
      const leftover = ids.filter((id) => !used.has(id));
      for (let i = 0; i < leftover.length - 1; i += 2) {
        pairs.push([leftover[i], leftover[i + 1]]);
        used.add(leftover[i]);
        used.add(leftover[i + 1]);
      }
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
      startedAt: null,
      finishedAt: null,
    }));
    if (bye && n % 2 === 1) {
      matches.push({ id: 0, round, playerA: bye, playerB: '(bye)', tableNo: matches.length + 1, roomName: null, playerAPass: null, playerBPass: null, resultA: 2, resultB: 0, source: 'bye', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    }
    return matches;
  }

  startRound(tid: number, round: number, actor: string): void {
    const state = loadState(tid);
    if (state.status !== 'matches') throw new Error('WRONG_PHASE');
    if (state.matches.some((m) => m.round === round)) throw new Error('ROUND_EXISTS');
    const matches = this.generateRound(state, round);
    // persist with ids
    const now = new Date().toISOString();
    const insert = getDb().prepare(
      'INSERT INTO matches (tournament_id, round, player_a, player_b, table_no, room_name, player_a_pass, player_b_pass, result_a, result_b, source, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const m of matches) {
      const row = insert.run(tid, m.round, m.playerA, m.playerB, m.tableNo, null, m.playerAPass, m.playerBPass, m.resultA, m.resultB, m.source, now, m.finishedAt);
      logEvent(tid, 'match', 'match', { ...m, id: Number(row.lastInsertRowid) }, actor);
    }
    if (state.round !== round) {
      logEvent(tid, 'tournament', 'phase', { status: 'matches', round }, actor);
    }
    persistMeta(tid);
    // async: create srvpro rooms for real pairs
    void this.createRoomsForRound(tid, round);
  }

  private async createRoomsForRound(tid: number, round: number): Promise<void> {
    const state = loadState(tid);
    const cfg = getConfig(state);
    for (const m of state.matches.filter((x) => x.round === round && x.roomName === null && x.playerB !== '(bye)')) {
      try {
        const roomName = `CUBE-${tid}-${round}-${m.tableNo}-${ROOM_WORDS[crypto.randomInt(ROOM_WORDS.length)]}`;
        const deckA = state.decks[m.playerA];
        const deckB = state.decks[m.playerB];
        const res = await this.srvpro.createRoom({
          room_name: roomName,
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
            [m.playerA]: { main: [...deckA.main, ...deckA.extra], side: deckA.side },
            [m.playerB]: { main: [...deckB.main, ...deckB.extra], side: deckB.side },
          },
        });
        if (res.ok) {
          this.patchMatch(tid, m.id, { roomName, source: 'srvpro' });
        } else {
          console.error('srvpro create_room failed', roomName, res);
        }
      } catch (e) {
        console.error('srvpro create_room error', m.id, (e as Error).message);
      }
    }
  }

  private patchMatch(tid: number, id: number, patch: Partial<MatchState>): void {
    const state = loadState(tid);
    const m = state.matches.find((x) => x.id === id);
    if (!m) return;
    logEvent(tid, 'match', 'match', { ...m, ...patch }, 'system');
    const db = getDb();
    db.prepare('UPDATE matches SET room_name=?, player_a_pass=?, player_b_pass=?, result_a=?, result_b=?, source=?, finished_at=? WHERE id=?').run(
      patch.roomName ?? m.roomName,
      patch.playerAPass ?? m.playerAPass,
      patch.playerBPass ?? m.playerBPass,
      patch.resultA ?? m.resultA,
      patch.resultB ?? m.resultB,
      patch.source ?? m.source,
      patch.finishedAt ?? m.finishedAt,
      id,
    );
    persistMeta(tid);
  }

  // srvpro webhook receiver (dev_docs/07 §3.4)
  onWebhook(body: any): { ack: boolean } {
    const roomName: string = body.room_name;
    const m = roomName.match(/^CUBE-(\d+)-(\d+)-(\d+)(?:-[A-Za-z0-9]+)?$/);
    if (!m) return { ack: false };
    const tid = Number(m[1]);
    const round = Number(m[2]);
    const table = Number(m[3]);
    const state = loadState(tid);
    const match = state.matches.find((x) => x.round === round && x.tableNo === table);
    if (!match) return { ack: false };
    if (match.resultA !== null) return { ack: true }; // idempotent
    const byId: Record<string, any> = {};
    for (const p of body.players || []) byId[p.player_id] = p;
    const a = byId[match.playerA];
    const b = byId[match.playerB];
    if (!a || !b) return { ack: false };
    const resultA = a.score ?? -5;
    const resultB = b.score ?? -5;
    this.patchMatch(tid, match.id, { resultA, resultB, source: 'webhook', finishedAt: body.end ?? new Date().toISOString() });
    this.maybeAdvance(tid, round);
    return { ack: true };
  }

  private maybeAdvance(tid: number, round: number): void {
    const state = loadState(tid);
    const roundMatches = state.matches.filter((m) => m.round === round);
    if (roundMatches.length === 0) return;
    const done = roundMatches.every((m) => m.resultA !== null && m.resultB !== null);
    if (!done) return;
    const n = state.players.filter((p) => !p.eliminated).length;
    const swissRounds = this.swissRounds(n);
    const isPlayoffRound = round > swissRounds;
    if (isPlayoffRound) {
      if (roundMatches.length <= 1) {
        logEvent(tid, 'tournament', 'phase', { status: 'finished', round }, 'system');
      } else {
        // next playoff round: winners of this round pair up
        const winners = roundMatches.map((m) => (m.resultA! > m.resultB! ? m.playerA : m.playerB));
        this.pairPlayoffRound(tid, round + 1, winners);
      }
      persistMeta(tid);
      return;
    }
    if (round < swissRounds) {
      this.startRound(tid, round + 1, 'system');
    } else if (n >= 9) {
      // top 4 (9-16) or top 8 (17+) playoffs：按积分+净胜局取种子（dev_docs/05 §5）
      const top = this.points(state, round + 1).slice(0, n >= 17 ? 8 : 4).map((r) => r.playerId);
      this.pairPlayoffRound(tid, round + 1, top);
    } else {
      logEvent(tid, 'tournament', 'phase', { status: 'finished', round }, 'system');
    }
    persistMeta(tid);
  }

  private pairPlayoffRound(tid: number, round: number, ids: string[]): void {
    const state = loadState(tid);
    const matches: MatchState[] = [];
    for (let i = 0; i < ids.length; i += 2) {
      if (i + 1 >= ids.length) break;
      matches.push({ id: 0, round, playerA: ids[i], playerB: ids[i + 1], tableNo: i / 2 + 1, roomName: null, playerAPass: null, playerBPass: null, resultA: null, resultB: null, source: null, startedAt: null, finishedAt: null });
    }
    const now = new Date().toISOString();
    const insert = getDb().prepare(
      'INSERT INTO matches (tournament_id, round, player_a, player_b, table_no, room_name, player_a_pass, player_b_pass, result_a, result_b, source, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const m of matches) {
      const row = insert.run(tid, m.round, m.playerA, m.playerB, m.tableNo, null, null, null, m.resultA, m.resultB, m.source, now, null);
      logEvent(tid, 'match', 'match', { ...m, id: Number(row.lastInsertRowid) }, 'system');
    }
    persistMeta(tid);
    void this.createRoomsForRound(tid, round);
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
      for (const m of state.matches.filter((x) => x.roomName && x.resultA === null && x.playerB !== '(bye)')) {
        try {
          const st = await this.srvpro.roomStatus(m.roomName!);
          if (st.ok && st.finished) {
            const scores = st.scores ?? {};
            const a = scores[state.players.find((p) => p.playerId === m.playerA)?.playerId ?? ''];
            const b = scores[state.players.find((p) => p.playerId === m.playerB)?.playerId ?? ''];
            this.patchMatch(r.tournament_id, m.id, { resultA: a ?? -5, resultB: b ?? -5, source: 'poll', finishedAt: new Date().toISOString() });
            this.maybeAdvance(r.tournament_id, m.round);
          }
        } catch (e) {
          // srvpro down: try again next tick
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
        for (const m of mine) {
          const isA = m.playerA === p.playerId;
          const my = isA ? m.resultA! : m.resultB!;
          const opp = isA ? m.resultB! : m.resultA!;
          if (my > opp) wins++;
          else if (my === opp) draws++;
          else losses++;
          const oppId = isA ? m.playerB : m.playerA;
          if (oppId !== '(bye)') gameDiff += my - opp; // 轮空净胜局记 0
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
          omw: mine.length ? Number((omw / mine.length).toFixed(3)) : 0,
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
      }));
  }
}
