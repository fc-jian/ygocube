'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { GuessText } from './guess-text';

export const GUESS_PATH = '/games/guess';
export const sessionKey = (roomId: string) => `yc_guess_session_${roomId}`;

export function guessRequest<T>(path: string, options: {
  token?: string; adminToken?: string; body?: unknown; signal?: AbortSignal;
} = {}): Promise<T> {
  const { token, adminToken, body, signal } = options;
  return api<T>(GUESS_PATH + path, {
    method: body === undefined ? 'GET' : 'POST',
    identity: null,
    authorization: token ? `Bearer ${token}` : undefined,
    adminToken,
    body,
    signal,
  });
}

export function guessError(error: unknown, text: GuessText): string {
  if (error instanceof ApiError && Object.prototype.hasOwnProperty.call(text.errors, error.code)) {
    return text.errors[error.code as keyof GuessText['errors']];
  }
  return text.genericError;
}

export function useGuessResource<T>(path: string) {
  const [result, setResult] = useState<{ data: T | null; error: unknown }>({ data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    guessRequest<T>(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult({ data, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ data: null, error });
    });
    return () => controller.abort();
  }, [path]);
  return result;
}

export function useGuessPolling(task: ((signal: AbortSignal) => Promise<void>) | null, interval: number) {
  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    async function tick(initial = false) {
      if (task && (initial || !document.hidden)) await task(controller.signal);
      if (!controller.signal.aborted) timeout = setTimeout(tick, interval);
    }
    void tick(true);
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [task, interval]);
}
