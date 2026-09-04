// Full tournament simulation (dev_docs/05, 07): 8 players, kuro750 pool, BO3 matches.
// Everything is driven randomly: random picks, random deck moves, and in-duel bots that
// answer mandatory prompts (hand/tp), idle, then one side surrenders at a random time.
//
// Prereqs: cube api on :3001 and srvpro on :7911/:7922 with modules.cube enabled,
// both configured from the repo-root config.yaml. Usage:
//   node scripts/e2e/cube-full-sim.js [apiPort] [srvproHost] [srvproGamePort]
// Artifacts are written to ./test_tournaments/<tid>/.
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API_PORT = parseInt(process.argv[2] || '3001', 10);
const SRVPRO_HOST = process.argv[3] || '127.0.0.1';
const SRVPRO_GAME_PORT = parseInt(process.argv[4] || '7911', 10);
const API = `http://127.0.0.1:${API_PORT}`;
const SUPER = process.env.CUBE_SUPER_TOKEN || 'change-me-super-token';
const CREATE = process.env.CUBE_CREATE_TOKEN || SUPER;
const CREATE_USER = process.env.CUBE_CREATE_USER;
const PROTO_VERSION = 0x1362;
const PLAYERS = Array.from({ length: parseInt(process.env.SIM_PLAYERS || '8', 10) }, (_, i) => `bot${i + 1}`);
const SIM_POOL = process.env.SIM_POOL || `test-fullsim-pool-${process.pid}-${Date.now().toString(36)}`;
const SIM_POOL_SIZE = parseInt(process.env.SIM_POOL_SIZE || String(Math.max(PLAYERS.length * 4 * 24, 120)), 10);
// tournament config overrides, e.g. SIM_CONFIG='{"mainMax":120,"timeLimit":999}'
const SIM_CONFIG = JSON.parse(process.env.SIM_CONFIG || '{}');
// SIM_FILL=max fills every main deck up to mainMax (oversized-deck testing)
const FILL_MAX = process.env.SIM_FILL === 'max';

