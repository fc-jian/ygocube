'use client';

import { useState } from 'react';
import type { CardVisibilityStatus } from '@ygocube/shared';
import { api, Identity } from '@/lib/api';
import { CardInfo } from '@/lib/types';
import { CardWithTooltip } from './CardImage';
import { sortCardSearchResults } from '@/lib/cardInfo';

type Status = CardVisibilityStatus;

const STATUS_TEXT: Record<Status, string> = {
  not_in_pool: '不在卡池',
  dropped: '初始排除',
  picked: '已选',
  other_picked: '其他玩家已选',
  seen: '此前见过',
  unknown: '未知',
};

const STATUS_STYLE: Record<Status, string> = {
  not_in_pool: 'bg-slate-800 text-slate-400',
  dropped: 'bg-red-950 text-red-300',
  picked: 'bg-emerald-950 text-emerald-300',
  other_picked: 'bg-violet-950 text-violet-300',
  seen: 'bg-amber-950 text-amber-300',
  unknown: 'bg-slate-800 text-slate-500',
};

// 卡牌搜索（dev_docs/06 §5.1）：按名称/代码查询，命中未使用选牌池的卡可一键加入副卡组。
export function CardSearch({ tid, identity, pool, onAdd }: {
  tid: string;
  identity: Identity;
  pool: number[];
  onAdd: (code: number) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<(CardInfo & { status?: Status })[]>([]);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      const cardPayload = await api<unknown>(`/t/${tid}/cards?q=${encodeURIComponent(q.trim())}`, { identity });
      if (!Array.isArray(cardPayload)) throw new Error('INVALID_CARD_RESPONSE');
      const cards = sortCardSearchResults(cardPayload as CardInfo[], q);
      const statuses: { code: number; status: Status }[] = [];
      for (let i = 0; i < cards.length; i += 500) {
        const codes = cards.slice(i, i + 500).map((c) => c.code).join(',');
        const statusPayload = await api<unknown>(`/t/${tid}/cards/status?codes=${codes}`, { identity });
        if (!Array.isArray(statusPayload)) throw new Error('INVALID_STATUS_RESPONSE');
        statuses.push(...(statusPayload as { code: number; status: Status }[]));
      }
      const statusMap = new Map(statuses.map((s) => [s.code, s.status]));
      setResults(cards.map((c) => ({ ...c, status: statusMap.get(c.code) })));
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
          placeholder="搜索名称、编号、效果、字段或系列（空格分隔多个关键词）"
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
            const status = c.status ?? 'unknown';
            const inPool = pool.includes(c.code);
            return (
              <li key={c.code} className="flex items-center gap-2 rounded bg-felt-deep/60 px-1.5 py-1">
                <CardWithTooltip code={c.code} card={c} className="h-9 w-7 shrink-0" />
                <span className="flex-1 truncate text-xs">{c.name}</span>
                <span className="font-mono text-[0.625rem] text-slate-500">{c.code}</span>
                <span className={`rounded px-1.5 py-0.5 text-[0.625rem] ${STATUS_STYLE[status]}`}>
                  {STATUS_TEXT[status]}
                </span>
                {inPool && status === 'picked' ? (
                  <button
                    onClick={() => onAdd(c.code)}
                    className="rounded bg-gold px-2 py-0.5 text-[0.625rem] font-semibold text-felt-deep hover:brightness-110"
                  >
                    加入副卡组
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {searched && results.length === 0 && <p className="mt-2 text-[0.625rem] text-slate-500">未找到匹配的卡牌</p>}
    </div>
  );
}
