'use client';

import { useEffect, useState } from 'react';
import { clearIdentityCookies } from '@/lib/api';
import { getDirHandle, removeDirHandle, saveDirHandle } from '@/lib/pics';



export function IdentityWidget({ tid, pid, token }: { tid?: string; pid?: string; token?: string }) {
  const [showToken, setShowToken] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);

  const logout = () => {
    if (tid) clearIdentityCookies(tid);
    else clearIdentityCookies();
    setLoggedOut(true);
  };

  if (loggedOut) {
    return (
      <span className="text-xs text-slate-400">
        已退出 — <a href={`/t/${tid}`} className="text-gold underline">重新输入令牌</a>
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
      <span>
        玩家：<span className="font-mono text-slate-100">{pid ?? '-'}</span>
      </span>
      {token ? (
        <button onClick={() => setShowToken((v) => !v)} className="rounded bg-felt px-2 py-1 hover:bg-felt-edge" title="显示/隐藏令牌">
          令牌：<span className="font-mono">{showToken ? token : '••••••••'}</span>
        </button>
      ) : (
        <span className="text-slate-500">无身份信息</span>
      )}
      <span className="text-slate-500">比赛 {tid ?? '-'}</span>
      <button onClick={logout} className="rounded bg-felt-edge px-2 py-1 hover:bg-red-900 hover:text-red-100" title="退出登录（清除令牌）">
        退出登录
      </button>
    </div>
  );
}

export function LocalPicsSetting() {
  const [bound, setBound] = useState<string | null>(null);
  const [bindError, setBindError] = useState('');

  useEffect(() => {
    getDirHandle().then((h) => setBound(h ? h.name : null)).catch(() => setBound(null));
  }, []);

  const bind = async () => {
    try {
      const w = window as any;
      if (!w.showDirectoryPicker) {
        setBindError('当前浏览器不支持目录授权，请使用 Chrome/Edge 或手动填写路径');
        return;
      }
      const handle = await w.showDirectoryPicker();
      await saveDirHandle(handle);
      setBound(handle.name);
      setBindError('');
    } catch (e: any) {
      if (e?.name !== 'AbortError') setBindError('绑定失败：' + String(e?.message ?? e));
    }
  };

  const unbind = async () => {
    await removeDirHandle();
    setBound(null);
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      {bound ? (
        <span className="text-emerald-300">
          已绑定：{bound}
          <button onClick={unbind} className="ml-2 rounded bg-felt-edge px-2 py-0.5 hover:bg-red-900 hover:text-red-100">
            解绑
          </button>
        </span>
      ) : (
        <button onClick={bind} className="rounded bg-gold px-2 py-0.5 font-semibold text-felt-deep hover:brightness-110">
          绑定本地图像目录
        </button>
      )}
      {bindError && <span className="text-red-300">{bindError}</span>}
    </div>
  );
}
