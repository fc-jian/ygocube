/** Wire layout follows this repository's gframe/network.h and duelclient.cpp. */
export class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  get remaining() {
    return this.bytes.length - this.offset;
  }
  take(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining)
      throw new Error("TRUNCATED_PACKET");
    const b = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  u8() {
    return this.take(1)[0];
  }
  u16() {
    const b = this.take(2);
    return b[0] | (b[1] << 8);
  }
  u32() {
    const b = this.take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  i32() {
    return this.u32() | 0;
  }
}
export function integer(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}
export function packet(opcode: number, body: Uint8Array = new Uint8Array()) {
  if (body.length > 65534) throw new Error("PACKET_TOO_LARGE");
  const b = new Uint8Array(body.length + 3);
  b[0] = (body.length + 1) & 255;
  b[1] = (body.length + 1) >>> 8;
  b[2] = opcode;
  b.set(body, 3);
  return b;
}
export class Framer {
  private pending = new Uint8Array();
  feed(chunk: Uint8Array) {
    const b = new Uint8Array(this.pending.length + chunk.length);
    b.set(this.pending);
    b.set(chunk, this.pending.length);
    const frames: Uint8Array[] = [];
    let i = 0;
    while (i + 2 <= b.length) {
      const n = b[i] | (b[i + 1] << 8);
      if (!n) throw new Error("INVALID_PACKET_LENGTH");
      if (i + n + 2 > b.length) break;
      frames.push(b.slice(i, i + n + 2));
      i += n + 2;
    }
    this.pending = b.slice(i);
    if (this.pending.length > 65537) throw new Error("PACKET_TOO_LARGE");
    return frames;
  }
}
export const LOC = {
  DECK: 1,
  HAND: 2,
  MONSTER: 4,
  SPELL: 8,
  GRAVE: 16,
  REMOVED: 32,
  EXTRA: 64,
  OVERLAY: 128,
};
const CARD_QUESTION = 38723936; // gframe/client_field.h
export interface Ref {
  player: number;
  location: number;
  sequence: number;
  sub?: number;
}
export interface Card extends Ref {
  code: number;
  position: number;
  atk?: number;
  def?: number;
  baseAtk?: number;
  baseDef?: number;
  status?: number;
  type?: number;
  level?: number;
  rank?: number;
  lscale?: number;
  rscale?: number;
  link?: number;
  markers?: number;
  counters: Record<number, number>;
  materials: number[];
  equip?: Ref;
  targets?: Ref[];
}
export interface Choice {
  index: number;
  code?: number;
  ref?: Ref;
  originRef?: Ref;
  label?: string;
  description?: number;
  value?: number;
  weight?: number;
  selected?: boolean;
  forced?: boolean;
}
export interface Prompt {
  message: number;
  kind:
    | "command"
    | "yesno"
    | "cards"
    | "chain"
    | "place"
    | "position"
    | "tribute"
    | "counter"
    | "sum"
    | "sort"
    | "unselect"
    | "mask"
    | "declare";
  player: number;
  choices: Choice[];
  min: number;
  max: number;
  cancel?: boolean;
  target?: number;
  mode?: number;
  mandatory?: Choice[];
  opcodes?: number[];
  hint?: number;
}
export interface DuelState {
  cards: Card[];
  lp: number[];
  names: string[];
  lobbyNames: string[];
  lobbySeat: number;
  seat: number;
  host: boolean;
  phase: number;
  turn: number;
  turnPlayer: number;
  rule: number;
  stage: string;
  prompt: Prompt | null;
  lastPrompt: Prompt | null;
  chain: Choice[];
  logs: string[];
  hint: number;
  disabled: number;
  time: number[];
  timePlayer: number;
  revealed: number[];
  graveLocked?: boolean[];
  handResult?: [number, number];
  winner?: number;
  winReason?: number;
  error?: string;
  deck: {
    main: number[];
    side: number[];
  };
  ready: boolean[];
}
export function initialState(): DuelState {
  return {
    cards: [],
    lp: [8000, 8000],
    names: ["玩家一", "玩家二"],
    lobbyNames: ["玩家一", "玩家二"],
    lobbySeat: 0,
    seat: 0,
    host: false,
    phase: 0,
    turn: 0,
    turnPlayer: 0,
    rule: 5,
    stage: "lobby",
    prompt: null,
    lastPrompt: null,
    chain: [],
    logs: [],
    hint: 0,
    disabled: 0,
    time: [0, 0],
    timePlayer: 2,
    deck: { main: [], side: [] },
    ready: [false, false],
    revealed: [],
    graveLocked: [false, false],
  };
}
const ref = (r: Reader, sub = true): Ref => ({
  player: r.u8(),
  location: r.u8(),
  sequence: r.u8(),
  ...(sub ? { sub: r.u8() } : {}),
});
const key = (a: Ref, b: Ref) =>
  a.player === b.player &&
  a.location === b.location &&
  a.sequence === b.sequence;
