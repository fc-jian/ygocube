"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { DuelClient } from "./DuelClient";
import { LocalPicsSetting } from "@/components/IdentityWidget";
import "./standalone.css";
import { RoomDeletedDialog } from "./RoomDeletedDialog";
export function StandaloneRoom({ room }: { room: string }) {
  const [info, setInfo] = useState<any>(null),
    [session, setSession] = useState<any>(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<any>(`/public/duel/rooms/${encodeURIComponent(room)}`, {
        identity: null,
      })
        .then((r) => {
          if (active) setInfo(r);
        })
        .catch((e) => active && setError(e.message));
    refresh();
    const t = setInterval(refresh, 5000);
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(`yc_room_${room}`) || "null",
      );
      if (saved) setSession(saved);
    } catch {}
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [room]);
  async function enter(kind: "join" | "reconnect" | "watch") {
    setBusy(true);
    setError("");
    try {
      const r = await api<any>(
        kind === "watch" ? "/public/duel/watch" : "/public/duel/join",
        {
          method: "POST",
          identity: null,
          body:
            kind === "watch"
              ? { room }
              : {
                  room,
                  name,
                  reconnect: kind === "reconnect",
                  credential: session?.credential,
                },
        },
      );
      const next = { ...r, role: kind === "watch" ? "watch" : "player" };
      sessionStorage.setItem(`yc_room_${room}`, JSON.stringify(next));
      setSession(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <RoomDeletedDialog missing={error === "MATCH_NOT_FOUND"} />
      <section
        className={`standalone room-heading ${session ? "in-session" : ""}`}
      >
        <details open={!session}>
          <summary>房间信息与链接</summary>
          <header>
            <a href="/duel">← 对战大厅</a>
            <a href="/duel/decks" target="_blank" rel="noreferrer">
              我的卡组
            </a>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    location.origin + `/duel/room/${room}`,
                  );
                  setCopied(true);
                } catch {
                  setError("请复制地址栏链接");
                }
              }}
            >
              {copied ? "已复制" : "复制房间链接"}
            </button>
          </header>
          <small>房间链接与密码等价，请仅向参与者分享。</small>
          {info?.nativeConnection && (
            <p className="native-connection">
              YGOPro 客户端：{info.nativeConnection.host || location.hostname}：
              {info.nativeConnection.port}
              <br />
              房间密码：<code>{info.nativeConnection.password}</code>{" "}
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(info.nativeConnection.password)
                    .catch(() => setError("请手动复制房间密码"))
                }
              >
                复制密码
              </button>
            </p>
          )}
          <LocalPicsSetting />
          {info && (
            <p>
              {info.options.mode ? "三局两胜" : "单局"} ·{" "}
              {info.options.timeLimit
                ? `${info.options.timeLimit} 秒`
                : "不限时"}{" "}
              · LP {info.options.startLp} · 主卡组 {info.options.mainMin}–
              {info.options.mainMax} · 额外 {info.options.extraMax} · 副卡组{" "}
              {info.options.sideMax}
            </p>
          )}
        </details>
        {error && error !== "MATCH_NOT_FOUND" && <p role="alert">{error}</p>}
        {!session && (
          <section className="standalone-panel">
            <h1>房间</h1>
            <p>
              {info?.players
                ?.map(
                  (p: any) => `${p.id} · ${p.connected ? "在线" : "已断线"}`,
                )
                .join(" / ") || "等待玩家"}
            </p>
            <div className="standalone-fields">
              <label>
                玩家 ID
                <input
                  maxLength={12}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
            <div className="builder-toolbar">
              <button
                className="primary"
                disabled={busy || !info || !name}
                onClick={() => enter("join")}
              >
                加入对战
              </button>
              <button
                disabled={busy || !info || !name}
                onClick={() => enter("reconnect")}
              >
                使用 ID 重连
              </button>
              <button disabled={busy || !info} onClick={() => enter("watch")}>
                观战
              </button>
            </div>
          </section>
        )}
        {session && (
          <button
            onClick={() => {
              setSession(null);
              sessionStorage.removeItem(`yc_room_${room}`);
            }}
          >
            返回房间选项
          </button>
        )}
      </section>
      {session && (
        <DuelClient
          key={session.credential}
          credential={session.credential}
          mode={session.role === "watch" ? "watch" : "player"}
        />
      )}
    </>
  );
}
