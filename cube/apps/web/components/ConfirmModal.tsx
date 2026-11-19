'use client';

import { ReactNode } from 'react';

export function ConfirmModal({ open, title, children, onConfirm, onCancel, confirmText = '确认', cancelText = '取消' }: {
  open: boolean;
  title: string;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="mx-4 max-h-[90vh] w-[26rem] max-w-[92vw] overflow-y-auto rounded-lg border border-felt-edge bg-felt p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-lg font-semibold text-gold">{title}</h3>
        {children}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onCancel} className="rounded px-4 py-1.5 text-slate-300 hover:bg-felt-edge">
            {cancelText}
          </button>
          <button onClick={onConfirm} className="rounded bg-gold px-4 py-1.5 font-semibold text-felt-deep hover:brightness-110">
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
