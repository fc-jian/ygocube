'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { API_BASE, encodePathSegment, identityHeaders, Identity, onPlayerLogout, setIdentityCookie } from './api';
import { readEventStream } from './eventStream';

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
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let retry = 0;

    const connect = async () => {
      try {
        // Explicit headers keep concurrent players in the same tournament isolated.
        // Scoped cookies remain available for legacy links and no-token sessions.
        setIdentityCookie(identity.tid, identity.pid, identity.token);
        const response = await fetch(`${API_BASE}/t/${encodePathSegment(tid)}/stream`, {
          headers: { ...identityHeaders(identity), Accept: 'text/event-stream' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (closed) return;
        if (!response.ok) {
          if (response.status === 401) onEventRef.current?.('auth-required', null);
          throw new Error(`STREAM_HTTP_${response.status}`);
        }
        if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
          throw new Error('INVALID_EVENT_STREAM');
        }
        retry = 0;
        setConnected(true);
        // Events missed while offline are recovered by fetching current state.
        onEventRef.current?.('reconnect', null);
        const known = new Set(['phase', 'pack', 'pick', 'pause', 'deck', 'match', 'notice']);
        await readEventStream(response, ({ event, data }) => {
          if (closed || !known.has(event)) return;
          try {
            onEventRef.current?.(event, JSON.parse(data));
          } catch (error) {
            console.error('invalid tournament stream event', event, error);
          }
        });
      } catch {
        // Transport failures and stream EOF share the bounded reconnect policy.
      } finally {
        if (closed) return;
        setConnected(false);
        retry++;
        retryTimer = setTimeout(() => void connect(), Math.min(5000, 500 * Math.pow(2, retry)));
      }
    };
    const stop = () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      setConnected(false);
    };
    const unsubscribe = onPlayerLogout(identity, stop);
    void connect();
    return () => { unsubscribe(); stop(); };
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
