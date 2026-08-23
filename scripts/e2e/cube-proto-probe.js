// Protocol-order probe for the cube deck sync fix (srvpro STOC_CUBE_DECK injection).
// Spins up a minimal 2-player tournament against the LOCAL cube api (:3001) and
// srvpro (:7911), joins the match room with a bare TCP bot, and records the first
// STOC proto ids in arrival order. Asserts:
//   - STOC_CUBE_DECK (0xA) is received exactly once per player
//   - it arrives AFTER STOC_JOIN_GAME (0x12)  (the bug had it arriving before)
// Usage: node scripts/e2e/cube-proto-probe.js [apiPort] [srvproHost] [srvproGamePort]
// Exit code 0 = PASS, 1 = FAIL/error.
const net = require('net');
const http = require('http');

const API_PORT = parseInt(process.argv[2] || '3001', 10);
const SRVPRO_HOST = process.argv[3] || '127.0.0.1';
const SRVPRO_GAME_PORT = parseInt(process.argv[4] || '7911', 10);
const API = `http://127.0.0.1:${API_PORT}`;
const SUPER = process.env.CUBE_SUPER_TOKEN || 'change-me-super-token';
const CREATE = process.env.CUBE_CREATE_TOKEN || SUPER;
const CREATE_USER = process.env.CUBE_CREATE_USER;
const PROTO_VERSION = 0x1362;
const PLAYERS = ['probeA', 'probeB'];
const STOC_JOIN_GAME = 0x12;
const STOC_CUBE_DECK = 0xa;
const CAPTURE_LIMIT = 15;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
const rnd = (n) => Math.floor(Math.random() * n);
const pick1 = (arr) => arr[rnd(arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      headers['X-Token'] = SUPER;
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

function pkt(type, payload) {
  const b = Buffer.alloc(1 + payload.length);
  b.writeUInt8(type, 0);
  payload.copy(b, 1);
  const o = Buffer.alloc(2 + b.length);
  o.writeUInt16LE(b.length, 0);
  b.copy(o, 2);
  return o;
}

// Connect, join the room, capture the first CAPTURE_LIMIT STOC proto ids in order.
function captureProtos(pid, roomName) {
  return new Promise((resolve) => {
    const seq = [];
    let cubeFilename = null;
    const sock = net.connect(SRVPRO_GAME_PORT, SRVPRO_HOST);
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ pid, seq, why, cubeFilename });
    };
    const timeout = setTimeout(() => finish('capture timeout'), 20000);
    sock.on('error', () => finish('socket error'));
    sock.on('close', () => { clearTimeout(timeout); finish('closed'); });
    sock.on('connect', () => {
      const pi = Buffer.alloc(40);
      pi.write(pid, 0, 'utf16le');
      sock.write(pkt(0x10, pi)); // CTOS_PLAYER_INFO
      setTimeout(() => {
        // Match the real client: legacy fixed struct for <20 UTF-16 units;
        // variable NUL-terminated extension for long room passwords.
        const encodedPass = Buffer.from(`${roomName}\0`, 'utf16le');
        const units = encodedPass.length / 2 - 1;
        const jg = Buffer.alloc(units < 20 ? 48 : 8 + encodedPass.length);
        jg.writeUInt16LE(PROTO_VERSION, 0);
        jg.writeUInt32LE(0, 4);
        encodedPass.copy(jg, 8);
        sock.write(pkt(0x12, jg)); // CTOS_JOIN_GAME
      }, 100);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        const len = buf.readUInt16LE(0);
        if (buf.length < 2 + len) break;
        const type = buf.readUInt8(2);
        if (type === STOC_CUBE_DECK) {
          const payload = buf.subarray(3, 2 + len);
          if (payload.length >= 8) {
            const mainc = payload.readUInt32LE(0);
            const sidec = payload.readUInt32LE(4);
            const filenameOffset = 8 + (mainc + sidec) * 4;
            if (payload.length >= filenameOffset + 2) {
              const filenameLength = payload.readUInt16LE(filenameOffset);
              if (filenameLength > 0 && payload.length >= filenameOffset + 2 + filenameLength) {
                cubeFilename = payload.subarray(filenameOffset + 2, filenameOffset + 2 + filenameLength).toString('utf8');
              }
            }
          }
        }
        buf = buf.slice(2 + len);
        if (seq.length < CAPTURE_LIMIT) seq.push(type);
        if (seq.includes(STOC_CUBE_DECK)) {
          // got what we came for; give it a beat for a duplicate 0xA to show up
          setTimeout(() => finish('captured'), 1500);
        }
      }
    });
  });
}

async function runDraft(tid) {
  log('draft started');
  for (;;) {
    const observer = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid: PLAYERS[0] } });
    if (observer.status !== 'drafting') {
      log(`draft over (status=${observer.status})`);
      return;
    }
    let acted = false;
    for (const pid of PLAYERS) {
      const st = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid } });
      if (st.status !== 'drafting') break;
      if (st.pack?.isMyTurn && st.pack.cards?.length) {
        await apiCall('POST', `/t/${tid}/pick`, { player: { tid, pid }, body: { card_code: pick1(st.pack.cards) } });
        acted = true;
      }
    }
    if (!acted) await sleep(300);
  }
}

