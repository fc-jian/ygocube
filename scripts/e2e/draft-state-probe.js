// Online smoke probe for round order, remaining-card count, pause timing, and
// unlimited deckbuilding. Creates one temporary tournament and always deletes it.
const http = require('http');

const port = Number(process.argv[2] || 3001);
const apiBase = `http://127.0.0.1:${port}`;
const superToken = process.env.CUBE_SUPER_TOKEN;
const createToken = process.env.CUBE_CREATE_TOKEN || superToken;
const createUser = process.env.CUBE_CREATE_USER;
if (!superToken || !createToken) throw new Error('CUBE_SUPER_TOKEN is required');

function call(method, path, { body, admin = false, create = false, player } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (admin) headers['X-Admin-Token'] = superToken;
    if (create) {
      headers['X-Create-Token'] = createToken;
      if (createUser) headers['X-Create-User'] = createUser;
    }
    if (player) {
      headers['X-Tournament-Id'] = String(player.tid);
      headers['X-Player-Id'] = player.pid;
      headers['X-Token'] = superToken;
    }
    const req = http.request(`${apiBase}${path}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
        if ((res.statusCode || 500) >= 400) return reject(new Error(parsed.code || parsed.message || `HTTP ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
  let tid = null;
  let poolId = null;
  try {
    const cards = await call('GET', '/admin/cards?q=', { admin: true });
    const poolCard = cards.find((card) => (card.type & 0x4000) === 0);
    assert(poolCard, 'no non-token card available for import probe');
    const imported = await call('POST', '/admin/pools', {
      admin: true,
      body: {
        name: `named-import-probe-${Date.now()}`,
        importText: `${poolCard.code}\t${poolCard.name}\n${poolCard.code}\tWRONG NAME\n999999993\tMISSING\ninvalid-line`,
      },
    });
    poolId = imported.id;
    assert(imported.codes.length === 1, 'named card-pool import did not retain the valid code');
    assert(imported.entryWarnings.length === 3, 'named card-pool import did not report all invalid lines');
    await call('GET', '/admin/settings/default-pool', { admin: true });

    const created = await call('POST', '/tournaments', {
      create: true,
      body: { name: `draft-state-probe-${Date.now()}`, maxPlayers: 3, cardPool: 'kuro750', packSize: 5, packCount: 6, pickSeconds: 30 },
    });
    tid = created.tid;
    const resetToken = await call('POST', `/admin/t/${tid}/admin-token`, { admin: true });
    assert(resetToken.admin_token && resetToken.admin_token !== created.admin_token, 'admin token reset failed');
    const info = await call('GET', `/t/${tid}`);
    assert(info.config.deckbuildingSeconds === null, 'default deckbuildingSeconds is not null');
    for (const pid of ['probeA', 'probeB', 'probeC']) {
      await call('POST', `/t/${tid}/join`, { body: { player_id: pid, display_name: pid } });
    }
    await call('POST', `/admin/t/${tid}/start_draft`, { admin: true });
    let state = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
    assert(state.cardsRemainingExact === true && state.cardsRemainingToDraft === 10, 'remaining-card count is not exact 10');
    assert(state.queueLengths.map((q) => q.playerId).join(',') === state.players.map((p) => p.playerId).join(','), 'queue order differs from seat order');

    const firstMeta = await call('GET', `/t/${tid}/cards?codes=${state.pack.cards.join(',')}`, { player: { tid, pid: 'probeA' } });
    const firstMain = firstMeta.find((card) => (card.type & 0x4802040) === 0);
    assert(firstMain, 'probeA first pack contains no main-deck card');
    await call('POST', `/t/${tid}/pick`, { player: { tid, pid: 'probeA' }, body: { card_code: firstMain.code } });
    await call('POST', `/t/${tid}/deck/move`, { player: { tid, pid: 'probeA' }, body: { card_code: firstMain.code, from: 'main', to: 'pool' } });
    const waiting = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
    assert(waiting.pack === null && waiting.draftReserveMs > 0, 'reserve is hidden while the player queue is empty');

    await call('POST', `/t/${tid}/pause`, { player: { tid, pid: 'probeB' }, body: { action: 'propose' } });
    await call('POST', `/t/${tid}/pause`, { player: { tid, pid: 'probeC' }, body: { action: 'vote_yes' } });
    const paused1 = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeB' } });
    await wait(1500);
    const paused2 = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeB' } });
    assert(paused1.pack.deadlineAt === null && paused1.pack.pausedRemainingMs > 0, 'pause did not freeze deadline');
    assert(paused1.pack.pausedRemainingMs === paused2.pack.pausedRemainingMs, 'paused countdown continued consuming time');
    await call('POST', `/t/${tid}/pause`, { player: { tid, pid: 'probeB' }, body: { action: 'resume' } });

    let guard = 0;
    while (guard++ < 100) {
      state = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
      if (state.status !== 'drafting') break;
      for (const pid of ['probeA', 'probeB', 'probeC']) {
        const view = await call('GET', `/t/${tid}/state`, { player: { tid, pid } });
        if (view.pack?.cards?.length) {
          await call('POST', `/t/${tid}/pick`, { player: { tid, pid }, body: { card_code: view.pack.cards[0] } });
        }
      }
    }
    state = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
    assert(state.status === 'deckbuilding', `draft did not enter deckbuilding (${state.status})`);
    assert(state.phaseDeadline === null, 'unlimited deckbuilding unexpectedly has a deadline');
    assert(state.deck.main.includes(firstMain.code), 'unused picked card was not restored to main at deckbuilding');
    const mainBefore = [...state.deck.main];
    const extraBefore = [...state.deck.extra];
    const sideBefore = [...state.deck.side];
    await call('POST', `/t/${tid}/deck/shuffle`, { player: { tid, pid: 'probeA' } });
    const shuffled = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
    assert([...shuffled.deck.main].sort((a, b) => a - b).join(',') === mainBefore.sort((a, b) => a - b).join(','), 'main shuffle changed card membership');
    assert(shuffled.deck.extra.join(',') === extraBefore.join(',') && shuffled.deck.side.join(',') === sideBefore.join(','), 'main shuffle changed extra/side');

    const preview = await call('POST', `/admin/t/${tid}/phase`, { admin: true, body: { status: 'matches' } });
    assert(preview.requires_confirmation === true && preview.invalid_decks.length === 3, 'match preflight did not report invalid decks');
    const stillBuilding = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
    assert(stillBuilding.status === 'deckbuilding', 'preflight mutated tournament phase');
    const confirmed = await call('POST', `/admin/t/${tid}/phase`, { admin: true, body: { status: 'matches', confirm_invalid_decks: true } });
    assert(confirmed.ok === true && confirmed.repairs.every((repair) => repair.disqualified), 'confirmed match transition did not DSQ undersized decks');
    const matchesState = await call('GET', `/t/${tid}/state`, { player: { tid, pid: 'probeA' } });
    assert(matchesState.status === 'matches' && matchesState.disqualified === true, 'player state did not refresh to matches/DSQ');
    console.log(`PROBE PASS tid=${tid} import=validated token=reset reserve=visible pause=frozen deckbuilding=unlimited shuffle=main-only preflight=confirmed`);
  } finally {
    if (tid !== null) {
      try { await call('DELETE', `/admin/t/${tid}`, { admin: true }); } catch (error) { console.error(`cleanup failed: ${error.message}`); }
    }
    if (poolId !== null) {
      try { await call('DELETE', `/admin/pools/${poolId}`, { admin: true }); } catch (error) { console.error(`pool cleanup failed: ${error.message}`); }
    }
  }
})().catch((error) => {
  console.error(`PROBE FAIL: ${error.message}`);
  process.exitCode = 1;
});
