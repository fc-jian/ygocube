'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, setIdentityCookie, readIdentity } from '@/lib/api';

export default function 报名参加Page() {
  const params = useParams<{ tid: string }>();
  const tid = params.tid;
  const [info, setInfo] = useState<any>(null);
  const [playerId, setPlayerId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/t/${tid}`).then(setInfo).catch(() => setError('比赛不存在'));
  }, [tid]);

  const join = async () => {
    // 进房昵称即玩家 ID（YGOPro 协议仅支持 ASCII 文本），非 ASCII 无法进入游戏，前端先行拦截
    if (!/^[\x20-\x7E]+$/.test(playerId)) {
      setError('玩家 ID 只能包含 ASCII 字符（字母/数字/符号），中文等字符将无法进入游戏');
      return;
    }
    try {
      const r = await api<{ token: string }>(`/t/${tid}/join`, { method: 'POST', body: { player_id: playerId, display_name: displayName || playerId } });
      setToken(r.token);
      setIdentityCookie(tid, playerId, r.token);
    } catch (e: any) {
      setError(e.code ?? String(e));
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
            <p className="text-sm text-emerald-300">报名成功！请保存你的令牌（已同时保存到 cookie）：</p>
            <code className="block break-all rounded bg-felt-deep p-3 font-mono text-xs text-gold">{token}</code>
            <a href={`/t/${tid}/draft/${playerId}`} className="block rounded bg-gold px-4 py-2 text-center font-semibold text-felt-deep">
              进入我的页面
            </a>
          </div>
        ) : existing ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              已以 <b>{existing.pid}</b>.
            </p>
            <a href={`/t/${tid}/draft/${existing.pid}`} className="block rounded bg-gold px-4 py-2 text-center font-semibold text-felt-deep">
              进入我的页面
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
              placeholder="玩家 ID"
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
            />
            <input
              className="w-full rounded bg-felt-deep px-3 py-2 outline-none ring-gold/50 focus:ring-2"
              placeholder="显示名称（可选）"
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
