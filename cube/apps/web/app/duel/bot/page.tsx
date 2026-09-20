"use client";
import { useEffect, useState } from "react";
import type { DuelBot } from "@ygocube/shared";
import { api } from "@/lib/api";
import "@/components/duel/standalone.css";
export default function BotPage() {
  const [bots, setBots] = useState<DuelBot[]>([]),
    [bot, setBot] = useState(""),
    [robot, setRobot] = useState("");
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
        setRobot(r.bots[0]?.robot || "");
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
        <div className="standalone-fields">
          <label>
            机器人
            <select
              required
              aria-label="机器人"
              value={robot}
              disabled={busy || !bots.length}
              onChange={(e) => {
                setRobot(e.target.value);
                setBot(bots.find((b) => b.robot === e.target.value)?.id || "");
              }}
            >
              {[...new Set(bots.map((b) => b.robot))].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            机器人卡组
            <select
              required
              aria-label="机器人卡组"
              value={bot}
              disabled={busy || !robot}
              onChange={(e) => setBot(e.target.value)}
            >
              {bots
                .filter((b) => b.robot === robot)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <p aria-live="polite">{bots.find((b) => b.id === bot)?.description}</p>

        <button disabled={busy || !bot}>
          {busy ? "正在建立房间…" : "建立房间并进入"}
        </button>
      </form>
    </main>
  );
}
