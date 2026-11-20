'use client';

import { ReactNode, useEffect, useId, useRef } from 'react';

export function ConfirmModal({ open, title, children, onConfirm, onCancel, confirmText = '确认', cancelText = '取消' }: {
  open: boolean;
  title: string;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const trigger = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog ref={dialog} aria-labelledby={titleId}
      className="fixed inset-0 m-auto max-h-[90vh] w-[26rem] max-w-[92vw] overflow-y-auto rounded-lg border border-felt-edge bg-felt p-0 text-inherit shadow-2xl backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:enabled, input:enabled, select:enabled, textarea:enabled, a[href], [tabindex]',
        )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="p-5">
        <h3 id={titleId} className="mb-3 text-lg font-semibold text-gold">{title}</h3>
        {children}
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded px-4 py-1.5 text-slate-300 hover:bg-felt-edge">
            {cancelText}
          </button>
          <button type="button" onClick={onConfirm} className="rounded bg-gold px-4 py-1.5 font-semibold text-felt-deep hover:brightness-110">
            {confirmText}
          </button>
        </div>
      </div>
    </dialog>
  );
}