function fresh(a: Ref, code = 0, position = 0): Card {
  return { ...a, code, position, counters: {}, materials: [] };
}
function get(s: DuelState, a: Ref) {
  return s.cards.find((c) => key(c, a));
}
function ensure(s: DuelState, a: Ref) {
  let c = get(s, a);
  if (!c) {
    c = fresh(a);
    s.cards.push(c);
  }
  return c;
}
function remove(s: DuelState, a: Ref) {
  if (a.location & 128) {
    const c = get(s, { ...a, location: a.location & 127 });
    const code = c?.materials.splice(a.sub ?? 0, 1)[0] ?? 0;
    return fresh(a, code);
  }
  const c = get(s, a);
  s.cards = s.cards.filter((x) => x !== c);
  if (!(a.location & 12))
    for (const x of s.cards)
      if (
        x.player === a.player &&
        x.location === a.location &&
        x.sequence > a.sequence
      )
        x.sequence--;
  return c ?? fresh(a);
}
function add(s: DuelState, c: Card, a: Ref) {
  if (!a.location) return;
  if (a.location & 128) {
    ensure(s, { ...a, location: a.location & 127 }).materials.splice(
      a.sub ?? 0,
      0,
      c.code,
    );
    return;
  }
  if (!(a.location & 12))
    for (const x of s.cards)
      if (
        x.player === a.player &&
        x.location === a.location &&
        x.sequence >= a.sequence
      )
        x.sequence++;
  Object.assign(c, a);
  s.cards.push(c);
}
function count(s: DuelState, p: number, l: number) {
  return s.cards.filter((c) => c.player === p && c.location === l).length;
}
function fill(s: DuelState, p: number, l: number, n: number) {
  for (let i = 0; i < n; i++)
    s.cards.push(fresh({ player: p, location: l, sequence: i }));
}
function list(
  r: Reader,
  extra: "none" | "sub" | "desc" | "weight" | "counter" | "attack" = "sub",
): Choice[] {
  const n = r.u8();
  const out: Choice[] = [];
  for (let i = 0; i < n; i++) {
    const code = r.u32() & 0x7fffffff;
    const a = ref(r, extra === "sub");
    const c: Choice = { index: i, code, ref: a };
    if (extra === "desc") c.description = r.u32();
    if (extra === "weight") c.weight = r.u32();
    if (extra === "counter") c.weight = r.u16();
    if (extra === "attack") c.weight = r.u8();
    out.push(c);
  }
  return out;
}
export function decodePrompt(bytes: Uint8Array): Prompt | null {
  const r = new Reader(bytes);
  const m = r.u8();
  if (
    ![
      10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 22, 23, 24, 25, 26, 132, 140, 141,
      142, 143,
    ].includes(m)
  )
    return null;
  const mode = m === 23 ? r.u8() : undefined;
  const p: Prompt = {
    message: m,
    player: r.u8(),
    kind: "command",
    choices: [],
    min: 1,
    max: 1,
    mode,
  };
  if (m === 10 || m === 11) {
    const labels =
      m === 11
        ? [
            "summon",
            "special",
            "position",
            "setMonster",
            "setSpell",
            "activate",
          ]
        : ["activate", "attack"];
    for (let k = 0; k < labels.length; k++) {
      const cs = list(
        r,
        labels[k] === "activate"
          ? "desc"
          : labels[k] === "attack"
            ? "attack"
            : "none",
      );
      for (const c of cs) {
        c.label = labels[k];
        c.value = (c.index << 16) | k;
        p.choices.push(c);
      }
    }
    if (r.u8())
      p.choices.push({
        index: p.choices.length,
        label: m === 11 ? "battle" : "main2",
        value: m === 11 ? 6 : 2,
      });
    if (r.u8())
      p.choices.push({
        index: p.choices.length,
        label: "end",
        value: m === 11 ? 7 : 3,
      });
    if (m === 11 && r.u8())
      p.choices.push({ index: p.choices.length, label: "shuffle", value: 8 });
  } else if (m === 12 || m === 13) {
    p.kind = "yesno";
    if (m === 12) {
      const code = r.u32();
      const a = ref(r);
      p.choices = [{ index: 0, code, ref: a }];
    }
    p.hint = r.u32();
    p.choices = [
      { ...p.choices[0], index: 0, label: "yes", value: 1 },
      { index: 1, label: "no", value: 0 },
    ];
  } else if (m === 14 || m === 143) {
    const n = r.u8();
    for (let i = 0; i < n; i++) {
      const v = r.u32();
      p.choices.push({
        index: i,
        value: i,
        ...(m === 14 ? { description: v } : { label: String(v) }),
      });
    }
  } else if (m === 15 || m === 20) {
    p.kind = m === 15 ? "cards" : "tribute";
    p.cancel = !!r.u8();
    p.min = r.u8();
    p.max = r.u8();
    if (m === 15) p.choices = list(r);
    else {
      p.choices = list(r, "sub");
      for (const c of p.choices) {
        c.weight = c.ref!.sub;
        delete c.ref!.sub;
      }
    }
  } else if (m === 26) {
    p.kind = "unselect";
    p.cancel = !!r.u8();
    p.cancel = !!r.u8() || p.cancel;
    p.min = r.u8();
    p.max = r.u8();
    const a = list(r),
      b = list(r);
    p.choices = [
      ...a,
      ...b.map((c, i) => ({ ...c, index: a.length + i, selected: true })),
    ];
  } else if (m === 16) {
    p.kind = "chain";
    const n = r.u8();
    r.u8();
    r.u32();
    r.u32();
    for (let i = 0; i < n; i++) {
      r.u8();
      const forced = !!r.u8();
      const code = r.u32();
      const a = ref(r);
      p.choices.push({
        index: i,
        code,
        ref: a,
        description: r.u32(),
        value: i,
        forced,
      });
    }
    p.cancel = !p.choices.some((c) => c.forced);
  } else if (m === 18 || m === 24) {
    p.kind = "place";
    p.min = p.max = r.u8();
    const mask = r.u32();
    for (let bit = 0; bit < 32; bit++) {
      const seq = bit % 8,
        loc = bit % 16 < 8 ? 4 : 8;
      if (seq > (loc === 4 ? 6 : 7)) continue;
      if (!(mask & (1 << bit)))
        p.choices.push({
          index: bit,
          ref: {
            player: bit < 16 ? p.player : 1 - p.player,
            location: loc,
            sequence: seq,
          },
        });
    }
    p.cancel = p.min === 0;
    if (p.min === 0) p.max = 1;
  } else if (m === 19) {
    p.kind = "position";
    const code = r.u32(),
      mask = r.u8();
    for (const v of [1, 2, 4, 8])
      if (mask & v)
        p.choices.push({ index: v, value: v, code, label: `position${v}` });
  } else if (m === 22) {
    p.kind = "counter";
    p.hint = r.u16();
    p.target = r.u16();
    p.choices = list(r, "counter");
  } else if (m === 23) {
    p.kind = "sum";
    p.target = r.u32();
    p.min = r.u8();
    p.max = r.u8();
    p.mandatory = list(r, "weight");
    p.choices = list(r, "weight");
  } else if (m === 25) {
    p.kind = "sort";
    p.choices = list(r, "none");
    p.min = p.max = p.choices.length;
    p.cancel = true;
  } else if (m === 140 || m === 141) {
    p.kind = "mask";
    p.min = p.max = r.u8();
    const mask = r.u32();
    for (let i = 0; i < 32; i++)
      if (mask & (1 << i))
        p.choices.push({
          index: i,
          value: 1 << i,
          label: `${m === 140 ? "race" : "attribute"}${i}`,
        });
  } else if (m === 142) {
    p.kind = "declare";
    const n = r.u8();
    p.opcodes = [];
    for (let i = 0; i < n; i++) p.opcodes.push(r.u32());
  } else if (m === 132)
    p.choices = [1, 2, 3].map((v) => ({
      index: v,
      value: v,
      label: `hand${v}`,
    }));
  if (r.remaining) throw new Error(`PROMPT_LAYOUT_${m}`);
  return p;
}
function query(s: DuelState, a: Ref, r: Reader) {
  const n = r.u32();
  if (n < 4) throw new Error("INVALID_QUERY");
  const q = new Reader(r.take(n - 4));
  if (!q.remaining) return;
  const flags = q.u32();
  const c = ensure(s, a);
  if (flags === 0) {
    const clean = fresh(a, 0, c.position);
    Object.keys(c).forEach((k) => delete (c as any)[k]);
    Object.assign(c, clean);
    return;
  }
  const fields: Record<number, string> = {
    1: "code",
    2: "position",
    4: "alias",
    8: "type",
    16: "level",
    32: "rank",
    64: "attribute",
    128: "race",
    256: "atk",
    512: "def",
    1024: "baseAtk",
    2048: "baseDef",
    4096: "reason",
    8192: "reasonCard",
    262144: "owner",
    524288: "status",
    2097152: "lscale",
    4194304: "rscale",
  };
  for (let b = 1; b <= 8388608; b *= 2)
    if (flags & b) {
      if (fields[b]) {
        const v = q.i32();
        if (b === 1 && v === 0) {
          const clean = fresh(a, 0, c.position);
          Object.keys(c).forEach((k) => delete (c as any)[k]);
          Object.assign(c, clean);
        }
        (c as any)[fields[b]] = b === 2 ? v >>> 24 : v;
      } else if (b === 16384) c.equip = ref(q);
      else if (b === 32768) {
        c.targets = [];
        const len = q.u32();
        for (let i = 0; i < len; i++) c.targets.push(ref(q));
      } else if (b === 65536) {
        c.materials = [];
        const len = q.u32();
        for (let i = 0; i < len; i++) c.materials.push(q.u32());
      } else if (b === 131072) {
        c.counters = {};
        const len = q.u32();
        for (let i = 0; i < len; i++) c.counters[q.u16()] = q.u16();
      } else if (b === 1048576) {
        /* Reserved query flag: this core emits no payload. */
      } else if (b === 8388608) {
        c.link = q.u32();
        c.markers = q.u32();
      } else throw new Error("UNSUPPORTED_QUERY");
    }
  if (q.remaining) throw new Error("QUERY_LAYOUT");
}
export function applyGame(s: DuelState, bytes: Uint8Array) {
  const r = new Reader(bytes),
    m = r.u8();
  const p = decodePrompt(bytes);
  if (p) {
    s.error = undefined;
    p.hint = p.hint ?? ([15, 16, 19, 20, 22, 23, 26].includes(m) ? s.hint : 0);
    s.hint = 0;
    s.prompt = p;
    s.lastPrompt = p;
    return;
  }
  if (m === 1) {
    s.prompt = s.lastPrompt;
    s.error = "RETRY";
    return;
  }
  if (m === 2) {
    const kind = r.u8();
    r.u8();
    const data = r.u32();
    if (kind === 3) s.hint = data;
    s.logs.push(`hint:${kind}:${data}`);
  } else if (m === 3) {
    s.prompt = null;
  } else if (m === 4) {
    s.cards = [];
    s.chain = [];
    s.turn = 0;
    s.logs = [];
    s.revealed = [];
    s.winner = undefined;
    s.graveLocked = [false, false];
    s.winReason = undefined;
    s.stage = "dueling";
    s.prompt = null;
    const type = r.u8();
    const swapped = type & 16 ? !!(type & 1) : s.lobbySeat !== (type & 1);
    s.names = swapped ? [...s.lobbyNames].reverse() : [...s.lobbyNames];
    if (!(type & 16)) s.seat = type & 1;
    s.rule = r.u8();
    s.lp = [r.u32(), r.u32()];
    for (let i = 0; i < 2; i++) {
      fill(s, i, 1, r.u16());
      fill(s, i, 64, r.u16());
    }
  } else if (m === 5) {
    s.winner = r.u8();
    s.winReason = r.u8();
    s.timePlayer = 2;
    s.prompt = null;
    s.logs.push(`win:${s.winner}`);
  } else if (m === 6) {
    const a: Ref = { player: r.u8(), location: r.u8(), sequence: 0 };
    while (r.remaining) {
      query(s, a, r);
      a.sequence++;
    }
  } else if (m === 7) {
    const a = ref(r, false);
    query(s, a, r);
  } else if (m === 30 || m === 31 || m === 42) {
    const player = r.u8();
    if (m === 31) r.u8(); // skip_panel is present only in CONFIRM_CARDS.
    const n = r.u8();
    s.revealed = [];
    for (let i = 0; i < n; i++) {
      const code = r.u32(),
        a = ref(r, false);
      if (code) { s.revealed.push(code & 0x7fffffff); s.logs.push(`reveal:${code & 0x7fffffff}:${player}`); }
      const target =
        m === 31
          ? a
          : {
              player,
              location: m === 30 ? 1 : 64,
              sequence:
                count(s, player, m === 30 ? 1 : 64) -
                1 -
                i -
                (m === 42
                  ? s.cards.filter(
                      (c) =>
                        c.player === player &&
                        c.location === 64 &&
                        c.position & 5,
                    ).length
                  : 0),
            };
      ensure(s, target).code = code & 0x7fffffff;
    }
  } else if (m === 32) {
    const player = r.u8();
    for (const c of s.cards)
      if (c.player === player && c.location === 1) {
        c.code = 0;
        c.materials = [];
      }
  } else if (m === 33 || m === 39) {
    const player = r.u8(),
      n = r.u8(),
      l = m === 33 ? 2 : 64;
    for (let i = 0; i < n; i++)
      ensure(s, { player, location: l, sequence: i }).code =
        r.u32() & 0x7fffffff;
  } else if (m === 34) {
    r.u8();
  } else if (m === 37) {
    /* Visibility remains determined by host queries. */
  } else if (m === 35) {
    const player = r.u8();
    const grave = s.cards
      .filter((c) => c.player === player && c.location === 16)
      .sort((a, b) => a.sequence - b.sequence);
    for (const c of s.cards)
      if (c.player === player && c.location === 1) c.location = 16;
    let sequence = 0;
    for (const c of grave) {
      c.code = 0;
      if ((c.type ?? 0) & (0x40 | 0x2000 | 0x800000 | 0x4000000)) {
        const extraSequence = s.cards.filter(
          (x) => x.player === player && x.location === 64 && !(x.position & 5),
        ).length;
        for (const x of s.cards)
          if (
            x.player === player &&
            x.location === 64 &&
            x.sequence >= extraSequence
          )
            x.sequence++;
        c.location = 64;
        c.position = 2;
        c.sequence = extraSequence;
      } else {
        c.location = 1;
        c.sequence = sequence++;
      }
    }
  } else if (m === 36) {
    r.u8();
    const n = r.u8(),
      old: Ref[] = [];
    for (let i = 0; i < n; i++) old.push(ref(r));
    const next: Ref[] = [];
    for (let i = 0; i < n; i++) next.push(ref(r));
    const cs = old.map((a) => ensure(s, a));
    for (const c of cs) c.code = 0;
    cs.forEach((c, i) => {
      if (!next[i].location) return;
      const target = get(s, next[i]);
      const previous = {
        player: c.player,
        location: c.location,
        sequence: c.sequence,
      };
      Object.assign(c, {
        player: next[i].player,
        location: next[i].location,
        sequence: next[i].sequence,
      });
      if (target && target !== c) Object.assign(target, previous);
    });
  } else if (m === 38) {
    const player = r.u8(),
      seq = r.u8(),
      code = r.u32();
    ensure(s, {
      player,
      location: 1,
      sequence: count(s, player, 1) - 1 - seq,
    }).code = code & 0x7fffffff;
  } else if (m === 40) {
    s.turnPlayer = r.u8();
    s.turn++;
    s.prompt = null;
    s.logs.push(`turn:${s.turn}:${s.turnPlayer}`);
  } else if (m === 41) {
    s.phase = r.u16();
    s.prompt = null;
    s.logs.push(`phase:${s.phase}`);
  } else if (m === 50) {
    const code = r.u32();
    const from = ref(r),
      to = ref(r);
    r.u32();
    let c = remove(s, from);
    if (!code) c = fresh(from);
    c.code = code & 0x7fffffff;
    c.position = to.sub ?? 0;
    c.equip = undefined;
    c.targets = [];
    add(s, c, to);
    s.logs.push(`move:${c.code}:${from.location}:${to.location}`);
  } else if (m === 53) {
    const code = r.u32(),
      a = ref(r, false);
    r.u8();
    const pos = r.u8();
    Object.assign(ensure(s, a), { code, position: pos });
  } else if (m === 54) {
    const code = r.u32(),
      a = ref(r);
    Object.assign(ensure(s, a), { code, position: a.sub });
  } else if (m === 55) {
    const c1 = r.u32(),
      a = ref(r),
      c2 = r.u32(),
      b = ref(r);
    const x = get(s, a),
      y = get(s, b);
    if (x) Object.assign(x, b, { code: c1, position: b.sub });
    if (y) Object.assign(y, a, { code: c2, position: a.sub });
  } else if (m === 56) s.disabled = r.u32();
  else if ([60, 62, 64].includes(m)) {
    const code = r.u32(),
      a = ref(r);
    Object.assign(ensure(s, a), { code, position: a.sub });
    s.logs.push(`summon:${code}`);
  } else if (m === 70) {
    const code = r.u32() & 0x7fffffff,
      a = ref(r);
    const originRef = ref(r, false);
    const description = r.u32();
    const index = r.u8();
    const source = s.cards.find((card) => key(card, a));
    if (source) source.code = code;
    s.chain.push({ code, ref: a, originRef, description, index });
    s.logs.push(`activate:${code}:${a.player}:${index}:${a.location}`);
  } else if ([71, 72, 73, 75, 76].includes(m)) {
    const index = r.u8();
    s.logs.push(`chain:${m}:${index}:${s.chain.find(c => c.index === index)?.code ?? 0}`);
  } else if (m === 74) s.chain = [];
  else if (m === 90) {
    const player = r.u8(),
      n = r.u8();
    for (let i = 0; i < n; i++) {
      const code = r.u32() & 0x7fffffff;
      const c = remove(s, {
        player,
        location: 1,
        sequence: Math.max(0, count(s, player, 1) - 1),
      });
      c.code = code;
      add(s, c, { player, location: 2, sequence: count(s, player, 2) });
    }
    s.logs.push(`draw:${player}:${n}:${(n ? s.cards.filter(c => c.player === player && c.location === 2).slice(-n) : []).map(c => c.code).join(",")}`);
  } else if ([91, 92, 94, 100].includes(m)) {
    const player = r.u8(),
      n = r.u32();
    if (player > 1) throw new Error("INVALID_PLAYER");
    s.lp[player] =
      m === 94 ? n : Math.max(0, s.lp[player] + (m === 92 ? n : -n));
  } else if ([93, 96, 97].includes(m)) {
    const a = ref(r),
      b = ref(r),
      c = ensure(s, a);
    if (m === 93) c.equip = b;
    else if (m === 96) c.targets = [...(c.targets ?? []), b];
    else c.targets = c.targets?.filter((t) => !key(t, b));
  } else if (m === 95) {
    ensure(s, ref(r)).equip = undefined;
  } else if (m === 101 || m === 102) {
    const type = r.u16(),
      a = ref(r, false),
      n = r.u16(),
      c = ensure(s, a);
    c.counters[type] = Math.max(
      0,
      (c.counters[type] ?? 0) + (m === 101 ? n : -n),
    );
  } else if (m === 162) {
    s.cards = [];
    s.chain = [];
    s.prompt = null;
    s.graveLocked = [false, false];
    s.rule = r.u8();
    for (let player = 0; player < 2; player++) {
      s.lp[player] = r.u32();
      for (let seq = 0; seq < 7; seq++)
        if (r.u8()) {
          const pos = r.u8(),
            n = r.u8(),
            c = fresh({ player, location: 4, sequence: seq }, 0, pos);
          c.materials = Array(n).fill(0);
          s.cards.push(c);
        }
      for (let seq = 0; seq < 8; seq++)
        if (r.u8())
          s.cards.push(
            fresh({ player, location: 8, sequence: seq }, 0, r.u8()),
          );
      for (const l of [1, 2, 16, 32, 64]) fill(s, player, l, r.u8());
      r.u8();
    }
    const n = r.u8();
    for (let i = 0; i < n; i++) {
      const code = r.u32(),
        a = ref(r);
      ref(r, false);
      s.chain.push({ index: i, code, ref: a, description: r.u32() });
    }
    s.stage = "dueling";
  } else if (m === 110) {
    const attackerRef = ref(r), targetRef = ref(r);
    const attacker = get(s, attackerRef),
      target = targetRef.location ? get(s, targetRef) : undefined;
    const visible = (c: Card | undefined) => c && (c.player === s.seat || !!(c.position & 5)) ? c.code : 0;
    s.logs.push(`attack:${visible(attacker)}:${visible(target)}:${targetRef.location === 0 ? 1 : 0}`);
  } else if (m === 111) {
    const attackerRef = ref(r),
      attackerAtk = r.i32(),
      attackerDef = r.i32();
    r.u8(); // Battle result flag; movement is handled by its own message.
    const targetRef = ref(r),
      targetAtk = r.i32(),
      targetDef = r.i32();
    r.u8();
    if (r.remaining) throw new Error("MESSAGE_LAYOUT_111");
    // Battle refs do not reveal card identity or change battle position.
    const attacker = attackerRef.location ? get(s, attackerRef) : undefined,
      target = targetRef.location ? get(s, targetRef) : undefined;
    if (attacker) Object.assign(attacker, { atk: attackerAtk, def: attackerDef });
    if (target) Object.assign(target, { atk: targetAtk, def: targetDef });
    s.logs.push(`event:${m}:${Array.from(bytes.subarray(1)).join(",")}`);
  } else if (m === 165) {
    const player = r.u8(), hintType = r.u8(), value = r.u32();
    if (player > 1) throw new Error("INVALID_PLAYER");
    if (r.remaining) throw new Error("MESSAGE_LAYOUT_165");
    if (value === CARD_QUESTION && (hintType === 6 || hintType === 7)) {
      // Index the affected viewer, not the owner of either graveyard.
      s.graveLocked = [...(s.graveLocked ?? [false, false])];
      s.graveLocked[player] = hintType === 6;
    }
    s.logs.push(`event:${m}:${Array.from(bytes.subarray(1)).join(",")}`);
  } else if (
    [
      61, 63, 65, 80, 81, 83, 112, 113, 114, 120, 130, 131, 133, 160,
      163, 164, 170,
    ].includes(m)
  ) {
    s.logs.push(`event:${m}:${Array.from(r.take(r.remaining)).join(",")}`);
  } else throw new Error(`UNSUPPORTED_MESSAGE_${m}`);
  if (r.remaining) throw new Error(`MESSAGE_LAYOUT_${m}`);
  s.logs = s.logs.slice(-2000);
}
export function applyFrame(s: DuelState, frame: Uint8Array) {
  const r = new Reader(frame);
  if (r.u16() !== frame.length - 2) throw new Error("INVALID_FRAME");
  const op = r.u8();
  if (op === 1) applyGame(s, r.take(r.remaining));
  else if (op === 2) {
    r.u8();
    r.take(3);
    s.error = `HOST_ERROR_${r.u32()}`;
  } else if (op === 3 || op === 4) {
    s.stage = op === 3 ? "hand" : "turn";
    s.prompt = null;
  } else if (op === 5) {
    s.handResult = [r.u8(), r.u8()];
    s.stage = "waitingTurn";
  } else if (op === 7) {
    s.stage = "siding";
    s.prompt = null;
  } else if (op === 8) {
    s.stage = "waitingSide";
    s.prompt = null;
  } else if (op === 10) {
    const a = r.u32(),
      b = r.u32();
    if (a + b > 512) throw new Error("INVALID_DECK");
    s.deck = { main: [], side: [] };
    for (let i = 0; i < a; i++) s.deck.main.push(r.u32());
    for (let i = 0; i < b; i++) s.deck.side.push(r.u32());
  } else if (op === 0x12) {
    s.stage = "lobby";
  } else if (op === 0x13) {
    const type = r.u8();
    s.seat = type & 15;
    s.lobbySeat = type & 15;
    s.host = !!(type & 16);
  } else if (op === 0x15) s.stage = "starting";
  else if (op === 0x16) {
    s.stage = "ended";
    s.prompt = null;
  } else if (op === 0x18) {
    s.timePlayer = r.u8();
    r.u8();
    s.time[s.timePlayer] = r.u16();
  } else if (op === 0x20) {
    const name = new TextDecoder("utf-16le")
      .decode(r.take(40))
      .replace(/\0.*$/s, "");
    const pos = r.u8();
    if (pos < 2) {
      s.names[pos] = name;
      s.lobbyNames[pos] = name;
    }
  } else if (op === 0x21) {
    const status = r.u8(),
      pos = status >>> 4;
    if (pos < 2) {
      if ((status & 15) === 9) s.ready[pos] = true;
      else if ((status & 15) === 10) s.ready[pos] = false;
    }
  } else if (op === 0x19) {
    r.u16();
    s.logs.push(
      new TextDecoder("utf-16le")
        .decode(r.take(r.remaining))
        .replace(/\0.*$/s, ""),
    );
    s.logs = s.logs.slice(-2000);
  }
}
export function encodeDeck(main: number[], side: number[]) {
  const b = new Uint8Array(8 + 4 * (main.length + side.length)),
    v = new DataView(b.buffer);
  v.setUint32(0, main.length, true);
  v.setUint32(4, side.length, true);
  [...main, ...side].forEach((c, i) => v.setUint32(8 + i * 4, c, true));
  return b;
}
export function selectionValid(
  p: Prompt,
  indices: number[],
  amounts: number[] = [],
) {
  if (new Set(indices).size !== indices.length) return false;
  const cs = indices.map((i) => p.choices.find((c) => c.index === i));
  if (cs.some((c) => !c)) return false;
  if (p.kind === "counter")
    return (
      amounts.length === p.choices.length &&
      amounts.every(
        (v, i) =>
          Number.isInteger(v) && v >= 0 && v <= (p.choices[i].weight ?? 0),
      ) &&
      amounts.reduce((a, b) => a + b, 0) === p.target
    );
  if (p.kind === "tribute")
    return (
      indices.length <= p.max &&
      cs.reduce((a, c) => a + (c!.weight ?? 1), 0) >= p.min
    );
  if (p.kind === "sum") {
    if (p.mode === 0 && (indices.length < p.min || indices.length > p.max))
      return false;
    const all = [...(p.mandatory ?? []), ...(cs as Choice[])];
    let sums = new Set([0]);
    for (const c of all) {
      const a = (c.weight ?? 0) & 65535,
        b = (c.weight ?? 0) >>> 16;
      const next = new Set<number>();
      for (const sum of sums) {
        next.add(sum + a);
        if (b) next.add(sum + b);
      }
      sums = next;
      if (sums.size > 65536) return false;
    }
    if (p.mode === 0) return sums.has(p.target!);
    // Minimal overpayment: no selected card may be removed while still meeting the sum.
    const lows = all.map((c) =>
      Math.min((c.weight ?? 0) & 65535, (c.weight ?? 0) >>> 16 || Infinity),
    );
    const sum = lows.reduce((a, b) => a + b, 0),
      mx = all.reduce(
        (n, c) => n + Math.max((c.weight ?? 0) & 65535, (c.weight ?? 0) >>> 16),
        0,
      );
    return mx >= p.target! && sum - Math.min(...lows) < p.target!;
  }
  return indices.length >= p.min && indices.length <= p.max;
}
export function encodeSelection(
  p: Prompt,
  indices: number[],
  amounts: number[] = [],
): Uint8Array {
  if (!selectionValid(p, indices, amounts))
    throw new Error("INVALID_SELECTION");
  if (p.kind === "counter") {
    const b = new Uint8Array(amounts.length * 2);
    amounts.forEach((v, i) => new DataView(b.buffer).setUint16(i * 2, v, true));
    return b;
  }
  if (p.kind === "place")
    return new Uint8Array(
      indices.flatMap((i) => {
        const a = p.choices.find((c) => c.index === i)!.ref!;
        return [a.player, a.location, a.sequence];
      }),
    );
  if (p.kind === "mask")
    return integer(
      indices.reduce(
        (v, i) => v | p.choices.find((c) => c.index === i)!.value!,
        0,
      ),
    );
  if (p.kind === "sort")
    return new Uint8Array(p.choices.map((c) => indices.indexOf(c.index)));
  if (p.kind === "sum")
    return new Uint8Array([
      indices.length + (p.mandatory?.length ?? 0),
      ...Array(p.mandatory?.length ?? 0).fill(0),
      ...indices,
    ]);
  return new Uint8Array([indices.length, ...indices]);
}
export interface DeclareCard {
  code: number;
  type: number;
  race: number;
  attribute: number;
  alias: number;
  setCodes: number[];
}
export function declarable(card: DeclareCard, ops: number[]) {
  if (card.type & 0x4000 || card.alias) return false;
  const stack: number[] = [];
  const pop = () => {
    if (!stack.length) throw new Error("BAD_OPCODE");
    return stack.pop()!;
  };
  try {
    for (const op of ops) {
      if (op >= 0x40000000 && op <= 0x40000005) {
        const b = pop(),
          a = pop();
        stack.push(
          op === 0x40000000
            ? a + b
            : op === 0x40000001
              ? a - b
              : op === 0x40000002
                ? a * b
                : op === 0x40000003
                  ? b
                    ? Math.trunc(a / b)
                    : 0
                  : op === 0x40000004
                    ? +(!!a && !!b)
                    : +(!!a || !!b),
        );
      } else if (op === 0x40000006) stack.push(-pop());
      else if (op === 0x40000007) stack.push(+!pop());
      else if (op >= 0x40000100 && op <= 0x40000104) {
        const v = pop();
        stack.push(
          +(op === 0x40000100
            ? card.code === v
            : op === 0x40000101
              ? card.setCodes.some(
                  (s) =>
                    (s & 0xfff) === (v & 0xfff) &&
                    (s & v & 0xf000) === (v & 0xf000),
                )
              : op === 0x40000102
                ? card.type & v
                : op === 0x40000103
                  ? card.race & v
                  : card.attribute & v),
        );
      } else stack.push(op);
    }
    return stack.length === 1 && !!stack[0];
  } catch {
    return false;
  }
}
