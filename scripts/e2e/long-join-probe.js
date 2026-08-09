// Live srvpro probe for the variable-length CTOS_JOIN_GAME room password.
// Creates a disposable cube room whose name exceeds the legacy 20 UTF-16 units,
// joins it over TCP, and asserts JOIN_GAME then CUBE_DECK are received.
const net = require('net');

const host = process.argv[2] || '127.0.0.1';
const gamePort = Number(process.argv[3] || 7911);
const httpPort = Number(process.argv[4] || 7922);
const apiKey = process.env.API_KEY;
const player = `longProbe${Date.now().toString(36)}`;
const room = `CUBE-LONG-JOIN-${Date.now()}-abcdefghijklmnopqrstuvwxyz`;

if (!apiKey) throw new Error('API_KEY is required');

function packet(type, payload) {
  const framed = Buffer.alloc(payload.length + 3);
  framed.writeUInt16LE(payload.length + 1, 0);
  framed.writeUInt8(type, 2);
  payload.copy(framed, 3);
  return framed;
}

async function srvpro(path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
    method,
    headers: { 'X-Cube-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function joinLongRoom() {
  return new Promise((resolve, reject) => {
    const seen = [];
    const socket = net.connect(gamePort, host);
    let receive = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error(`timeout; protos=${seen.map((x) => `0x${x.toString(16)}`).join(',')}`)), 12000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(seen);
    };
    socket.on('error', finish);
    socket.on('connect', () => {
      const playerInfo = Buffer.alloc(40);
      playerInfo.write(player, 0, 'utf16le');
      socket.write(packet(0x10, playerInfo));
      setTimeout(() => {
        const encoded = Buffer.from(`${room}\0`, 'utf16le');
        const join = Buffer.alloc(8 + encoded.length);
        join.writeUInt16LE(0x1362, 0);
        join.writeUInt32LE(0, 4);
        encoded.copy(join, 8);
        socket.write(packet(0x12, join));
      }, 100);
    });
    socket.on('data', (chunk) => {
      receive = Buffer.concat([receive, chunk]);
      while (receive.length >= 3) {
        const length = receive.readUInt16LE(0);
        if (receive.length < length + 2) break;
        seen.push(receive.readUInt8(2));
        receive = receive.subarray(length + 2);
      }
      const joinAt = seen.indexOf(0x12);
      const cubeAt = seen.indexOf(0x0a);
      if (joinAt >= 0 && cubeAt > joinAt) finish();
    });
  });
}

(async () => {
  await srvpro('/cube/create_room', 'POST', {
    room_name: room,
    hostinfo: { mode: 0, rule: 5, duel_rule: 5, start_lp: 8000, start_hand: 5, draw_count: 1, time_limit: 180 },
    deck_size: { main_min: 1, main_max: 60, extra_max: 30, side_max: 30 },
    players: [{ player_id: player, name_vpass: player }],
    cube_decks: { [player]: { main: [10000], side: [] } },
  });
  try {
    const seen = await joinLongRoom();
    console.log(JSON.stringify({ ok: true, roomUnits: room.length, protos: seen.map((x) => `0x${x.toString(16)}`) }));
  } finally {
    try {
      await srvpro('/cube/close_room', 'POST', { room_name: room });
    } catch (error) {
      // A one-player disposable room may auto-delete as soon as the probe socket
      // disconnects; ROOM_NOT_FOUND is therefore successful cleanup.
      if (!/HTTP 404/.test(error.message)) throw error;
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
