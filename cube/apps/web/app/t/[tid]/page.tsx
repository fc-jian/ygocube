'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, encodePathSegment, readableApiError, setIdentityCookie, readIdentity } from '@/lib/api';

export default function 报名参加Page() {
  const params = useParams<{ tid: string }>();
  const router = useRouter();
  const tid = params.tid;
  const tidPath = encodePathSegment(tid);
  const [info, setInfo] = useState<any>(null);
  const [playerId, setPlayerId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/t/${tidPath}`).then(setInfo).catch(() => setError('比赛不存在'));
  }, [tidPath]);

  const join = async () => {
    const normalizedPlayerId = playerId.trim();
    if (!normalizedPlayerId) {
      setError('请输入玩家 ID');
      return;
    }
    // 进房昵称即玩家 ID（YGOPro 协议仅支持 ASCII 文本），非 ASCII 无法进入游戏，前端先行拦截
    if (!/^[\x20-\x7E]{1,19}$/.test(normalizedPlayerId) || normalizedPlayerId.includes('$')) {
      setError('玩家 ID 需为 1–19 个 ASCII 字符，且不能包含 $（YGOPro 协议限制）');
      return;
    }

    // A player changing devices has no token cookie, but the public tournament
    // summary still knows that the ID is already registered. Do not call join
    // (which correctly rejects duplicates/full rooms); send them to the player
    // page where the token prompt can authenticate the existing registration.
    let currentInfo = info;
    if (!currentInfo) {
      try {
        currentInfo = await api(`/t/${tidPath}`);
      } catch {
        currentInfo = null;
      }
    }
    if (currentInfo?.players?.some((p: { playerId: string }) => p.playerId === normalizedPlayerId)) {
      router.push(`/t/${tidPath}/draft/${encodePathSegment(normalizedPlayerId)}`);
      return;
    }

    try {
      const r = await api<{ token: string }>(`/t/${tidPath}/join`, { method: 'POST', body: { player_id: normalizedPlayerId, display_name: displayName || normalizedPlayerId } });
      setToken(r.token);
      setIdentityCookie(tid, normalizedPlayerId, r.token);
    } catch (e: any) {
      // Handle a race where another view registered the same ID after the
      // public summary was loaded. Refresh once and use the same recovery path.
      if (e.code === 'ALREADY_JOINED' || e.code === 'TOURNAMENT_FULL') {
        try {
          const latest = await api<{ players?: { playerId: string }[] }>(`/t/${tidPath}`);
          if (latest.players?.some((p) => p.playerId === normalizedPlayerId)) {
            router.push(`/t/${tidPath}/draft/${encodePathSegment(normalizedPlayerId)}`);
            return;
          }
        } catch {
          // Keep the original API error below when the refresh fails.
        }
      }
      setError(readableApiError(e, '报名失败，请稍后重试'));
    }
  };

  const existing = readIdentity(tid);

  return (
    <main className="mx-auto mt-12 max-w-md px-4 sm:mt-20">
      <div className="yc-panel p-6 sm:p-8">
        <h1 className="mb-1 text-xl font-bold text-gold">{info?.name ?? '比赛'}</h1>
        <p className="mb-4 text-xs text-slate-400">
          {info?.playerCount}/{info?.config?.maxPlayers} 人 · 阶段： {info?.status}
        </p>
        {token ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-300">报名成功！请保存你的令牌（仅显示一次）：</p>
            <code className="block break-all rounded bg-felt-deep p-3 font-mono text-xs text-gold">{token}</code>
            <a href={`/t/${tidPath}/draft/${encodePathSegment(playerId.trim())}`} className="block rounded bg-gold px-4 py-2 text-center font-semibold text-felt-deep">
              进入我的页面
            </a>
          </div>
        ) : existing ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              已登录：<b>{existing.pid}</b>。
            </p>
            <a href={`/t/${tidPath}/draft/${encodePathSegment(existing.pid)}`} className="block rounded bg-gold px-4 py-2 text-center font-semibold text-felt-deep">
              进入我的页面
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
              placeholder="玩家 ID"
              maxLength={19}
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
            />
            <input
              className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
              placeholder="显示名称（可选）"
              maxLength={64}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            {error && <p className="text-xs text-red-300">{error}</p>}
            <button onClick={join} className="w-full rounded bg-gold px-4 py-2 font-semibold text-felt-deep hover:brightness-110">
              报名参加
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
