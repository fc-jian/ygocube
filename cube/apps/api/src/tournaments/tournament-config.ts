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
  'name', 'maxPlayers', 'mode', 'packSize', 'packSizeMultiple', 'packCount', 'pickSeconds',
  'deckbuildingSeconds', 'mainMin', 'mainMax', 'extraMax', 'sideMax', 'maxCopies', 'timeLimit',
  'dropMode', 'dropLeftover', 'packStrategy', 'extraRatioPercent', 'dropPublic', 'draftMode',
  'reseatEachRound', 'evenPackCount', 'reserveSeconds', 'cardPool', 'matchFormat', 'swissRoundCount', 'playoffSize',
]);

export interface ValidationDetails {
  field?: string;
  message?: string;
  [key: string]: unknown;
}

function bad(code = 'BAD_PAYLOAD', details?: ValidationDetails): never {
  const error = new Error(code) as Error & { details?: ValidationDetails };
  if (details) error.details = details;
  throw error;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    bad('BAD_PAYLOAD', { field, message: `${field} 必须是 ${min}–${max} 的整数` });
  }
  return value;
}

function optionalInteger(target: Record<string, unknown>, key: string, min: number, max: number): void {
  if (target[key] !== undefined) target[key] = integer(target[key], min, max, key);
}

function optionalBoolean(target: Record<string, unknown>, key: string): void {
  if (target[key] !== undefined && typeof target[key] !== 'boolean') {
    bad('BAD_PAYLOAD', { field: key, message: `${key} 必须是布尔值` });
  }
}

function optionalEnum(target: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (target[key] !== undefined && !values.includes(String(target[key]))) {
    bad('BAD_PAYLOAD', { field: key, message: `${key} 不是有效选项` });
  }
}

export function validateTournamentName(value: unknown): string {
  if (typeof value !== 'string') bad('BAD_PAYLOAD', { field: 'name', message: '请输入比赛名称' });
  const name = value.trim();
  if (!name) bad('BAD_PAYLOAD', { field: 'name', message: '请输入比赛名称' });
  if ([...name].length > 128) bad('BAD_PAYLOAD', { field: 'name', message: '比赛名称不能超过 128 个字符' });
  if (/[\u0000-\u001f\u007f]/u.test(name)) bad('BAD_PAYLOAD', { field: 'name', message: '比赛名称不能包含控制字符' });
  return name;
}

/** Runtime validation shared by create and registration-stage admin edits. */
export function validateTournamentInput(value: unknown, partial = false, allowUnknown = false): CreateTournamentInput {
  if (!plainObject(value)) bad('BAD_PAYLOAD', { message: '请求参数必须是对象' });
  for (const key of Object.keys(value)) {
    if (!allowUnknown && !CONFIG_KEYS.has(key as keyof CreateTournamentInput)) {
      bad('BAD_PAYLOAD', { field: key, message: `不支持的参数：${key}` });
    }
  }
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).filter(([key]) => CONFIG_KEYS.has(key as keyof CreateTournamentInput)),
  );

  if (!partial || result.name !== undefined) result.name = validateTournamentName(result.name);
  if (!partial || result.maxPlayers !== undefined) result.maxPlayers = integer(result.maxPlayers, 2, TOURNAMENT_LIMITS.maxPlayers, 'maxPlayers');
  if (!partial && (typeof result.cardPool !== 'string' || !result.cardPool.trim())) {
    bad('BAD_PAYLOAD', { field: 'cardPool', message: '请选择卡池' });
  }
  if (result.cardPool !== undefined && (typeof result.cardPool !== 'string' || !result.cardPool.trim())) {
    bad('BAD_PAYLOAD', { field: 'cardPool', message: '请选择卡池' });
  }

  optionalInteger(result, 'packSize', 1, TOURNAMENT_LIMITS.packSize);
  optionalInteger(result, 'packSizeMultiple', 1, 100);
  optionalInteger(result, 'packCount', 1, TOURNAMENT_LIMITS.packCount);
  optionalInteger(result, 'pickSeconds', 1, TOURNAMENT_LIMITS.seconds);
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
    result.deckbuildingSeconds = integer(result.deckbuildingSeconds, 1, TOURNAMENT_LIMITS.seconds, 'deckbuildingSeconds');
  }
  if (result.extraRatioPercent !== undefined && result.extraRatioPercent !== null) {
    if (typeof result.extraRatioPercent !== 'number' || !Number.isInteger(result.extraRatioPercent)
      || result.extraRatioPercent < 0 || result.extraRatioPercent > 100) {
      bad('BAD_EXTRA_RATIO', { field: 'extraRatioPercent', message: '额外卡比例必须是 0–100 的整数' });
    }
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
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    bad('BAD_PAYLOAD', { field: 'mainMin', message: '主卡组最小值不能大于最大值' });
  }
  if (result.packSize === undefined && typeof result.maxPlayers === 'number'
    && typeof result.packSizeMultiple === 'number'
    && result.maxPlayers * result.packSizeMultiple > TOURNAMENT_LIMITS.packSize) {
    bad('BAD_PAYLOAD', { field: 'packSizeMultiple', message: '按人数计算的每堆卡数超过上限' });
  }
  const playoff = result.playoffSize;
  if (typeof playoff === 'number' && playoff !== 0 && (playoff < 2 || (playoff & (playoff - 1)) !== 0)) {
    bad('BAD_PLAYOFF_SIZE', { field: 'playoffSize', message: '淘汰赛人数必须是 0 或 2 的幂' });
  }
  return result as unknown as CreateTournamentInput;
}
