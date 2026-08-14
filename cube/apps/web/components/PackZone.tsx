'use client';

import { useMemo, useState } from 'react';
import { CardImage, CardWithTooltip } from './CardImage';
import { ConfirmModal } from './ConfirmModal';
import { CardMeta } from './CardPreview';
import { CardInfo } from '@/lib/types';
import { matchesCardQuery, sortCardCodes } from '@/lib/cardInfo';
import { useNowTick } from './TopBar';

// 右侧牌堆区（dev_docs/06 §2）：他人回合显示卡背+数量，自己回合显示正面，
// 背景为剩余秒数倒计时呼吸光效（每秒 tick 实时更新）。
export function PackZone({ pack, cardMap, droppedCards, alternativeCode, onAlternative, onPick }: {
  pack: {
    cardsLeft: number;
    isMyTurn: boolean;
    queueLength?: number; // passing 模式：本人牌堆队列长度
    reserveMs?: number; // passing 模式：本人剩余保留时间（ms）
    cards?: number[];
    deadlineAt: string | null;
    pausedRemainingMs?: number;
  } | null;
  cardMap: Record<number, CardInfo>;
  droppedCards?: number[];
  alternativeCode?: number | null;
  onAlternative?: (code: number) => void;
  onPick: (code: number) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const [dropFilter, setDropFilter] = useState('');
  // Sorting is presentation-only. The server's pack order remains untouched so
  // pick validation, passing, event logs, and replays keep their exact order.
  const displayCards = useMemo(() => sortCardCodes(pack?.cards ?? [], cardMap, 'lv'), [pack?.cards, cardMap]);
  const now = useNowTick(true);

  // 初始弃置（公开）：按钮 + 可搜索的卡图-卡名列表弹窗（dev_docs/06 §2）
  const droppedList = droppedCards ?? [];
  const filteredDropped = useMemo(() => {
    const q = dropFilter.trim().toLowerCase();
    if (!q) return droppedList;
    return droppedList.filter((c) => {
      const info = cardMap[c];
      return matchesCardQuery(info, q);
    });
  }, [droppedList, cardMap, dropFilter]);

  const secondsLeft = pack?.pausedRemainingMs !== undefined
    ? Math.max(0, Math.ceil(pack.pausedRemainingMs / 1000))
    : pack?.deadlineAt
      ? Math.max(0, Math.ceil((new Date(pack.deadlineAt).getTime() - now) / 1000))
      : null;
  // passing 保留时间：base 期显示基础倒计时，reserve 期红色提示正在消耗保留时间
  const reserveMs = pack?.reserveMs ?? 0;
  const baseLeft = pack?.pausedRemainingMs !== undefined
    ? Math.max(0, Math.ceil((pack.pausedRemainingMs - reserveMs) / 1000))
    : pack?.deadlineAt
      ? Math.max(0, Math.ceil((new Date(pack.deadlineAt).getTime() - reserveMs - now) / 1000))
      : null;
  const inReserve = baseLeft !== null && baseLeft <= 0 && secondsLeft !== null && secondsLeft > 0;

  if (!pack) {
    return (
      <aside className="flex h-full min-h-[300px] items-center justify-center rounded-lg border border-felt-edge bg-felt/40 text-slate-500">
        暂无可选择的牌堆（等待传堆）
      </aside>
    );
  }

  const pendingCard = pending !== null ? cardMap[pending] : undefined;

  return (
    <aside className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-felt-edge bg-felt/60">
      {pack.isMyTurn && secondsLeft !== null && (
        <div
          className="countdown-bg pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at center, rgba(212,175,55,${0.12 + (secondsLeft / 30) * 0.2}) 0%, transparent 70%)`,
          }}
        />
      )}
      <header className="z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs text-slate-200">
        <span>
          {pack.isMyTurn ? '轮到你选牌' : '等待其他玩家'} · 剩余 {pack.cardsLeft} 张
          {pack.queueLength !== undefined && ` · 队列 ${pack.queueLength} 堆`}
        </span>
        {secondsLeft !== null && (
          <span className={`font-mono ${inReserve || (baseLeft ?? 1) <= 5 ? 'text-red-300' : 'text-gold'}`}>
            {pack.pausedRemainingMs !== undefined ? `已暂停 · 剩余 ${secondsLeft} 秒` : inReserve ? `保留时间 ${secondsLeft} 秒` : `${baseLeft ?? secondsLeft} 秒`}
          </span>
        )}
      </header>
      <div className="z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {pack.isMyTurn && pack.cards ? (
          <div className="card-grid-pack">
            {displayCards.map((c, i) => (
              <div
                key={i}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', String(c));
                  e.dataTransfer.setData('application/x-card-zone', 'pack');
                }}
                onClick={() => {
                  // Clicking opens the confirmation/details modal and records
                  // this card as the timeout fallback. The latest click wins.
                  setPending(c);
                  onAlternative?.(c);
                }}
                className={`animate-pick cursor-pointer ${alternativeCode === c ? 'rounded ring-2 ring-amber-300 ring-offset-1 ring-offset-felt' : ''}`}
              >
                {/* pinOnClick=false：点击只触发选牌确认，不再弹出第二个固定详情窗口 */}
                <CardWithTooltip code={c} card={cardMap[c]} pinOnClick={false} />
              </div>
            ))}
          </div>
        ) : (
          <div className="card-grid-pack">
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
              <CardWithTooltip code={c} card={cardMap[c]} className="h-12 w-8 shrink-0" />
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
        {pendingCard ? (
          <>
            <div className="flex items-start gap-3">
              <CardImage code={pendingCard.code} name={pendingCard.name} className="h-40 w-28 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug text-gold">{pendingCard.name}</p>
                <p className="mt-1 font-mono text-xs text-slate-500">[{String(pendingCard.code).padStart(8, '0')}]</p>
                <div className="mt-2">
                  <CardMeta card={pendingCard} />
                </div>
              </div>
            </div>
            {pendingCard.desc && (
              <p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-slate-200">
                {pendingCard.desc}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400">卡牌信息加载中…</p>
        )}
      </ConfirmModal>
    </aside>
  );
}
