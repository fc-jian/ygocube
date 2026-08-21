'use client';

import { useEffect, useState } from 'react';
import { clearIdentityCookies } from '@/lib/api';
import { getDirHandle, removeDirHandle, saveDirHandle } from '@/lib/pics';



export function IdentityWidget({
  tid,
  pid,
  token,
  displayName,
  canEditDisplayName = false,
  onDisplayNameChange,
}: {
  tid?: string;
  pid?: string;
  token?: string;
  displayName?: string;
  canEditDisplayName?: boolean;
  onDisplayNameChange?: (displayName: string) => Promise<void>;
}) {
  const [showToken, setShowToken] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName ?? '');
  const [nameError, setNameError] = useState('');
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    if (!editingName) setNameDraft(displayName ?? '');
  }, [displayName, editingName]);

  const logout = () => {
    if (tid) clearIdentityCookies(tid);
    else clearIdentityCookies();
    setLoggedOut(true);
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next) {
      setNameError('显示名称不能为空');
      return;
    }
    if ([...next].length > 64) {
      setNameError('显示名称不能超过 64 个字符');
      return;
    }
    if (!onDisplayNameChange) return;
    setSavingName(true);
    setNameError('');
    try {
      await onDisplayNameChange(next);
      setEditingName(false);
    } catch (e: any) {
      const code = e?.code;
      setNameError(code === 'WRONG_PHASE' ? '选牌已开始，无法再修改显示名称' : code === 'AUTH_REQUIRED' ? '身份已失效，请重新输入令牌' : code === 'BAD_DISPLAY_NAME' ? '显示名称格式不合法' : (code ?? '名称修改失败'));
    } finally {
      setSavingName(false);
    }
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
      {canEditDisplayName && onDisplayNameChange && (
        editingName ? (
          <form
            className="flex flex-wrap items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <label className="sr-only" htmlFor="yc-display-name">显示名称</label>
            <input
              id="yc-display-name"
              className="w-32 rounded bg-felt-deep px-2 py-1 text-xs text-slate-100 outline-none ring-gold/50 focus:ring-2"
              value={nameDraft}
              maxLength={64}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              disabled={savingName}
            />
            <button type="submit" className="rounded bg-gold px-2 py-1 font-semibold text-felt-deep hover:brightness-110 disabled:opacity-50" disabled={savingName}>
              {savingName ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="rounded bg-felt-edge px-2 py-1 hover:brightness-110 disabled:opacity-50"
              onClick={() => {
                setEditingName(false);
                setNameError('');
              }}
              disabled={savingName}
            >
              取消
            </button>
            {nameError && <span className="basis-full text-red-300">{nameError}</span>}
          </form>
        ) : (
          <button
            type="button"
            className="rounded bg-felt-edge px-2 py-1 hover:brightness-110"
            title="选牌开始前可修改显示名称"
            onClick={() => {
              setNameDraft(displayName ?? '');
              setNameError('');
              setEditingName(true);
            }}
          >
            名称：<span className="text-slate-100">{displayName || pid || '-'}</span> <span className="text-gold">✎</span>
          </button>
        )
      )}
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