const LOG_LINES = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  LOG_LINES.push(line);
  console.log(line);
}
const rnd = (n) => Math.floor(Math.random() * n);
const pick1 = (arr) => arr[rnd(arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- cube api ----------
function apiCall(method, p, { body, admin, create, player, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (admin) headers['X-Admin-Token'] = SUPER;
    if (create) {
      headers['X-Create-Token'] = CREATE;
      if (CREATE_USER) headers['X-Create-User'] = CREATE_USER;
    }
    if (player) {
      headers['X-Tournament-Id'] = String(player.tid);
      headers['X-Player-Id'] = player.pid;
      headers['X-Token'] = SUPER; // super token doubles as a universal player token
    }
    const req = http.request(`${API}${p}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (raw) return resolve({ status: res.statusCode, body: d, headers: res.headers });
        let j;
        try { j = JSON.parse(d); } catch { j = { parse_error: d }; }
        if (res.statusCode >= 400) {
          const e = new Error(j.code || j.message || `HTTP ${res.statusCode}`);
          e.details = j.details || j.detail;
          e.status = res.statusCode;
          return reject(e);
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('api timeout')));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------- ygopro protocol bot (idle + random surrender) ----------
function pkt(type, payload) {
  const b = Buffer.alloc(1 + payload.length);
  b.writeUInt8(type, 0);
  payload.copy(b, 1);
  const o = Buffer.alloc(2 + b.length);
  o.writeUInt16LE(b.length, 0);
  b.copy(o, 2);
  return o;
}
function deckPkt(mainCodes, sideCodes) {
  // UPDATE_DECK: mainc（含 extra 合并）, sidec, codes[main…,side…]
  const p = Buffer.alloc(8 + (mainCodes.length + sideCodes.length) * 4);
  p.writeUInt32LE(mainCodes.length, 0);
  p.writeUInt32LE(sideCodes.length, 4);
  let off = 8;
  for (const c of [...mainCodes, ...sideCodes]) {
    p.writeUInt32LE(c, off);
    off += 4;
  }
  return pkt(0x2, p);
}
function garbageDeckPkt() {
  // If the API cannot provide a recorded cube deck, send an empty upload.  The
  // BEGIN-stage server path still supplies the recorded deck; using a removed
  // historical card ID here would make a refreshed cards.cdb look broken.
  return deckPkt([], []);
}

const EXTRA_TYPE_MASK = 0x4802040;

async function runBot(tid, pid, roomName, isLoser, blog, garbageSide = false) {
  // 取本人 cube 卡组与卡类型（siding 时做合法的 main↔side 互换，验证换 side 真正生效）
  let myMain = null;
  let mySide = [];
  try {
    const st = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid } });
    const deck = st.deck ?? { main: [], extra: [], side: [] };
    const codes = [...deck.main, ...deck.extra, ...deck.side];
    const infos = codes.length ? await apiCall('GET', `/t/${tid}/cards?codes=${codes.join(',')}`, { player: { tid, pid } }) : [];
    const typeOf = {};
    for (const c of infos) typeOf[c.code] = c.type;
    const isExtra = (c) => (typeOf[c] & EXTRA_TYPE_MASK) !== 0;
    // UPDATE_DECK 布局：extra 合并在 main 段，宿主/srvpro 按类型分拣
    myMain = [...deck.main, ...deck.extra];
    mySide = [...deck.side];
    // siding 互换只允许非额外卡（保持各区数量一致）
    var swappableMain = myMain.filter((c) => !isExtra(c));
    var swappableSide = mySide.filter((c) => !isExtra(c));
  } catch (e) {
    blog(`${pid} failed to load cube deck: ${e.message}; falling back to garbage deck`);
  }
  const sideMode = garbageSide ? 'garbage' : 'valid';
  blog(`${pid} deck loaded: main=${myMain?.length ?? '?'} side=${mySide.length}, sideMode=${sideMode}`);
  return new Promise((resolve) => {
    const sock = net.connect(SRVPRO_GAME_PORT, SRVPRO_HOST);
    let buf = Buffer.alloc(0);
    let duelNo = 0;
    let surrendered = 0;
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      blog(`${pid} exit: ${why} (duels=${duelNo}, surrenders=${surrendered})`);
      resolve();
    };
    const hardTimeout = setTimeout(() => finish('hard timeout'), 300000);
    sock.on('error', () => finish('socket error'));
    sock.on('close', () => { clearTimeout(hardTimeout); finish('closed'); });
    sock.on('connect', () => {
      const pi = Buffer.alloc(40);
      pi.write(pid, 0, 'utf16le');
      sock.write(pkt(0x10, pi)); // CTOS_PLAYER_INFO
      setTimeout(() => {
        const jg = Buffer.alloc(48);
        jg.writeUInt16LE(PROTO_VERSION, 0);
        jg.writeUInt32LE(0, 4);
        jg.write(roomName, 8, 'utf16le');
        sock.write(pkt(0x12, jg)); // CTOS_JOIN_GAME
      }, 100);
      setTimeout(() => sock.write(myMain ? deckPkt(myMain, mySide) : garbageDeckPkt()), 400);
      setTimeout(() => sock.write(pkt(0x22, Buffer.alloc(0))), 600); // CTOS_HS_READY
      // someone has to start the duel: CTOS_HS_START (ignored for the non-host player);
      // retry until the duel actually begins
      let startTries = 0;
      const tryStart = setInterval(() => {
        if (done || duelNo > 0 || ++startTries > 10) {
          clearInterval(tryStart);
          return;
        }
        try { sock.write(pkt(0x25, Buffer.alloc(0))); } catch {}
      }, 1500);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        const len = buf.readUInt16LE(0);
        if (buf.length < 2 + len) break;
        const type = buf.readUInt8(2);
        const body = buf.slice(3, 2 + len);
        buf = buf.slice(2 + len);
        if (type === 0x2) {
          blog(`${pid} ERROR_MSG msg=${body.readUInt8(0)} code=0x${(body.readUInt32LE(4) >>> 0).toString(16)}`);
        } else if (type === 0x21) {
          blog(`${pid} HS_CHANGE status=0x${(body.readUInt8(0) & 0xf).toString(16)}`);
        } else if (type === 0x3) {
          // STOC_SELECT_HAND -> random rock/paper/scissors
          sock.write(pkt(0x3, Buffer.from([1 + rnd(3)])));
        } else if (type === 0x4) {
          // STOC_SELECT_TP -> random first/second
          sock.write(pkt(0x4, Buffer.from([rnd(2)])));
        } else if (type === 0x7) {
          // STOC_CHANGE_SIDE -> 提交换 side 后的卡组（valid：cube 卡组内随机 main↔side 互换；
          // garbage：非法卡组，验证 srvpro 回退覆盖兼容路径）
          setTimeout(() => {
            try {
              if (garbageSide || !myMain) {
                sock.write(garbageDeckPkt());
                blog(`${pid} siding: submitted garbage deck (expect srvpro fallback override)`);
              } else {
                const k = Math.min(swappableMain.length, swappableSide.length, 1 + rnd(3));
                const main = [...myMain];
                const side = [...mySide];
                for (let i = 0; i < k; i++) {
                  const mi = main.indexOf(swappableMain[rnd(swappableMain.length)]);
                  const si = side.indexOf(swappableSide[rnd(swappableSide.length)]);
                  if (mi < 0 || si < 0) continue;
                  [main[mi], side[si]] = [side[si], main[mi]];
                }
                sock.write(deckPkt(main, side));
                blog(`${pid} siding: submitted valid sided deck (swapped ${k})`);
              }
              sock.write(pkt(0x22, Buffer.alloc(0)));
            } catch {}
          }, 300);
        } else if (type === 0x18) {
          sock.write(pkt(0x15, Buffer.alloc(0))); // CTOS_TIME_CONFIRM
        } else if (type === 0x15) {
          // STOC_DUEL_START
          duelNo++;
          blog(`${pid} duel ${duelNo} started (${roomName})`);
          if (isLoser) {
            const delay = 2000 + rnd(5000);
            setTimeout(() => {
              try {
                sock.write(pkt(0x14, Buffer.alloc(0))); // CTOS_SURRENDER
                surrendered++;
                blog(`${pid} surrendered duel ${duelNo} after ${delay}ms`);
              } catch {}
            }, delay);
          }
        } else if (type === 0x16) {
          // STOC_DUEL_END: BO3 decided after 2 surrenders -> leave so the room can close
          blog(`${pid} duel ${duelNo} ended`);
          if (surrendered >= 2 || duelNo >= 3) setTimeout(() => finish('match decided'), 4000);
        }
      }
    });
  });
}

// ---------- phases ----------
async function waitFor(desc, fn, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await sleep(intervalMs);
  }
}

async function runDraft(tid) {
  log('draft started');
  let picks = 0;
  for (;;) {
    const observer = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid: PLAYERS[0] } });
    if (observer.status !== 'drafting') {
      log(`draft over (status=${observer.status}), driver picks=${picks}`);
      return observer.status;
    }
    if (observer.queueLengths) {
      // passing 模式：所有玩家并发选牌——轮询每人状态，有队首堆即随机选 1 张
      let acted = false;
      for (const pid of PLAYERS) {
        const st = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid } });
        if (st.status !== 'drafting') break;
        if (!st.pack?.isMyTurn || !st.pack.cards?.length) continue;
        await apiCall('POST', `/t/${tid}/pick`, { player: { tid, pid }, body: { card_code: pick1(st.pack.cards) } });
        picks++;
        acted = true;
        if (picks % 50 === 0) log(`draft progress: ${picks} picks`);
      }
      if (!acted) await sleep(300);
      continue;
    }
    // serial 模式：单光标驱动
    const cur = observer.pack?.currentPicker;
    if (!cur) {
      await sleep(300);
      continue;
    }
    const st = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid: cur } });
    if (st.status !== 'drafting' || !st.pack?.isMyTurn || !st.pack.cards?.length) {
      await sleep(200);
      continue;
    }
    const card = pick1(st.pack.cards);
    await apiCall('POST', `/t/${tid}/pick`, { player: { tid, pid: cur }, body: { card_code: card } });
    picks++;
    if (picks % 50 === 0) log(`draft progress: ${picks} picks`);
  }
}

async function buildDecks(tid) {
  log('deckbuilding started');
  for (const pid of PLAYERS) {
    const st = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid } });
    const cfg = st.config;
    const deck = { main: [...(st.deck?.main ?? [])], extra: [...(st.deck?.extra ?? [])], side: [...(st.deck?.side ?? [])] };
    const used = () => new Set([...deck.main, ...deck.extra, ...deck.side]);
    const move = (card_code, from, to) =>
      apiCall('POST', `/t/${tid}/deck/move`, { player: { tid, pid }, body: { card_code, from, to } }).catch(() => {});
    // random flavor moves (errors ignored: WRONG_ZONE / CARD_NOT_IN_ZONE etc.)
    for (let i = 0; i < 6; i++) {
      const from = pick1(['main', 'side']);
      const src = deck[from];
      if (!src.length) break;
      const c = pick1(src);
      const to = pick1(['main', 'side', 'pool']);
      if (from === to) continue;
      await move(c, from, to);
      src.splice(src.indexOf(c), 1);
      if (to !== 'pool') deck[to].push(c);
    }
    // legalize: trim overflows, fill main from the picked pool
    while (deck.main.length > cfg.mainMax) {
      const c = deck.main.pop();
      if (deck.side.length < cfg.sideMax) {
        await move(c, 'main', 'side');
        deck.side.push(c);
      } else {
        await move(c, 'main', 'pool');
      }
    }
    while (deck.extra.length > cfg.extraMax) await move(deck.extra.pop(), 'extra', 'pool');
    while (deck.side.length > cfg.sideMax) await move(deck.side.pop(), 'side', 'pool');
    // fill main from the picked pool up to a random target size (mainMin..mainMax),
    // so raised mainMax limits are actually exercised with oversized decks
    const mainEligible = st.pickedCards.filter((c) => !used().has(c));
    const deficit = Math.max(0, cfg.mainMin - deck.main.length);
    const room = Math.max(0, Math.min(cfg.mainMax, deck.main.length + mainEligible.length) - deck.main.length - deficit);
    const target = deck.main.length + deficit + (FILL_MAX ? room : room > 0 ? rnd(room + 1) : 0);
    for (const c of mainEligible) {
      if (deck.main.length >= target) break;
      try {
        await apiCall('POST', `/t/${tid}/deck/move`, { player: { tid, pid }, body: { card_code: c, from: 'pool', to: 'main' } });
        deck.main.push(c);
      } catch {
        // extra-deck card: cannot go to main
      }
    }
    // lock; on DECK_INVALID move the offending cards out and retry, then fall back to admin auto-fix
    let locked = false;
    for (let attempt = 0; attempt < 6 && !locked; attempt++) {
      try {
        await apiCall('POST', `/t/${tid}/deck/lock`, { player: { tid, pid } });
        locked = true;
      } catch (e) {
        const details = e.details || [];
        let fixed = false;
        for (const d of details) {
          let m = d.match(/more than \d+ copies of (\d+)/) || d.match(/extra-deck card (\d+) in main/) || d.match(/card (\d+) not in picked/);
          if (m) {
            const c = Number(m[1]);
            for (const from of ['main', 'extra', 'side']) {
              try {
                await apiCall('POST', `/t/${tid}/deck/move`, { player: { tid, pid }, body: { card_code: c, from, to: 'pool' } });
                fixed = true;
                break;
              } catch {}
            }
          }
        }
        if (!fixed) break;
      }
    }
    if (!locked) {
      log(`${pid}: lock failed, falling back to admin auto-fix`);
      await apiCall('POST', `/admin/t/${tid}/deck/fix`, { admin: true, body: { player_id: pid } });
    } else {
      log(`${pid}: deck locked (main=${deck.main.length}, extra=${deck.extra.length}, side=${deck.side.length})`);
    }
  }
  log('all decks locked');
}

// The public administrator start endpoint now opens a persisted one-minute
// confirmation window.  Use the same player endpoint as real clients so this
// simulation cannot accidentally bypass the production handshake.
async function confirmDraftStart(tid) {
  let result = await apiCall('POST', `/admin/t/${tid}/start_draft`, { admin: true });
  if (!result.pending) return result;
  for (const pid of PLAYERS) {
    result = await apiCall('POST', `/t/${tid}/player/draft-confirm`, { player: { tid, pid } });
    if (result.started) break;
  }
  if (!result.started) throw new Error(`draft confirmation did not start (${result.confirmedCount ?? 0}/${result.total ?? PLAYERS.length})`);
  return result;
}

async function playMatches(tid, outDir) {
  const matchLogs = {};
  const mlog = (mid) => (msg) => {
    const line = `[${new Date().toISOString()}] [match ${mid}] ${msg}`;
    LOG_LINES.push(line);
    console.log(line);
  };
  for (;;) {
    const admin = await apiCall('POST', `/admin/t/${tid}/state`, { admin: true });
    if (admin.status === 'finished') {
      log('tournament finished');
      return admin;
    }
    if (admin.status !== 'matches') throw new Error(`unexpected status ${admin.status}`);
    const round = admin.round;
    const matches = admin.matches.filter((m) => m.round === round);
    const pending = matches.filter((m) => m.playerB !== '(bye)' && m.resultA === null);
    if (pending.length === 0) {
      log(`round ${round} complete; administrator confirms advancement`);
      await apiCall('POST', `/admin/t/${tid}/matches/advance`, { admin: true });
      await sleep(1000);
      continue;
    }
    // wait for room names (rooms are created async by the api)
    if (pending.some((m) => !m.roomName)) {
      await sleep(1500);
      continue;
    }
    log(`round ${round}: ${pending.length} matches to play`);
    const bots = [];
    for (const [mi, m] of pending.entries()) {
      const loserIsA = rnd(2) === 0;
      const ml = mlog(m.id);
      matchLogs[m.id] = ml;
      ml(`table ${m.tableNo}: ${m.playerA} vs ${m.playerB}, room=${m.roomName}, loser=${loserIsA ? m.playerA : m.playerB}`);
      bots.push(runBot(tid, m.playerA, m.roomName, loserIsA, ml));
      // 每轮第一桌的 playerB 用垃圾卡组换 side：覆盖 srvpro siding 回退兼容路径
      bots.push(runBot(tid, m.playerB, m.roomName, !loserIsA, ml, mi === 0));
    }
    // wait until all matches of this round have results (webhook or poller)
    await waitFor(
      `round ${round} results`,
      async () => {
        const s = await apiCall('POST', `/admin/t/${tid}/state`, { admin: true });
        const ms = s.matches.filter((m) => m.round === round);
        return ms.every((m) => m.resultA !== null) ? s : null;
      },
      360000,
      4000,
    );
    let botWaitTimer;
    await Promise.race([
      Promise.all(bots),
      new Promise((resolve) => { botWaitTimer = setTimeout(resolve, 30000); }),
    ]);
    if (botWaitTimer) clearTimeout(botWaitTimer);
    log(`round ${round} results collected`);
  }
}

// ---------- main ----------
(async () => {
  const t0 = Date.now();
  log('=== cube full simulation start ===');
  await apiCall('GET', '/health');
  log('api healthy');

  const pools = await apiCall('GET', '/admin/pools', { admin: true });
  if (!pools.some((pool) => pool.name === SIM_POOL)) {
    await apiCall('POST', '/admin/pools/random', {
      admin: true,
      body: { name: SIM_POOL, size: SIM_POOL_SIZE },
    });
    log(`created isolated random pool ${SIM_POOL} (${SIM_POOL_SIZE} cards)`);
  }

  const created = await apiCall('POST', '/tournaments', {
    create: true,
    body: {
      name: `test-fullsim-${Date.now().toString(36)}`,
      maxPlayers: PLAYERS.length,
      mode: 'match',
      cardPool: SIM_POOL,
      packSize: 24,
      packCount: PLAYERS.length * 4,
      pickSeconds: 30,
      reserveSeconds: 400,
      deckbuildingSeconds: null,
      mainMin: 40,
      mainMax: 60,
      extraMax: 30,
      sideMax: 30,
      maxCopies: 3,
      dropMode: 'drop_leftover',
      matchFormat: 'swiss',
      swissRoundCount: Math.min(3, Math.max(1, PLAYERS.length - 1)),
      playoffSize: 0,
      ...SIM_CONFIG,
    },
  });
  const tid = created.tid;
  const outDir = path.join(__dirname, '..', '..', 'test_tournaments', String(tid));
  fs.mkdirSync(outDir, { recursive: true });
  log(`tournament ${tid} created -> ${outDir}`);

  try {
    for (const pid of PLAYERS) {
      await apiCall('POST', `/t/${tid}/join`, { body: { player_id: pid, display_name: pid } });
      await apiCall('POST', `/t/${tid}/player/ready`, {
        player: { tid, pid },
        body: { ready: true },
      });
    }
    log(`${PLAYERS.length} players joined and ready`);
    await confirmDraftStart(tid);

    const afterDraft = await runDraft(tid);
    if (afterDraft !== 'deckbuilding') {
      await waitFor('deckbuilding phase', async () => {
        const s = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid: PLAYERS[0] } });
        return s.status === 'deckbuilding';
      }, 60000);
    }
    await buildDecks(tid);
    await apiCall('POST', `/admin/t/${tid}/phase`, {
      admin: true,
      body: { status: 'matches', round: 1, confirm_invalid_decks: true },
    });
    log('administrator advanced deckbuilding to matches');

    const finalState = await playMatches(tid, outDir);

    // artifacts
    for (const pid of PLAYERS) {
      const r = await apiCall('GET', `/t/${tid}/deck.ydk`, { player: { tid, pid }, raw: true });
      fs.writeFileSync(path.join(outDir, `deck-${pid}.ydk`), r.body);
    }
    const ranking = await apiCall('GET', `/t/${tid}/ranking`, { player: { tid, pid: PLAYERS[0] } });
    fs.writeFileSync(path.join(outDir, 'matches.json'), JSON.stringify(finalState.matches, null, 2));
    fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify(finalState, null, 2));

    const lines = [];
    lines.push(`# 模拟赛结果：tournament ${tid} (${finalState.name})`);
    lines.push('');
    lines.push(`- 卡池: ${SIM_POOL} · ${PLAYERS.length} 人 · BO3 (match) · 瑞士轮`);
    lines.push(`- 耗时: ${Math.round((Date.now() - t0) / 1000)}s`);
    lines.push('');
    lines.push('## 最终排名');
    lines.push('');
    lines.push('| 排名 | 玩家 | 胜 | 平 | 负 | 积分 | 净胜局 | OMW% |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of ranking) {
      lines.push(`| ${r.rank} | ${r.playerId} | ${r.wins} | ${r.draws} | ${r.losses} | ${r.points} | ${r.gameDiff} | ${r.omw} |`);
    }
    lines.push('');
    lines.push('## 对阵记录');
    lines.push('');
    const rounds = [...new Set(finalState.matches.map((m) => m.round))].sort((a, b) => a - b);
    for (const rd of rounds) {
      lines.push(`### 第 ${rd} 轮`);
      lines.push('');
      for (const m of finalState.matches.filter((m) => m.round === rd).sort((a, b) => a.tableNo - b.tableNo)) {
        lines.push(`- 桌 ${m.tableNo}: ${m.playerA} vs ${m.playerB} → ${m.resultA}:${m.resultB} (${m.source ?? '-'})`);
      }
      lines.push('');
    }
    fs.writeFileSync(path.join(outDir, 'result.md'), lines.join('\n'));
    log(`=== simulation complete in ${Math.round((Date.now() - t0) / 1000)}s ===`);
  } finally {
    fs.writeFileSync(path.join(outDir, 'events.log'), LOG_LINES.join('\n') + '\n');
  }
})().catch((e) => {
  console.error('SIM FAILED', e);
  process.exit(1);
});
