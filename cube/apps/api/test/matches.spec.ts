import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { loadState } from '../src/events/events.service';
import { MatchesService } from '../src/matches/matches.service';
import { DecksService } from '../src/decks/decks.service';
import { CardsService } from '../src/cards/cards.service';
import { cubeDeckFileBase } from '../src/decks/deck-filename';
import { getDb } from '../src/db';

// In-memory fake srvpro: records createRoom calls, lets tests resolve rooms.
class FakeSrvpro {
  rooms: Record<string, { players: string[]; scores: Record<string, number>; request: any }> = {};
  requests: any[] = [];
  closedRooms: string[] = [];
  async createRoom(req: any) {
    this.requests.push(req);
    this.rooms[req.room_name] = { players: req.players.map((p: any) => p.player_id), scores: {}, request: req };
    return { ok: true, room_name: req.room_name, port: 12345 };
  }
  async roomStatus(roomName: string) {
    const r = this.rooms[roomName];
    if (!r) throw Object.assign(new Error('room gone'), { response: { status: 404 } });
    return { ok: true, finished: true, scores: r.scores };
  }
  async closeRoom(roomName: string) {
    this.closedRooms.push(roomName);
    return { ok: true };
  }
}

function setupMatches(n: number, matchFormat?: 'round_robin' | 'swiss') {
  const tournaments = makeTournaments();
  const cards = new CardsService();
  const decks = new DecksService(cards);
  const fake = new FakeSrvpro();
  const matches = new MatchesService(fake as any);
  const tid = tournaments.create({ name: 'm', maxPlayers: n, cardPool: TEST_POOL, ...(matchFormat ? { matchFormat, ...(matchFormat === 'swiss' && n <= 8 ? { swissRoundCount: 4, playoffSize: 0 } : {}) } : {}) }, 'test').tid;
  for (let i = 0; i < n; i++) tournaments.join(tid, `p${i}`, `P${i}`);
  tournaments.setPhase(tid, 'drafting', undefined, 'test');
  tournaments.setPhase(tid, 'deckbuilding', undefined, 'test');
  // give everyone a locked legal deck (no pool check needed for pairing)
  const state = loadState(tid);
  for (const p of state.players) {
    const { logEvent } = require('../src/events/events.service');
    logEvent(tid, 'deck', 'deck', {
      playerId: p.playerId,
      deck: { main: [10000], extra: [], side: [], lockedAt: new Date().toISOString(), status: 'locked' },
    }, 'test');
  }
  tournaments.setPhase(tid, 'matches', undefined, 'test');
  return { tournaments, matches, tid, fake };
}

