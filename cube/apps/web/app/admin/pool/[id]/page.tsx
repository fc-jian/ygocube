'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CardInfo } from '@/lib/types';
import { CardWithTooltip } from '@/components/CardImage';
import { isExtraDeckType } from '@/lib/cardInfo';

// 卡池编辑页（dev_docs/06 §5.7）：左侧按 main/extra 显示当前卡池，右侧搜索全卡，
// 拖拽/点击增删；保存需要 super admin 令牌。
export default function PoolEditorPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const isNew = params.id === 'new';
  const [adminToken, setAdminToken] = useState('');
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<Set<number>>(new Set());
  const [cardMap, setCardMap] = useState<Record<number, CardInfo>>({});
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CardInfo[]>([]);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [metaLoading, setMetaLoading] = useState(false);

  useEffect(() => {
    setAdminToken(localStorage.getItem('yc_admin_token') ?? '');
  }, []);

  const adminFetch = useCallback(
    async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { ...(adminToken ? { 'X-Admin-Token': encodeURIComponent(adminToken) } : {}), 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.code ?? `${res.status}`);
      return d;
    },
    [adminToken],
  );

  // 加载已有卡池 + 卡牌元数据
  useEffect(() => {
    if (!adminToken || isNew) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const pool = await adminFetch(`/admin/pools/${params.id}`);
        setName(pool.name);
        const list: number[] = pool.codes ?? [];
        setCodes(new Set(list));
        setMetaLoading(true);
        for (let i = 0; i < list.length; i += 500) {
          const chunk = list.slice(i, i + 500);
          const meta = await adminFetch(`/admin/cards?codes=${chunk.join(',')}`);
          const map: Record<number, CardInfo> = {};
          for (const c of meta) map[c.code] = c;
          setCardMap((m) => ({ ...m, ...map }));
        }
        setMetaLoading(false);
      } catch (e: any) {
        setMsg(e.message === 'AUTH_REQUIRED' ? '需要超级管理员令牌' : e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminToken, isNew, params.id, adminFetch]);

  const loadMeta = useCallback(
    async (list: number[]) => {
      const missing = list.filter((c) => !cardMap[c]);
      if (!missing.length) return;
      setMetaLoading(true);
      try {
        for (let i = 0; i < missing.length; i += 500) {
          const chunk = missing.slice(i, i + 500);
          const meta = await adminFetch(`/admin/cards?codes=${chunk.join(',')}`);
          const map: Record<number, CardInfo> = {};
          for (const c of meta) map[c.code] = c;
          setCardMap((m) => ({ ...m, ...map }));
        }
      } catch {
        // ignore metadata load errors
      } finally {
        setMetaLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminFetch],
  );

  const addCode = (code: number) => {
    setCodes((prev) => {
      const next = new Set(prev);
      next.add(code);
      void loadMeta([...next]);
      return next;
    });
  };

  const removeCode = (code: number) => {
    setCodes((prev) => {
      const next = new Set(prev);
      next.delete(code);
      return next;
    });
  };

  const search = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      setResults(await adminFetch(`/admin/cards?q=${encodeURIComponent(q.trim())}`));
    } catch {
      setResults([]);
    }
  };

  const save = async () => {
    const list = [...codes];
    try {
      const body = { codes: list };
      const d = isNew ? await adminFetch('/admin/pools', 'POST', { name: name.trim() || '未命名卡池', ...body }) : await adminFetch(`/admin/pools/${params.id}`, 'PUT', body);
      setMsg(d.filtered > 0 ? `已保存，自动过滤 ${d.filtered} 张 token 卡` : '已保存');
      if (isNew) router.replace(`/admin/pool/${d.id}`);
    } catch (e: any) {
      setMsg(e.message === 'POOL_EXISTS' ? '卡池名称已存在' : e.message);
    }
  };

  const metaMissing = [...codes].filter((c) => !cardMap[c]).length;
  const main = [...codes].filter((c) => cardMap[c] && !isExtraDeckType(cardMap[c].type));
  const extra = [...codes].filter((c) => cardMap[c] && isExtraDeckType(cardMap[c].type));

  const zoneDrop = (e: React.DragEvent, toMain: boolean) => {
    e.preventDefault();
    const code = Number(e.dataTransfer.getData('text/plain'));
    if (!code) return;
    const kind = e.dataTransfer.getData('application/x-pool-card');
    if (kind === 'search') addCode(code);
  };

  if (loading) return <main className="p-8 text-slate-400">加载中...</main>;
  if (metaLoading || metaMissing > 0) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        加载卡牌信息中（{metaMissing} 张待解析）...
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-felt-edge bg-felt px-4 py-2 text-sm text-slate-200">
        <span className="flex items-center gap-3">
          <a href="/admin" className="rounded bg-felt-edge px-2 py-0.5 text-xs hover:brightness-110">
            返回管理台
          </a>
          {isNew ? (
            <input
              className="rounded bg-felt-deep px-2 py-1 text-sm outline-none ring-gold/50 focus:ring-2"
              placeholder="卡池名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : (
            <b className="text-gold">{name}</b>
          )}
          <span className="text-xs text-slate-400">{codes.size} 张卡</span>
        </span>
        <span className="flex items-center gap-2">
          {msg && <span className="text-xs text-amber-300">{msg}</span>}
          <button onClick={save} className="rounded bg-gold px-4 py-1.5 text-sm font-semibold text-felt-deep hover:brightness-110">
            保存
          </button>
        </span>
      </header>
      <div className="flex flex-1 gap-3 overflow-hidden p-3">
        <div className="flex w-3/5 flex-col gap-2 overflow-y-auto pr-1">
          {(['main', 'extra'] as const).map((zone) => {
            const list = zone === 'main' ? main : extra;
            return (
              <section
                key={zone}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => zoneDrop(e, zone === 'main')}
                className="rounded-lg border border-felt-edge bg-felt/60 p-2"
              >
                <header className="mb-1 flex items-center justify-between text-xs text-slate-300">
                  <span className="font-semibold">{zone === 'main' ? '主卡组' : '额外卡组'}</span>
                  <span className="font-mono text-gold">{list.length}</span>
                </header>
                <div className="card-grid">
                  {list.map((c) => (
                    <div
                      key={c}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', String(c));
                        e.dataTransfer.setData('application/x-pool-card', 'pool');
                      }}
                      className="group relative cursor-grab active:cursor-grabbing"
                    >
                      <CardWithTooltip code={c} card={cardMap[c]} />
                      <button
                        onClick={() => removeCode(c)}
                        className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-red-900 text-[9px] text-red-100 group-hover:flex"
                        title="从卡池移除"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-1 rounded border border-dashed border-felt-edge py-0.5 text-center text-[0.625rem] text-slate-500">
                  拖入搜索到的卡牌以加入
                </div>
              </section>
            );
          })}
        </div>
        <aside className="flex flex-1 flex-col gap-2 overflow-y-auto">
          <div className="rounded-lg border border-felt-edge bg-felt/60 p-2">
            <header className="mb-1 text-xs font-semibold text-slate-300">搜索全部卡牌（点击或拖入左侧加入）</header>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded bg-felt-deep px-2 py-1 text-xs outline-none ring-gold/50 focus:ring-2"
                placeholder="按名称或编号搜索"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void search()}
              />
              <button onClick={() => void search()} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
                搜索
              </button>
            </div>
            <ul className="mt-2 space-y-0.5">
              {results.map((c) => {
                const inPool = codes.has(c.code);
                return (
                  <li
                    key={c.code}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(c.code));
                      e.dataTransfer.setData('application/x-pool-card', 'search');
                    }}
                    className={`flex cursor-grab items-center gap-2 rounded px-1.5 py-1 active:cursor-grabbing ${inPool ? 'bg-emerald-950/40' : 'bg-felt-deep/60'}`}
                  >
                    <CardWithTooltip code={c.code} card={c} className="h-9 w-7 shrink-0" />
                    <span className="flex-1 truncate text-xs">{c.name}</span>
                    <span className="font-mono text-[0.625rem] text-slate-500">{c.code}</span>
                    {inPool ? (
                      <span className="text-[0.625rem] text-emerald-400">已在池中</span>
                    ) : (
                      <button onClick={() => addCode(c.code)} className="rounded bg-gold px-2 py-0.5 text-[0.625rem] font-semibold text-felt-deep hover:brightness-110">
                        加入
                      </button>
                    )}
                  </li>
                );
              })}
              {q.trim() && results.length === 0 && <li className="text-[0.625rem] text-slate-500">未找到匹配的卡牌</li>}
            </ul>
          </div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const code = Number(e.dataTransfer.getData('text/plain'));
              const kind = e.dataTransfer.getData('application/x-pool-card');
              if (code && kind === 'pool') removeCode(code);
            }}
            className="flex min-h-16 items-center justify-center rounded-lg border-2 border-dashed border-red-900/60 bg-red-950/20 text-xs text-red-300"
          >
            将左侧卡牌拖到这里移除
          </div>
        </aside>
      </div>
    </main>
  );
}
