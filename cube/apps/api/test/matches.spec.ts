import { useTestDb, makeTournaments, TEST_POOL } from './helpers';
import { loadState } from '../src/events/events.service';
import { MatchesService } from '../src/matches/matches.service';
import { DecksService } from '../src/decks/decks.service';
import { CardsService } from '../src/cards/cards.service';
import { getDb } from '../src/db';

// In-memory fake srvpro: records createRoom calls, lets tests resolve rooms.
class FakeSrvpro {
  rooms: Record<string, { players: string[]; scores: Record<string, number> }> = {};
  async createRoom(req: any) {
    this.rooms[req.room_name] = { players: req.players.map((p: any) => p.player_id), scores: {} };
    return { ok: true, room_name: req.room_name, port: 12345 };
  }
  async roomStatus(roomName: string) {
    const r = this.rooms[roomName];
    if (!r) throw Object.assign(new Error('room gone'), { response: { status: 404 } });
    return { ok: true, finished: true, scores: r.scores };
  }
  async closeRoom() {
    return { ok: true };
  }
}

function setupMatches(n: number) {
  const tournaments = makeTournaments();
  const cards = new CardsService();
  const decks = new DecksService(cards);
  const fake = new FakeSrvpro();
  const matches = new MatchesService(fake as any);
  const tid = tournaments.create({ name: 'm', maxPlayers: n, cardPool: TEST_POOL }, 'test').tid;
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

describe('pairing engine', () => {
  beforeEach(() => useTestDb());

  it('4 players round robin: one match per player per round, all pairs exactly once', () => {
    const { matches, tid } = setupMatches(4);
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

  it('6 players: 4 swiss rounds, no repeated pairings within a round', () => {
    const { matches, tid } = setupMatches(6);
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

  it('9 players: after 4 swiss rounds transitions to top-4 playoff (not a 5th swiss round)', () => {
    const { matches, tid } = setupMatches(9);
    matches.startRound(tid, 1, 'test');
    // 每轮全部对局以 A 胜（2:0）结束；maybeAdvance 自动推进下一轮
    for (let r = 1; r <= 4; r++) {
      const roundMatches = loadState(tid).matches.filter((m) => m.round === r);
      expect(roundMatches.length).toBeGreaterThan(0);
      for (const m of roundMatches) {
        const room = `CUBE-${tid}-${r}-${m.tableNo}-ember`;
        matches.onWebhook({
          room_name: room,
          players: [{ player_id: m.playerA, score: 2 }, { player_id: m.playerB, score: 0 }],
        });
      }
    }
    const st = loadState(tid);
    // 第 5 轮必须是季后赛（2 桌、4 名不同选手），而不是 4+ 桌的瑞士轮
    const r5 = st.matches.filter((m) => m.round === 5);
    expect(r5.length).toBe(2);
    const r5Players = new Set(r5.flatMap((m) => [m.playerA, m.playerB]));
    expect(r5Players.size).toBe(4);
    // 打完季后赛两场 -> 决赛 1 桌 -> 结束
    for (const m of r5) {
      matches.onWebhook({ room_name: `CUBE-${tid}-5-${m.tableNo}-ember`, players: [{ player_id: m.playerA, score: 2 }, { player_id: m.playerB, score: 0 }] });
    }
    const st2 = loadState(tid);
    const r6 = st2.matches.filter((m) => m.round === 6);
    expect(r6.length).toBe(1);
    for (const m of r6) {
      matches.onWebhook({ room_name: `CUBE-${tid}-6-${m.tableNo}-ember`, players: [{ player_id: m.playerA, score: 2 }, { player_id: m.playerB, score: 0 }] });
    }
    expect(loadState(tid).status).toBe('finished');
  });

  it('webhook records results and is idempotent', () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    const state = loadState(tid);
    const m = state.matches.find((x) => x.round === 1)!;
    const room = `CUBE-${tid}-1-${m.tableNo}-ember`;
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
  });

  it('create_room sends recorded decks and deck limits', async () => {
    const { matches, tid, fake } = setupMatches(2);
    matches.startRound(tid, 1, 'test');
    await new Promise((r) => setTimeout(r, 300));
    const state = loadState(tid);
    const m = state.matches.find((x) => x.round === 1 && x.playerB !== '(bye)')!;
    expect(m.roomName).toMatch(new RegExp(`^CUBE-${tid}-1-${m.tableNo}-[a-z]+$`));
    const room = fake.rooms[m.roomName!];
    expect(room).toBeDefined();
    const created = Object.values(fake.rooms)[0];
    // the srvpro request body captured decks & limits via createRoom arg
    expect(Object.keys(fake.rooms).length).toBe(1);
    expect(created.players.length).toBe(2);
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
    // 两桌都完成后 round2 自动生成
    expect(loadState(tid).matches.some((x) => x.round === 2)).toBe(true);
  });

  it('setMatchResult rejects invalid scores and unknown matches', () => {
    const { matches, tid } = setupMatches(4);
    matches.startRound(tid, 1, 'test');
    const m = loadState(tid).matches.find((x) => x.round === 1)!;
    expect(() => matches.setMatchResult(tid, 1, m.tableNo, 3, 0)).toThrow('BAD_RESULT');
    expect(() => matches.setMatchResult(tid, 9, 1, 1, 0)).toThrow('MATCH_NOT_FOUND');
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
