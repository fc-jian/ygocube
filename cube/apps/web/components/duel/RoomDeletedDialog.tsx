"use client";
import { useEffect, useRef } from "react";
export function RoomDeletedDialog({ missing }: { missing: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (missing && !document.querySelector("dialog[data-room-deleted][open]"))
      dialog.current?.showModal();
    else dialog.current?.close();
  }, [missing]);
  return (
    <dialog
      ref={dialog}
      data-room-deleted
      aria-labelledby="room-deleted-title"
      style={{
        background: "#152b35",
        color: "#edf6fa",
        border: "1px solid #668c9b",
        borderRadius: 16,
        padding: 24,
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      <h2 id="room-deleted-title">房间已关闭</h2>
      <p>该房间已结束或已被删除，是否返回对战大厅？</p>
      <div style={{ display: "flex", gap: 16 }}>
        <a href="/duel">返回对战大厅</a>
        <button onClick={() => dialog.current?.close()}>暂时留在此页</button>
      </div>
    </dialog>
  );
}
