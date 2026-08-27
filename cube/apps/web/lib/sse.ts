'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Identity } from './api';

// SSE stream per tournament (dev_docs/07 §2.3): reconnect + refetch full state.
export function useTournamentStream(tid: string | null, identity: Identity | null, onEvent?: (event: string, data: any) => void) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!tid || !identity) {
      setConnected(false);
      return;
    }
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let retry = 0;

    const connect = () => {
      // EventSource cannot set authentication headers. The identity helper has
      // already written per-tournament SameSite cookies, so credentials never
      // need to appear in browser history, proxy logs, or Referer headers.
      es = new EventSource(`/api/t/${tid}/stream`);
      es.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) {
          retry++;
          retryTimer = setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry)));
        }
      };
      const known = ['phase', 'pack', 'pick', 'pause', 'deck', 'match', 'notice'];
      for (const ev of known) {
        es.addEventListener(ev, (e) => {
          try {
            onEventRef.current?.(ev, JSON.parse((e as MessageEvent).data));
          } catch (error) {
            console.error('invalid tournament stream event', ev, error);
          }
        });
      }
    };
    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      setConnected(false);
    };
  }, [tid, identity?.tid, identity?.pid, identity?.token]);

  const refetch = useCallback(async () => {
    // full state refetch handled by callers via api('/t/:tid/state')
  }, []);

  return { connected, refetch };
}

/**
 * Use a slow, visibility-aware polling fallback only while SSE is offline.
 * Callers still own the actual loader; this hook merely schedules it and
 * prevents fallback ticks from overlapping one another.
 */
export function useTournamentFallbackPolling({
  connected,
  enabled,
  intervalMs = 15_000,
  onPoll,
}: {
  connected: boolean;
  enabled: boolean;
  intervalMs?: number;
  onPoll: () => Promise<void> | void;
}): void {
  const onPollRef = useRef(onPoll);
  useEffect(() => {
    onPollRef.current = onPoll;
  }, [onPoll]);

  useEffect(() => {
    if (!enabled || connected) return;
    let busy = false;
    const run = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        await onPollRef.current();
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void run(), intervalMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connected, enabled, intervalMs]);
}
