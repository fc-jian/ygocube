'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, Identity, resolvePlayerIdentity } from '@/lib/api';
import { useTournamentStream } from '@/lib/sse';
import { TokenPrompt } from '@/components/TokenPrompt';

interface RankRow {
  rank: number;
  playerId: string;
  displayName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  gameDiff: number;
  omw: number;
  oppPoints: number;
}

// 实时积分榜单（dev_docs/07 §2.4）：胜 3 分 / 平 1 分 / 负 0 分，OMW% 破同分
export default function RankingPage() {
  const params = useParams<{ tid: string; pid: string }>();
  const tid = params.tid;
  const pid = params.pid;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [rows, setRows] = useState<RankRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api<{ authRequired: boolean }>(`/t/${tid}`, { identity: null });
        if (!cancelled) {
          if (info.authRequired === false) {
            setIdentity({ tid, pid, token: '' });
          } else {
            const r = resolvePlayerIdentity(tid, pid);
            if ('needToken' in r) setNeedToken(true);
            else setIdentity(r.identity);
          }
        }
      } catch {
        if (!cancelled) setIdentity(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tid, pid]);

  const load = useCallback(async () => {
    if (!identity) return;
    try {
      setRows(await api<RankRow[]>(`/t/${tid}/ranking`, { identity }));
    } catch (e: any) {
      if (e.code === 'AUTH_REQUIRED') {
        setIdentity(null);
        setNeedToken(true);
      }
    }
  }, [tid, identity]);

  useEffect(() => {
    void load();
  }, [load]);

  useTournamentStream(tid, identity, useCallback(() => void load(), [load]));

  // 榜单随对局结果实时刷新（SSE + 5 秒轮询兜底）
  useEffect(() => {
    if (!identity) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [identity, load]);

  if (needToken) return <TokenPrompt tid={tid} pid={pid} onToken={(t) => { setNeedToken(false); setIdentity({ tid, pid, token: t }); }} />;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gold">积分榜单 <span className="text-sm font-normal text-slate-400">（{pid}）</span></h1>
        <a href={`/t/${tid}/matches/${encodeURIComponent(pid)}`} className="rounded bg-felt-edge px-3 py-1.5 text-sm text-gold hover:brightness-110">
          返回对战页
        </a>
      </div>
      <table className="w-full overflow-hidden rounded-lg border border-felt-edge text-sm">
        <thead className="bg-felt text-left text-xs text-slate-400">
          <tr>
            <th className="px-3 py-2">排名</th>
            <th className="px-3 py-2">玩家</th>
            <th className="px-3 py-2">场次</th>
            <th className="px-3 py-2">胜 / 平 / 负</th>
            <th className="px-3 py-2">积分</th>
            <th className="px-3 py-2">净胜</th>
            <th className="px-3 py-2">OMW%</th>
          </tr>
        </thead>
        <tbody className="bg-felt/60">
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                暂无对局结果
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.playerId} className={`border-t border-felt-edge ${r.playerId === pid ? 'bg-gold/10' : ''}`}>
              <td className="px-3 py-2 font-mono">{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</td>
              <td className="px-3 py-2 font-semibold">{r.displayName}</td>
              <td className="px-3 py-2">{r.played}</td>
              <td className="px-3 py-2 font-mono">{r.wins} / {r.draws} / {r.losses}</td>
              <td className="px-3 py-2 font-mono font-semibold text-gold">{r.points}</td>
              <td className="px-3 py-2 font-mono">{r.gameDiff > 0 ? '+' : ''}{r.gameDiff}</td>
              <td className="px-3 py-2 font-mono text-slate-400">{Math.round(r.omw * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-500">计分：胜 3 分、平 1 分、负 0 分；同分按净胜局 → 对手胜率（OMW%）→ 对手积分排序。榜单随对局结果实时更新。</p>
    </main>
  );
}
