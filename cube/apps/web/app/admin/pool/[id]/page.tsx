'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CardInfo } from '@/lib/types';
import { apiErrorCode, readableApiError } from '@/lib/api';
import { CardWithTooltip } from '@/components/CardImage';
import { isExtraDeckType, sortCardCodes, sortCardSearchResults } from '@/lib/cardInfo';

// 卡池编辑页（dev_docs/06 §5.7）：左侧按 main/extra 显示当前卡池，右侧搜索全卡，
// 拖拽/点击增删；保存需要 super admin 令牌。
export default function PoolEditorPage() {
  const params = useParams<{ id: string }>()!;
  const [adminToken, setAdminToken] = useState<string | null>(null);
  useEffect(() => {
    try { setAdminToken(sessionStorage.getItem('yc_super_token') ?? ''); }
    catch { setAdminToken(''); }
  }, []);
  if (adminToken === null) return <main className="p-8 text-slate-400">加载中…</main>;
  if (!adminToken) return <main className="p-8">需要超级管理员令牌。<a className="text-gold underline" href="/admin">返回管理台</a></main>;
  return <PoolEditor key={params.id} id={params.id} adminToken={adminToken} />;
}

function PoolEditor({ id, adminToken }: { id: string; adminToken: string }) {
  const router = useRouter();
  const isNew = id === 'new';
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<number[]>([]);
  const [physicalCopies, setPhysicalCopies] = useState(false);
  const [cardMap, setCardMap] = useState<Record<number, CardInfo>>({});
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CardInfo[]>([]);
  const [msg, setMsg] = useState('');
  const [saveReport, setSaveReport] = useState<{ filtered: number; missingCodes: number[]; candidateRemovedCodes: number[] } | null>(null);
  const [candidateCount, setCandidateCount] = useState(0);
  const [ready, setReady] = useState(isNew);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [metaAttempt, setMetaAttempt] = useState(0);
  const refreshAll = useRef(false);
  const [metaError, setMetaError] = useState('');
  const [saving, setSaving] = useState(false);
  const knownCards = useRef<Record<number, CardInfo>>({});
  const [metaLoading, setMetaLoading] = useState(false);

  const adminFetch = useCallback(
    async (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => {
      const res = await fetch(`/api${path}`, {
        method, signal,
        headers: { ...(adminToken ? { 'X-Admin-Token': encodeURIComponent(adminToken) } : {}), 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.code ?? `${res.status}`);
      return d;
    },
    [adminToken],
  );

  useEffect(() => {
    if (isNew) return;
    const controller = new AbortController();
    setLoadError('');
    void (async () => {
      try {
        const pool = await adminFetch(`/admin/pools/${id}`, 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (pool.id !== Number(id) || !Array.isArray(pool.codes) || !pool.codes.every(Number.isSafeInteger)) {
          throw new Error('INVALID_POOL_RESPONSE');
        }
        setName(pool.name);
        setCodes(pool.codes);
        setPhysicalCopies(pool.draftFormat === 'edison_e3');
        setCandidateCount(Number(pool.candidateCodes?.length ?? pool.candidateCount ?? 0));
        setReady(true);
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(apiErrorCode(e) === 'AUTH_REQUIRED'
          ? '需要超级管理员令牌' : readableApiError(e, '卡池加载失败'));
      }
    })();
    return () => controller.abort();
  }, [adminFetch, id, isNew, loadAttempt]);

  const mergeCards = useCallback((rows: CardInfo[]) => {
    const next = { ...knownCards.current };
    for (const card of rows) next[card.code] = card;
    knownCards.current = next;
    setCardMap(next);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = async (all: boolean) => {
      if (busy) return;
      const list = [...new Set(codes)].filter((code) => all || !knownCards.current[code]);
      if (!list.length) {
        setMetaError('');
        setMetaLoading(false);
        return;
      }
      busy = true;
      setMetaLoading(true);
      try {
        for (let i = 0; i < list.length; i += 500) {
          const chunk = list.slice(i, i + 500);
          const rows = await adminFetch(`/admin/cards?pool_id=${encodeURIComponent(id)}&codes=${chunk.join(',')}`, 'GET', undefined, controller.signal);
          if (controller.signal.aborted) return;
          mergeCards(rows);
        }
        setMetaError('');
      } catch (e) {
        if (!controller.signal.aborted) setMetaError(readableApiError(e, '卡牌资料加载失败'));
      } finally {
        busy = false;
        if (!controller.signal.aborted) setMetaLoading(false);
      }
    };
    void refresh(refreshAll.current);
    refreshAll.current = false;
    const timer = window.setInterval(() => {
      if (!isNew && !document.hidden) void refresh(true);
    }, 30000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [adminFetch, codes, id, isNew, mergeCards, metaAttempt, ready]);

  const addCode = (code: number) => {
    const card = results.find((row) => row.code === code);
    if (card) mergeCards([card]);
    setCodes((prev) => physicalCopies || !prev.includes(code) ? [...prev, code] : prev);
  };

  const removeCode = (code: number) => {
    setCodes((prev) => {
      const index = prev.indexOf(code);
      return index < 0 ? prev : [...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  };

  const search = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      setResults(sortCardSearchResults(await adminFetch(`/admin/cards?pool_id=${encodeURIComponent(id)}&q=${encodeURIComponent(q.trim())}`), q));
    } catch {
      setResults([]);
    }
  };

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    const list = [...codes];
    try {
      const body = { codes: list };
      const d = isNew ? await adminFetch('/admin/pools', 'POST', { name: name.trim() || '未命名卡池', ...body }) : await adminFetch(`/admin/pools/${id}`, 'PUT', body);
      const report = {
        filtered: Number(d.filtered ?? 0),
        missingCodes: d.missingCodes ?? [],
        candidateRemovedCodes: d.candidateRemovedCodes ?? [],
      };
      setSaveReport(report);
      setMsg(report.missingCodes.length > 0
        ? `已保存，但 ${report.missingCodes.length} 个编号未找到`
        : (report.candidateRemovedCodes.length > 0
          ? `已保存，并从候选池移除 ${report.candidateRemovedCodes.length} 张重复卡`
          : (report.filtered > 0 ? `已保存，自动过滤 ${report.filtered} 张 token 卡` : '已保存')));
      setCandidateCount((count) => Math.max(0, count - report.candidateRemovedCodes.length));
      if (isNew) router.replace(`/admin/pool/${d.id}`);
    } catch (e: any) {
      setMsg(apiErrorCode(e) === 'POOL_EXISTS' ? '卡池名称已存在' : readableApiError(e, '保存卡池失败'));
    } finally {
      setSaving(false);
    }
  };

  const unresolved = codes.filter((code) => !cardMap[code]);
  const main = [...codes].filter((c) => cardMap[c] && !isExtraDeckType(cardMap[c].type));
  const extra = [...codes].filter((c) => cardMap[c] && isExtraDeckType(cardMap[c].type));

  const zoneDrop = (e: React.DragEvent, toMain: boolean) => {
    e.preventDefault();
    const code = Number(e.dataTransfer.getData('text/plain'));
    if (!code) return;
    const kind = e.dataTransfer.getData('application/x-pool-card');
    if (kind === 'search') addCode(code);
  };

  if (!ready) return (
    <main className="space-y-3 p-8 text-slate-300">
      <a href="/admin" className="text-gold underline">返回管理台</a>
      {loadError ? <div role="alert">{loadError} <button className="underline" onClick={() => setLoadAttempt((n) => n + 1)}>重试</button></div>
        : <p role="status">加载卡池中…</p>}
    </main>
  );

  return (
    <main className="flex min-h-screen flex-col md:h-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-felt-edge bg-felt px-4 py-2 text-sm text-slate-200">
        <span className="flex flex-wrap items-center gap-3">
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
          <span className="text-xs text-slate-400">{codes.length} 张卡 · 候选 {candidateCount} 张</span>
          {!isNew && (
            <a
              href={`/pool/${encodeURIComponent(name)}/candidate`}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-felt-edge px-2 py-0.5 text-xs text-cyan-200 hover:brightness-110"
            >
              查看候选池
            </a>
          )}
          <button
            onClick={() => setCodes(sortCardCodes(codes, cardMap, 'lv'))}
            className="rounded bg-felt-edge px-2 py-0.5 text-xs hover:brightness-110"
            title="按 YGOPro 卡组编辑器整理顺序排列主卡与额外卡"
          >
            整理卡表
          </button>
        </span>
        <span className="flex items-center gap-2">
          {msg && <span className="text-xs text-amber-300">{msg}</span>}
          <button onClick={save} disabled={saving} className="rounded bg-gold px-4 py-1.5 text-sm font-semibold text-felt-deep hover:brightness-110">
            {saving ? '保存中…' : '保存'}
          </button>
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-3 p-3 md:flex-row md:overflow-hidden">
        <div className="flex w-full flex-col gap-2 md:w-3/5 md:overflow-y-auto md:pr-1">
          {(unresolved.length > 0 || metaError) && (
            <section className="rounded border border-amber-900 p-2 text-xs text-amber-200">
              <span role="status">{metaError || (metaLoading ? '正在加载卡牌资料' : '暂无卡牌资料')} · {unresolved.length} 张待解析</span>
              <button disabled={metaLoading} onClick={() => { refreshAll.current = unresolved.length === 0; setMetaAttempt((n) => n + 1); }} className="ml-2 underline">重试</button>
              {unresolved.length > 0 && !metaLoading && <ul className="mt-1 flex flex-wrap gap-2">
                {unresolved.map((code, index) => <li key={`${code}-${index}`}>{code} <button className="underline" onClick={() => removeCode(code)}>移除</button></li>)}
              </ul>}
            </section>
          )}
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
                  {list.map((c, index) => (
                    <div
                      key={`${c}-${index}`}
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
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-900 text-[10px] text-red-100 md:hidden md:group-hover:flex"
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
        <aside className="flex flex-1 flex-col gap-2 md:overflow-y-auto">
          <div className="rounded-lg border border-felt-edge bg-felt/60 p-2">
            <header className="mb-1 text-xs font-semibold text-slate-300">搜索全部卡牌（点击或拖入左侧加入）</header>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded bg-felt-deep px-2 py-1 text-xs outline-none ring-gold/50 focus:ring-2"
                placeholder="按名称、编号、效果或字段搜索（空格分隔多个关键词）"
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
                const inPool = codes.includes(c.code);
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
                    {inPool && !physicalCopies ? (
                      <span className="text-[0.625rem] text-emerald-400">已在池中</span>
                    ) : (
                      <button onClick={() => addCode(c.code)} className="rounded bg-gold px-2 py-0.5 text-[0.625rem] font-semibold text-felt-deep hover:brightness-110">
                        {inPool ? `增加一张（已有 ${codes.filter((code) => code === c.code).length}）` : '加入'}
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
      {saveReport && (saveReport.filtered > 0 || saveReport.missingCodes.length > 0 || saveReport.candidateRemovedCodes.length > 0) && (
        <div className="yc-notice fixed bottom-4 left-4 right-4 z-50 p-3 text-xs shadow-2xl sm:left-auto sm:max-w-lg" role="alert">
          <button onClick={() => setSaveReport(null)} className="float-right rounded px-1.5" aria-label="关闭保存报告">×</button>
          <b className="block">卡池保存报告</b>
          {saveReport.missingCodes.length > 0 && <p className="mt-1 break-all">未找到并跳过：<code>{saveReport.missingCodes.join(', ')}</code></p>}
          {saveReport.filtered > 0 && <p className="mt-1">已过滤 {saveReport.filtered} 张 token 卡。</p>}
          {saveReport.candidateRemovedCodes.length > 0 && <p className="mt-1 break-all">因加入主卡池而从候选池移除：<code>{saveReport.candidateRemovedCodes.join(', ')}</code></p>}
        </div>
      )}
    </main>
  );
}
