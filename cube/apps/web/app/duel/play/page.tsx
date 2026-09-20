"use client";
import { useEffect, useState } from "react";
import { DuelClient } from "@/components/duel/DuelClient";
export default function Page() {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    try {
      setS(JSON.parse(sessionStorage.getItem("yc_standalone") || "null"));
    } catch {}
  }, []);
  return s ? (
    <>
      <details style={{ padding: "8px 16px" }}>
        <summary>
          房间规则 · {s.options.mode ? "三局两胜" : "单局"}
          {s.options.timeLimit ? ` · ${s.options.timeLimit} 秒` : ""}
        </summary>
        <p>
          主卡 {s.options.mainMin}–{s.options.mainMax} · 额外{" "}
          {s.options.extraMax} · 副卡 {s.options.sideMax}
          <br />
          禁限卡表 {s.options.lflist} · 大师规则 {s.options.duelRule} · 初始生命{" "}
          {s.options.startLp} · 初始手牌 {s.options.startHand} · 每回合抽卡{" "}
          {s.options.drawCount}
        </p>
      </details>
      <DuelClient credential={s.credential} />
    </>
  ) : (
    <main>
      <a href="/duel">返回建房</a>
    </main>
  );
}
