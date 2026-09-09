#!/usr/bin/env node
// Isolated real-host BO3: no running deployment or production database is used.
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  net = require("net"),
  assert = require("node:assert/strict"),
  { spawn } = require("child_process");
const root = path.resolve(__dirname, "../.."),
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ygocube-web-"));
const apiRoot = path.join(root, "cube/apps/api"),
  proto = require(path.join(root, "cube/packages/duel-protocol/dist"));
const { WebSocket } = require(path.join(apiRoot, "node_modules/ws"));
const children = [],
  sockets = [];
let gamePort, httpPort, apiPort, tid, mid, room, fixtureDeck;
const standaloneCredentials = {};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(50);
  }
  throw Error("TIMEOUT: " + label);
}
function child(cmd, args, cwd) {
  const log = fs.openSync(
    path.join(tmp, children.length ? "api.log" : "srvpro.log"),
    "w",
  );
  const p = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: path.join(root, "envs/ygocube/lib"),
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  children.push(p);
  return p;
}
async function http(url, opts = {}) {
  const r = await fetch(url, opts);
  const body = await r.text();
  if (!r.ok) throw Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}
async function rest(route, pid, body) {
  return http(`http://127.0.0.1:${apiPort}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(pid
        ? {
            "X-Player-Id": pid,
            "X-Tournament-Id": String(tid),
            "X-Token": "web-test-super",
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function native(pid) {
  const ws = net.connect(gamePort, "127.0.0.1");
  ws.terminate = () => ws.destroy();
  sockets.push(ws);
  const c = {
      ws,
      state: proto.initialState(),
      id: 0,
      errors: [],
      frames: [],
      closed: false,
    },
    framer = new proto.Framer();
  c.send = (op, data = new Uint8Array()) => {
    ws.write(proto.packet(op, data));
    if ([1, 2, 3, 4].includes(op)) c.state.prompt = null;
  };
  ws.on("connect", () => {
    const name = Buffer.alloc(40),
      join = Buffer.alloc(48);
    name.write(pid, 0, 38, "utf16le");
    join.writeUInt16LE(4962);
    join.write(room, 8, 38, "utf16le");
    c.send(0x10, name);
    c.send(0x12, join);
  });
  ws.on("data", (chunk) => {
    try {
      for (const f of framer.feed(chunk)) {
        if (f[2] === 0x17) continue;
        c.frames.push(f);
        proto.applyFrame(c.state, f);
        c.id++;
        if (f[2] === 0x12)
          c.send(2, proto.encodeDeck(fixtureDeck.main, fixtureDeck.side));
        if (f[2] === 0x18) c.send(0x15);
      }
    } catch (e) {
      c.errors.push(String(e));
    }
  });
  ws.on("close", () => {
    c.closed = true;
  });
  ws.on("error", (e) => c.errors.push(String(e)));
  await until(() => c.id, "native client join");
  return c;
}
async function connect(pid) {
  if (pid === "bob" && process.env.NATIVE_BOB === "1") return native(pid);
  const ticket = process.env.STANDALONE_ONLY
    ? await rest("/public/duel/session", null, {
        credential: standaloneCredentials[pid],
      })
    : await rest(
        pid
          ? `/t/${tid}/matches/${mid}/duel-session`
          : `/public/t/${tid}/matches/${mid}/watch-session`,
        pid,
        {},
      );
  const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/duel/ws`, {
    origin: "http://localhost:3000",
  });
  sockets.push(ws);
  const client = {
    ws,
    state: proto.initialState(),
    id: 0,
    errors: [],
    frames: [],
    closed: false,
  };
  client.send = (opcode, data = new Uint8Array()) =>
    ws.send(
      JSON.stringify({
        type: "action",
        id: client.id,
        opcode,
        data: Array.from(data),
      }),
    );
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "auth", version: 1, ticket: ticket.ticket }),
    ),
  );
  ws.on("message", (data, binary) => {
    try {
      if (binary) {
        const f = new Uint8Array(data);
        client.frames.push(f);
        proto.applyFrame(client.state, f);
      } else {
        const v = JSON.parse(data.toString());
        if (v.type === "prompt") client.id = v.id;
        if (v.type === "snapshot") {
          client.state = v.state;
          client.snapshot = true;
        }
        if (v.type === "accepted") client.state.prompt = null;
        if (v.type === "error") client.errors.push(v);
      }
    } catch (e) {
      client.errors.push(String(e));
    }
  });
  ws.on("close", (code, reason) => {
    client.closed = true;
    client.closeCode = code;
    client.closeReason = reason.toString();
  });
  ws.on("error", (e) => client.errors.push(String(e)));
  await until(
    () =>
      client.id ||
      (pid === "watch" && client.frames.length) ||
      (!pid && (client.frames.length || client.snapshot)) ||
      client.closed,
    "websocket join",
  );
  assert.equal(client.closed, false, client.closeReason);
  return client;
}
(async () => {
  [gamePort, httpPort, apiPort] = await Promise.all([port(), port(), port()]);
  const serverDir = path.join(tmp, "srvpro");
  fs.mkdirSync(serverDir);
  for (const entry of fs.readdirSync(path.join(root, "srvpro"))) {
    if (["config", ".git", "ygopro"].includes(entry)) continue;
    fs.symlinkSync(
      path.join(root, "srvpro", entry),
      path.join(serverDir, entry),
    );
  }
  fs.mkdirSync(path.join(serverDir, "ygopro"));
  for (const entry of fs.readdirSync(path.join(root, "srvpro/ygopro"))) {
    if (["replay", "deck"].includes(entry)) continue;
    fs.symlinkSync(
      entry === "ygopro" ? path.join(root, "ygopro/bin/release/ygopro") : path.join(root, "srvpro/ygopro", entry),
      path.join(serverDir, "ygopro", entry),
    );
  }
  fs.mkdirSync(path.join(serverDir, "config"));
  fs.writeFileSync(
    path.join(serverDir, "config/config.json"),
    JSON.stringify({
      port: gamePort,
      version: 4962,
      modules: {
        http: { port: httpPort },
        cube: {
          enabled: true,
          api_key: "web-test-key",
          web_public_url: process.env.STANDALONE_ONLY ? "http://localhost:3000/duel" : "",
          web_native_host: "127.0.0.1",
          webhook_url: `http://127.0.0.1:${apiPort}/cube/result`,
        },
        random_duel: { enabled: false },
        cloud_replay: { enabled: false },
        reconnect: { enabled: true, allow_kick_reconnect: true },
        max_mem_percentage: 100,
      },
    }),
  );
  const configFile = path.join(tmp, "config.yaml");
  fs.writeFileSync(
    configFile,
    `admin:\n  super_token: web-test-super\nsrvpro:\n  url: http://127.0.0.1:${httpPort}\n  api_key: web-test-key\n  game_port: ${gamePort}\nserver:\n  port: ${apiPort}\n  db_path: ${tmp}/cube.sqlite\n  cards_cdb: ${root}/srvpro/ygopro/cards.cdb\n  card_names_json: ${root}/assets/ygocdb_cards.json\n  allowed_origins: [http://localhost:3000, http://127.0.0.1:3000]\nweb_duel:\n  enabled: true\n  archive_dir: ${tmp}/archives\n  protocol_version: 4962\n`,
  );
  process.env.CONFIG_FILE = configFile;
  child(
    process.execPath,
    [path.join(serverDir, "ygopro-server.js")],
    serverDir,
  );
  await until(async () => {
    try {
      await fetch(`http://127.0.0.1:${httpPort}/`);
      return true;
    } catch {
      return false;
    }
  }, "srvpro listening");
  const { CardsService } = require(
      path.join(apiRoot, "dist/cards/cards.service"),
    ),
    { PoolsService } = require(path.join(apiRoot, "dist/pools/pools.service")),
    { TournamentsService } = require(
      path.join(apiRoot, "dist/tournaments/tournaments.service"),
    ),
    { MatchesService, RealSrvproClient } = require(
      path.join(apiRoot, "dist/matches/matches.service"),
    ),
    { loadState, logEvent } = require(
      path.join(apiRoot, "dist/events/events.service"),
    );
  const cards = new CardsService(),
    pools = new PoolsService(cards),
    tournaments = new TournamentsService(pools);
  const normals = cards
    .getMany(cards.allCodes())
    .filter(
      (c) =>
        (c.type & 0x11) === 0x11 &&
        !(c.type & 0x4000) &&
        c.level <= 4 &&
        c.level > 0 &&
        !c.alias,
    )
    .slice(0, 42)
    .map((c) => c.code);
  assert(normals.length >= 41);
  fixtureDeck = { main: normals.slice(0, 40), side: [normals[40]] };
  if (process.env.EXPANSION_CODE) {
    const code = Number(process.env.EXPANSION_CODE);
    assert(cards.get(code), 'expansion metadata must exist');
    assert(cards.search(String(code)).some(c => c.code === code));
    fixtureDeck.main[0] = code;
    normals[0] = code;
    const result = pools.create('expansion-probe', [code]);
    assert.deepEqual(result.pool.codes, [code]);
  }

  if (process.env.EXPANSION_EFFECT) {
    fixtureDeck.main = cards.getMany(cards.allCodes()).filter(c => (c.type & 0x40002) === 0x40002 && !c.alias).slice(0,39).map(c=>c.code);
    fixtureDeck.main.splice(20,0,100200292);
  }
  if (process.env.STANDALONE_ONLY) {
    child(process.execPath, [path.join(apiRoot, "dist/main.js")], apiRoot);
    await until(async () => {
      try {
        return await rest("/health");
      } catch {
        return false;
      }
    }, "api listening");
    const { defaults, lists } = await rest("/public/duel/options");
    assert(lists.some((l) => l.id === -1));
    const deck = { ...fixtureDeck, extra: [] };
    const options = {
      ...defaults,
      mode: process.env.STANDALONE_MATCH ? 1 : 0,
      timeLimit: 120,
      extraMax: 30,
      sideMax: 30,
      ...(process.env.EXPANSION_EFFECT ? {noCheck: true, noShuffle: true, startHand: 39, drawCount: 0} : {}),
    };
    const join = async (name, overrides = {}) =>
      rest("/public/duel/join", null, {
        name,
        password: "standalone-test",
        deck,
        options: { ...options, ...overrides },
      });
    const alice = await join("Alice");
    standaloneCredentials.alice = alice.credential;
    let a = await connect("alice");
    const resolved = await rest("/public/duel/resolve", null, {
      password: "standalone-test",
    });
    assert.equal(resolved.url, `/duel/room/${alice.room}`);
    const bob = await rest("/public/duel/join", null, {
      name: "Bob",
      room: alice.room,
      deck,
    });
    standaloneCredentials.bob = bob.credential;
    assert.equal(alice.room, bob.room);
    assert.equal(bob.options.mode, options.mode);
    assert.equal(bob.options.timeLimit, 120);
    assert.equal(bob.options.extraMax, 30);
    const b = await connect("bob");
    await until(
      () => a.state.host && a.state.names.includes("Bob"),
      "standalone seats",
    );
    b.send(0x25);
    await until(() => b.errors.length, "non-host rejected");
    assert.equal(b.errors.pop().code, "INVALID_ACTION");
    a.send(0x22);
    b.send(0x22);
    await until(() => a.state.ready.every(Boolean), "standalone ready").catch(
      (e) => {
        console.error(
          JSON.stringify({
            a: a.state,
            b: b.state,
            errors: [a.errors, b.errors],
            frames: a.frames.map((f) => Buffer.from(f).toString("hex")),
          }),
        );
        throw e;
      },
    );
    a.send(0x25);
    const sent = new Map();
    await until(() => {
      for (const c of [a, b]) {
        assert.deepEqual(c.errors, []);
        if (sent.get(c) === c.id) continue;
        if (c.state.stage === "hand") {
          sent.set(c, c.id);
          c.send(3, Uint8Array.of(c === a ? 1 : 2));
        }
        if (c.state.stage === "turn") {
          sent.set(c, c.id);
          c.send(4, Uint8Array.of(1));
        }
      }
      return (
        a.state.stage === "dueling" &&
        b.state.stage === "dueling" &&
        a.state.cards.some((c) => c.location === 2 && c.code)
      );
    }, "standalone duel");
    if (process.env.EXPANSION_EFFECT) {
      const handled = new Map();
      let activated = false, selected = false;
      await until(() => {
        if(activated && selected && [a,b].some(c=>c.state.cards.some(x=>x.location===16 && fixtureDeck.main.includes(x.code)))) return true;
        for (const c of [a, b]) {
          assert.deepEqual(c.errors, []);
          const q = c.state.prompt;
          if (!q || handled.get(c) === c.id) continue;
          handled.set(c, c.id);
          if (q.kind === "command") {
            const action = q.choices.find(x => x.label === "activate" && x.code === 100200292)
              || q.choices.find(x => x.label === "summon" && x.code === 100200292);
            assert(action, 'expansion summon or ignition effect available');
            if (action.label === 'activate') activated = true;
            c.send(1, proto.integer(action.value));
          } else if (q.kind === 'place' || q.kind === 'cards') {
            if(q.kind === 'cards') selected = true;
            c.send(1, proto.encodeSelection(q, q.choices.slice(0, Math.max(1,q.min)).map(x=>x.index)));
          } else if(q.cancel) c.send(1,proto.integer(-1));
          else if(q.kind === 'position') c.send(1,proto.integer(q.choices[0].value));
          else throw Error('Unexpected expansion prompt '+q.kind);
        }
        return activated && selected && [a,b].some(c=>c.state.cards.some(x=>x.location===16 && fixtureDeck.main.includes(x.code)));
      }, 'expansion ignition effect resolved');
      console.log('PASS expansion script: summon, activate, select equip from deck, send to graveyard');
    }
    const observed = await rest("/public/duel/watch", null, {
      room: alice.room,
    });
    standaloneCredentials.watch = observed.credential;
    const spectator = await connect("watch");
    await until(
      () => spectator.state.cards.some((c) => c.location === 2),
      "late spectator scene",
    );
    assert(
      spectator.state.cards
        .filter((c) => c.location === 2)
        .every((c) => c.code === 0),
    );
    spectator.send(0x14);
    await until(() => spectator.closed, "spectator read only");
    assert.equal(spectator.closeCode, 4003);
    a.ws.terminate();
    await delay(200);
    const resumed = await rest("/public/duel/join", null, {
      room: alice.room,
      name: "Alice",
      reconnect: true,
    });
    assert.equal(resumed.credential, alice.credential);
    standaloneCredentials.alice = resumed.credential;
    a = await connect("alice");
    await until(
      () =>
        a.state.stage === "dueling" &&
        a.state.cards.some((c) => c.location === 2),
      "standalone reconnect",
    );
    b.send(0x14);
    if (options.mode === 1) {
      const sentSide = new Set(),
        decisions = new Map();
      await until(() => {
        for (const c of [a, b]) {
          if (c.errors.length) throw Error(JSON.stringify(c.errors));
          if (c.state.stage === "siding" && !sentSide.has(c)) {
            sentSide.add(c);
            const d = c.state.deck,
              main = [...d.main],
              side = [...d.side];
            [main[0], side[0]] = [side[0], main[0]];
            c.send(2, proto.encodeDeck(main, side));
          }
          if (c.state.stage === "turn" && decisions.get(c) !== c.id) {
            decisions.set(c, c.id);
            c.send(4, Uint8Array.of(1));
          }
        }
        return (
          sentSide.size === 2 &&
          a.state.stage === "dueling" &&
          b.state.stage === "dueling"
        );
      }, "standalone siding");
      b.send(0x14);
    }
    await until(
      () => a.closed || a.state.stage === "ended",
      "standalone finish",
    );
    fs.writeFileSync(
      path.join(tmp, "fixture.ydk"),
      ["#main", ...deck.main, "#extra", "!side", ...deck.side].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "local-services.json"),
      JSON.stringify({
        apiPort,
        gamePort,
        httpPort,
        configFile,
        pids: children.map((c) => c.pid),
      }),
    );
    console.log(
      JSON.stringify({
        ok: true,
        standalone: true,
        firstCreatorRules: true,
        hostOnlyStart: true,
        reconnected: true,
        artifacts: tmp,
        apiPort,
        gamePort,
        httpPort,
      }),
    );
    return;
  }
  pools.create("web-test", normals);
  tid = tournaments.create(
    {
      name: "Web BO3 smoke",
      maxPlayers: 2,
      cardPool: "web-test",
      mainMin: 40,
      mainMax: 60,
      mode: "match",
      maxCopies: 3,
    },
    "test",
  ).tid;
  tournaments.join(tid, "alice", "Alice");
  tournaments.join(tid, "bob", "Bob");
  tournaments.setPhase(tid, "drafting", undefined, "test");
  tournaments.setPhase(tid, "deckbuilding", undefined, "test");
  for (const pid of ["alice", "bob"])
    logEvent(
      tid,
      "deck",
      "deck",
      {
        playerId: pid,
        deck: {
          main: normals.slice(0, 40),
          extra: [],
          side: [normals[40]],
          lockedAt: new Date().toISOString(),
          status: "locked",
        },
      },
      "test",
    );
  tournaments.setPhase(tid, "matches", undefined, "test");
  const matches = new MatchesService(
    new RealSrvproClient(`http://127.0.0.1:${httpPort}`, "web-test-key"),
  );
  matches.startRound(tid, 1, "test");
  await until(() => loadState(tid).matches[0]?.roomName, "room creation");
  ({ id: mid, roomName: room } = loadState(tid).matches[0]);
  child(process.execPath, [path.join(apiRoot, "dist/main.js")], apiRoot);
  await until(async () => {
    try {
      await rest("/health");
      return true;
    } catch {
      return false;
    }
  }, "api listening");
  const missing = await fetch(
    `http://127.0.0.1:${apiPort}/t/${tid}/matches/${mid}/duel-session`,
    { method: "POST" },
  );
  assert.equal(missing.status, 401);
  const locked = await fetch(
    `http://127.0.0.1:${apiPort}/public/t/${tid}/matches/${mid}/replay`,
  );
  assert.equal(locked.status, 403);
  let a = await connect("alice"),
    b = await connect("bob");
  let watch = await connect();
  const forbiddenWatch = await connect();
  forbiddenWatch.ws.send(
    JSON.stringify({ type: "action", id: 0, opcode: 0x14, data: [] }),
  );
  await until(() => forbiddenWatch.closed, "read-only spectator");
  assert.equal(forbiddenWatch.closeCode, 4003);
  await until(() => a.state.names[1] === "bob" && a.state.host, "both seats");
  a.send(0x22);
  b.send(0x22);
  await until(() => {
    if (a.errors.length || b.errors.length)
      throw Error(
        JSON.stringify({
          a: a.errors,
          b: b.errors,
          as: a.state.stage,
          bs: b.state.stage,
        }),
      );
    return a.state.ready.every(Boolean);
  }, "both ready").catch((e) => {
    console.error(
      JSON.stringify({
        a: a.state,
        b: b.state,
        af: a.frames.map((f) => Buffer.from(f).toString("hex")),
        bf: b.frames.map((f) => Buffer.from(f).toString("hex")),
      }),
    );
    throw e;
  });
  a.send(0x25);
  const observed = new Set();
  let games = 0,
    reconnected = false,
    lastSent = new Map();
  await until(
    async () => {
      if (b.surrendered?.size >= 2 && b.closed) return true;
      for (const c of [a, b]) {
        if (c.errors.length) throw Error(JSON.stringify(c.errors));
        if (c.closed && !c.replaced)
          throw Error(`Unexpected close ${c.closeCode} ${c.closeReason}`);
        if (lastSent.get(c) === c.id) continue;
        if (c.state.stage === "hand") {
          lastSent.set(c, c.id);
          c.send(3, new Uint8Array([c === a ? 1 : 2]));
        } else if (c.state.stage === "turn") {
          lastSent.set(c, c.id);
          c.send(4, new Uint8Array([1]));
        } else if (c.state.stage === "siding") {
          lastSent.set(c, c.id);
          const d = c.state.deck;
          const main = [...d.main],
            side = [...d.side];
          [main[0], side[0]] = [side[0], main[0]];
          c.send(2, proto.encodeDeck(main, side));
          c.state.stage = "waitingSide";
        } else if (c.state.prompt) {
          const p = c.state.prompt;
          observed.add(p.message);
          lastSent.set(c, c.id);
          if (p.kind === "command") {
            const choice =
              p.choices.find((x) => x.label === "summon") ??
              p.choices.find((x) => x.label === "end") ??
              p.choices[0];
            c.send(1, proto.integer(choice.value));
          } else if (p.kind === "place")
            c.send(
              1,
              proto.encodeSelection(
                p,
                p.choices.slice(0, p.min || 1).map((x) => x.index),
              ),
            );
          else if (p.kind === "chain" && p.cancel) c.send(1, proto.integer(-1));
          else if (p.kind === "position")
            c.send(1, proto.integer(p.choices[0].value));
          else throw Error("Unexpected prompt " + p.kind);
        }
      }
      games = a.frames.filter((f) => f[2] === 1 && f[3] === 4).length;
      if (!reconnected && a.state.cards.some((c) => c.location === 4)) {
        reconnected = true;
        a.replaced = true;
        a.ws.close();
        await delay(250);
        a = await connect("alice");
        await until(
          () =>
            a.state.stage === "dueling" &&
            a.state.cards.some((c) => c.location === 4),
          "field restored",
        );
        assert(
          a.state.cards.some((c) => c.location === 4),
          "reconnect must restore summoned monster",
        );
      }
      const starts = b.frames.filter((f) => f[2] === 1 && f[3] === 4).length;
      if (
        b.state.stage === "dueling" &&
        b.state.cards.some((c) => c.location === 4) &&
        !b.surrendered?.has(starts)
      ) {
        b.surrendered ??= new Set();
        b.surrendered.add(starts);
        await delay(250);
        assert(
          watch.state.cards
            .filter((c) => c.location === 2)
            .every((c) => c.code === 0),
          "public spectator sees hidden hand",
        );
        b.send(0x14);
      }
      return (
        b.surrendered?.size >= 2 && (b.closed || b.state.stage === "ended")
      );
    },
    "BO3, side deck and reconnect",
    60000,
  );
  assert(reconnected);
  assert(observed.has(11));
  assert(observed.has(18));
  const archive = path.join(tmp, "archives", room, "full.ndjson");
  await until(() => fs.existsSync(archive), "archive");
  await delay(500);
  const lines = fs
    .readFileSync(archive, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  let full = proto.initialState(),
    privateHand = false;
  for (const row of lines) {
    proto.applyFrame(full, Buffer.from(row.frame, "base64"));
    if (full.cards.some((c) => c.location === 2 && c.code)) privateHand = true;
  }
  assert(privateHand, "full recorder contains hand identities");
  assert.equal(full.error, undefined);
  const meta = JSON.parse(
    fs.readFileSync(path.join(tmp, "archives", room, "meta.json"), "utf8"),
  );
  assert.equal(meta.complete, true, "normal match must seal a complete replay");
  const stillLocked = await fetch(
    `http://127.0.0.1:${apiPort}/public/t/${tid}/matches/${mid}/replay`,
  );
  assert.equal(
    stillLocked.status,
    403,
    "match end alone does not release full replay",
  );
  await http(`http://127.0.0.1:${apiPort}/admin/t/${tid}/phase`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": "web-test-super",
    },
    body: JSON.stringify({ status: "finished" }),
  });
  await until(
    async () => {
      try {
        const replay = await rest(`/public/t/${tid}/matches/${mid}/replay`);
        fs.writeFileSync(
          path.join(tmp, "web-replay.json"),
          JSON.stringify(replay),
        );
        return replay;
      } catch {
        return false;
      }
    },
    "released replay after tournament completion",
    10000,
  );
  console.log(
    JSON.stringify({
      ok: true,
      tid,
      mid,
      recordedFrames: lines.length,
      observedPrompts: [...observed],
      reconnected,
      artifacts: tmp,
    }),
  );
})()
  .catch((e) => {
    console.error(e);
    console.error("Artifacts:", tmp);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const s of sockets) s.terminate();
    for (const p of process.env.KEEP_SERVICES && !process.exitCode
      ? []
      : children) {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {}
    }
    await delay(100);
    process.exit(process.exitCode ?? 0);
  });
