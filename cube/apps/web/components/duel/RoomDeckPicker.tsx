"use client";
import { useEffect, useState } from "react";
import type { BrowserDeck } from "@ygocube/shared";
import { readDecks, saveDeck, SavedDeck } from "./deck-cookie";
import { importYdk } from "./import-ydk";
export function RoomDeckPicker({
  disabled,
  onChoose,
  onError,
}: {
  disabled: boolean;
  onChoose: (deck: BrowserDeck) => void;
  onError: (message: string) => void;
}) {
  const [decks, setDecks] = useState<SavedDeck[]>([]),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const refresh = () => setDecks(readDecks());
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return (
    <fieldset disabled={disabled || loading} className="duel-room-deck">
      <legend>选择卡组</legend>
      <select
        aria-label="选择卡组"
        value=""
        onChange={(e) => {
          const deck = decks.find((d) => d.id === e.target.value);
          if (deck) onChoose(deck);
        }}
      >
        <option value="">选择已保存卡组</option>
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}（{d.main.length}/{d.extra.length}/{d.side.length}）
          </option>
        ))}
      </select>
      <label>
        上传 YDK
        <input
          type="file"
          accept=".ydk,.txt"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setLoading(true);
            try {
              if (f.size > 65536) throw Error("文件过大");
              const deck = await importYdk(await f.text(), f.name);
              saveDeck(deck);
              setDecks(readDecks());
              onChoose(deck);
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setLoading(false);
            }
          }}
        />
      </label>
      <a href="/duel/decks" target="_blank" rel="noreferrer">
        构筑卡组
      </a>
    </fieldset>
  );
}
