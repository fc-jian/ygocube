'use client';

import { useEffect, useState } from 'react';
import type { DgRoomView } from '@ygocube/shared';
import { api, ApiError } from '@/lib/api';
import { guessError } from '@/components/guess/guess-client';
import type { GuessText } from '@/components/guess/guess-text';
import type { DgText } from './dg-text';

export const DG_PATH = '/games/dg';
export const dgSessionKey = (roomId: string) => `yc_dg_session_${roomId}`;

export function dgRequest<T>(path: string, options: { token?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const { token, body, signal } = options;
  return api<T>(DG_PATH + path, {
    method: body === undefined ? 'GET' : 'POST',
    identity: null,
    authorization: token ? `Bearer ${token}` : undefined,
    body,
    signal,
  });
}

export function dgError(error: unknown, text: DgText, shared: GuessText): string {
  if (error instanceof ApiError && Object.prototype.hasOwnProperty.call(text.errors, error.code)) {
    return text.errors[error.code as keyof DgText['errors']];
  }
  return guessError(error, shared);
}

export function useDgClock({ deadlineAt, serverNow }: DgRoomView, receivedAt: number) {
  const [, tick] = useState(0);
  const running = deadlineAt !== null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 200);
    return () => window.clearInterval(timer);
  }, [running]);

  const now = serverNow + (performance.now() - receivedAt);
  const seconds = deadlineAt === null ? 0 : Math.max(0, Math.ceil((deadlineAt - now) / 1000));
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return { now, seconds, countdown };
}