async function waitRooms(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('pairing engine', () => {
  beforeEach(() => useTestDb());

  it('4 players round robin: one match per player per round, all pairs exactly once', () => {
    const { matches, tid } = setupMatches(4, 'round_robin');
    const seen = new Set<string>();
    for (let r = 1; r <= 3; r++) {
      matches.startRound(tid, r, 'test');
      const state = loadState(tid);
      const roundMatches = state.matches.filter((m) => m.round === r);
      expect(roundMatches.length).toBe(2); // n/2 per round
      // no player appears twice in the same round
      const players = roundMatches.flatMap((m) => [m.playerA, m.playerB]);
      expect(new Set(players).size).toBe(4);
      for (const m of roundMatches) {
        const key = [m.playerA, m.playerB].sort().join('|');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        getDb().prepare('UPDATE matches SET result_a=2, result_b=0 WHERE id=?').run(m.id);
      }
    }
    expect(seen.size).toBe(6); // C(4,2)
    // explicit schedule: R1 1v2,3v4; R2 1v3,2v4; R3 1v4,2v3
    const rows = getDb().prepare('SELECT round, player_a, player_b FROM matches ORDER BY round, table_no').all() as { round: number; player_a: string; player_b: string }[];
    const fmt = rows.map((r) => `R${r.round}:${r.player_a}v${r.player_b}`).join(' ');
    expect(fmt).toContain('R1:p0vp1');
    expect(fmt).toContain('R1:p2vp3');
    expect(fmt).toContain('R2:p0vp2');
    expect(fmt).toContain('R3:p0vp3');
  });

  it('5 players round robin schedules every pair once with one bye per round', () => {
    const { matches, tid } = setupMatches(5, 'round_robin');
    const seen = new Set<string>();
    for (let round = 1; round <= 5; round++) {
      matches.startRound(tid, round, 'test');
      const current = loadState(tid).matches.filter((m) => m.round === round);
      expect(current).toHaveLength(2);
      for (const match of current) {
        const key = [match.playerA, match.playerB].sort().join('|');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(10);
  });

  it('double elimination advances winners and losers groups into a single grand final', () => {
    const tournaments = makeTournaments();
    const matches = new MatchesService(new FakeSrvpro() as any);
    const tid = tournaments.create({ name: 'de', maxPlayers: 4, cardPool: TEST_POOL, matchFormat: 'double_elimination' }, 'test').tid;
    for (let i = 0; i < 4; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    tournaments.setPhase(tid, 'matches', 1, 'test');
    matches.startRound(tid, 1, 'test');
    for (let round = 1; round <= 3; round++) {
      const current = loadState(tid).matches.filter((m) => m.round === round);
      expect(current.length).toBeGreaterThan(0);
      current.forEach((m) => matches.setMatchResult(tid, round, m.tableNo, 2, 0));
      matches.advanceRound(tid, 'test');
    }
    const final = loadState(tid).matches.filter((m) => m.round === 4);
    expect(final).toHaveLength(1);
    expect(final[0].stage).toBe('grand_final');
    expect(() => matches.setMatchResult(tid, 4, final[0].tableNo, 1, 1)).toThrow('ELIMINATION_DRAW');
    matches.setMatchResult(tid, 4, final[0].tableNo, 2, 0);
    expect(loadState(tid).status).toBe('finished');
  });

  it('6 players: 4 swiss rounds, no repeated pairings within a round', () => {
    const { matches, tid } = setupMatches(6, 'swiss');
    const seen = new Set<string>();
    for (let r = 1; r <= 4; r++) {
      matches.startRound(tid, r, 'test');
      const state = loadState(tid);
      const roundMatches = state.matches.filter((m) => m.round === r);
      expect(roundMatches.length).toBe(3);
      const roundKeys = new Set<string>();
      for (const m of roundMatches) {
        const key = [m.playerA, m.playerB].sort().join('|');
        expect(roundKeys.has(key)).toBe(false);
        expect(seen.has(key)).toBe(false);
        roundKeys.add(key);
        seen.add(key);
      }
      // resolve round so next pairing sees results
      for (const m of roundMatches) {
        const { logEvent } = require('../src/events/events.service');
        logEvent(tid, 'match', 'match', { ...m, resultA: 2, resultB: 0, finishedAt: new Date().toISOString() }, 'test');
        getDb().prepare('UPDATE matches SET result_a=2, result_b=0 WHERE id=?').run(m.id);
      }
    }
  });

  it('backtracks across the whole swiss round instead of repeating the final leftover pair', () => {
    const { matches, tid } = setupMatches(6, 'swiss');
    const { logEvent } = require('../src/events/events.service');
    // Everyone drew in round 1, so standings remain p0..p5. A greedy scheduler
    // would choose p0-p1 and p2-p3, then leave the already-played p4-p5 pair.
    // A complete no-rematch solution exists and must be found by backtracking.
    const previous: [string, string][] = [['p0', 'p2'], ['p1', 'p3'], ['p4', 'p5']];
    previous.forEach(([playerA, playerB], index) => {
      logEvent(tid, 'match', 'match', {
        id: -(index + 1), round: 1, playerA, playerB, tableNo: index + 1,
        roomName: null, playerAPass: null, playerBPass: null,
        resultA: 1, resultB: 1, source: 'admin', faultedAt: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      }, 'test');
    });

    matches.startRound(tid, 2, 'test');
    const roundTwo = loadState(tid).matches.filter((match) => match.round === 2);
    expect(roundTwo).toHaveLength(3);
    const previousKeys = new Set(previous.map((pair) => [...pair].sort().join('|')));
    const roundTwoPlayers = roundTwo.flatMap((match) => [match.playerA, match.playerB]);
    expect(new Set(roundTwoPlayers).size).toBe(6);
    for (const match of roundTwo) {
      expect(previousKeys.has([match.playerA, match.playerB].sort().join('|'))).toBe(false);
    }
  });

  it('9 players: 4 swiss rounds then top-4 playoff', () => {
    const { matches, tid } = setupMatches(9);
    matches.startRound(tid, 1, 'test');
    const state = loadState(tid);
    expect(state.matches.filter((m) => m.round === 1).length).toBe(5); // 4 pairs + 1 bye
    const bye = state.matches.find((m) => m.playerB === '(bye)');
    expect(bye).toBeDefined();
    expect(bye!.resultA).toBe(2);
  });

  it('17 players: standard swiss (ceil(log2 17)+1 = 6 rounds)', () => {
    const { matches } = setupMatches(17);
    expect(matches.swissRounds(17)).toBe(6);
  });

  it('9 players: after 4 swiss rounds transitions to top-4 playoff (not a 5th swiss round)', async () => {
    const { matches, tid } = setupMatches(9);
    matches.startRound(tid, 1, 'test');
    // 每轮全部对局以 A 胜（2:0）结束；maybeAdvance 自动推进下一轮
    for (let r = 1; r <= 4; r++) {
      await waitRooms();
      const roundMatches = loadState(tid).matches.filter((m) => m.round === r);
      expect(roundMatches.length).toBeGreaterThan(0);
      for (const m of roundMatches) {
        if (m.playerB === '(bye)') continue;
        const room = m.roomName!;
        matches.onWebhook({
          room_name: room,
          players: [{ player_id: m.playerA, score: 2 }, { player_id: m.playerB, score: 0 }],
        });
      }
      // 轮次结果齐后不会自动推进：管理员确认后才进入下一轮
      if (r < 4) expect(loadState(tid).matches.some((x) => x.round === r + 1)).toBe(false);
      matches.advanceRound(tid, 'test');
    }
    const st = loadState(tid);
    // 第 5 轮必须是季后赛（2 桌、4 名不同选手），而不是 4+ 桌的瑞士轮
    const r5 = st.matches.filter((m) => m.round === 5);
    expect(r5.length).toBe(2);
    const r5Players = new Set(r5.flatMap((m) => [m.playerA, m.playerB]));
    expect(r5Players.size).toBe(4);
    await waitRooms();
    // 打完季后赛两场 -> 管理员确认 -> 决赛 1 桌 -> 打完自动结束
    for (const m of loadState(tid).matches.filter((x) => x.round === 5)) {
      matches.onWebhook({ room_name: m.roomName!, players: [{ player_id: m.playerA, score: 2 }, { player_id: m.playerB, score: 0 }] });
    }
    matches.advanceRound(tid, 'test');
    const st2 = loadState(tid);
    const r6 = st2.matches.filter((m) => m.round === 6);
    expect(r6.length).toBe(1);
    await waitRooms();
    // 决赛完成：无需确认自动 finished
    const final = loadState(tid).matches.find((m) => m.id === r6[0].id)!;
    matches.onWebhook({ room_name: final.roomName!, players: [{ player_id: final.playerA, score: 2 }, { player_id: final.playerB, score: 0 }] });
    expect(loadState(tid).status).toBe('finished');
    for (const m of r6) {
      matches.onWebhook({ room_name: m.roomName!, players: [{ player_id: m.playerA, score: 2 }, { player_id: m.playerB, score: 0 }] });
    }
    expect(loadState(tid).status).toBe('finished');
  });

  it('webhook records results and is idempotent and rejects stale room names', async () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    await waitRooms();
    const state = loadState(tid);
    const m = state.matches.find((x) => x.round === 1)!;
    const room = m.roomName!;
    const body = {
      room_name: room,
      start: new Date().toISOString(),
      end: new Date().toISOString(),
      players: [
        { player_id: m.playerA, score: 2, deck: null },
        { player_id: m.playerB, score: 0, deck: null },
      ],
    };
    expect(matches.onWebhook(body).ack).toBe(true);
    const s1 = loadState(tid);
    const m1 = s1.matches.find((x) => x.id === m.id)!;
    expect(m1.resultA).toBe(2);
    expect(m1.resultB).toBe(0);
    expect(matches.onWebhook(body).ack).toBe(true); // idempotent, no double-advance
    const s2 = loadState(tid);
    expect(s2.matches.find((x) => x.id === m.id)!.resultA).toBe(2);
    expect(matches.onWebhook({ ...body, room_name: 'CUBE-00000000000000' }).ack).toBe(false);
  });

  it('create_room sends recorded decks and deck limits', async () => {
    const { matches, tid, fake } = setupMatches(2);
    matches.startRound(tid, 1, 'test');
    await new Promise((r) => setTimeout(r, 300));
    const state = loadState(tid);
    const m = state.matches.find((x) => x.round === 1 && x.playerB !== '(bye)')!;
    expect(m.roomName).toMatch(/^CUBE-[0-9a-z]{14}$/);
    expect(m.roomName!.length).toBeLessThanOrEqual(19);
    const room = fake.rooms[m.roomName!];
    expect(room).toBeDefined();
    const created = Object.values(fake.rooms)[0];
    // the srvpro request body captured decks & limits via createRoom arg
    expect(Object.keys(fake.rooms).length).toBe(1);
    expect(created.players.length).toBe(2);
    expect(created.request.request_id).toMatch(new RegExp(`^t:${tid}:m:${m.id}:[0-9a-z]{14}$`));
    for (const playerId of created.players) {
      expect(created.request.cube_decks[playerId].filename).toMatch(new RegExp(`^cube-deck-${tid}-${playerId}-\\d{14}$`));
    }
  });

  it('reuses the match start timestamp when room creation is retried', async () => {
    const { matches, tid, fake } = setupMatches(2);
    matches.startRound(tid, 1, 'test');
    await waitRooms();
    const state = loadState(tid);
    const match = state.matches.find((x) => x.round === 1 && x.playerB !== '(bye)')!;
    expect(match.startedAt).toBeTruthy();
    expect(fake.requests).toHaveLength(1);
    const first = fake.requests[0].cube_decks.p0.filename;

    // Simulate a failed state update/retry after srvpro accepted the first
    // request. The second room must reuse the same per-match deck filename.
    (matches as any).patchMatch(tid, match.id, { roomName: null });
    await (matches as any).createRoomsForRound(tid, 1);

    expect(fake.requests).toHaveLength(2);
    const second = fake.requests[1].cube_decks.p0.filename;
    expect(second).toBe(first);
    expect(fake.requests[1].room_name).toBe(fake.requests[0].room_name);
    expect(fake.requests[1].request_id).toBe(fake.requests[0].request_id);
    expect(first).toBe(cubeDeckFileBase(tid, 'p0', new Date(match.startedAt!)));
  });

  it('does not close a room when concurrent retries resolve the same idempotent request', async () => {
    const { matches, tid, fake } = setupMatches(2);
    matches.startRound(tid, 1, 'test');
    await waitRooms();
    const match = loadState(tid).matches.find((candidate) => candidate.playerB !== '(bye)')!;
    (matches as any).patchMatch(tid, match.id, { roomName: null });
    fake.closedRooms.length = 0;

    await Promise.all([
      (matches as any).createRoomsForRound(tid, 1),
      (matches as any).createRoomsForRound(tid, 1),
    ]);

    const current = loadState(tid).matches.find((candidate) => candidate.id === match.id)!;
    expect(current.roomName).toBeTruthy();
    expect(fake.closedRooms).toEqual([]);
  });

  it('requires a grand-final reset when the one-loss finalist wins', () => {
    const tournaments = makeTournaments();
    const matches = new MatchesService(new FakeSrvpro() as any);
    const tid = tournaments.create({ name: 'de-reset', maxPlayers: 4, cardPool: TEST_POOL, matchFormat: 'double_elimination' }, 'test').tid;
    for (let i = 0; i < 4; i++) tournaments.join(tid, `p${i}`, `P${i}`);
    tournaments.setPhase(tid, 'matches', 1, 'test');
    matches.startRound(tid, 1, 'test');
    for (let round = 1; round <= 3; round++) {
      for (const match of loadState(tid).matches.filter((candidate) => candidate.round === round)) {
        matches.setMatchResult(tid, round, match.tableNo, 2, 0);
      }
      matches.advanceRound(tid, 'test');
    }
    const state = loadState(tid);
    const grandFinal = state.matches.find((match) => match.round === 4)!;
    expect(grandFinal.stage).toBe('grand_final');
    const seeds = state.competition!.seeds!;
    const losses = (matches as any).doubleEliminationLosses(state, seeds) as Record<string, number>;
    const aIsOneLoss = losses[grandFinal.playerA] === 1;
    matches.setMatchResult(tid, 4, grandFinal.tableNo, aIsOneLoss ? 2 : 0, aIsOneLoss ? 0 : 2);
    expect(loadState(tid).status).toBe('matches');
    matches.advanceRound(tid, 'test');
    const reset = loadState(tid).matches.find((match) => match.round === 5)!;
    expect(reset.stage).toBe('grand_final_reset');
    matches.setMatchResult(tid, 5, reset.tableNo, 2, 0);
    expect(loadState(tid).status).toBe('finished');
  });
});

describe('manual results & fault detection', () => {
  beforeEach(() => useTestDb());

  it('setMatchResult records score, advances to next round, closes room', async () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    const m = loadState(tid).matches.find((x) => x.round === 1)!;
    matches.setMatchResult(tid, 1, m.tableNo, 2, 0);
    const s1 = loadState(tid);
    expect(s1.matches.find((x) => x.id === m.id)!.resultA).toBe(2);
    expect(s1.matches.find((x) => x.id === m.id)!.source).toBe('admin');
    expect(s1.matches.find((x) => x.id === m.id)!.faultedAt).toBeNull();
    // 4 人 round1 有两桌：只设一桌不会推进
    expect(s1.matches.some((x) => x.round === 2)).toBe(false);
    for (const m1 of loadState(tid).matches.filter((x) => x.round === 1)) {
      matches.setMatchResult(tid, 1, m1.tableNo, m1.playerA === m1.playerA ? 2 : 0, 0);
    }
    // 两桌都完成后不会自动生成 round2（等待管理员确认）
    expect(loadState(tid).matches.some((x) => x.round === 2)).toBe(false);
    expect(() => matches.advanceRound(tid, 'test')).not.toThrow();
    expect(loadState(tid).matches.some((x) => x.round === 2)).toBe(true);
    // 未完成时 advance 拒绝
    const m2 = loadState(tid).matches.find((x) => x.round === 2)!;
    matches.setMatchResult(tid, 2, m2.tableNo, 1, 0);
    expect(() => matches.advanceRound(tid, 'test')).toThrow('ROUND_PENDING');
  });

  it('setMatchResult rejects invalid scores and unknown matches', () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    const m = loadState(tid).matches.find((x) => x.round === 1)!;
    expect(() => matches.setMatchResult(tid, 1, m.tableNo, 3, 0)).toThrow('BAD_RESULT');
    expect(() => matches.setMatchResult(tid, 9, 1, 1, 0)).toThrow('MATCH_NOT_FOUND');
  });

  it('rolls back a recorded result when round-finalization fails', () => {
    const { matches, tid } = setupMatches(2);
    matches.startRound(tid, 1, 'test');
    const match = loadState(tid).matches.find((candidate) => candidate.playerB !== '(bye)')!;
    const original = (matches as any).maybeAdvance;
    (matches as any).maybeAdvance = () => { throw new Error('FINALIZE_FAILED'); };
    try {
      expect(() => matches.setMatchResult(tid, 1, match.tableNo, 2, 0)).toThrow('FINALIZE_FAILED');
    } finally {
      (matches as any).maybeAdvance = original;
    }
    expect(loadState(tid).matches.find((candidate) => candidate.id === match.id)).toMatchObject({ resultA: null, resultB: null });
    expect(getDb().prepare('SELECT result_a, result_b FROM matches WHERE id=?').get(match.id))
      .toEqual({ result_a: null, result_b: null });
  });

  it('rejects malformed srvpro scores and locks historical results after advancement', async () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    await waitRooms();
    const first = loadState(tid).matches.find((match) => match.round === 1)!;
    expect(matches.onWebhook({
      room_name: first.roomName,
      players: [
        { player_id: first.playerA, score: 999 },
        { player_id: first.playerB, score: 0 },
      ],
    }).ack).toBe(true);
    expect(loadState(tid).matches.find((match) => match.id === first.id)).toMatchObject({
      resultA: null,
      resultB: null,
      source: 'invalid_result',
    });

    for (const match of loadState(tid).matches.filter((candidate) => candidate.round === 1)) {
      matches.setMatchResult(tid, 1, match.tableNo, 2, 0);
    }
    matches.advanceRound(tid, 'test');
    expect(() => matches.setMatchResult(tid, 1, first.tableNo, 0, 2)).toThrow('RESULT_ROUND_LOCKED');
  });

  it('pollAll marks room-gone-without-result as faulted and stops polling it', async () => {
    const { matches, tid, fake } = setupMatches(2);
    matches.startRound(tid, 1, 'test');
    await new Promise((r) => setTimeout(r, 300));
    const m = loadState(tid).matches.find((x) => x.round === 1 && x.playerB !== '(bye)')!;
    delete fake.rooms[m.roomName!]; // room vanished without a result
    const poll = (matches as any).pollAll.bind(matches);
    await poll();
    const s1 = loadState(tid);
    expect(s1.matches.find((x) => x.id === m.id)!.faultedAt).toBeTruthy();
    const faultedAt = s1.matches.find((x) => x.id === m.id)!.faultedAt;
    // 再次轮询：faulted 对局被排除，不会重复标记（时间戳不变）
    await poll();
    expect(loadState(tid).matches.find((x) => x.id === m.id)!.faultedAt).toBe(faultedAt);
  });
});

  it('disconnected player (-9) is recorded as a 0:2 loss', async () => {
    const { matches, tid } = setupMatches(7);
    matches.startRound(tid, 1, 'test');
    await waitRooms();
    const ms = loadState(tid).matches.filter((x) => x.round === 1 && x.playerB !== '(bye)');
    // A 断线：A 记 0，B 记 2
    const m = ms[0];
    matches.onWebhook({ room_name: m.roomName!, players: [{ player_id: m.playerA, score: -9 }, { player_id: m.playerB, score: 1 }] });
    let mm = loadState(tid).matches.find((x) => x.id === m.id)!;
    expect([mm.resultA, mm.resultB]).toEqual([0, 2]);
    // B 断线：B 记 0，A 记 2
    const m2 = ms[1];
    matches.onWebhook({ room_name: m2.roomName!, players: [{ player_id: m2.playerA, score: 0 }, { player_id: m2.playerB, score: -9 }] });
    mm = loadState(tid).matches.find((x) => x.id === m2.id)!;
    expect([mm.resultA, mm.resultB]).toEqual([2, 0]);
    // 双方均断线：0:0（无人胜出）
    const m4 = ms[2];
    matches.onWebhook({ room_name: m4.roomName!, players: [{ player_id: m4.playerA, score: -9 }, { player_id: m4.playerB, score: -9 }] });
    mm = loadState(tid).matches.find((x) => x.id === m4.id)!;
    expect([mm.resultA, mm.resultB]).toEqual([0, 0]);
  });

  it('poll fallback also normalizes -9 disconnect scores', async () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    await new Promise((r) => setTimeout(r, 5)); // 等 createRoomsForRound 异步建房完成
    const m = loadState(tid).matches.find((x) => x.round === 1 && x.playerB !== '(bye)')!;
    const fake = (matches as any).srvpro as FakeSrvpro;
    fake.rooms[m.roomName!].scores = { [m.playerA]: -9, [m.playerB]: 0 };
    await (matches as any).doPollAll();
    const mm = loadState(tid).matches.find((x) => x.id === m.id)!;
    expect([mm.resultA, mm.resultB]).toEqual([0, 2]);
  });
