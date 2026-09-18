"use client";
import { useEffect, useRef } from "react";

/** Operation feedback expires; initial loading failures stay in the page. */
export function TransientNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => dismiss.current(), 8000);
    return () => window.clearTimeout(timer);
  }, [message]);
  if (!message) return null;
  return <div className="mx-3 mb-2 flex items-center gap-3 rounded bg-red-900/60 px-3 py-2 text-xs text-red-200" role="alert">
    <span className="flex-1">{message}</span>
    <button type="button" aria-label="关闭提示 / Dismiss" onClick={onDismiss} className="rounded px-2 py-1">×</button>
  </div>;
}
