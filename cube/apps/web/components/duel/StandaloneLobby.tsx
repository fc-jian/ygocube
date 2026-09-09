"use client";
import { useEffect, useState } from "react";
import type { StandaloneDuelOptions } from "@ygocube/shared";
import { api } from "@/lib/api";
import { readDecks, saveDeck, parseYdk, SavedDeck } from "./deck-cookie";
import { LocalPicsSetting } from "@/components/IdentityWidget";
import "./standalone.css";
export function StandaloneLobby() {
  const [options, setOptions] = useState<StandaloneDuelOptions | null>(null),
    [lists, setLists] = useState<
      {
        id: number;
        name: string;
      }[]
    >([]),
    [decks, setDecks] = useState<SavedDeck[]>([]),
    [deckId, setDeckId] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () => setDecks(readDecks());
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    api<any>("/public/duel/options", { identity: null })
      .then((r) => {
        setOptions(r.defaults);
        setLists(r.lists);
      })
      .catch((e) => setError(e.message));
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const change = (k: keyof StandaloneDuelOptions, v: any) =>
    setOptions((o) => (o ? { ...o, [k]: v } : o));
  async function join(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const deck = decks.find((d) => d.id === deckId);
      if (!deck) throw Error("请选择卡组");
      const r = await api<any>("/public/duel/join", {
        method: "POST",
        identity: null,
        body: { name, password, options, deck },
      });
      sessionStorage.setItem("yc_standalone", JSON.stringify(r));
      sessionStorage.setItem(`yc_room_${r.room}`, JSON.stringify(r));
      location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="standalone">
      <header>
        <a href="/">YGO Cube</a>
        <a href="/duel/decks">我的卡组</a>
      </header>
      <h1>网页对战</h1>
      <p>相同密码进入同一房间。首位创建者决定规则，双方准备后由房主开始。</p>

      <LocalPicsSetting />

      <button
        type="button"
        disabled={busy || !password}
        onClick={async () => {
          setError("");
          try {
            const r = await api<any>("/public/duel/resolve", {
              method: "POST",
              identity: null,
              body: { password },
            });
            location.assign(r.url);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        用密码打开已有房间（重连 / 观战）
      </button>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={join}>
        <section className="standalone-panel">
          <h2>加入房间</h2>
          <div className="standalone-fields">
            <label>
              昵称
              <input
                required
                maxLength={12}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              房间密码
              <input
                required
                type="password"
                autoComplete="off"
                maxLength={100}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              卡组
              <select
                required
                value={deckId}
                onChange={(e) => setDeckId(e.target.value)}
              >
                <option value="">选择已保存卡组</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.main.length}/{d.extra.length}/{d.side.length}
                  </option>
                ))}
              </select>
            </label>
            <label>
              上传 YDK
              <input
                type="file"
                accept=".ydk,.txt"
                onChange={async (e) => {
                  try {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 65536) throw Error("文件过大");
                    const id = saveDeck(
                      parseYdk(await f.text(), f.name.replace(/\.ydk$/i, "")),
                    );
                    refresh();
                    setDeckId(id);
                    setError("");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              />
            </label>
          </div>
        </section>
        {options && (
          <section className="standalone-panel">
            <h2>建房选项</h2>

            <div className="standalone-fields">
              <label>
                对局模式
                <select
                  value={options.mode}
                  onChange={(e) => change("mode", +e.target.value)}
                >
                  <option value={1}>比赛 BO3</option>
                  <option value={0}>单局</option>
                </select>
              </label>
              <label>
                禁限卡表
                <select
                  value={options.lflist}
                  onChange={(e) => change("lflist", +e.target.value)}
                >
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                卡片范围
                <select
                  value={options.rule}
                  onChange={(e) => change("rule", +e.target.value)}
                >
                  {[
                    "OCG",
                    "TCG",
                    "简体中文",
                    "Custom",
                    "同时 OCG/TCG",
                    "全部",
                  ].map((v, i) => (
                    <option key={v} value={i}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                大师规则
                <select
                  value={options.duelRule}
                  onChange={(e) => change("duelRule", +e.target.value)}
                >
                  {[1, 2, 3, 4, 5].map((v) => (
                    <option key={v} value={v}>
                      {v === 5 ? "MR2020" : `MR${v}`}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ["timeLimit", "时间（秒，0不限）", 0, 999],
                  ["startLp", "初始 LP", 1, 99999],
                  ["startHand", "初始手牌", 1, 40],
                  ["drawCount", "每回合抽牌", 0, 35],
                  ["mainMin", "Main 最小", 1, 200],
                  ["mainMax", "Main 最大", 1, 200],
                  ["extraMax", "Extra 最大", 0, 200],
                  ["sideMax", "Side 最大", 0, 200],
                ] as const
              ).map(([k, l, min, max]) => (
                <label key={k}>
                  {l}
                  <input
                    type="number"
                    required
                    min={min}
                    max={max}
                    value={options[k]}
                    onChange={(e) => change(k, +e.target.value)}
                  />
                </label>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={options.noCheck}
                  onChange={(e) => change("noCheck", e.target.checked)}
                />
                不检查卡组
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={options.noShuffle}
                  onChange={(e) => change("noShuffle", e.target.checked)}
                />
                不洗牌
              </label>
            </div>
          </section>
        )}
        <button className="primary" disabled={busy || !options}>
          {busy ? "连接中" : "创建 / 加入房间"}
        </button>
      </form>
    </main>
  );
}
