import { isIP } from 'net';

export type RateLimitCategory = 'asset' | 'privileged' | 'tournament' | 'public';

// Card pools intentionally load many immutable thumbnails in a short burst.
// Keep those requests isolated from JSON/API traffic instead of weakening the
// limits on state-changing endpoints.
export const RATE_LIMITS: Record<RateLimitCategory, number> = {
  asset: 6000,
  privileged: 120,
  tournament: 300,
  public: 600,
};

export interface RateLimitRequest {
  path: string;
  socket: { remoteAddress?: string | null };
  headers: Record<string, string | string[] | undefined>;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  return raw.split(',')[0].trim();
}

function isLoopback(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function validAddress(value: string): string | null {
  return value && isIP(value) ? value : null;
}

/**
 * Resolve the source address only from forwarding headers supplied by our
 * local reverse proxy. Direct clients cannot spoof these headers because the
 * API port is firewalled and non-loopback peers are ignored.
 */
export function clientAddress(req: RateLimitRequest): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (isLoopback(peer)) {
    const forwarded = validAddress(firstHeaderValue(req.headers['x-real-ip']))
      ?? validAddress(firstHeaderValue(req.headers['x-forwarded-for']));
    if (forwarded) return forwarded;
  }
  return peer;
}

export function rateLimitCategory(req: Pick<RateLimitRequest, 'path'>): RateLimitCategory {
  if (req.path.startsWith('/pics/')) return 'asset';
  if (req.path.startsWith('/admin') || req.path === '/tournaments') return 'privileged';
  if (req.path.startsWith('/t/')) return 'tournament';
  return 'public';
}

export function rateLimitFor(category: RateLimitCategory): number {
  return RATE_LIMITS[category];
}
