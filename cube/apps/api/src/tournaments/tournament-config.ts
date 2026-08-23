import type { MatchFormat } from '@ygocube/shared';

export const TOURNAMENT_LIMITS = Object.freeze({
  maxPlayers: 32,
  packSize: 1000,
  packCount: 10_000,
  seconds: 7 * 24 * 60 * 60,
  deckZone: 250,
  maxCopies: 100,
});

export type DropMode = 'use_all' | 'drop_leftover' | 'drop_leftover_exact';

export interface CreateTournamentInput {
  name: string;
  maxPlayers: number;
  mode?: 'single' | 'match';
  packSize?: number;
  packSizeMultiple?: number;
  packCount?: number;
  pickSeconds?: number;
  pauseSeconds?: number;
  deckbuildingSeconds?: number | null;
  mainMin?: number;
  mainMax?: number;
  extraMax?: number;
  sideMax?: number;
  maxCopies?: number;
  timeLimit?: number;
  dropMode?: DropMode;
  dropLeftover?: boolean;
  packStrategy?: 'stratify' | 'random' | 'main_then_extra';
  extraRatioPercent?: number | null;
  dropPublic?: boolean;
  draftMode?: 'passing' | 'serial';
  reseatEachRound?: boolean;
  evenPackCount?: boolean;
  reserveSeconds?: number;
  cardPool?: string;
  matchFormat?: MatchFormat;
  swissRoundCount?: number;
  playoffSize?: number;
}

const CONFIG_KEYS = new Set<keyof CreateTournamentInput>([
  'name', 'maxPlayers', 'mode', 'packSize', 'packSizeMultiple', 'packCount', 'pickSeconds', 'pauseSeconds',
  'deckbuildingSeconds', 'mainMin', 'mainMax', 'extraMax', 'sideMax', 'maxCopies', 'timeLimit',
  'dropMode', 'dropLeftover', 'packStrategy', 'extraRatioPercent', 'dropPublic', 'draftMode',
  'reseatEachRound', 'evenPackCount', 'reserveSeconds', 'cardPool', 'matchFormat', 'swissRoundCount', 'playoffSize',
]);

function bad(code = 'BAD_PAYLOAD'): never {
  throw new Error(code);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) bad();
  return value;
}

function optionalInteger(target: Record<string, unknown>, key: string, min: number, max: number): void {
  if (target[key] !== undefined) target[key] = integer(target[key], min, max);
}

function optionalBoolean(target: Record<string, unknown>, key: string): void {
  if (target[key] !== undefined && typeof target[key] !== 'boolean') bad();
}

function optionalEnum(target: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (target[key] !== undefined && !values.includes(String(target[key]))) bad();
}

export function validateTournamentName(value: unknown): string {
  if (typeof value !== 'string') bad();
  const name = value.trim();
  if (!name || [...name].length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) bad();
  return name;
}

/** Runtime validation shared by create and registration-stage admin edits. */
export function validateTournamentInput(value: unknown, partial = false, allowUnknown = false): CreateTournamentInput {
  if (!plainObject(value)) bad();
  for (const key of Object.keys(value)) {
    if (!allowUnknown && !CONFIG_KEYS.has(key as keyof CreateTournamentInput)) bad();
  }
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).filter(([key]) => CONFIG_KEYS.has(key as keyof CreateTournamentInput)),
  );

  if (!partial || result.name !== undefined) result.name = validateTournamentName(result.name);
  if (!partial || result.maxPlayers !== undefined) result.maxPlayers = integer(result.maxPlayers, 2, TOURNAMENT_LIMITS.maxPlayers);
  if (!partial && (typeof result.cardPool !== 'string' || !result.cardPool)) bad();
  if (result.cardPool !== undefined && typeof result.cardPool !== 'string') bad();

  optionalInteger(result, 'packSize', 1, TOURNAMENT_LIMITS.packSize);
  optionalInteger(result, 'packSizeMultiple', 1, 100);
  optionalInteger(result, 'packCount', 1, TOURNAMENT_LIMITS.packCount);
  optionalInteger(result, 'pickSeconds', 1, TOURNAMENT_LIMITS.seconds);
  optionalInteger(result, 'pauseSeconds', 1, TOURNAMENT_LIMITS.seconds);
  optionalInteger(result, 'reserveSeconds', 0, TOURNAMENT_LIMITS.seconds);
  optionalInteger(result, 'mainMin', 0, TOURNAMENT_LIMITS.deckZone);
  optionalInteger(result, 'mainMax', 1, TOURNAMENT_LIMITS.deckZone);
  optionalInteger(result, 'extraMax', 0, TOURNAMENT_LIMITS.deckZone);
  optionalInteger(result, 'sideMax', 0, TOURNAMENT_LIMITS.deckZone);
  optionalInteger(result, 'maxCopies', 1, TOURNAMENT_LIMITS.maxCopies);
  optionalInteger(result, 'timeLimit', 1, 999);
  optionalInteger(result, 'swissRoundCount', 1, TOURNAMENT_LIMITS.maxPlayers - 1);
  optionalInteger(result, 'playoffSize', 0, TOURNAMENT_LIMITS.maxPlayers);
  if (result.deckbuildingSeconds !== undefined && result.deckbuildingSeconds !== null) {
    result.deckbuildingSeconds = integer(result.deckbuildingSeconds, 1, TOURNAMENT_LIMITS.seconds);
  }
  if (result.extraRatioPercent !== undefined && result.extraRatioPercent !== null) {
    if (typeof result.extraRatioPercent !== 'number' || !Number.isInteger(result.extraRatioPercent)
      || result.extraRatioPercent < 0 || result.extraRatioPercent > 100) bad('BAD_EXTRA_RATIO');
  }

  optionalBoolean(result, 'dropLeftover');
  optionalBoolean(result, 'dropPublic');
  optionalBoolean(result, 'evenPackCount');
  optionalBoolean(result, 'reseatEachRound');
  optionalEnum(result, 'mode', ['single', 'match']);
  optionalEnum(result, 'dropMode', ['use_all', 'drop_leftover', 'drop_leftover_exact']);
  optionalEnum(result, 'packStrategy', ['stratify', 'random', 'main_then_extra']);
  optionalEnum(result, 'draftMode', ['passing', 'serial']);
  optionalEnum(result, 'matchFormat', ['round_robin', 'swiss', 'double_elimination']);

  const min = result.mainMin;
  const max = result.mainMax;
  if (typeof min === 'number' && typeof max === 'number' && min > max) bad();
  if (result.packSize === undefined && typeof result.maxPlayers === 'number'
    && typeof result.packSizeMultiple === 'number'
    && result.maxPlayers * result.packSizeMultiple > TOURNAMENT_LIMITS.packSize) bad();
  const playoff = result.playoffSize;
  if (typeof playoff === 'number' && playoff !== 0 && (playoff < 2 || (playoff & (playoff - 1)) !== 0)) {
    throw new Error('BAD_PLAYOFF_SIZE');
  }
  return result as unknown as CreateTournamentInput;
}
