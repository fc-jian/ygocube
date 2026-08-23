// Online smoke probe: a six-player all-draw first round is the classic case
// where greedy table-by-table pairing can leave the final previous opponents
// together. The second round must contain no repeated pair.
const http = require('http');

const port = Number(process.argv[2] || 3001);
const base = `http://127.0.0.1:${port}`;
const superToken = process.env.CUBE_SUPER_TOKEN;
const createToken = process.env.CUBE_CREATE_TOKEN || superToken;
const createUser = process.env.CUBE_CREATE_USER;
if (!superToken || !createToken) throw new Error('CUBE_SUPER_TOKEN is required');

function call(method, path, { body, admin = false, create = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (admin) headers['X-Admin-Token'] = superToken;
    if (create) {
      headers['X-Create-Token'] = createToken;
      if (createUser) headers['X-Create-User'] = createUser;
    }
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
        if ((res.statusCode || 500) >= 400) return reject(new Error(data.code || `HTTP ${res.statusCode}`));
        resolve(data);
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const key = (match) => [match.playerA, match.playerB].sort().join('|');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
  let tid = null;
  try {
    const created = await call('POST', '/tournaments', {
      create: true,
      body: { name: `swiss-pair-probe-${Date.now()}`, maxPlayers: 6, cardPool: 'kuro750', mainMin: 0 },
    });
    tid = created.tid;
    for (let i = 0; i < 6; i++) {
      await call('POST', `/admin/t/${tid}/players`, { admin: true, body: { player_id: `swiss${i}`, display_name: `Swiss ${i}` } });
    }
    await call('POST', `/admin/t/${tid}/phase`, { admin: true, body: { status: 'drafting' } });
    await call('POST', `/admin/t/${tid}/phase`, { admin: true, body: { status: 'deckbuilding' } });
    await call('POST', `/admin/t/${tid}/phase`, { admin: true, body: { status: 'matches' } });

    let state = await call('POST', `/admin/t/${tid}/state`, { admin: true });
    const roundOne = state.matches.filter((match) => match.round === 1 && match.playerB !== '(bye)');
    assert(roundOne.length === 3, 'round one is not three tables');
    for (const match of roundOne) {
      await call('POST', `/admin/t/${tid}/match/result`, {
        admin: true,
        body: { round: 1, tableNo: match.tableNo, resultA: 1, resultB: 1 },
      });
    }
    await call('POST', `/admin/t/${tid}/matches/advance`, { admin: true });
    state = await call('POST', `/admin/t/${tid}/state`, { admin: true });
    const roundTwo = state.matches.filter((match) => match.round === 2 && match.playerB !== '(bye)');
    const prior = new Set(roundOne.map(key));
    assert(roundTwo.length === 3, 'round two is not three tables');
    assert(roundTwo.every((match) => !prior.has(key(match))), 'round two contains a repeated opponent pair');
    assert(new Set(roundTwo.flatMap((match) => [match.playerA, match.playerB])).size === 6, 'round two does not use every player once');
    console.log(`SWISS PROBE PASS tid=${tid} round1=${[...prior].join(',')} round2=${roundTwo.map(key).join(',')}`);
  } finally {
    if (tid !== null) {
      try { await call('DELETE', `/admin/t/${tid}`, { admin: true }); } catch (error) { console.error(`cleanup failed: ${error.message}`); }
    }
  }
})().catch((error) => {
  console.error(`SWISS PROBE FAIL: ${error.message}`);
  process.exitCode = 1;
});
