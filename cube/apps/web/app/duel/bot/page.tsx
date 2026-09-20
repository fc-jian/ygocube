"use client";
import { useEffect, useState } from "react";
import type { DuelBot } from "@ygocube/shared";
import { api } from "@/lib/api";
import "@/components/duel/standalone.css";
export default function BotPage() {
  const [bots, setBots] = useState<DuelBot[]>([]),
    [bot, setBot] = useState("");
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ enabled: boolean; bots: DuelBot[] }>("/public/duel/bots", {
      identity: null,
    })
      .then((r) => {
        if (!r.enabled) {
          setError("机器人对战暂未开放");
          return;
        }
        setBots(r.bots);
        setBot(r.bots[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);
  async function enter(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<any>("/public/duel/bot", {
        method: "POST",
        identity: null,
        body: { name, bot },
      });
      sessionStorage.setItem("yc_standalone", JSON.stringify(r));
      sessionStorage.setItem(`yc_room_${r.room}`, JSON.stringify(r));
      location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="standalone duel-lobby">
      <header>
        <a href="/duel">玩家对战</a>
        <a href="/duel/decks">我的卡组</a>
      </header>
      <h1>机器人对战</h1>
      <p className="lobby-hint">
        进入房间后选择卡组，准备并开始单局对战。使用无限制禁限卡表。
      </p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={enter} className="standalone-panel">
        <label>
          昵称
          <input
            required
            maxLength={12}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>选择对手</legend>
          {bots.map((b) => (
            <label
              key={b.id}
              style={{
                display: "block",
                padding: "12px",
                border: "1px solid #52657d",
                borderRadius: 8,
                margin: "10px 0",
                background: bot === b.id ? "#17344a" : undefined,
              }}
            >
              <input
                type="radio"
                name="bot"
                value={b.id}
                checked={bot === b.id}
                onChange={() => setBot(b.id)}
              />{" "}
              <strong>{b.name}</strong>
              <p>{b.description}</p>
            </label>
          ))}
        </fieldset>
        <button disabled={busy || !bot}>
          {busy ? "正在建立房间…" : "建立房间并进入"}
        </button>
      </form>
    </main>
  );
}
