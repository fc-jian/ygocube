import { useEffect, useMemo, useState } from 'react';
import type { DraftStartConfirmation } from '@ygocube/shared';

export function useConfirmationSeconds(confirmation?: DraftStartConfirmation | null): number | null {
  const deadline = confirmation?.pending ? confirmation.deadlineAt : null;
  const serverNow = confirmation?.serverNow;
  const expires = useMemo(() => deadline === null ? null
    : performance.now() + Date.parse(deadline) - (serverNow ?? Date.now()), [deadline, serverNow]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (expires === null) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [expires]);
  return expires === null ? null : Math.max(0, Math.ceil((expires - performance.now()) / 1000));
}
