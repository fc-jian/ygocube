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
          房间实际规则 / Room rules · {s.options.mode ? "BO3" : "Single"} ·{" "}
          {s.options.timeLimit}s · Main {s.options.mainMin}–{s.options.mainMax}{" "}
          / Extra {s.options.extraMax} / Side {s.options.sideMax}
        </summary>
        <p>
          Banlist {s.options.lflist} · MR {s.options.duelRule} · LP{" "}
          {s.options.startLp} · Hand {s.options.startHand} · Draw{" "}
          {s.options.drawCount}
        </p>
      </details>
      <DuelClient credential={s.credential} />
    </>
  ) : (
    <main>
      <a href="/duel">返回建房 / Join a room</a>
    </main>
  );
}
