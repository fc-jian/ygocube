import { BadRequestException } from '@nestjs/common';

export function badPayload(): never {
  throw new BadRequestException({ code: 'BAD_PAYLOAD' });
}

export function payload(body: unknown, keys: string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) badPayload();
  if (Object.keys(body).some((key) => !keys.includes(key))) badPayload();
  return body as Record<string, unknown>;
}

export function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') badPayload();
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > limit || /[\p{Cc}\p{Cf}]/u.test(normalized)) badPayload();
  return normalized;
}

export function playerId(value: unknown): string {
  const id = text(value, 24);
  if (!/^[\p{L}\p{N}_. -]+$/u.test(id)) badPayload();
  return id;
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) badPayload();
  return value;
}
