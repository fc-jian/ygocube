'use client';

import { useEffect, useRef } from 'react';
import { encodePathSegment, Identity, onPlayerLogout } from './api';

/** Clear page state before navigation; another player's tab is left untouched. */
export function usePlayerLogout(identity: Identity | null, clearSession: () => void): void {
  const clearRef = useRef(clearSession);
  clearRef.current = clearSession;
  useEffect(() => {
    if (!identity) return;
    return onPlayerLogout(identity, () => {
      clearRef.current();
      window.location.replace(`/t/${encodePathSegment(identity.tid)}`);
    });
  }, [identity?.tid, identity?.pid]);
}
