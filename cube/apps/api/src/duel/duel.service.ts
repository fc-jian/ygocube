import {
  standaloneDefaults,
  standaloneOptions,
  toHost,
  fromHost,
} from "./standalone";
import { WindBots } from "./windbot";
import { readReplayCatalog } from "./replay-catalog";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Database from "better-sqlite3";
import fs from "fs";
import { Server } from "http";
import net from "net";
import crypto from "crypto";
import axios from "axios";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config";
import { loadState } from "../events/events.service";
import { getDb } from "../db";
import { CardsService, cardDatabasePaths } from "../cards/cards.service";
import {
  Framer,
  packet,
  encodeDeck,
  applyFrame,
  initialState,
  DuelState,
  declarable,
} from "@ygocube/duel-protocol";
type Ticket = {
  tid: number;
  mid: number;
  pid?: string;
  room: string;
  expiresAt: number;
  role: "player" | "watch";
  authHash?: string;
  standalone?: string;
};
export class Tickets {
  private values = new Map<string, Ticket>();
  issue(value: Omit<Ticket, "expiresAt">) {
    this.prune();
    if (this.values.size >= 1000) throw new Error("SESSION_LIMIT");
    const ticket = crypto.randomBytes(32).toString("base64url"),
      expiresAt = Date.now() + 30000;
    this.values.set(ticket, { ...value, expiresAt });
    return { version: 1 as const, ticket, expiresAt, wsPath: "/api/duel/ws" };
  }
  take(ticket: string) {
    const t = this.values.get(ticket);
    this.values.delete(ticket);
    return t && t.expiresAt > Date.now() ? t : null;
  }
  prune() {
    for (const [k, v] of this.values)
      if (v.expiresAt <= Date.now()) this.values.delete(k);
  }
}
export function allowedAction(s: DuelState, op: number, data: Uint8Array) {
  if (op === 0x14)
    return (
      data.length === 0 &&
      [
        "dueling",
        "hand",
        "turn",
        "waitingTurn",
        "siding",
        "waitingSide",
        "starting",
      ].includes(s.stage)
    );
  if (op === 1) return !!s.prompt && data.length > 0 && data.length <= 256;
  if (op === 3)
    return (
      s.stage === "hand" && data.length === 1 && [1, 2, 3].includes(data[0])
    );
  if (op === 4) return s.stage === "turn" && data.length === 1 && data[0] <= 1;
  if (op === 2)
    return s.stage === "siding" && data.length >= 8 && data.length <= 2056;
  if (op === 0x22 || op === 0x23)
    return s.stage === "lobby" && data.length === 0;
  if (op === 0x25)
    return (
      s.stage === "lobby" &&
      s.host &&
      s.ready.every(Boolean) &&
      data.length === 0
    );
  return false;
}
@Injectable()
export class DuelService implements OnModuleDestroy {
  private bots = new WindBots();
  private botCreating = false;
  private botCreatedAt = 0;
  botOptions() {
    return {
      enabled: config.webDuel.enabled && config.windbot.enabled,
      bots: config.webDuel.enabled ? this.bots.catalog() : [],
    };
  }
  async joinBot(body: any) {
    this.bots.check(body?.bot);
    if (this.botCreating || Date.now() - this.botCreatedAt < 3000)
      throw new Error("BOT_BUSY");
    this.botCreating = true;
    try {
      const result = await this.standaloneJoin({
        name: body?.name,
        password: crypto.randomBytes(24).toString("hex"),
        options: { ...standaloneDefaults, mode: 0, lflist: -1, timeLimit: 0 },
      });
      this.standalonePlayers.get(result.credential)!.bot = body.bot;
      this.persistStandalone(result.credential);
      this.botCreatedAt = Date.now();
      return result;
    } finally {
      this.botCreating = false;
    }
  }
  private tickets = new Tickets();
  private wss?: WebSocketServer;
  private timer?: NodeJS.Timeout;
  private active = new Map<
    WebSocket,
    {
      t: Ticket;
      close: () => void;
    }
  >();
  private players = new Map<string, WebSocket>();
  private watchers = new Map<
    string,
    {
      clients: Set<WebSocket>;
      state: DuelState;
      abort: AbortController;
      done: boolean;
    }
  >();
  private standalonePlayers = new Map<
    string,
    {
      bot?: string;
      role?: "player" | "watch";
      room: string;
      name: string;
      deck: { main: number[]; extra: number[]; side: number[] };
      current: { main: number[]; side: number[] };
      expiresAt: number;
    }
  >();
  constructor(private cards: CardsService) {}
  async standaloneOptions() {
    if (!config.webDuel.enabled) throw new Error("DUEL_DISABLED");
    const r = await axios.get(`${config.srvpro.url}/cube/standalone-options`, {
      headers: this.headers(),
      timeout: 5000,
    });
    return { ...r.data, defaults: standaloneDefaults };
  }
  private joining = new Set<string>();
  async standaloneJoin(body: any) {
    const key = this.roomKey(body) + ":" + String(body?.name).trim();
    if (this.joining.has(key)) throw new Error("PLAYER_ID_EXISTS");
    this.joining.add(key);
    try {
      return await this.joinStandalone(body);
    } finally {
      this.joining.delete(key);
    }
  }
  private checkedDeck(
    raw: any,
    options?: ReturnType<typeof standaloneOptions>,
  ) {
    const fail = (reason: string): never => {
      throw Object.assign(new Error("INVALID_DECK"), { details: { reason } });
    };
    if (
      !raw ||
      ["main", "extra", "side"].some(
        (k) =>
          !Array.isArray(raw[k]) ||
          raw[k].length > 200 ||
          raw[k].some(
            (c: any) => !Number.isInteger(c) || c <= 0 || c > 0xffffffff,
          ),
      )
    )
      fail("卡组格式错误：每区最多 200 张，卡号必须是正整数");
    const codes: number[] = [...raw.main, ...raw.extra, ...raw.side];
    if (codes.length > 500) fail("卡组总数不能超过 500 张");
    const cards = new Map(
      this.cards.getMany([...new Set(codes)]).map((c) => [c.code, c]),
    );
    for (const code of codes) {
      const card = cards.get(code);
      if (!card) fail(`未知卡片：${code}`);
      if (card!.type & 0x4000)
        fail(`衍生物不能加入卡组：${card!.name}（${code}）`);
    }
    const combined = [...raw.main, ...raw.extra] as number[];
    const deck = {
      main: combined.filter((c) => !this.cards.isExtraDeck(c)),
      extra: combined.filter((c) => this.cards.isExtraDeck(c)),
      side: [...raw.side] as number[],
    };
    if (options && !options.noCheck) {
      if (
        deck.main.length < options.mainMin ||
        deck.main.length > options.mainMax
      )
        fail(
          `主卡组 ${deck.main.length} 张，要求 ${options.mainMin}–${options.mainMax} 张`,
        );
      if (deck.extra.length > options.extraMax)
        fail(`额外卡组 ${deck.extra.length} 张，最多 ${options.extraMax} 张`);
      if (deck.side.length > options.sideMax)
        fail(`副卡组 ${deck.side.length} 张，最多 ${options.sideMax} 张`);
    }
    return deck;
  }
  private async joinStandalone(body: any) {
    if (!config.webDuel.enabled) throw new Error("DUEL_DISABLED");
    getDb()
      .prepare("DELETE FROM standalone_duel_players WHERE expires_at<=?")
      .run(Date.now());
    for (const [k, v] of this.standalonePlayers)
      if (v.expiresAt < Date.now()) this.standalonePlayers.delete(k);
    const room = this.roomKey(body);
    if (
      typeof body?.name !== "string" ||
      body.name.length > 12 ||
      !/^[^\x00-\x1f\x7f#$\\]{1,12}$/u.test(body.name) ||
      !body.name.trim()
    )
      throw new Error("BAD_PAYLOAD");
    const id = body.name.trim();
    let saved = getDb()
      .prepare(
        "SELECT credential,data_json FROM standalone_duel_players WHERE room=? AND player_id=? AND expires_at>?",
      )
      .get(room, id, Date.now()) as any;
    if (body.reconnect) {
      await this.roomInfo(room);
      if (!saved) throw new Error("PLAYER_NOT_FOUND");
      const active = this.players.get(saved.credential);
      if (
        active?.readyState === WebSocket.OPEN &&
        body.credential !== saved.credential
      )
        throw new Error("PLAYER_CONNECTED");
      this.standalonePlayers.set(saved.credential, JSON.parse(saved.data_json));
      return { ...(await this.roomInfo(room)), credential: saved.credential };
    }
    if (saved) {
      try {
        await this.roomInfo(room);
      } catch (e) {
        if ((e as Error).message === "MATCH_NOT_FOUND") {
          getDb()
            .prepare("DELETE FROM standalone_duel_players WHERE room=?")
            .run(room);
          for (const [key, value] of this.standalonePlayers)
            if (value.room === room) this.standalonePlayers.delete(key);
          saved = null;
        } else throw e;
      }
      if (saved) throw new Error("PLAYER_ID_EXISTS");
    }
    if (this.standalonePlayers.size >= config.webDuel.maxConnections)
      throw new Error("SESSION_LIMIT");
    const existing = await this.roomInfo(room).catch((e) => {
      if (e.message !== "MATCH_NOT_FOUND" || body.room) throw e;
      return null;
    });
    const options = existing?.options ?? standaloneOptions(body.options);
    const d = body.deck
      ? this.checkedDeck(body.deck, options)
      : { main: [], extra: [], side: [] };
    const lists = await this.standaloneOptions();
    if (!lists.lists.some((l: any) => l.id === options.lflist))
      throw new Error("BAD_PAYLOAD");
    const r = await axios.post(
      `${config.srvpro.url}/cube/standalone-room`,
      { room_name: room, hostinfo: toHost(options) },
      { headers: this.headers(), timeout: 15000 },
    );
    const actual = fromHost(r.data.hostinfo);
    if (body.deck) this.checkedDeck(d, actual);
    const credential = crypto.randomBytes(32).toString("base64url");
    // A private suffix distinguishes players with identical display names in srvpro reconnect.
    const name = body.name.trim() + "$" + credential.slice(0, 5);
    this.standalonePlayers.set(credential, {
      room,
      name,
      deck: d,
      current: { main: [...d.main, ...d.extra], side: d.side },
      expiresAt: Date.now() + 86400000,
    });
    this.persistStandalone(credential);
    return { credential, room, url: `/duel/room/${room}`, options: actual };
  }
  standaloneSession(credential: string) {
    if (!this.standalonePlayers.has(credential)) {
      const row = getDb()
        .prepare(
          "SELECT data_json FROM standalone_duel_players WHERE credential=? AND expires_at>?",
        )
        .get(credential, Date.now()) as any;
      if (row)
        this.standalonePlayers.set(credential, JSON.parse(row.data_json));
    }
    const p = this.standalonePlayers.get(credential);
    if (!config.webDuel.enabled || !p || p.expiresAt < Date.now())
      throw new Error("AUTH_REQUIRED");
    return this.tickets.issue({
      tid: 0,
      mid: 0,
      pid: p.name,
      room: p.room,
      role: p.role ?? "player",
      standalone: credential,
    });
  }
  private roomKey(body: any) {
    if (body?.room !== undefined) {
      if (typeof body.room !== "string" || !/^W[a-f0-9]{18}$/.test(body.room))
        throw new Error("BAD_PAYLOAD");
      return body.room;
    }
    if (
      typeof body?.password !== "string" ||
      !body.password.length ||
      body.password.length > 100
    )
      throw new Error("BAD_PAYLOAD");
    if (/^W[a-f0-9]{18}$/.test(body.password)) return body.password;
    return (
      "W" +
      crypto
        .createHmac("sha256", config.srvpro.apiKey)
        .update(body.password)
        .digest("hex")
        .slice(0, 18)
    );
  }
  private persistStandalone(credential: string) {
    const p = this.standalonePlayers.get(credential)!;
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO standalone_duel_players(room,player_id,credential,data_json,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(
        p.room,
        p.name.split("$")[0],
        credential,
        JSON.stringify(p),
        p.expiresAt,
      );
  }
  async roomInfo(room: string) {
    if (!config.webDuel.enabled) throw new Error("DUEL_DISABLED");
    this.roomKey({ room });
    try {
      const r = await axios.get(`${config.srvpro.url}/cube/standalone-info`, {
        params: { room_name: room },
        headers: this.headers(),
        timeout: 5000,
      });
      return {
        room,
        url: `/duel/room/${room}`,
        options: fromHost(r.data.hostinfo),
        players: r.data.players,
        finished: r.data.finished,
        nativeConnection: r.data.nativeConnection,
      };
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 404)
        throw new Error("MATCH_NOT_FOUND");
      throw e;
    }
  }
  resolveRoom(body: any) {
    return this.roomInfo(this.roomKey(body));
  }
  async standaloneWatch(room: string) {
    const info = await this.roomInfo(room);
    if (info.finished) throw new Error("FORBIDDEN");
    if (this.standalonePlayers.size >= config.webDuel.maxConnections)
      throw new Error("SESSION_LIMIT");
    const credential = crypto.randomBytes(32).toString("base64url");
    this.standalonePlayers.set(credential, {
      role: "watch",
      room,
      name: "Observer",
      deck: { main: [], extra: [], side: [] },
      current: { main: [], side: [] },
      expiresAt: Date.now() + 86400000,
    });
    return { ...info, credential, role: "watch" };
  }
  private match(tid: number, mid: number) {
    const s = loadState(tid),
      m = s.matches.find((m) => m.id === mid);
    if (!m?.roomName) throw new Error("MATCH_NOT_FOUND");
    return { s, m };
  }
  valid(t: Ticket) {
    try {
      if (t.standalone) {
        const p = this.standalonePlayers.get(t.standalone);
        return (
          !!p &&
          p.expiresAt > Date.now() &&
          config.webDuel.enabled &&
          p.room === t.room
        );
      }
      const { s, m } = this.match(t.tid, t.mid);
      const player = t.pid
        ? (getDb()
            .prepare(
              "SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=? AND active=1",
            )
            .get(t.tid, t.pid) as { token_hash: string } | undefined)
        : undefined;
      if (
        t.pid &&
        (!player || (t.authHash && t.authHash !== player.token_hash))
      )
        return false;
      return (
        config.webDuel.enabled &&
        m.roomName === t.room &&
        !s.frozen &&
        !m.finishedAt &&
        !m.faultedAt &&
        s.status === "matches" &&
        (!t.pid ||
          ([m.playerA, m.playerB].includes(t.pid) &&
            s.players.some((p) => p.playerId === t.pid)))
      );
    } catch {
      return false;
    }
  }
  session(tid: number, mid: number, pid?: string) {
    if (!config.webDuel.enabled) throw new Error("DUEL_DISABLED");
    const { m } = this.match(tid, mid);
    const t = {
      tid,
      mid,
      pid,
      room: m.roomName!,
      role: pid ? ("player" as const) : ("watch" as const),
      authHash: pid
        ? (
            getDb()
              .prepare(
                "SELECT token_hash FROM tournament_players WHERE tournament_id=? AND player_id=? AND active=1",
              )
              .get(tid, pid) as { token_hash: string } | undefined
          )?.token_hash
        : undefined,
    };
    if (!this.valid({ ...t, expiresAt: 0 })) throw new Error("FORBIDDEN");
    return this.tickets.issue(t);
  }
  attach(server: Server) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 8192,
      perMessageDeflate: false,
    });
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.split("?")[0] !== "/duel/ws") {
        socket.destroy();
        return;
      }
      if (
        !config.webDuel.enabled ||
        !config.server.allowedOrigins.includes(req.headers.origin ?? "") ||
        this.wss!.clients.size >= config.webDuel.maxConnections
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    });
    this.timer = setInterval(() => {
      this.tickets.prune();
      for (const [ws, a] of this.active) {
        const credential = a.t.standalone;
        const player = credential && this.standalonePlayers.get(credential);
        if (
          player &&
          player.expiresAt > Date.now() &&
          player.expiresAt < Date.now() + 3600000
        ) {
          player.expiresAt = Date.now() + 86400000;
          this.persistStandalone(credential as string);
        }
        if (!this.valid(a.t)) ws.close(4003, "SESSION_REVOKED");
      }
    }, 1000);
    this.timer.unref();
  }
  private send(ws: WebSocket, value: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.close(4008, "SLOW_CLIENT");
      return;
    }
    ws.send(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  private connect(ws: WebSocket) {
    let alive = true;
    const timeout = setTimeout(() => ws.close(4001, "AUTH_TIMEOUT"), 5000);
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 15000);
    heartbeat.unref();
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.active.get(ws)?.close();
      this.active.delete(ws);
    });
    ws.once("message", (raw, binary) => {
      try {
        if (binary) throw new Error("AUTH_REQUIRED");
        const message = JSON.parse(raw.toString());
        if (
          message.type !== "auth" ||
          message.version !== 1 ||
          typeof message.ticket !== "string"
        )
          throw new Error("AUTH_REQUIRED");
        const t = this.tickets.take(message.ticket);
        if (!t || !this.valid(t)) throw new Error("AUTH_REQUIRED");
        clearTimeout(timeout);
        this.send(ws, {
          type: "session",
          generation: crypto.randomUUID(),
          role: t.role,
        });
        if (t.role === "player")
          void this.player(ws, t).catch(() =>
            ws.close(4011, "HOST_UNAVAILABLE"),
          );
        else if (t.standalone) this.standaloneObserver(ws, t);
        else this.watch(ws, t);
      } catch {
        ws.close(4001, "AUTH_REQUIRED");
      }
    });
  }
  private async player(ws: WebSocket, t: Ticket) {
    const key = t.standalone ?? `${t.tid}:${t.mid}:${t.pid}`;
    const standalone = t.standalone
      ? this.standalonePlayers.get(t.standalone)!
      : undefined;
    this.players.get(key)?.close(4009, "TAKEN_OVER");
    this.players.set(key, ws);
    let upstream: net.Socket | undefined;
    this.active.set(ws, {
      t,
      close: () => {
        upstream?.destroy();
        if (this.players.get(key) === ws) {
          this.players.delete(key);
          if (standalone?.bot) {
            this.bots.stop(t.room);
            void axios
              .post(
                `${config.srvpro.url}/cube/close_room`,
                { room_name: t.room },
                { headers: this.headers(), timeout: 5000 },
              )
              .catch(() =>
                console.error("Unable to close disconnected bot room"),
              );
          }
        }
      },
    });
    const nativeStatus = standalone
      ? (
          await axios.get(`${config.srvpro.url}/cube/room_status`, {
            params: { room_name: t.room },
            headers: this.headers(),
            timeout: 5000,
          })
        ).data
      : undefined;
    const roomOptions = standalone
      ? (await this.roomInfo(t.room)).options
      : undefined;
    const currentDeck = standalone
      ? { data: standalone.current }
      : await axios.get(`${config.srvpro.url}/cube/web-player`, {
          params: { room_name: t.room, player_id: t.pid },
          headers: this.headers(),
          timeout: 5000,
        });
    if (
      ws.readyState !== WebSocket.OPEN ||
      !this.valid(t) ||
      this.players.get(key) !== ws
    )
      return;
    const s = initialState(),
      framer = new Framer();
    let id = 0,
      sentDeck = false,
      readyRequested = false;
    const tcp = net.connect({
      host: config.webDuel.upstreamHost,
      port: config.srvpro.gamePort,
    });
    upstream = tcp;
    const write = (op: number, b = new Uint8Array()) => {
      if (tcp.writableLength > 1024 * 1024) {
        ws.close(4008, "UPSTREAM_BUSY");
        return;
      }
      tcp.write(packet(op, b));
    };
    this.send(
      ws,
      Buffer.from(
        packet(10, encodeDeck(currentDeck.data.main, currentDeck.data.side)),
      ),
    );
    let initial = standalone?.deck ?? loadState(t.tid).decks[t.pid!];
    const initialDeck = encodeDeck(
      [...initial.main, ...initial.extra],
      initial.side,
    );
    const prompt = () => this.send(ws, { type: "prompt", id: ++id });
    tcp.on("connect", () => {
      const n = Buffer.alloc(40);
      n.write(t.pid!, 0, 38, "utf16le");
      const j = Buffer.alloc(48);
      j.writeUInt16LE(config.webDuel.version);
      j.write(t.room, 8, 38, "utf16le");
      write(0x10, n);
      write(0x12, j);
    });
    tcp.on("data", (chunk) => {
      try {
        for (const frame of framer.feed(chunk)) {
          if (frame[2] === 0x17) continue; // Native replays must not bypass the tournament release gate.
          const previousPrompt = s.prompt,
            previousStage = s.stage;
          applyFrame(s, frame);
          if (
            (frame[2] === 0x21 && frame[3] >>> 4 === s.seat) ||
            frame[2] === 2
          )
            readyRequested = !!s.ready[s.seat];
          if (standalone && frame[2] === 0x16)
            getDb()
              .prepare("DELETE FROM standalone_duel_players WHERE credential=?")
              .run(t.standalone!);
          if (frame[2] === 0x12 && !sentDeck) {
            sentDeck = true;
            if (
              (!standalone || nativeStatus.duel_stage !== 0) &&
              (initial.main.length ||
                initial.extra.length ||
                initial.side.length)
            )
              write(2, initialDeck);
          }
          if (
            frame[2] === 0x13 &&
            standalone?.bot &&
            s.host &&
            s.stage === "lobby"
          ) {
            try {
              this.bots.start(
                t.room,
                standalone.bot,
                () =>
                  this.send(ws, {
                    type: "error",
                    code: "BOT_FAILED",
                    message: "机器人已退出，请重新建立机器人房间",
                  }),
                () => this.players.get(key)?.readyState === WebSocket.OPEN,
              );
            } catch {
              this.send(ws, {
                type: "error",
                code: "BOT_FAILED",
                message: "机器人启动失败，请稍后重新建房",
              });
            }
          }
          if (frame[2] === 0x18) write(0x15);
          if (
            s.prompt !== previousPrompt ||
            s.stage !== previousStage ||
            frame[2] === 0x12 ||
            frame[2] === 0x13 ||
            (frame[2] === 1 && frame[3] === 1)
          )
            prompt();
          this.send(ws, Buffer.from(frame));
        }
      } catch (e) {
        console.error("duel protocol parse failed", (e as Error).message);
        this.send(ws, {
          type: "error",
          code: "PROTOCOL_ERROR",
          message: (e as Error).message,
        });
        ws.close(4010, "PROTOCOL_ERROR");
      }
    });
    tcp.on("error", () => ws.close(4011, "HOST_UNAVAILABLE"));
    tcp.on("close", () => ws.close(4012, "HOST_CLOSED"));
    let windowStart = Date.now(),
      count = 0;
    ws.on("message", (raw, binary) => {
      try {
        if (binary || !this.valid(t) || this.players.get(key) !== ws)
          throw new Error("FORBIDDEN");
        if (Date.now() - windowStart > 1000) {
          windowStart = Date.now();
          count = 0;
        }
        if (++count > 30) throw new Error("RATE_LIMIT");
        const a = JSON.parse(raw.toString());
        if (
          a.type !== "action" ||
          ([1, 2, 3, 4].includes(a.opcode) && a.id !== id) ||
          !Number.isInteger(a.opcode) ||
          !Array.isArray(a.data) ||
          a.data.some(
            (v: unknown) =>
              typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255,
          )
        )
          throw new Error("STALE_ACTION");
        const data = new Uint8Array(a.data);
        const lobbyDeck =
          !!standalone &&
          s.stage === "lobby" &&
          !s.ready[s.seat] &&
          !readyRequested &&
          a.opcode === 2 &&
          data.length >= 8 &&
          data.length <= 2056;
        if (!lobbyDeck && !allowedAction(s, a.opcode, data))
          throw new Error("INVALID_ACTION");
        if (standalone && a.opcode === 0x22) {
          if (!standalone.deck.main.length)
            throw Object.assign(new Error("INVALID_DECK"), {
              details: { reason: "请先选择卡组" },
            });
          this.checkedDeck(standalone.deck, roomOptions);
          readyRequested = true;
          write(
            2,
            encodeDeck(
              [...standalone.deck.main, ...standalone.deck.extra],
              standalone.deck.side,
            ),
          );
        }
        if (lobbyDeck) {
          const v = new DataView(data.buffer),
            n = v.getUint32(0, true),
            k = v.getUint32(4, true);
          if (n + k > 500 || data.length !== 8 + 4 * (n + k))
            throw Object.assign(new Error("INVALID_DECK"), {
              details: { reason: "卡组数据长度错误" },
            });
          const codes = Array.from({ length: n + k }, (_, i) =>
            v.getUint32(8 + i * 4, true),
          );
          initial = this.checkedDeck(
            { main: codes.slice(0, n), extra: [], side: codes.slice(n) },
            roomOptions,
          );
          standalone!.deck = initial;
          s.deck = {
            main: [...initial.main, ...initial.extra],
            side: initial.side,
          };
          standalone!.current = s.deck;
          this.persistStandalone(t.standalone!);
          this.send(
            ws,
            Buffer.from(packet(10, encodeDeck(s.deck.main, s.deck.side))),
          );
          this.send(ws, { type: "accepted", opcode: 2, stage: "lobby" });
          return;
        }
        if (a.opcode === 2) {
          const v = new DataView(data.buffer);
          const n = v.getUint32(0, true),
            k = v.getUint32(4, true);
          if (
            data.length !== 8 + 4 * (n + k) ||
            n !== initial.main.length + initial.extra.length ||
            k !== initial.side.length
          )
            throw Object.assign(new Error("INVALID_DECK"), {
              details: {
                reason:
                  "换备必须保持主卡组、额外卡组、副卡组数量及所有卡片总集合不变",
              },
            });
          const codes = Array.from({ length: n + k }, (_, i) =>
            v.getUint32(8 + i * 4, true),
          );
          const expected = [
            ...initial.main,
            ...initial.extra,
            ...initial.side,
          ].sort((a, b) => a - b);
          if (
            codes
              .slice()
              .sort((a, b) => a - b)
              .some((c, i) => c !== expected[i])
          )
            throw Object.assign(new Error("INVALID_DECK"), {
              details: {
                reason:
                  "换备必须保持主卡组、额外卡组、副卡组数量及所有卡片总集合不变",
              },
            });
          const main = codes.slice(0, n),
            extra = main.filter((c) => this.cards.isExtraDeck(c));
          if (extra.length !== initial.extra.length)
            throw Object.assign(new Error("INVALID_DECK"), {
              details: {
                reason:
                  "换备必须保持主卡组、额外卡组、副卡组数量及所有卡片总集合不变",
              },
            });
          s.deck = { main, side: codes.slice(n) };
          if (standalone) {
            standalone.current = s.deck;
            this.persistStandalone(t.standalone!);
          }
        }
        write(a.opcode, data);
        if ([1, 3, 4, 2].includes(a.opcode)) {
          s.prompt = null;
          s.stage = a.opcode === 2 ? "waitingSide" : s.stage;
        }
        prompt();
        this.send(ws, { type: "accepted", opcode: a.opcode });
      } catch (e) {
        this.send(ws, {
          type: "error",
          code: (e as Error).message,
          message: (e as any).details?.reason,
        });
      }
    });
  }
  private standaloneObserver(ws: WebSocket, t: Ticket) {
    const tcp = net.connect({
        host: config.webDuel.upstreamHost,
        port: config.srvpro.gamePort,
      }),
      framer = new Framer();
    this.active.set(ws, {
      t,
      close: () => {
        tcp.destroy();
      },
    });
    ws.on("message", () => ws.close(4003, "READ_ONLY"));
    tcp.on("connect", () => {
      const name = Buffer.alloc(40);
      name.write("Observer", 0, 38, "utf16le");
      const join = Buffer.alloc(48);
      join.writeUInt16LE(config.webDuel.version);
      join.write(t.room, 8, 38, "utf16le");
      tcp.write(packet(0x10, name));
      tcp.write(packet(0x12, join));
    });
    tcp.on("data", (chunk) => {
      try {
        for (const frame of framer.feed(chunk)) {
          if (frame[2] === 0x17 || frame[2] === 10) continue;
          if (frame[2] === 0x12) tcp.write(packet(0x21));
          this.send(ws, Buffer.from(frame));
        }
      } catch {
        ws.close(4010, "PROTOCOL_ERROR");
      }
    });
    tcp.on("error", () => ws.close(4011, "HOST_UNAVAILABLE"));
    tcp.on("close", () => ws.close(4012, "HOST_CLOSED"));
  }
  private params(room: string) {
    return { room_name: room, archive_dir: config.webDuel.archiveDir };
  }
  private headers() {
    return { "X-Cube-Api-Key": config.srvpro.apiKey };
  }
  private watch(ws: WebSocket, t: Ticket) {
    let group = this.watchers.get(t.room);
    if (!group) {
      group = {
        clients: new Set(),
        state: initialState(),
        abort: new AbortController(),
        done: false,
      };
      this.watchers.set(t.room, group);
      void this.watchStream(t, group);
    }
    group.clients.add(ws);
    this.active.set(ws, {
      t,
      close: () => {
        group!.clients.delete(ws);
        if (!group!.clients.size) {
          group!.abort.abort();
          if (this.watchers.get(t.room) === group) this.watchers.delete(t.room);
        }
      },
    });
    this.send(ws, { type: "snapshot", state: group.state });
    ws.on("message", () => ws.close(4003, "READ_ONLY"));
  }
  private async watchStream(
    t: Ticket,
    g: NonNullable<ReturnType<typeof this.watchers.get>>,
  ) {
    try {
      const r = await axios.get(`${config.srvpro.url}/cube/web-stream`, {
        params: this.params(t.room),
        headers: this.headers(),
        responseType: "stream",
        signal: g.abort.signal,
        timeout: 0,
      });
      let pending = "";
      for await (const chunk of r.data) {
        pending += chunk.toString();
        if (pending.length > 262144) throw new Error("STREAM_LIMIT");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (!line.frame) continue;
          const b = Buffer.from(line.frame, "base64");
          if (b[2] === 0x17 || b[2] === 10) throw new Error("PRIVATE_FRAME");
          applyFrame(g.state, new Uint8Array(b));
          g.state.prompt = null;
          g.state.lastPrompt = null;
          for (const c of g.clients) this.send(c, b);
        }
      }
      g.done = true;
      for (const c of g.clients) this.send(c, { type: "ended" });
    } catch {
      for (const c of g.clients) c.close(4011, "WATCH_UNAVAILABLE");
    } finally {
      if (this.watchers.get(t.room) === g && g.done)
        this.watchers.delete(t.room);
    }
  }
  private replayReaders = 0;
  async replay(tid: number, mid: number) {
    if (this.replayReaders >= 2) throw new Error("SESSION_LIMIT");
    this.replayReaders++;
    try {
      return await this.buildReplay(tid, mid);
    } finally {
      this.replayReaders--;
    }
  }
  private async buildReplay(tid: number, mid: number) {
    const { s, m } = this.match(tid, mid);
    if (s.status !== "finished") throw new Error("FORBIDDEN");
    const r = await axios.get(`${config.srvpro.url}/cube/web-replay`, {
      params: this.params(m.roomName!),
      headers: this.headers(),
      responseType: "text",
      maxContentLength: 128 * 1024 * 1024,
      timeout: 30000,
    });
    if (loadState(tid).status !== "finished") throw new Error("FORBIDDEN");
    const frames: any[] = [],
      snapshots: any[] = [],
      state = initialState(),
      codes = new Set<number>();
    let meta: any = { complete: false };
    let failed = false;
    for (const line of String(r.data).split("\n").filter(Boolean)) {
      const value = JSON.parse(line);
      if (value.end) {
        meta = value;
        continue;
      }
      frames.push(value);
      if (failed) continue;
      try {
        applyFrame(state, Buffer.from(value.frame, "base64"));
        for (const c of state.cards) {
          if (c.code) codes.add(c.code);
          for (const code of c.materials) if (code) codes.add(code);
        }
        if (frames.length % 100 === 0)
          snapshots.push({
            index: frames.length,
            t: value.t,
            state: JSON.parse(JSON.stringify(state)),
          });
      } catch {
        failed = true;
      }
    }
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO web_replays(tournament_id,match_id,room_name,complete,frame_count) VALUES(?,?,?,?,?)",
      )
      .run(
        tid,
        mid,
        m.roomName,
        meta.complete && !failed ? 1 : 0,
        frames.length,
      );
    const catalog = readReplayCatalog(tid, mid);
    return {
      version: 1,
      protocolVersion: meta.protocolVersion,
      resources: meta.resources,
      complete: !!meta.complete && !failed,
      frames,
      snapshots,
      cards: catalog
        ? catalog.cards.filter((c) => codes.has(c.code))
        : this.cards.getMany([...codes]),
      descriptions: catalog?.descriptions ?? {},
    };
  }
  async deleteReplay(tid: number, mid: number) {
    const { m } = this.match(tid, mid);
    if (!m.finishedAt) throw new Error("FORBIDDEN");
    getDb()
      .prepare(
        "INSERT INTO web_replay_audit(tournament_id,match_id,action,created_at) VALUES(?,?,?,?)",
      )
      .run(tid, mid, "delete_requested", new Date().toISOString());
    await axios.post(`${config.srvpro.url}/cube/web-delete`, null, {
      params: this.params(m.roomName!),
      headers: this.headers(),
      timeout: 10000,
    });
    getDb().transaction(() => {
      getDb()
        .prepare("DELETE FROM web_replays WHERE tournament_id=? AND match_id=?")
        .run(tid, mid);
      getDb()
        .prepare(
          "DELETE FROM web_replay_catalog_matches WHERE tournament_id=? AND match_id=?",
        )
        .run(tid, mid);
      getDb()
        .prepare(
          "DELETE FROM web_replay_catalogs WHERE id NOT IN (SELECT catalog_id FROM web_replay_catalog_matches)",
        )
        .run();
    })();
    return { ok: true };
  }
  descriptions(ids: number[]) {
    const values: Record<number, string> = {};
    const system = new Map<number, string>();
    if (fs.existsSync(config.server.stringsConf))
      for (const line of fs
        .readFileSync(config.server.stringsConf, "utf8")
        .split(/\r?\n/)) {
        const m = line.match(/^!system\s+(\d+)\s+(.+)$/);
        if (m) system.set(Number(m[1]), m[2]);
      }
    for (const id of ids)
      values[id] = id <= 0x7ff ? (system.get(id) ?? String(id)) : String(id);
    for (const source of cardDatabasePaths(config.server.cardsCdb)) {
      const db = new Database(source, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        for (const id of ids) {
          if (id <= 0x7ff) values[id] = system.get(id) ?? String(id);
          else {
            const row = db
              .prepare("SELECT * FROM texts WHERE id=?")
              .get(Math.floor(id / 16)) as Record<string, string> | undefined;
            if (row) values[id] = row[`str${(id % 16) + 1}`] || String(id);
          }
        }
      } finally {
        db.close();
      }
    }
    return values;
  }
  searchCards(q: string) {
    return this.cards.search(q, 100);
  }
  cardInfo(codes: number[]) {
    return this.cards.getMany(codes.slice(0, 256));
  }
  declare(q: string, ops: number[]) {
    return this.cards
      .search(q, 200)
      .filter((c) => declarable(c, ops))
      .slice(0, 50);
  }
  onModuleDestroy() {
    this.bots.close();
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.active.keys()) ws.terminate();
    for (const g of this.watchers.values()) g.abort.abort();
    this.wss?.close();
  }
}
