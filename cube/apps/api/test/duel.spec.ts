import { Tickets, allowedAction } from "../src/duel/duel.service";
import { initialState, decodePrompt } from "@ygocube/duel-protocol";
import { useTestDb, makeTournaments, TEST_POOL } from "./helpers";
import { DuelService } from "../src/duel/duel.service";
import { CardsService } from "../src/cards/cards.service";
import { config } from "../src/config";
describe("web duel session boundaries", () => {
  it("consumes tickets only once and expires them", () => {
    const ts = new Tickets(),
      input = {
        tid: 1,
        mid: 1,
        pid: "a",
        role: "player" as const,
        room: "CUBE-test",
      };
    const a = ts.issue(input);
    expect(ts.take(a.ticket)?.pid).toBe("a");
    expect(ts.take(a.ticket)).toBeNull();
    jest.spyOn(Date, "now").mockReturnValue(0);
    const b = ts.issue(input);
    jest.spyOn(Date, "now").mockReturnValue(31000);
    expect(ts.take(b.ticket)).toBeNull();
    jest.restoreAllMocks();
  });
  it("restricts wire operations to host-issued stages", () => {
    const s = initialState();
    expect(allowedAction(s, 0x12, new Uint8Array())).toBe(false);
    expect(allowedAction(s, 0x22, new Uint8Array())).toBe(true);
    expect(allowedAction(s, 0x25, new Uint8Array())).toBe(false);
    s.host = true;
    s.ready = [true, true];
    expect(allowedAction(s, 0x25, new Uint8Array())).toBe(true);
    expect(allowedAction(s, 1, new Uint8Array([0]))).toBe(false);
    s.stage = "dueling";
    s.prompt = decodePrompt(new Uint8Array([132, 0]));
    expect(allowedAction(s, 1, new Uint8Array([1, 0, 0, 0]))).toBe(true);
    expect(allowedAction(s, 1, new Uint8Array(257))).toBe(false);
  });
  it("keeps player sessions disabled by default", () => {
    useTestDb();
    const svc = new DuelService(new CardsService());
    const before = config.webDuel.enabled;
    config.webDuel.enabled = false;
    expect(() => svc.session(1, 1, "p")).toThrow("DUEL_DISABLED");
    config.webDuel.enabled = before;
  });
  it("creates replay index and append-only cleanup audit tables", () => {
    useTestDb();
    const { getDb } = require("../src/db");
    expect(
      getDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('web_replays','web_replay_audit')",
        )
        .all(),
    ).toHaveLength(2);
  });
});

describe("duel authorization and replay release", () => {
  afterEach(() => jest.restoreAllMocks());
  it("rejects another seat and revoked tokens while allowing anonymous read-only sessions", () => {
    useTestDb();
    const tournaments = makeTournaments();
    const tid = tournaments.create(
      { name: "duel", maxPlayers: 2, cardPool: TEST_POOL },
      "test",
    ).tid;
    tournaments.join(tid, "alice", "Alice");
    tournaments.join(tid, "bob", "Bob");
    const events = require("../src/events/events.service");
    const original = events.loadState(tid);
    const state = {
      ...original,
      status: "matches",
      frozen: null,
      matches: [
        {
          id: 1,
          playerA: "alice",
          playerB: "bob",
          roomName: "CUBE-test",
          finishedAt: null,
          faultedAt: null,
        },
      ],
    };
    jest.spyOn(events, "loadState").mockReturnValue(state);
    const before = config.webDuel.enabled;
    config.webDuel.enabled = true;
    try {
      const svc = new DuelService(new CardsService());
      expect(() => svc.session(tid, 1, "outsider")).toThrow("FORBIDDEN");
      expect(svc.session(tid, 1).ticket).toBeTruthy();
      expect(
        svc.valid({
          tid,
          mid: 1,
          pid: "alice",
          room: "CUBE-test",
          role: "player",
          expiresAt: 0,
          authHash: "revoked",
        }),
      ).toBe(false);
      state.frozen = {} as any;
      expect(() => svc.session(tid, 1, "alice")).toThrow("FORBIDDEN");
    } finally {
      config.webDuel.enabled = before;
    }
  });
  it("does not read private recorder storage before tournament completion", async () => {
    const events = require("../src/events/events.service");
    jest.spyOn(events, "loadState").mockReturnValue({
      status: "matches",
      matches: [{ id: 1, roomName: "CUBE-test" }],
    });
    const svc = new DuelService(new CardsService());
    await expect(svc.replay(1, 1)).rejects.toThrow("FORBIDDEN");
  });
});

