'use client';

import { useState } from 'react';
import { api, Identity } from '@/lib/api';
import { CardInfo } from '@/lib/types';
import { CardWithTooltip } from './CardImage';

// 卡牌搜索（dev_docs/06 §5.1）：按名称/代码查询，命中未使用选牌池的卡可一键加入副卡组。
export function CardSearch({ tid, identity, pool, onAdd }: {
  tid: string;
  identity: Identity;
  pool: number[];
  onAdd: (code: number) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CardInfo[]>([]);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      const r = await api<CardInfo[]>(`/t/${tid}/cards?q=${encodeURIComponent(q.trim())}`, { identity });
      setResults(r);
      setSearched(true);
    } catch {
      setResults([]);
    }
  };

  return (
    <div className="rounded-lg border border-felt-edge bg-felt/60 p-2">
      <header className="mb-1 text-xs font-semibold text-slate-300">卡牌搜索</header>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded bg-felt-deep px-2 py-1 text-xs outline-none ring-gold/50 focus:ring-2"
          placeholder="按名称或编号搜索（如：青眼白龙 / 8964）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <button onClick={() => void search()} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
          搜索
        </button>
      </div>
      {results.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
          {results.map((c) => {
            const inPool = pool.includes(c.code);
            return (
              <li key={c.code} className="flex items-center gap-2 rounded bg-felt-deep/60 px-1.5 py-1">
                <CardWithTooltip code={c.code} card={c} className="h-9 w-7 shrink-0" />
                <span className="flex-1 truncate text-xs">{c.name}</span>
                <span className="font-mono text-[0.625rem] text-slate-500">{c.code}</span>
                {inPool ? (
                  <button
                    onClick={() => onAdd(c.code)}
                    className="rounded bg-gold px-2 py-0.5 text-[0.625rem] font-semibold text-felt-deep hover:brightness-110"
                  >
                    加入副卡组
                  </button>
                ) : (
                  <span className="text-[0.625rem] text-slate-600">不在选牌池</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {searched && results.length === 0 && <p className="mt-2 text-[0.625rem] text-slate-500">未找到匹配的卡牌</p>}
    </div>
  );
}
