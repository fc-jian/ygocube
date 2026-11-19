'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, readIdentity, Identity, readableApiError } from '@/lib/api';
import { CardInfo } from '@/lib/types';
import { isExtraDeckType, sortCardSearchResults } from '@/lib/cardInfo';
import { CardWithTooltip } from '@/components/CardImage';
import { LocalPicsSetting } from '@/components/IdentityWidget';

interface CandidatePool {
  poolId: number;
  poolName: string;
  poolCount: number;
  candidateCount: number;
  codes: number[];
}

type CandidateCard = CardInfo & {
  poolStatus?: 'not_in_pool' | 'in_pool' | 'in_candidate';
  inCandidate?: boolean;
};

const IDENTITY_STORAGE_KEY = 'yc_candidate_identity';

function statusLabel(status: CandidateCard['poolStatus']): string {
  if (status === 'in_pool') return '已在主卡池中';
  if (status === 'in_candidate') return '已在候选池中';
  return '未包含';
}

export default function CandidatePoolPage() {
  const params = useParams<{ name: string }>();
  const name = params.name ?? '';
  const encodedName = useMemo(() => encodeURIComponent(name), [name]);
  const [pool, setPool] = useState<CandidatePool | null>(null);
  const [cardMap, setCardMap] = useState<Record<number, CardInfo>>({});
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CandidateCard[]>([]);
  const [identity, setIdentity] = useState<Identity>({ tid: '', pid: '', token: '' });
  const [loading, setLoading] = useState(true);
  const [metaLoading, setMetaLoading] = useState(false);
  const [addingCode, setAddingCode] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(IDENTITY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<Identity>;
        if (typeof parsed.tid === 'string' && typeof parsed.pid === 'string' && typeof parsed.token === 'string') {
          setIdentity({ tid: parsed.tid, pid: parsed.pid, token: parsed.token });
          return;
        }
      }
    } catch {
      // Ignore malformed session data and try the regular player cookie below.
    }
    const current = readIdentity();
    if (current) setIdentity(current);
  }, []);

  const loadCardMetadata = useCallback(async (codes: number[], replace = false) => {
    const merged: Record<number, CardInfo> = {};
    for (let i = 0; i < codes.length; i += 400) {
      const chunk = codes.slice(i, i + 400);
      const cards = await api<CardInfo[]>(`/pools/${encodedName}/candidate/cards?codes=${chunk.join(',')}`, { identity: null });
      for (const card of cards) merged[card.code] = card;
    }
    setCardMap((current) => replace ? merged : { ...current, ...merged });
  }, [encodedName]);

  const loadCandidatePool = useCallback(async (initial = false) => {
    if (!encodedName) return;
    try {
      const next = await api<CandidatePool>(`/pools/${encodedName}/candidate`, { identity: null });
      setPool(next);
      setError('');
      setMetaLoading(true);
      await loadCardMetadata(next.codes, true);
    } catch (e: any) {
      setError(e?.code === 'POOL_NOT_FOUND' ? '卡池不存在或已被删除' : readableApiError(e, '候选池加载失败'));
    } finally {
      setMetaLoading(false);
      if (initial) setLoading(false);
    }
  }, [encodedName, loadCardMetadata]);

  useEffect(() => {
    setLoading(true);
    void loadCandidatePool(true);
  }, [loadCandidatePool]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCandidatePool(false);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadCandidatePool]);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    try {
      const payload = await api<unknown>(`/pools/${encodedName}/candidate/cards?q=${encodeURIComponent(q)}`, { identity: null });
      if (!Array.isArray(payload)) throw new Error('INVALID_CARD_RESPONSE');
      setResults(sortCardSearchResults(payload as CandidateCard[], q));
    } catch {
      setResults([]);
    }
  }, [encodedName, query]);

  const saveIdentity = (): Identity | null => {
    const next = {
      tid: identity.tid.trim(),
      pid: identity.pid.trim(),
      token: identity.token.trim(),
    };
    if (!next.tid || !next.pid || !next.token) {
      setMessage('请输入比赛 ID、玩家 ID 和令牌后再添加');
      return null;
    }
    setIdentity(next);
    try {
      sessionStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Session storage can be disabled; credentials still stay in memory.
    }
    return next;
  };

  const addCandidate = async (code: number) => {
    const auth = saveIdentity();
    if (!auth) return;
    setAddingCode(code);
    setMessage('');
    try {
      const result = await api<CandidatePool & {
        addedCodes: number[];
        alreadyCandidateCodes: number[];
        inPoolCodes: number[];
        missingCodes: number[];
        filtered: number;
      }>(`/pools/${encodedName}/candidate/cards`, {
        method: 'POST',
        identity: auth,
        body: { codes: [code] },
      });
      setPool(result);
      await loadCardMetadata(result.codes, true);
      if (result.addedCodes.includes(code)) setMessage(`已加入候选池：${code}`);
      else if (result.alreadyCandidateCodes.includes(code)) setMessage(`编号 ${code} 已在候选池中`);
      else if (result.inPoolCodes.includes(code)) setMessage(`编号 ${code} 已在主卡池中，不能加入`);
      else if (result.missingCodes.includes(code)) setMessage(`找不到编号 ${code}`);
      else if (result.filtered > 0) setMessage(`编号 ${code} 是 token 卡，不能加入`);
      else setMessage('候选池没有变化');
      await search();
    } catch (e: any) {
      const codeText = e?.code ?? e?.message;
      setMessage(codeText === 'AUTH_REQUIRED' ? '比赛身份无效，请检查比赛 ID、玩家 ID 和令牌' : readableApiError(e, '加入候选池失败'));
    } finally {
      setAddingCode(null);
    }
  };

  // Metadata failures must not make a previously accepted exact code vanish;
  // unknown legacy rows stay in the main candidate grid as placeholders.
  const candidateMain = pool?.codes.filter((code) => !cardMap[code] || !isExtraDeckType(cardMap[code].type)) ?? [];
  const candidateExtra = pool?.codes.filter((code) => cardMap[code] && isExtraDeckType(cardMap[code].type)) ?? [];

  if (loading) return <main className="mx-auto max-w-6xl p-6 text-slate-400">加载候选池中…</main>;
  if (error || !pool) {
    return (
      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <a href={`/pool/${encodedName}`} className="text-xs text-emerald-100/60 hover:text-gold">← 返回主卡池</a>
        <div className="yc-panel mt-8 p-6 text-red-200">{error || '候选池不存在'}</div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-felt-edge bg-felt px-4 py-3 sm:px-6">
        <div>
          <a href={`/pool/${encodedName}`} className="text-xs text-emerald-100/60 hover:text-gold">← 返回主卡池</a>
          <h1 className="yc-title mt-1 text-2xl font-bold">候选池：{pool.poolName}</h1>
          <p className="text-xs text-slate-400">{pool.candidateCount} 张候选卡 · 只能新增，不能删除 · 新增不会自动进入比赛</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LocalPicsSetting />
          <a href={`/pool/${encodedName}`} className="rounded bg-felt-edge px-3 py-1.5 text-xs text-slate-200 hover:brightness-110">查看主卡池</a>
        </div>
      </header>

      <section className="border-b border-felt-edge bg-felt/60 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-2">
          <div className="basis-full text-xs font-semibold text-slate-300">添加候选卡需要先验证比赛身份</div>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-slate-400">
            比赛 ID
            <input className="w-28 rounded bg-felt-deep px-2 py-1.5 text-xs text-slate-100 outline-none ring-gold/50 focus:ring-2" value={identity.tid} onChange={(e) => setIdentity((current) => ({ ...current, tid: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-slate-400">
            玩家 ID
            <input className="w-32 rounded bg-felt-deep px-2 py-1.5 text-xs text-slate-100 outline-none ring-gold/50 focus:ring-2" value={identity.pid} onChange={(e) => setIdentity((current) => ({ ...current, pid: e.target.value }))} />
          </label>
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-[0.6875rem] text-slate-400">
            玩家令牌
            <input type="password" className="w-full rounded bg-felt-deep px-2 py-1.5 font-mono text-xs text-slate-100 outline-none ring-gold/50 focus:ring-2" value={identity.token} onChange={(e) => setIdentity((current) => ({ ...current, token: e.target.value }))} />
          </label>
          {message && <span className="basis-full text-xs text-amber-200" role="status">{message}</span>}
        </div>
      </section>

      <div className="flex flex-1 flex-col gap-3 p-3 md:flex-row md:overflow-hidden">
        <div className="flex w-full flex-col gap-2 md:w-3/5 md:overflow-y-auto md:pr-1">
          {(['main', 'extra'] as const).map((zone) => {
            const codes = zone === 'main' ? candidateMain : candidateExtra;
            return (
              <section key={zone} className="rounded-lg border border-felt-edge bg-felt/60 p-2">
                <header className="mb-1 flex items-center justify-between text-xs text-slate-300">
                  <span className="font-semibold">{zone === 'main' ? '主卡组候选' : '额外卡组候选'}</span>
                  <span className="font-mono text-gold">{codes.length}</span>
                </header>
                <div className="card-grid">
                  {codes.map((code) => <CardWithTooltip key={code} code={code} card={cardMap[code]} />)}
                </div>
                {codes.length === 0 && <p className="py-4 text-center text-xs text-slate-500">暂无卡片</p>}
              </section>
            );
          })}
          {metaLoading && <p className="text-xs text-slate-500">正在更新卡片资料…</p>}
        </div>

        <aside className="flex flex-1 flex-col gap-2 md:overflow-y-auto">
          <div className="rounded-lg border border-felt-edge bg-felt/60 p-2">
            <header className="mb-1 text-xs font-semibold text-slate-300">搜索卡片并加入候选池</header>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded bg-felt-deep px-2 py-1.5 text-xs outline-none ring-gold/50 focus:ring-2"
                placeholder="名称、编号、效果、字段或系列（空格分隔多个关键词）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void search()}
              />
              <button onClick={() => void search()} className="rounded bg-felt-edge px-3 py-1.5 text-xs hover:brightness-110">搜索</button>
            </div>
            <ul className="mt-2 max-h-[min(36rem,65vh)] space-y-0.5 overflow-y-auto">
              {results.map((card) => {
                const status = card.poolStatus ?? 'not_in_pool';
                const isToken = (card.type & 0x4000) !== 0;
                const canAdd = status === 'not_in_pool' && !isToken;
                return (
                  <li key={card.code} className="flex items-center gap-2 rounded bg-felt-deep/60 px-1.5 py-1">
                    <CardWithTooltip code={card.code} card={card} className="h-10 w-7 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs">{card.name}</span>
                    <span className="font-mono text-[0.625rem] text-slate-500">{card.code}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[0.625rem] ${status === 'in_pool' ? 'bg-emerald-950 text-emerald-300' : status === 'in_candidate' ? 'bg-cyan-950 text-cyan-300' : 'bg-slate-800 text-slate-400'}`}>
                      {statusLabel(status)}
                    </span>
                    {isToken && <span className="text-[0.625rem] text-red-300">Token 卡不可加入</span>}
                    {canAdd && <button onClick={() => void addCandidate(card.code)} disabled={addingCode !== null} className="rounded bg-gold px-2 py-0.5 text-[0.625rem] font-semibold text-felt-deep hover:brightness-110 disabled:cursor-wait disabled:opacity-50">{addingCode === card.code ? '加入中…' : '加入'}</button>}
                  </li>
                );
              })}
              {query.trim() && results.length === 0 && <li className="text-[0.625rem] text-slate-500">未找到匹配的卡牌</li>}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
