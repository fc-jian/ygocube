'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createCoalescedRefresh, RefreshContext } from './coalescedRefresh';

const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useCoalescedRefresh(task: (context: RefreshContext) => Promise<void>) {
  const current = useRef<{ task: typeof task; refresh: ReturnType<typeof createCoalescedRefresh> } | null>(null);
  // Bind to committed identities before paint, without aborting work from an
  // abandoned concurrent render. Recreate after Strict Mode's effect cleanup.
  useCommitEffect(() => {
    const refresh = createCoalescedRefresh(task);
    current.current = { task, refresh };
    return () => {
      refresh.cancel();
      if (current.current?.refresh === refresh) current.current = null;
    };
  }, [task]);
  const request = useCallback(() => current.current?.task === task
    ? current.current.refresh.request()
    : Promise.resolve(), [task]);
  const cancel = useCallback(() => {
    if (current.current?.task === task) current.current.refresh.cancel();
  }, [task]);
  return { request, cancel };
}
