'use client';

import { useState } from 'react';
import { api, Identity } from '@/lib/api';
import { CardInfo } from '@/lib/types';
import { CardWithTooltip } from './CardImage';

// 选牌期全卡牌搜索（dev_docs/06 §5.6）：搜索所有卡牌并标注每个玩家的已知状态。
type Status = 'not_in_pool' | 'dropped' | 'picked' | 'seen' | 'unknown';

const STATUS_TEXT: Record<Status, string> = {
  not_in_pool: '未包含在卡池中',
  dropped: '已被初始随机丢弃',
  picked: '已选择',
  seen: '此前见过但未选择',
  unknown: '未知',
};

const STATUS_STYLE: Record<Status, string> = {
  not_in_pool: 'bg-slate-800 text-slate-400',
  dropped: 'bg-red-950 text-red-300',
  picked: 'bg-emerald-950 text-emerald-300',
  seen: 'bg-amber-950 text-amber-300',
  unknown: 'bg-slate-800 text-slate-500',
};

export function CardSearchAll({ tid, identity }: { tid: string; identity: Identity }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<(CardInfo & { status?: Status })[]>([]);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      const cards = await api<CardInfo[]>(`/t/${tid}/cards?q=${encodeURIComponent(q.trim())}`, { identity });
      if (!cards.length) {
        setResults([]);
        setSearched(true);
        return;
      }
      const codes = cards.map((c) => c.code).join(',');
      const statuses = await api<{ code: number; status: Status }[]>(`/t/${tid}/cards/status?codes=${codes}`, { identity });
      const statusMap = new Map(statuses.map((s) => [s.code, s.status]));
      setResults(cards.map((c) => ({ ...c, status: statusMap.get(c.code) })));
      setSearched(true);
    } catch {
      setResults([]);
    }
  };

  return (
    <div className="rounded-lg border border-felt-edge bg-felt/60 p-2">
      <header className="mb-1 text-xs font-semibold text-slate-300">搜索全部卡牌</header>
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
        <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
          {results.map((c) => (
            <li key={c.code} className="flex items-center gap-2 rounded bg-felt-deep/60 px-1.5 py-1">
              <CardWithTooltip code={c.code} card={c} className="h-9 w-7 shrink-0" />
              <span className="flex-1 truncate text-xs">{c.name}</span>
              <span className="font-mono text-[0.625rem] text-slate-500">{c.code}</span>
              <span className={`rounded px-1.5 py-0.5 text-[0.625rem] ${STATUS_STYLE[c.status ?? 'unknown']}`}>
                {STATUS_TEXT[c.status ?? 'unknown']}
              </span>
            </li>
          ))}
        </ul>
      )}
      {searched && results.length === 0 && <p className="mt-2 text-[0.625rem] text-slate-500">未找到匹配的卡牌</p>}
    </div>
  );
}
