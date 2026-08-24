'use client';

import { useMemo } from 'react';
import { CardWithTooltip } from './CardImage';
import { DeckZone } from './TopBar';
import { CardInfo } from '@/lib/types';
import { isExtraDeckType, PickSortMode, sortCardCodesByPick } from '@/lib/cardInfo';

export function PoolPreview({
  poolCodes,
  cardMap,
  searchQuery,
  searchResults,
  onSearchQuery,
  onSearch,
  heading,
  sortMode = 'default',
  onSortModeChange,
  poolId,
}: {
  poolCodes: number[];
  cardMap: Record<number, CardInfo>;
  searchQuery: string;
  searchResults: CardInfo[];
  onSearchQuery: (value: string) => void;
  onSearch: () => void;
  heading: string;
  sortMode?: PickSortMode;
  onSortModeChange?: (mode: PickSortMode) => void;
  poolId?: number;
}) {
  const orderedCodes = useMemo(
    () => sortMode === 'pick' ? sortCardCodesByPick(poolCodes, cardMap, poolId) : poolCodes,
    [cardMap, poolCodes, poolId, sortMode],
  );
  const main = orderedCodes.filter((code) => cardMap[code] && !isExtraDeckType(cardMap[code].type));
  const extra = orderedCodes.filter((code) => cardMap[code] && isExtraDeckType(cardMap[code].type));
  const inPool = new Set(orderedCodes);

  return (
    <div className="flex flex-1 flex-col gap-3 p-3 md:flex-row md:overflow-hidden">
      <div className="flex w-full flex-col gap-2 md:w-3/5 md:overflow-y-auto md:pr-1">
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>{heading}</span>
          {onSortModeChange && (
            <label className="flex items-center gap-1.5 text-slate-300">
              卡池排序
              <select
                className="rounded bg-felt-edge px-2 py-1 text-xs outline-none ring-gold/50 focus:ring-2"
                value={sortMode}
                onChange={(event) => onSortModeChange(event.target.value as PickSortMode)}
              >
                <option value="default">默认</option>
                <option value="pick">抓位（早→晚）</option>
              </select>
            </label>
          )}
        </header>
        <DeckZone title="主卡组" zone="main" codes={main} cardMap={cardMap} />
        <DeckZone title="额外卡组" zone="extra" codes={extra} cardMap={cardMap} />
      </div>
      <aside className="flex-1 rounded-lg border border-felt-edge bg-felt/60 p-2">
        <header className="mb-1 text-xs font-semibold text-slate-300">搜索并标记是否在卡池中</header>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded bg-felt-deep px-2 py-1 text-xs outline-none ring-gold/50 focus:ring-2"
            placeholder="搜索名称、编号、效果、字段或系列（空格分隔多个关键词）"
            value={searchQuery}
            onChange={(event) => onSearchQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && onSearch()}
          />
          <button onClick={onSearch} className="rounded bg-felt-edge px-3 py-1 text-xs hover:brightness-110">
            搜索
          </button>
        </div>
        <ul className="mt-2 max-h-[min(32rem,60vh)] space-y-0.5 overflow-y-auto">
          {searchResults.map((card) => {
            const present = inPool.has(card.code);
            return (
              <li key={card.code} className="flex items-center gap-2 rounded bg-felt-deep/60 px-1.5 py-1">
                <CardWithTooltip code={card.code} card={card} className="h-9 w-7 shrink-0" />
                <span className="flex-1 truncate text-xs">{card.name}</span>
                <span className="font-mono text-[0.625rem] text-slate-500">{card.code}</span>
                <span className={`rounded px-1.5 py-0.5 text-[0.625rem] ${present ? 'bg-emerald-950 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
                  {present ? '在卡池中' : '不在卡池中'}
                </span>
              </li>
            );
          })}
          {searchQuery.trim() && searchResults.length === 0 && <li className="text-[0.625rem] text-slate-500">未找到匹配的卡牌</li>}
        </ul>
      </aside>
    </div>
  );
}
