// Shared contracts between cube api and web (see dev_docs/07-protocol-api-design.md).
// Also the reference for the srvpro cube HTTP contract.

export type TournamentPhase = 'registration' | 'drafting' | 'deckbuilding' | 'matches' | 'finished';
export type DuelStage = 'begin' | 'dueling' | 'siding' | 'end';
export type MatchFormat = 'round_robin' | 'swiss' | 'double_elimination';
export type MatchStage = 'round_robin' | 'swiss' | 'playoff' | 'winners' | 'losers' | 'grand_final';
// Search status is player-relative during draft; deckbuilding switches to the
// global truth and may mark a card picked by another player explicitly.
export type CardVisibilityStatus = 'not_in_pool' | 'dropped' | 'picked' | 'other_picked' | 'seen' | 'unknown';

export interface CardInfo {
  code: number;
  name: string;
  type: number;
  desc: string;
  level: number;
  lscale: number;
  rscale: number;
  linkMarkers: number;
  race: number;
  attribute: number;
  atk: number;
  def: number;
  alias: number;
  setCodes: number[];
  setNames: string[];
  inPool?: boolean;
  poolStatus?: 'in_pool' | 'not_in_pool';
  pickStats?: CardPickStat[];
}

export interface CardPickStat {
  poolId: number;
  poolName: string;
  averagePickPosition: number;
  averagePickPercentage: number;
  packCount: number;
  tournamentCount: number;
  sampleCount: number;
}

export type SmallWorldSharedProperty = 'race' | 'attribute' | 'level' | 'atk' | 'def';

export interface SmallWorldCalculateRequest {
  deckCodes: number[];
  /** Optional current hand; omitted/empty means scan every unique main-deck monster. */
  handCodes?: number[];
  /** Allow one exact card code to be both the hand card and the target. */
  allowSameHandTarget?: boolean;
}

export interface SmallWorldPath {
  handCode: number;
  bridgeCode: number;
  targetCode: number;
  handBridgeShared: SmallWorldSharedProperty;
  bridgeTargetShared: SmallWorldSharedProperty;
}

export interface SmallWorldCalculationResponse {
  cards: CardInfo[];
  paths: SmallWorldPath[];
  unknownCodes: number[];
  summary: {
    deckCount: number;
    handCount: number;
    eligibleDeckCount: number;
    eligibleHandCount: number;
    pathCount: number;
    handMode: 'provided' | 'deck_unique';
  };
}

export interface TournamentConfig {
  maxPlayers: number;
  mode: 'single' | 'match'; // BO1 / BO3 with side
  packSize?: number; // cards per pack (any positive integer, default 24)
  packSizeMultiple: number; // legacy: pack size = players * multiple (used when packSize absent)
  packCount?: number; // explicit total pack count; <= floor(pool/packSize) = fixed count, rest discarded; > that = use ALL pool cards (count = ceil(pool/packSize), last pack may be partial); new create defaults target 4×players, reduced when the pool is smaller
  packStrategy?: 'stratify' | 'random' | 'main_then_extra'; // discarded subset is always main/extra proportional before this layout strategy
  extraRatioPercent?: number | null; // optional per-pack extra-deck percentage (0-100); null keeps packStrategy
  dropPublic?: boolean; // whether dropped cards are exposed (default false)
  dropLast: boolean; // public dropped card list per pack
  pickSeconds: number; // default 40
  pauseSeconds: number; // default 300 (5 min)
  deckbuildingSeconds?: number | null; // null/default = unlimited; admin advances manually
  mainMin: number;
  mainMax: number;
  extraMax: number;
  sideMax: number;
  maxCopies?: number; // picked code may be used this many times across main/extra/side
  cardPool: string; // must be an existing card_pools name ('full' is rejected on write paths; legacy configs may still contain it)
  cardPoolId?: number; // immutable pool identity used by historical statistics
  timeLimit?: number; // per-turn seconds for the duel host (default 180; 999 ≈ unlimited)
  draftMode?: 'passing' | 'serial'; // default 'passing' (per-player pack queues); 'serial' = legacy one-pack-at-a-time
  evenPackCount?: boolean; // default true: pack count must be a multiple of player count (explicit packCount rejected otherwise; computed counts round down)
  reseatEachRound?: boolean; // passing: shuffle player seats before each round (default true)
  reserveSeconds?: number; // passing mode: per-player reserve time bank (default 400); pick overrun deducts from it, auto-pick only when exhausted
  matchFormat?: MatchFormat; // absent only for legacy tournaments using the historical automatic policy
  swissRoundCount?: number;
  playoffSize?: number; // 0 or a power of two
}

export interface DeckPayload {
  main: number[]; // main deck + extra deck codes (game distinguishes by type)
  side: number[];
}

// srvpro /cube/create_room request body (contract with srvpro)
export interface SrvproCreateRoomRequest {
  room_name: string;
  password?: string;
  hostinfo: {
    mode: number;
    rule: number;
    lflist: number;
    duel_rule: number;
    start_lp: number;
    start_hand: number;
    draw_count: number;
    time_limit: number;
  };
  deck_size: { main_min: number; main_max: number; extra_max: number; side_max: number };
  players: { player_id: string; name_vpass: string }[];
  cube_decks: Record<string, DeckPayload>;
}

export interface SrvproCreateRoomResponse {
  ok: boolean;
  room_name?: string;
  port?: number;
  code?: string;
  message?: string;
}

export interface SrvproRoomStatus {
  ok: boolean;
  room_name?: string;
  established?: boolean;
  port?: number;
  duel_stage?: number;
  players?: { name_vpass: string; player_id: string | null; connected: boolean; pos: number }[];
  scores?: Record<string, number>;
  finished?: boolean;
  code?: string;
}

export interface SrvproResultWebhook {
  room_name: string;
  start: string;
  end: string;
  players: {
    player_id: string;
    name_vpass: string;
    score: number;
    deck: DeckPayload | null;
    deck_history: unknown;
  }[];
  first?: string;
  wins?: string;
  replays?: string;
}

/** Stable presentation-only ordering for card pick statistics. */
export function sortCardCodesByPick<T extends {
  code: number;
  pickStats?: Array<{ poolId: number; averagePickPercentage: number }>;
}>(codes: number[], cardMap: Record<number, T>, poolId?: number): number[] {
  return codes
    .map((code, index) => {
      const stat = cardMap[code]?.pickStats?.find((candidate) => poolId === undefined || candidate.poolId === poolId);
      return { code, index, percentage: stat?.averagePickPercentage };
    })
    .sort((a, b) => {
      if (a.percentage === undefined && b.percentage === undefined) return a.index - b.index;
      if (a.percentage === undefined) return 1;
      if (b.percentage === undefined) return -1;
      return a.percentage - b.percentage || a.index - b.index;
    })
    .map(({ code }) => code);
}
