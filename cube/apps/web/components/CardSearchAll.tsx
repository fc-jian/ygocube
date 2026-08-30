'use client';

import { useState } from 'react';
import type { CardVisibilityStatus } from '@ygocube/shared';
import { api, encodePathSegment, Identity } from '@/lib/api';
import { CardInfo } from '@/lib/types';
import { CardWithTooltip } from './CardImage';
import { sortCardSearchResults } from '@/lib/cardInfo';

// 选牌期全卡牌搜索（dev_docs/06 §5.6）：搜索所有卡牌并标注每个玩家的已知状态。
type Status = CardVisibilityStatus;

const STATUS_TEXT: Record<Status, string> = {
  not_in_pool: '未包含在卡池中',
  dropped: '已被初始随机丢弃',
  picked: '已选择',
  other_picked: '其他玩家已选择',
  seen: '此前见过但未选择',
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

export function CardSearchAll({ tid, identity }: { tid: string; identity: Identity }) {
  const tidPath = encodePathSegment(tid);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<(CardInfo & { status?: Status })[]>([]);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      const cardPayload = await api<unknown>(`/t/${tidPath}/cards?q=${encodeURIComponent(q.trim())}`, { identity });
      if (!Array.isArray(cardPayload)) throw new Error('INVALID_CARD_RESPONSE');
      const cards = sortCardSearchResults(cardPayload as CardInfo[], q);
      if (!cards.length) {
        setResults([]);
        setSearched(true);
        return;
      }
      // Search is intentionally uncapped, so do not put every matching code
      // into one URL (large pools would exceed proxy/request-line limits).
      const statuses: { code: number; status: Status }[] = [];
      for (let i = 0; i < cards.length; i += 500) {
        const codes = cards.slice(i, i + 500).map((c) => c.code).join(',');
        const statusPayload = await api<unknown>(`/t/${tidPath}/cards/status?codes=${codes}`, { identity });
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
      <header className="mb-1 text-xs font-semibold text-slate-300">搜索全部卡牌</header>
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
