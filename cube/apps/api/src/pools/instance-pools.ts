import fs from 'node:fs';

export interface DraftPoolSeed {
  name: string;
  codes: number[];
  draftFormat?: 'edison_e3';
}

export interface GuessPoolSeed {
  key: string;
  name: string;
  codes: number[];
  defaultPriority: number;
  browseOnly: boolean;
  aliases: string[];
  previousCodes: number[][];
}

export interface InstancePools { draft: DraftPoolSeed[]; guess: GuessPoolSeed[] }

function invalid(): never {
  throw new Error('Invalid private pool data. Check version, pool names, keys and card arrays.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) invalid();
  return value;
}

function codes(value: unknown, allowCopies = false): number[] {
  const entries = list(value);
  if (entries.length > 100_000 || entries.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 0xffffffff)) invalid();
  if (!allowCopies && new Set(entries).size !== entries.length) invalid();
  return entries as number[];
}

export function parseInstancePools(value: unknown): InstancePools {
  const data = record(value);
  if (data.version !== 1) invalid();
  const draft = list(data.draft ?? []).map((entry): DraftPoolSeed => {
    const pool = record(entry);
    const id = name(pool.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) invalid();
    if (pool.draftFormat !== undefined && pool.draftFormat !== 'edison_e3') invalid();
    return { name: id, codes: codes(pool.codes, !!pool.draftFormat), draftFormat: pool.draftFormat };
  });
  const guess = list(data.guess ?? []).map((entry): GuessPoolSeed => {
    const pool = record(entry);
    const key = name(pool.key);
    const priority = pool.defaultPriority ?? 0;
    if (!/^builtin:[a-zA-Z0-9._-]+$/.test(key) || typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0) invalid();
    if (pool.browseOnly !== undefined && typeof pool.browseOnly !== 'boolean') invalid();
    return { name: name(pool.name), key, codes: codes(pool.codes), defaultPriority: priority, browseOnly: pool.browseOnly === true,
      aliases: list(pool.aliases ?? []).map(name), previousCodes: list(pool.previousCodes ?? []).map((v) => codes(v)) };
  });
  const guessNames = guess.flatMap((pool) => [pool.name, ...pool.aliases].map((v) => v.normalize('NFKC').toLowerCase()));
  if (new Set(draft.map((p) => p.name)).size !== draft.length || new Set(guess.map((p) => p.key)).size !== guess.length
    || new Set(guessNames).size !== guessNames.length) invalid();
  return { draft, guess };
}

export function readInstancePools(file: string, optional: boolean): InstancePools {
  if (optional && !fs.existsSync(file)) return { draft: [], guess: [] };
  return parseInstancePools(JSON.parse(fs.readFileSync(file, 'utf8')));
}
