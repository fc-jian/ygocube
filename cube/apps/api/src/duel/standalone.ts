import { StandaloneDuelOptions } from "@ygocube/shared";
export const standaloneDefaults: StandaloneDuelOptions = {
  mode: 1,
  lflist: -1,
  rule: 5,
  duelRule: 5,
  timeLimit: 180,
  startLp: 8000,
  startHand: 5,
  drawCount: 1,
  mainMin: 40,
  mainMax: 60,
  extraMax: 15,
  sideMax: 15,
  noCheck: false,
  noShuffle: false,
};
export function standaloneOptions(raw: unknown): StandaloneDuelOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("BAD_PAYLOAD");
  const v = { ...standaloneDefaults, ...raw } as StandaloneDuelOptions;
  const limits: Record<string, number[]> = {
    mode: [0, 1],
    lflist: [-1, 1000],
    rule: [0, 5],
    duelRule: [1, 5],
    timeLimit: [0, 999],
    startLp: [1, 99999],
    startHand: [1, 40],
    drawCount: [0, 35],
    mainMin: [1, 200],
    mainMax: [1, 200],
    extraMax: [0, 200],
    sideMax: [0, 200],
  };
  for (const [k, [min, max]] of Object.entries(limits)) {
    const n = (v as any)[k];
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error("BAD_PAYLOAD");
  }
  if (
    v.mainMin > v.mainMax ||
    v.mainMax + v.extraMax + v.sideMax > 500 ||
    typeof v.noCheck !== "boolean" ||
    typeof v.noShuffle !== "boolean"
  )
    throw new Error("BAD_PAYLOAD");
  return v;
}
export function toHost(v: StandaloneDuelOptions) {
  return {
    mode: v.mode,
    lflist: v.lflist,
    rule: v.rule,
    duel_rule: v.duelRule,
    time_limit: v.timeLimit,
    start_lp: v.startLp,
    start_hand: v.startHand,
    draw_count: v.drawCount,
    no_check_deck: v.noCheck,
    no_shuffle_deck: v.noShuffle,
    deck_size: {
      main_min: v.mainMin,
      main_max: v.mainMax,
      extra_max: v.extraMax,
      side_max: v.sideMax,
    },
  };
}
export function fromHost(v: any): StandaloneDuelOptions {
  return {
    mode: v.mode,
    lflist: v.lflist,
    rule: v.rule,
    duelRule: v.duel_rule,
    timeLimit: v.time_limit,
    startLp: v.start_lp,
    startHand: v.start_hand,
    drawCount: v.draw_count,
    noCheck: !!v.no_check_deck,
    noShuffle: !!v.no_shuffle_deck,
    mainMin: v.deck_size?.main_min ?? 40,
    mainMax: v.deck_size?.main_max ?? 60,
    extraMax: v.deck_size?.extra_max ?? 15,
    sideMax: v.deck_size?.side_max ?? 15,
  };
}
