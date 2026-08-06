'use client';

import { useMemo, useState } from 'react';
import { CardImage, CardWithTooltip } from './CardImage';
import { ConfirmModal } from './ConfirmModal';
import { CardInfo } from '@/lib/types';
import { useNowTick } from './TopBar';

// 右侧牌堆区（dev_docs/06 §2）：他人回合显示卡背+数量，自己回合显示正面，
// 背景为剩余秒数倒计时呼吸光效（每秒 tick 实时更新）。
export function PackZone({ pack, cardMap, droppedCards, onPick }: {
  pack: {
    cardsLeft: number;
    isMyTurn: boolean;
    cards?: number[];
    deadlineAt: string;
  } | null;
  cardMap: Record<number, CardInfo>;
  droppedCards?: number[];
  onPick: (code: number) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const [dropFilter, setDropFilter] = useState('');
  const now = useNowTick(true);

  // 初始弃置（公开）：按钮 + 可搜索的卡图-卡名列表弹窗（dev_docs/06 §2）
  const droppedList = droppedCards ?? [];
  const filteredDropped = useMemo(() => {
    const q = dropFilter.trim().toLowerCase();
    if (!q) return droppedList;
    return droppedList.filter((c) => {
      const info = cardMap[c];
      return (info?.name ?? '').toLowerCase().includes(q) || String(c).includes(q);
    });
  }, [droppedList, cardMap, dropFilter]);

  const secondsLeft = pack?.deadlineAt ? Math.max(0, Math.ceil((new Date(pack.deadlineAt).getTime() - now) / 1000)) : null;

  if (!pack) {
    return (
      <aside className="flex h-full min-h-[300px] items-center justify-center rounded-lg border border-felt-edge bg-felt/40 text-slate-500">
        暂无牌堆
      </aside>
    );
  }

  const pendingCard = pending !== null ? cardMap[pending] : undefined;

  return (
    <aside className="relative flex flex-col overflow-hidden rounded-lg border border-felt-edge bg-felt/60">
      {pack.isMyTurn && secondsLeft !== null && (
        <div
          className="countdown-bg pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at center, rgba(212,175,55,${0.12 + (secondsLeft / 30) * 0.2}) 0%, transparent 70%)`,
          }}
        />
      )}
      <header className="z-10 flex items-center justify-between px-3 py-2 text-xs text-slate-200">
        <span>
          {pack.isMyTurn ? '轮到你选牌' : '等待其他玩家'} · 剩余 {pack.cardsLeft} 张
        </span>
        {secondsLeft !== null && (
          <span className={`font-mono ${secondsLeft <= 5 ? 'text-red-300' : 'text-gold'}`}>{secondsLeft} 秒</span>
        )}
      </header>
      <div className="z-10 flex-1 overflow-y-auto p-2">
        {pack.isMyTurn && pack.cards ? (
          <div className="card-grid-5">
            {pack.cards.map((c, i) => (
              <div
                key={i}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', String(c));
                  e.dataTransfer.setData('application/x-card-zone', 'pack');
                }}
                onClick={() => setPending(c)}
                className="animate-pick cursor-pointer"
              >
                {/* pinOnClick=false：点击只触发选牌确认，不再弹出第二个固定详情窗口 */}
                <CardWithTooltip code={c} card={cardMap[c]} pinOnClick={false} />
              </div>
            ))}
          </div>
        ) : (
          <div className="card-grid-5">
            {Array.from({ length: Math.min(pack.cardsLeft, 10) }).map((_, i) => (
              <div key={i} className="aspect-[7/10] w-full rounded-sm border border-slate-700 bg-gradient-to-br from-slate-800 to-slate-950" />
            ))}
          </div>
        )}
      </div>
      {droppedList.length > 0 && (
        <footer className="z-10 border-t border-felt-edge px-3 py-1.5">
          <button
            onClick={() => setShowDropped(true)}
            className="w-full rounded bg-felt-edge px-2 py-1 text-[0.625rem] text-slate-200 hover:brightness-110"
          >
            查看初始弃置（公开 {droppedList.length} 张）
          </button>
        </footer>
      )}
      <ConfirmModal
        open={showDropped}
        title={`初始弃置（${droppedList.length} 张，公开）`}
        onCancel={() => setShowDropped(false)}
        onConfirm={() => setShowDropped(false)}
        confirmText="关闭"
      >
        <input
          className="w-full rounded bg-felt-deep px-2 py-1 text-xs outline-none ring-gold/50 focus:ring-2"
          placeholder="搜索弃置卡牌（名称或编号）"
          value={dropFilter}
          onChange={(e) => setDropFilter(e.target.value)}
          autoFocus
        />
        <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
          {filteredDropped.map((c) => (
            <div key={c} className="flex items-center gap-2 rounded bg-felt-deep/60 px-1.5 py-1">
              <CardImage code={c} name={cardMap[c]?.name} className="h-10 w-8 shrink-0" />
              <span className="flex-1 truncate text-xs">{cardMap[c]?.name ?? c}</span>
              <span className="font-mono text-[0.625rem] text-slate-500">{c}</span>
            </div>
          ))}
          {filteredDropped.length === 0 && <p className="py-2 text-center text-xs text-slate-500">未找到匹配的卡牌</p>}
        </div>
      </ConfirmModal>
      <ConfirmModal
        open={pending !== null}
        title="选择这张卡？"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) onPick(pending);
          setPending(null);
        }}
      >
        <div className="flex items-center gap-3">
          <CardImage code={pending ?? 0} name={pendingCard?.name} className="h-28" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-gold">{pendingCard?.name ?? pending}</p>
            <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-slate-300">
              {pendingCard?.desc}
            </p>
          </div>
        </div>
      </ConfirmModal>
    </aside>
  );
}
