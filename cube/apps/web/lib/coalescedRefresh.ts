export interface RefreshContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

/** Keep one request in flight, and drain invalidations received while it runs. */
export function createCoalescedRefresh(task: (context: RefreshContext) => Promise<void>) {
  let version = 0;
  let disposed = false;
  let pending = false;
  let active: Promise<void> | null = null;
  const controller = new AbortController();

  const request = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    version++;
    pending = true;
    if (!active) {
      // Start in a microtask so active is set even when task finishes immediately.
      active = Promise.resolve().then(async () => {
        try {
          while (pending && !disposed) {
            pending = false;
            const requestedVersion = version;
            await task({
              signal: controller.signal,
              isCurrent: () => !disposed && requestedVersion === version,
            });
          }
        } finally {
          active = null;
        }
      });
    }
    return active;
  };

  return {
    request,
    cancel: () => {
      disposed = true;
      pending = false;
      controller.abort();
    },
  };
}
