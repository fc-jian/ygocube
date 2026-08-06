// Shared contracts between cube api and web (see dev_docs/07-protocol-api-design.md).
// Also the reference for the srvpro cube HTTP contract.

export type TournamentPhase = 'registration' | 'drafting' | 'deckbuilding' | 'matches' | 'finished';
export type DuelStage = 'begin' | 'dueling' | 'siding' | 'end';

export interface TournamentConfig {
  maxPlayers: number;
  mode: 'single' | 'match'; // BO1 / BO3 with side
  packSizeMultiple: number; // default 3 (pack size = players * multiple)
  dropLast: boolean; // public dropped card list per pack
  pickSeconds: number; // default 30
  pauseSeconds: number; // default 300 (5 min)
  mainMin: number;
  mainMax: number;
  extraMax: number;
  sideMax: number;
  cardPool: string; // must be an existing card_pools name ('full' is rejected on write paths; legacy configs may still contain it)
  timeLimit?: number; // per-turn seconds for the duel host (default 180; 999 ≈ unlimited)
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
