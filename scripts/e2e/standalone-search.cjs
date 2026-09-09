#!/usr/bin/env node
// Exercise only the isolated public endpoint; never uses Cube identity or rooms.
const assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path");
const root = path.resolve(__dirname, "../.."),
  p = require(root + "/cube/packages/duel-protocol/dist");
const { WebSocket } = require(root + "/cube/apps/api/node_modules/ws");
const base = process.argv[2],
  fixture = process.argv[3],
  clients = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < (process.env.WAIT_GAME_MS ? 4000 : 600); i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw Error("TIMEOUT " + label);
}
async function api(route, body) {
  const r = await fetch(base + "/duel-api/public/duel/" + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Origin: base },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(r.ok, true, await r.clone().text());
  return r.json();
}
async function client(credential) {
  const ticket = await api("session", { credential }),
    ws = new WebSocket(base.replace(/^http/, "ws") + "/duel-api/duel/ws", {
      origin: base,
    }),
    c = {
      ws,
      state: p.initialState(),
      id: 0,
      errors: [],
      closed: false,
      wins: 0,
      timeEvents: [],
    };
  clients.push(c);
  c.send = (opcode, data = new Uint8Array()) =>
    ws.send(
      JSON.stringify({
        type: "action",
        id: c.id,
        opcode,
        data: Array.from(data),
      }),
    );
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "auth", version: 1, ticket: ticket.ticket }),
    ),
  );
  ws.on("message", (raw, binary) => {
    try {
      if (binary) {
        const frame = new Uint8Array(raw);
        p.applyFrame(c.state, frame);
        if(frame[2]===0x18)c.timeEvents.push([...c.state.time]);
        if (frame[2] === 1 && frame[3] === 5) c.wins++;
      } else {
        const v = JSON.parse(raw);
        if (v.type === "prompt") c.id = v.id;
        if (v.type === "error") {console.log("ERROR", v.code,v.message); c.errors.push(v); }
        if (v.type === "accepted") c.state.prompt = null;
      }
    } catch (e) {
      c.errors.push(String(e));
    }
  });
  ws.on("error", (e) => c.errors.push(String(e)));
  ws.on("close", () => (c.closed = true));
  await until(() => c.id || c.closed, "join");
  assert(!c.closed);
  return c;
}
(async () => {
  const deck = { main: [], extra: [], side: [] };
  let z = "main";
  for (const s of fs.readFileSync(fixture, "utf8").split(/\r?\n/)) {
    if (s === "#main") z = "main";
    else if (s === "#extra") z = "extra";
    else if (s === "!side") z = "side";
    else if (/^\d+$/.test(s)) deck[z].push(+s);
  }
  deck.main.splice(0,3,32807846,32807846,32807846);
  const { defaults } = await api("options"),
    password = "smoke-" + Date.now();
  const join = (name) =>
    api("join", {
      name,
      password,
      deck,
      options: {
        ...defaults,
        mode: 0, noCheck:false, noShuffle:true,
        extraMax: 30,
        sideMax: 30,
        timeLimit: process.env.WAIT_GAME_MS ? 999 : 180,
      },
    });
  const first = await join("SmokeA"),
    a = await client(first.credential);
  if(process.env.LEAVE_LOBBY_TEST){
    a.ws.close();
    await until(async()=> (await fetch(base+'/duel-api/public/duel/rooms/'+first.room)).status===404,'empty lobby removed after leaving');
    console.log('PASS explicit lone-player disconnect removes lobby');return;
  }
  if(process.env.WAIT_LOBBY_MS){
    console.log('Waiting in one-player lobby beyond five minutes');
    await wait(Number(process.env.WAIT_LOBBY_MS));
    assert(!a.closed); await api('rooms/'+first.room);
    console.log('PASS connected one-player lobby retained');
  }
  const second = await join("SmokeB"),
    b = await client(second.credential);
  assert.equal(first.room, second.room);

  await until(() => a.state.host && a.state.names.includes("SmokeB"), "seats");
  a.send(0x22);
  b.send(0x22);
  await until(() => a.state.ready.every(Boolean), "ready");
  a.send(0x25);
  let searched = false, shuffled = false, baselineTime, activeClient;
  let gameWaitUntil = 0;
  const sent = new Map(),
    sided = new Set(),
    surrendered = new Set(),
    summoned = new Set();
  await until(() => {
    for (const c of [a, b]) {
      assert.deepEqual(c.errors, []);
      if (c.closed) continue;
      if (sent.get(c) === c.id) continue;
      const s = c.state;
      if (s.stage === "hand") {
        sent.set(c, c.id);
        c.send(3, Uint8Array.of(c === a ? 1 : 2));
      } else if (s.stage === "turn") {
        sent.set(c, c.id);
        c.send(4, Uint8Array.of(1));
      } else if (s.stage === "siding") {
        sent.set(c, c.id);
        const d = s.deck,
          main = [...d.main],
          side = [...d.side];
        [main[0], side[0]] = [side[0], main[0]];
        c.send(2, p.encodeDeck(main, side));
        sided.add(c);
      } else if (s.prompt) {
        const q = s.prompt;
        sent.set(c, c.id);
        if (q.kind === "command") {
          if(process.env.WAIT_GAME_MS && !gameWaitUntil){gameWaitUntil=Date.now()+Number(process.env.WAIT_GAME_MS);console.log('Waiting in live duel beyond five minutes');}
          if(Date.now()<gameWaitUntil){sent.delete(c);continue;}
          if(searched && s.cards.some(card=>card.location===16))continue;
          if(process.env.TIME_TEST && !shuffled){
            const shuffle=q.choices.find(x=>x.label==='shuffle');
            assert(shuffle,'shuffle available');shuffled=true;baselineTime=s.time[s.seat];activeClient=c;
            c.send(1,p.integer(shuffle.value));continue;
          }
          if(process.env.TIME_TEST && activeClient===c && !summoned.size)assert.equal(s.time[s.seat],baselineTime,'shuffle grants no extra time');
          const summon = q.choices.find((x) => x.label === "activate") || q.choices.find((x) => x.label === "summon");
          const choice =
            summon || q.choices.find((x) => x.value === 7) || q.choices[0];
          c.send(1, p.integer(choice.value));
          if (summon) summoned.add(s.game);
        } else if (q.kind === "place")
          c.send(1, p.encodeSelection(q, [q.choices[0].index]));
        else if (q.kind === "cards") {searched = true; c.send(1,p.encodeSelection(q,q.choices.slice(0,q.min).map(x=>x.index)));}
        else if (q.cancel) c.send(1, p.integer(-1));
        else if (q.kind === "yesno") c.send(1, p.integer(0));
        else throw Error("Unhandled test prompt " + q.kind);
      }
    }
    const game = a.wins;
    if (
      !b.closed &&
      b.state.stage === "dueling" &&
      a.state.cards.some((c) => c.location === 16) &&
      !surrendered.has(game)
    ) {
      surrendered.add(game);
      b.send(0x14);
    }
    return (
      a.wins >= 1 && b.wins >= 1 && (a.closed || a.state.stage === "ended")
    );
  }, "duel complete");


  assert(searched, "search selection reached");
  if(process.env.TIME_TEST){
    const maxTime=Math.max(...activeClient.timeEvents.map(t=>t[activeClient.state.seat]));
    assert.equal(maxTime,baselineTime+2,'one activation earns exactly two seconds; target/zone selection earns none');
    console.log('PASS authoritative +2 seconds, no shuffle/selection bonus');
  }
  if(process.env.WAIT_GAME_MS)console.log('PASS live duel retained beyond five minutes and completed');
  assert(a.state.revealed.length > 0 && b.state.revealed.length > 0, "both players decoded searched-card reveal");
  console.log(
    JSON.stringify({
      ok: true,
      endpoint: base + "/duel",
      transport: "HTTPS/WSS",
      games: a.wins,
      searchResolved: true,
      hostCompleted: true,
      method: "activate Reinforcement of the Army, search, reveal, shuffle, then surrender",
    }),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of clients) c.ws.terminate();
  });
