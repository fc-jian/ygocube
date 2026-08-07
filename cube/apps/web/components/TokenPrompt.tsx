'use client';

import { useState } from 'react';
import { storeToken } from '@/lib/api';

// 玩家页面缺少令牌时的输入框（dev_docs/06 §6）。
// super admin token 在此同样可用作万能令牌。
export function TokenPrompt({ tid, pid, onToken }: { tid: string; pid: string; onToken: (token: string) => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    if (!token.trim()) {
      setError('请输入令牌');
      return;
    }
    storeToken(tid, pid, token.trim());
    onToken(token.trim());
  };

  return (
    <main className="mx-auto mt-24 max-w-md px-4">
      <div className="rounded-lg border border-felt-edge bg-felt p-6 shadow-2xl">
        <h1 className="mb-1 text-lg font-bold text-gold">请输入令牌</h1>
        <p className="mb-4 text-xs leading-relaxed text-slate-400">
          玩家 <b className="text-slate-200">{pid}</b> · 比赛 {tid}。令牌在报名时展示，也可让管理员重新获取。
        </p>
        <input
          className="w-full rounded bg-felt-deep px-3 py-2 font-mono outline-none ring-gold/50 focus:ring-2"
          placeholder="令牌"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
        <button onClick={submit} className="mt-4 w-full rounded bg-gold px-4 py-2 font-semibold text-felt-deep hover:brightness-110">
          进入
        </button>
      </div>
    </main>
  );
}