async function buildDecks(tid) {
  log('deckbuilding started');
  let allLocked = true;
  for (const pid of PLAYERS) {
    const st = await apiCall('GET', `/t/${tid}/state`, { player: { tid, pid } });
    const cfg = st.config;
    const main = [...(st.deck?.main ?? [])];
    const used = new Set([...main, ...(st.deck?.extra ?? []), ...(st.deck?.side ?? [])]);
    for (const c of st.pickedCards) {
      if (main.length >= cfg.mainMin) break;
      if (used.has(c)) continue;
      try {
        await apiCall('POST', `/t/${tid}/deck/move`, { player: { tid, pid }, body: { card_code: c, from: 'pool', to: 'main' } });
        main.push(c);
      } catch {}
    }
    try {
      await apiCall('POST', `/t/${tid}/deck/lock`, { player: { tid, pid } });
      log(`${pid}: deck locked (main=${main.length})`);
    } catch (e) {
      allLocked = false;
      log(`${pid}: lock failed (${e.message}) details=${JSON.stringify(e.details)}`);
    }
  }
  if (!allLocked) {
    // admin phase switch auto-fixes unlocked decks and starts round 1
    log('forcing matches phase (admin auto-fix)');
    await apiCall('POST', `/admin/t/${tid}/phase`, { admin: true, body: { status: 'matches' } });
  }
}

(async () => {
  await apiCall('GET', '/health');
  log('api healthy');

  // tiny dedicated pool so the draft is over fast
  const poolName = `probe-${Date.now().toString(36)}`;
  const pool = await apiCall('POST', '/admin/pools/random', { admin: true, body: { name: poolName, size: 120 } });
  log(`pool ${pool.name} created (${pool.count} cards)`);

  const created = await apiCall('POST', '/tournaments', {
    create: true,
    body: {
      name: `probe-${Date.now().toString(36)}`,
      maxPlayers: 2,
      mode: 'single',
      cardPool: pool.name,
      packSizeMultiple: 3,
      pickSeconds: 30,
      deckbuildingSeconds: 600,
      mainMin: 5,
      mainMax: 10,
      extraMax: 5,
      sideMax: 5,
      maxCopies: 3,
      dropLeftover: true,
    },
  });
  const tid = created.tid;
  log(`tournament ${tid} created`);

  for (const pid of PLAYERS) {
    await apiCall('POST', `/t/${tid}/join`, { body: { player_id: pid, display_name: pid } });
  }
  await apiCall('POST', `/admin/t/${tid}/start_draft`, { admin: true });
  await runDraft(tid);
  await buildDecks(tid);

  // wait for the match room name
  let match = null;
  for (let i = 0; i < 60; i++) {
    const admin = await apiCall('POST', `/admin/t/${tid}/state`, { admin: true });
    if (admin.status !== 'matches') throw new Error(`unexpected status ${admin.status}`);
    match = admin.matches.find((m) => m.round === admin.round && m.playerB !== '(bye)');
    if (match?.roomName) break;
    await sleep(1000);
  }
  if (!match?.roomName) throw new Error('no room name after 60s');
  log(`match ${match.id}: ${match.playerA} vs ${match.playerB}, room=${match.roomName}`);

  const results = await Promise.all([
    captureProtos(match.playerA, match.roomName),
    captureProtos(match.playerB, match.roomName),
  ]);

  let ok = true;
  const hex = (t) => `0x${t.toString(16)}`;
  for (const r of results) {
    const seqHex = r.seq.map(hex).join(' ');
    log(`${r.pid} (${r.why}) proto sequence: ${seqHex}`);
    const joinIdx = r.seq.indexOf(STOC_JOIN_GAME);
    const cubeCount = r.seq.filter((t) => t === STOC_CUBE_DECK).length;
    const cubeIdx = r.seq.indexOf(STOC_CUBE_DECK);
    if (joinIdx < 0) {
      log(`FAIL ${r.pid}: STOC_JOIN_GAME (0x12) not seen`);
      ok = false;
    } else if (cubeCount !== 1) {
      log(`FAIL ${r.pid}: STOC_CUBE_DECK (0xa) seen ${cubeCount} times (expected exactly 1)`);
      ok = false;
    } else if (cubeIdx < joinIdx) {
      log(`FAIL ${r.pid}: STOC_CUBE_DECK at #${cubeIdx} arrives BEFORE STOC_JOIN_GAME at #${joinIdx}`);
      ok = false;
    } else if (!new RegExp(`^cube-deck-${tid}-${r.pid}-\\d{14}$`).test(r.cubeFilename || '')) {
      log(`FAIL ${r.pid}: invalid synchronized deck filename ${JSON.stringify(r.cubeFilename)}`);
      ok = false;
    } else {
      log(`OK ${r.pid}: STOC_JOIN_GAME at #${joinIdx}, STOC_CUBE_DECK at #${cubeIdx}, filename=${r.cubeFilename}`);
    }
  }
  log(ok ? 'PROBE PASS' : 'PROBE FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('PROBE ERROR', e);
  process.exit(1);
});
