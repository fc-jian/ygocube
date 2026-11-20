'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, readableApiError } from '@/lib/api';
import { CardInfo } from '@/lib/types';
import { safeCardCodes, sortCardSearchResults } from '@/lib/cardInfo';
import { buildPoolCsv } from '@/lib/poolCsv';
import { PoolPreview } from '@/components/PoolPreview';
import { EdisonDraftRules } from '@/components/EdisonDraftRules';
import { useCoalescedRefresh } from '@/lib/useCoalescedRefresh';
import type { PublicPoolPreview } from '@ygocube/shared';
import { LocalPicsSetting } from '@/components/IdentityWidget';

interface PoolSnapshot {
  pool: PublicPoolPreview;
  cards: Record<number, CardInfo>;
}

type PickSort = 'default' | 'pick_asc' | 'pick_desc';

export default function PublicPoolPage() {
  const params = useParams<{ name: string }>()!;
  return <PoolPage key={params.name} name={params.name} />;
}

function PoolPage({ name }: { name: string }) {
  const encodedName = encodeURIComponent(name);
  const [snapshot, setSnapshot] = useState<PoolSnapshot | null>(null);
  const cache = useRef<PoolSnapshot | null>(null);
  const pool = snapshot?.pool;
  const cardMap = snapshot?.cards ?? {};
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardInfo[]>([]);
  const [pickSort, setPickSort] = useState<PickSort>('default');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const { request: loadPool } = useCoalescedRefresh(useCallback(async ({ signal, isCurrent }) => {
    try {
      const raw = await api<PublicPoolPreview>(`/pools/${encodedName}`, { identity: null, signal });
      if (!isCurrent()) return;
      if (!Array.isArray(raw?.codes)) throw new Error('INVALID_POOL_RESPONSE');
      const next = { ...raw, codes: safeCardCodes(raw.codes) };
      const previous = cache.current;
      const reusable = previous && next.cardRevision && next.cardRevision === previous.pool.cardRevision && next.id === previous.pool.id
        ? previous : null;
      if (!reusable || JSON.stringify(next) !== JSON.stringify(reusable.pool)) {
        const retained = new Set(reusable?.pool.codes);
        const cards: Record<number, CardInfo> = {};
        const missing: number[] = [];
        for (const code of new Set(next.codes)) {
          if (!retained.has(code)) missing.push(code);
          else if (previous?.cards[code]) cards[code] = previous.cards[code];
        }
        for (let i = 0; i < missing.length; i += 400) {
          if (signal.aborted || document.hidden) return;
          const chunk = missing.slice(i, i + 400);
          const rows = await api<CardInfo[]>(`/pools/${encodedName}/cards?codes=${chunk.join(',')}`, { identity: null, signal });
          if (!isCurrent()) return;
          for (const card of rows) cards[card.code] = card;
        }
        cache.current = { pool: next, cards };
        setSnapshot(cache.current);
      }
      setError('');
      setLoading(false);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e.code === 'POOL_NOT_FOUND') {
        cache.current = null;
        setSnapshot(null);
      }
      setError(e.code === 'POOL_NOT_FOUND' ? '卡池不存在或已被删除' : readableApiError(e, '卡池加载失败'));
      setLoading(false);
    }
  }, [encodedName]));

  useEffect(() => {
    let inFlight = false;
    const refreshVisible = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try { await loadPool(); } finally { inFlight = false; }
    };
    void refreshVisible();
    const timer = window.setInterval(refreshVisible, 30000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [loadPool]);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    try {
      const payload = await api<unknown>(`/pools/${encodedName}/cards?q=${encodeURIComponent(q)}`, { identity: null });
      if (!Array.isArray(payload)) throw new Error('INVALID_CARD_RESPONSE');
      setResults(sortCardSearchResults(payload as CardInfo[], q));
    } catch {
      setResults([]);
    }
  }, [encodedName, query]);

  const missingCount = pool?.codes.filter((code) => !cardMap[code]).length ?? 0;
  const cardsReady = !!pool && missingCount === 0;
  const downloadCsv = useCallback(() => {
    if (!pool || !cardsReady) return;
    const csv = buildPoolCsv(pool.codes, cardMap);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `pool-${pool.name}.csv`;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [cardMap, cardsReady, pool]);

  const orderedCodes = useMemo(() => {
    if (!pool || pickSort === 'default') return pool?.codes ?? [];
    const originalIndex = new Map(pool.codes.map((code, index) => [code, index]));
    const statFor = (code: number) => cardMap[code]?.pickStats?.find((stat) => stat.poolId === pool.id);
    return [...pool.codes].sort((a, b) => {
      const aStat = statFor(a);
      const bStat = statFor(b);
      if (!aStat && !bStat) return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
      if (!aStat) return 1;
      if (!bStat) return -1;
      const difference = aStat.averagePickPercentage - bStat.averagePickPercentage;
      if (difference !== 0) return pickSort === 'pick_asc' ? difference : -difference;
      return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
    });
  }, [cardMap, pickSort, pool]);

  if (loading) return <main className="mx-auto max-w-6xl p-6 text-slate-400">加载卡池中…</main>;
  if (!pool) {
    return (
      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <a href="/" className="text-xs text-emerald-100/60 hover:text-gold">← 返回首页</a>
        <div className="yc-panel mt-8 p-6 text-red-200">{error || '卡池不存在'} <button className="underline" onClick={() => void loadPool()}>重试</button></div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-felt-edge bg-felt px-4 py-3 sm:px-6">
        <div>
          <a href="/" className="text-xs text-emerald-100/60 hover:text-gold">← 返回首页</a>
          <h1 className="yc-title mt-1 text-2xl font-bold">卡池：{pool.name}</h1>
          <p className="text-xs text-slate-400">{pool.count} 张卡 · 候选池 {pool.candidateCount ?? 0} 张 · 抓位统计实时更新</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LocalPicsSetting />
          <a
            href={pool.candidateUrl ?? `/pool/${encodedName}/candidate`}
            className="rounded bg-felt-edge px-3 py-1.5 text-xs text-cyan-200 hover:brightness-110"
          >
            候选池
          </a>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!cardsReady}
            className="rounded bg-felt-edge px-3 py-1.5 text-xs text-slate-200 hover:brightness-110 disabled:cursor-wait disabled:opacity-50"
            title={cardsReady ? '下载包含卡号、卡名、主/额外分类和类型的 CSV' : `卡库缺少 ${missingCount} 张卡的资料`}
          >
            {cardsReady ? '下载卡池 CSV' : `CSV 缺少 ${missingCount} 张卡的资料`}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            抓位排序
            <select
              className="rounded bg-felt-edge px-2 py-1.5 text-xs outline-none ring-gold/50 focus:ring-2"
              value={pickSort}
              onChange={(event) => setPickSort(event.target.value as PickSort)}
            >
              <option value="default">默认顺序</option>
              <option value="pick_asc">百分比正序（低→高）</option>
              <option value="pick_desc">百分比逆序（高→低）</option>
            </select>
          </label>
          <a href="/create-tournament" className="rounded bg-felt-edge px-3 py-1.5 text-xs text-slate-200 hover:brightness-110">创建比赛</a>
        </div>
      </header>
      {error && <p role="alert" className="px-4 py-2 text-sm text-amber-200">{error} <button className="underline" onClick={() => void loadPool()}>重试</button></p>}
      {pool.draftFormat === 'edison_e3' && <EdisonDraftRules />}
      <PoolPreview
        poolCodes={orderedCodes}
        cardMap={cardMap}
        searchQuery={query}
        searchResults={results.map((card) => cardMap[card.code] ?? card)}
        onSearchQuery={setQuery}
        onSearch={() => void search()}
        heading={`主卡与额外卡预览（共 ${pool.count} 张）`}
      />
    </main>
  );
}
