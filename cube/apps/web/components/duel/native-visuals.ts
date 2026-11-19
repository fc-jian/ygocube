import type { Card, DuelState, Ref } from "@ygocube/duel-protocol";

export type NativeVisual =
  | {
      kind: "move";
      from: Ref;
      to: Ref;
      code: number;
      position: number;
      delay: number;
    }
  | { kind: "summon" | "target"; ref: Ref; label: string }
  | { kind: "attack"; from: Ref; to: Ref }
  | { kind: "life"; player: number; amount: number; label: string }
  | { kind: "banner"; label: string; player: number };

export const phaseNames: Record<number, string> = {
  1: "抽卡阶段",
  2: "准备阶段",
  4: "主要阶段一",
  8: "战斗阶段",
  16: "战斗步骤",
  32: "伤害步骤",
  64: "伤害计算",
  128: "战斗结束",
  256: "主要阶段二",
  512: "结束阶段",
};

// Presentation only: called after applyFrame validated and applied the packet.
// Never recover artwork from metadata or from a previously known hidden card.
export function nativeVisuals(
  state: DuelState,
  frame: Uint8Array,
  previousLP: number[],
): NativeVisual[] {
  if (frame[2] !== 1 || frame.length < 4) return [];
  const m = frame[3];
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const ref = (offset: number): Ref => ({
    player: frame[offset],
    location: frame[offset + 1],
    sequence: frame[offset + 2],
    sub: frame[offset + 3],
  });
  const visible = (code: number, to: Ref) => {
    const location = to.location & 127;
    if (location === 1 || !location) return 0;
    const own = state.seat < 2 && to.player === state.seat;
    if (
      !own &&
      (location === 2 || ([4, 8, 32, 64].includes(location) && !(to.sub! & 5)))
    )
      return 0;
    return code & 0x7fffffff;
  };
  if (m === 50 && frame.length >= 20) {
    const from = ref(8),
      to = ref(12);
    if (!from.location || !to.location) return [];
    return [
      {
        kind: "move",
        from,
        to,
        code: visible(u32(4), to),
        position: to.sub ?? 0,
        delay: 0,
      },
    ];
  }
  if (m === 90 && frame.length >= 6 + frame[5] * 4) {
    const player = frame[4],
      count = frame[5];
    const hand = state.cards.filter(
      (c) => c.player === player && c.location === 2,
    );
    return Array.from({ length: Math.min(count, 10) }, (_, i) => ({
      kind: "move" as const,
      from: { player, location: 1, sequence: 0 },
      to: { player, location: 2, sequence: hand.length - count + i },
      code: player === state.seat ? u32(6 + i * 4) & 0x7fffffff : 0,
      position: 1,
      delay: i * 75,
    }));
  }
  if ([60, 62, 64].includes(m) && frame.length >= 12)
    return [
      {
        kind: "summon",
        ref: ref(8),
        label: m === 62 ? "特殊召唤" : m === 64 ? "反转召唤" : "通常召唤",
      },
    ];
  if (m === 83 && frame.length >= 5 + frame[4] * 4)
    return Array.from({ length: frame[4] }, (_, i) => ({
      kind: "target",
      ref: ref(5 + i * 4),
      label: "效果对象",
    }));
  if (m === 110 && frame.length >= 12) {
    const from = ref(4),
      to = ref(8);
    // Direct attacks have a zero location; the defending player follows the attacker.
    if (!to.location) to.player = 1 - from.player;
    return [{ kind: "attack", from, to }];
  }
  if ([91, 92, 94, 100].includes(m) && frame.length >= 9) {
    const player = frame[4];
    const amount =
      m === 94
        ? state.lp[player] - previousLP[player]
        : u32(5) * (m === 92 ? 1 : -1);
    if (!amount) return [];
    return [
      {
        kind: "life",
        player,
        amount,
        label:
          m === 100
            ? "支付"
            : m === 92
              ? "回复"
              : m === 94
                ? "生命值变化"
                : "伤害",
      },
    ];
  }
  if (m === 40)
    return [
      {
        kind: "banner",
        label: `第 ${state.turn} 回合`,
        player: state.turnPlayer,
      },
    ];
  if (m === 41 && phaseNames[state.phase])
    return [
      {
        kind: "banner",
        label: phaseNames[state.phase],
        player: state.turnPlayer,
      },
    ];
  return [];
}

export function monsterStatus(
  card: Card,
  printed?: { type: number; atk: number; def: number; level: number },
) {
  const type = card.type ?? printed?.type ?? 0;
  const atk = card.atk ?? printed?.atk,
    def = card.def ?? printed?.def;
  const stat = (value: number | undefined) =>
    value === undefined || value < 0 ? "?" : String(value);
  const tone = (value: number | undefined, base: number | undefined) =>
    value === undefined ||
    base === undefined ||
    value < 0 ||
    base < 0 ||
    value === base
      ? ""
      : value > base
        ? "raised"
        : "lowered";
  const link = !!(type & 0x4000000),
    xyz = !!(type & 0x800000);
  return {
    atk: stat(atk),
    def: link ? `L${card.link ?? printed?.level ?? "?"}` : stat(def),
    atkTone: tone(atk, card.baseAtk ?? printed?.atk),
    defTone: link ? "link" : tone(def, card.baseDef ?? printed?.def),
    badge: link
      ? ""
      : `${xyz ? "阶" : "★"}${(xyz ? card.rank : card.level) ?? printed?.level ?? "?"}`,
  };
}
