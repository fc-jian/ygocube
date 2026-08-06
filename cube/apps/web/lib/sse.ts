'use client';

import { useEffect, useState, useCallback } from 'react';
import { Identity } from './api';

// SSE stream per tournament (dev_docs/07 §2.3): reconnect + refetch full state.
export function useTournamentStream(tid: string | null, identity: Identity | null, onEvent?: (event: string, data: any) => void) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!tid || !identity) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry = 0;

    const connect = () => {
      const qs = new URLSearchParams({ tid: identity.tid, pid: identity.pid, token: identity.token });
      es = new EventSource(`/api/t/${tid}/stream?${qs}`);
      es.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) {
          retry++;
          setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry)));
        }
      };
      const known = ['phase', 'pack', 'pick', 'pause', 'deck', 'match', 'notice'];
      for (const ev of known) {
        es.addEventListener(ev, (e) => onEvent?.(ev, JSON.parse((e as MessageEvent).data)));
      }
    };
    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [tid, identity, onEvent]);

  const refetch = useCallback(async () => {
    // full state refetch handled by callers via api('/t/:tid/state')
  }, []);

  return { connected, refetch };
}