describe("standalone room options", () => {
  const {
    standaloneDefaults,
    standaloneOptions,
    toHost,
    fromHost,
  } = require("../src/duel/standalone");
  it("round-trips host options without rule-token time conversions", () => {
    const options = standaloneOptions({
      ...standaloneDefaults,
      timeLimit: 30,
      extraMax: 30,
      sideMax: 30,
      lflist: 2,
    });
    expect(fromHost(toHost(options))).toEqual(options);
    expect(toHost(options).time_limit).toBe(30);
    expect(toHost(options).cube_mode).toBeUndefined();
  });
  it("accepts native default rooms without an explicit deck size extension", () => {
    const host = toHost(standaloneDefaults);
    delete host.deck_size;
    expect(fromHost(host)).toMatchObject({mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15});
  });
  it("rejects invalid modes, impossible deck ranges and oversized buffers", () => {
    for (const bad of [
      { mode: 2 },
      { timeLimit: -1 },
      { sideMax: 251 },
      { mainMin: 61, mainMax: 60 },
      { noCheck: "true" },
      { mainMax: 200, extraMax: 200, sideMax: 200 },
    ])
      expect(() => standaloneOptions(bad)).toThrow("BAD_PAYLOAD");
  });
  it("does not grant a standalone session without a valid credential", () => {
    const svc = new DuelService(new CardsService());
    expect(() => svc.standaloneSession("missing")).toThrow("AUTH_REQUIRED");
  });
});

describe('standalone room identity',()=>{
  it('keeps password and room URL equivalent and persists reconnect identity',async()=>{
    useTestDb();const axios=require('axios').default;
    const {standaloneDefaults,toHost}=require('../src/duel/standalone');
    const cards=new CardsService(),main=cards.poolCodes().filter(c=>!cards.isExtraDeck(c)).slice(0,40);
    const enabled=config.webDuel.enabled;config.webDuel.enabled=true;
    jest.spyOn(axios,'get').mockImplementation(async(url:any)=>({data:url.endsWith('options')?{lists:[{id:-1,name:'Unlimited'}]}:{hostinfo:toHost(standaloneDefaults),players:[],finished:false}}));
    jest.spyOn(axios,'post').mockResolvedValue({data:{hostinfo:toHost(standaloneDefaults)}});
    try{
      const svc=new DuelService(cards),a=await svc.standaloneJoin({name:'Alice',password:'private-room',options:standaloneDefaults,deck:{main,extra:[],side:[]}});
      expect(a.url).toBe(`/duel/room/${a.room}`);
      expect((await svc.resolveRoom({password:'private-room'})).room).toBe(a.room);
      await expect(svc.standaloneJoin({name:'Alice',room:a.room,deck:{main,extra:[],side:[]}})).rejects.toThrow('PLAYER_ID_EXISTS');
      const restarted=new DuelService(cards),resumed=await restarted.standaloneJoin({room:a.room,name:'Alice',reconnect:true});
      expect(resumed.credential).toBe(a.credential);
      expect(restarted.standaloneSession(a.credential).ticket).toBeTruthy();
      await expect(svc.roomInfo('../cube')).rejects.toThrow('BAD_PAYLOAD');
      const info=await svc.roomInfo(a.room);expect(info).not.toHaveProperty('credential');expect(info).not.toHaveProperty('deck');
    }finally{config.webDuel.enabled=enabled;jest.restoreAllMocks()}
  });
});
