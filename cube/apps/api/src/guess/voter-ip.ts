import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { isIP } from 'node:net';

export function normalizeVoterIp(value: string | undefined): string | null {
  if (!value || value.includes('%') || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function voterIp(request: Pick<Request, 'socket' | 'headers'>): string {
  const peer = normalizeVoterIp(request.socket.remoteAddress);
  if (!peer) throw new BadRequestException({ code: 'GUESS_VOTER_IP_REQUIRED' });
  // Nginx and the Next pool proxy overwrite this header. Never trust arbitrary
  // forwarded headers on a direct connection from an external client.
  if (peer === '127.0.0.1' || peer === '::1') {
    const real = request.headers['x-real-ip'];
    if (typeof real === 'string') return normalizeVoterIp(real) ?? peer;
  }
  return peer;
}
