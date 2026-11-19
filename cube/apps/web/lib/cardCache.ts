import { api, Identity } from './api';
import { CardInfo } from './types';

// Card metadata is immutable for the lifetime of a pool revision. Keep a
// small browser-local cache so state refreshes do not repeatedly transfer the
// same 40–60 KB JSON payload to every player. The short TTL also picks up
// completed-match pick-stat changes without requiring a page reload.
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 20_000;
const CHUNK_SIZE = 400;

interface Entry {
  card: CardInfo;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

function touch(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function trim(): void {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Read card metadata for exact codes, fetching only expired/missing entries.
 * `endpoint` must identify the visibility/statistics context (for example
 * `/t/39/cards`); it is deliberately part of the cache key.
 */
export async function fetchCardMetadata(
  endpoint: string,
  codes: readonly number[],
  identity: Identity | null,
  ttlMs = CACHE_TTL_MS,
): Promise<CardInfo[]> {
  const unique = [...new Set(codes)].filter((code) => Number.isSafeInteger(code) && code > 0);
  if (unique.length === 0) return [];
  const now = Date.now();
  const namespace = `${endpoint}|${identity?.tid ?? 'public'}`;
  const missing: number[] = [];
  for (const code of unique) {
    const key = `${namespace}:${code}`;
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (entry) cache.delete(key);
      missing.push(code);
    } else {
      touch(key, entry);
    }
  }

  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    const chunk = missing.slice(i, i + CHUNK_SIZE);
    const payload = await api<unknown>(`${endpoint}?codes=${chunk.join(',')}`, { identity });
    if (!Array.isArray(payload)) throw new Error('INVALID_CARD_RESPONSE');
    const expiresAt = Date.now() + ttlMs;
    for (const card of payload) {
      if (!card || typeof card !== 'object') continue;
      const value = card as CardInfo;
      if (!Number.isSafeInteger(value.code) || value.code <= 0) continue;
      touch(`${namespace}:${value.code}`, { card: value, expiresAt });
    }
    trim();
  }

  const result: CardInfo[] = [];
  for (const code of unique) {
    const entry = cache.get(`${namespace}:${code}`);
    if (entry && entry.expiresAt > Date.now()) {
      touch(`${namespace}:${code}`, entry);
      result.push(entry.card);
    }
  }
  return result;
}

/** Test/diagnostic hook; it does not affect the server or persistent data. */
export function clearCardMetadataCache(): void {
  cache.clear();
}
