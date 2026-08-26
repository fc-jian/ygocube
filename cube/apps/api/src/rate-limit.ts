import { isIP } from 'node:net';
import type { Request } from 'express';

export type RateLimitCategory = 'asset' | 'privileged' | 'tournament' | 'public';

export const RATE_LIMITS: Readonly<Record<RateLimitCategory, number>> = Object.freeze({
  // Pool pages can legitimately request thousands of card thumbnails. Keep
  // assets isolated from API requests so image loading cannot lock out users.
  asset: 6_000,
  privileged: 120,
  tournament: 300,
  public: 600,
});

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validAddress(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

function isTrustedProxy(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Trust proxy-provided client addresses only when the immediate peer is the
 * local reverse proxy. Direct clients cannot spoof X-Real-IP/X-Forwarded-For
 * to evade or share a rate-limit bucket.
 */
export function clientAddress(req: Pick<Request, 'headers' | 'socket'>): string {
  const peer = req.socket.remoteAddress;
  if (isTrustedProxy(peer)) {
    const forwarded = validAddress(firstHeader(req.headers['x-real-ip']))
      ?? validAddress(firstHeader(req.headers['x-forwarded-for']));
    if (forwarded) return forwarded;
  }
  return validAddress(peer) ?? 'unknown';
}

export function rateLimitCategory(req: Pick<Request, 'path'>): RateLimitCategory {
  if (req.path === '/pics' || req.path.startsWith('/pics/')) return 'asset';
  if (req.path === '/admin' || req.path.startsWith('/admin/') || req.path === '/tournaments') {
    return 'privileged';
  }
  if (req.path === '/t' || req.path.startsWith('/t/')) return 'tournament';
  return 'public';
}

export function rateLimitFor(category: RateLimitCategory): number {
  return RATE_LIMITS[category];
}
